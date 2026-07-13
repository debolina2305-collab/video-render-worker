/**
 * puzzle_generator.js — PUZZLE Quiz Generator (Cloudflare Worker)
 *
 * The puzzle equivalent of worker8.js. Reads ONE pending puzzle_queue row
 * (its puzzle_type was already chosen by puzzle_seeder.js), asks the LLM for a
 * fully self-contained visual puzzle of that type, validates it (structure +
 * math sanity checks), pulls audio cues from the SAME reused pools worker8 uses,
 * builds a `puzzle` row, assigns a render format, inserts it, and fires the
 * puzzle render workflow.
 *
 * ISOLATION:
 *   • Reads (read-only): quiz_generation_settings (LLM creds), and the audio
 *     pools (quiz_hooks, timeup_cues, cta*_cues, *_intro_cues, sfx_cues,
 *     background_music_tracks, background_animation). Reading changes nothing
 *     for the trending workers.
 *   • Writes ONLY: puzzle_queue (its own row) and puzzle (new rows).
 *   • Never touches quiz / quiz_queue.
 *
 * DEPLOY: single-file drag-drop Cloudflare Worker.
 *
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY,
 *      [GITHUB_TOKEN, GITHUB_REPO] (to fire repository_dispatch trigger-puzzle-render)
 *
 * The puzzle_spec shapes below MUST match puzzleRenderers.js exactly.
 */

const PUZZLE_TYPES = [
  'matchstick', 'geometry_triangle', 'geometry_right_triangle', 'geometry_straight_line',
  'number_sequence', 'number_grid', 'visual_math', 'odd_one_out', 'rebus', 'detective',
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/generate-puzzle') {
      await processPuzzleQueue(env);
      return new Response('OK', { status: 200 });
    }
    if (request.method === 'GET' && url.pathname === '/health') return new Response('OK', { status: 200 });
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(processPuzzleQueue(env)); }
};

// ════════════════════════════════════════════════════════════════════════════
async function processPuzzleQueue(env) {
  console.log('[PGEN] Checking pending puzzle jobs...');
  const nowIso = new Date().toISOString();

  // Fresh pending first, then retryable failed jobs (same model as worker8)
  let jobs = await dbGet(env,
    `puzzle_queue?job_type=eq.puzzle_generation&status=eq.pending&order=priority.desc,created_at.asc&limit=1`
  ).catch(() => null);

  if (!jobs?.length) {
    jobs = await dbGet(env,
      `puzzle_queue?job_type=eq.puzzle_generation&status=eq.failed` +
      `&retry_count=lt.10&or=(next_retry_at.is.null,next_retry_at.lte.${encodeURIComponent(nowIso)})` +
      `&order=priority.desc,created_at.asc&limit=1`
    ).catch(() => null);
    if (jobs?.length && jobs[0].retry_count >= (jobs[0].max_retries || 3)) jobs = [];
  }
  if (!jobs?.length) { console.log('[PGEN] No pending/retryable jobs.'); return; }

  const job = jobs[0];
  const puzzleType = job.puzzle_type;
  console.log(`[PGEN] Job ${job.id}: type=${puzzleType} difficulty=${job.difficulty}`);

  if (!PUZZLE_TYPES.includes(puzzleType)) {
    await failJob(env, job, `Unknown puzzle_type "${puzzleType}"`);
    return;
  }

  await dbPatch(env, 'puzzle_queue', job.id, { status: 'processing', started_at: nowIso });

  try {
    const lang        = job.lang_code || 'en';
    const category    = job.category  || 'math';
    const difficulty  = job.difficulty || 'medium';
    const channelName = job.channel_name || 'JaasX Brain Challenge';
    const niche       = 'brain';

    // ── 1. LLM: generate the puzzle for this type ─────────────────────────
    const { puzzles, model } = await generatePuzzlesWithLLM(env, puzzleType, difficulty, job.seed_hint, lang);
    console.log(`[PGEN] LLM returned ${puzzles.length} candidate(s) (model=${model})`);

    // ── 2. Validate + normalise (may fix correct/options for some types) ──
    const valid = [];
    for (const p of puzzles) {
      const res = validatePuzzle(puzzleType, p);
      if (res.ok) valid.push(p);
      else console.warn(`[PGEN] REJECT: ${res.reason}`);
    }
    if (!valid.length) throw new Error('No valid puzzle survived validation.');
    const chosen = valid[0];

    // ── 3. Load reused audio + design pools (ONE batch, like worker8) ─────
    const pools = await loadAllPools(env, lang, niche);

    // ── 4. Numbering ──────────────────────────────────────────────────────
    const now = new Date();
    const yy = String(now.getUTCFullYear()).slice(-2);
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const datePrefix = `${yy}${mm}${dd}`;
    let todayCount = 0;
    try {
      const rows = await dbGet(env, `puzzle?created_at=gte.${now.getUTCFullYear()}-${mm}-${dd}T00%3A00%3A00Z&select=id`).catch(() => null);
      todayCount = rows?.length || 0;
    } catch {}
    const serial = String(todayCount + 1).padStart(4, '0');
    const quizNo = Number(`${datePrefix}${serial}`);

    let typeCount = 0;
    try {
      const rows = await dbGet(env, `puzzle?puzzle_type=eq.${encodeURIComponent(puzzleType)}&select=id&limit=5000`).catch(() => null);
      typeCount = rows?.length || 0;
    } catch {}
    const nicheChallengeNo = typeCount + 1;

    // ── 5. Pick audio cues + design ───────────────────────────────────────
    const hook      = randomPick(pools.hooks);
    const timeup    = randomPick(pools.timeup);
    const cta1      = randomPick(pools.cta1);
    const cta2      = randomPick(pools.cta2);
    const cta3      = randomPick(pools.cta3);
    const cta4      = randomPick(pools.cta4);
    const qIntro    = randomPick(pools.qIntro);
    const optsIntro = randomPick(pools.optsIntro);
    const sfxQApp   = randomPick(pools.sfxQuestionAppear);
    const sfxOApp   = randomPick(pools.sfxOptionsAppear);
    const sfxCdown  = randomPick(pools.sfxCountdownLoop);
    const sfxCorrect= randomPick(pools.sfxCorrectAnswer);
    const bgMusic   = randomPick(pools.bgMusic);
    const bgAnim    = randomPick(pools.bgAnim);

    const displayName = job.payload?.display_name || puzzleType;
    const baseSlug = makeSlug(`${puzzleType}-${quizNo}`);

    // Accent colours (drive the SVG puzzle too, via puzzle_spec-independent cols)
    const accents = pickAccents();

    // ── 6. Build the puzzle row ───────────────────────────────────────────
    const row = {
      topic: `${displayName} #${nicheChallengeNo}`,
      topic_slug: baseSlug,
      niche, lang_code: lang, country_code: job.country_code || 'US',
      channel_name: channelName,
      is_active: true, puzzle_enriched: true,
      is_human_approved: false, video_status: 'pending',
      created_at: now.toISOString(), updated_at: now.toISOString(),

      // format columns — set after RPC
      assigned_format: null, short_status: null, medium_status: null, long_status: null,

      // ⭐ puzzle-specific
      puzzle_type: puzzleType,
      puzzle_spec: chosen.spec,          // jsonb — plain object (NOT stringified)
      puzzle_svg: null,                  // render worker fills this in
      difficulty,

      quiz_no: quizNo,
      niche_challenge_no: nicheChallengeNo,
      youtube_title: (chosen.youtube_title || '').trim() || `Can You Solve This ${displayName}?`,
      thinking_time_sec: 10,
      question_appearance_text: 'Here Is Your Challenge — Solve It',
      quiz_intro_speech: buildIntroSpeech(displayName),

      // the puzzle prompt + answers
      question_1: chosen.question,
      options_1: chosen.options.slice(0, 4),
      correct_answer_1: chosen.correct,
      explanation_1: chosen.explanation || '',
      hint_1: chosen.hint || '',
      keep_5050_1: normaliseKeep5050(chosen.keep_5050, chosen.options, chosen.correct),

      // audio (reused pools)
      hook_phrase: hook?.hook_text || null,
      hook_audio_url: hook?.audio_url || null,
      timeup_text: timeup?.lead_in_text || null,
      timeup_audio_url: timeup?.audio_url || null,
      question_intro_audio_url: qIntro?.audio_url || null,
      options_intro_audio_url: optsIntro?.audio_url || null,
      sfx_audio_url: buildSfxJson({
        question_appear: sfxQApp?.audio_url || null,
        options_appear:  sfxOApp?.audio_url || null,
        countdown_loop:  sfxCdown?.audio_url || null,
      }),
      countdown_music: sfxCdown?.audio_url || null,
      correct_answer_sfx_audio_url: sfxCorrect?.audio_url || null,
      background_music: bgMusic?.audio_url || null,
      quiz_background_css: bgAnim?.background_css || null,

      cta1_description_text: cta1?.cta_text || null,
      cta1_audio_url: cta1?.audio_url || null,
      cta2_text: cta2?.cta_text || null,
      cta2_audio_url: cta2?.audio_url || null,
      cta3_text: cta3?.cta_text || null,
      cta3_audio_url: cta3?.audio_url || null,
      cta4_text: cta4?.cue_text || 'Write your answer in the comments below!',
      cta4_audio_url: cta4?.audio_url || null,

      blog_page_url: `jaasblog.online/quiz/${niche}`,
      blog_slug: baseSlug,

      // design engine (same names as quiz)
      visual_theme_id: randomPick(['glass','gaming','luxury','cyberpunk','minimal','comic','space','news','neon','retro']),
      layout_variant:  randomPick(['standard','bold','compact','cinematic','split','card','overlay','spotlight']),
      countdown_style: randomPick(['ring','bar','digital','bomb','hourglass','pulse']),
      transition_style:randomPick(['fade','slide_up','zoom_in','flip','blur_in','bounce']),
      theme_accent_primary:   accents[0],
      theme_accent_secondary: accents[1],
      theme_accent_tertiary:  accents[2],

      llm_provider: 'vercel-ai-gateway',
      llm_model: model,
    };

    // ── 7. Assign format + insert ─────────────────────────────────────────
    let assignedFormat = 'short';
    try { assignedFormat = await dbRpc(env, 'assign_puzzle_format'); }
    catch (e) { console.warn(`[PGEN] assign_puzzle_format failed (${e.message}) — defaulting short`); }

    row.assigned_format = assignedFormat;
    if (assignedFormat === 'short')      { row.short_status  = 'pending_short';  row.video_status = 'assigned_short'; }
    else if (assignedFormat === 'medium'){ row.medium_status = 'pending_medium'; row.video_status = 'assigned_medium'; }
    else                                 { row.long_status   = 'pending_long'; /* video_status stays 'pending' */ }

    const ins = await dbInsert(env, 'puzzle', row);
    const puzzleId = ins?.[0]?.id || null;
    console.log(`[PGEN] Inserted puzzle ${puzzleId} slug=${baseSlug} format=${assignedFormat}`);

    // ── 8. Bump audio usage counts (only tables WITH last_used_at) ────────
    await bumpUsage(env, {
      quiz_hooks: hook, timeup_cues: timeup, cta1_audio_cues: cta1,
      cta2_audio_cues: cta2, cta3_audio_cues: cta3,
      question_intro_cues: qIntro, options_intro_cues: optsIntro,
    });

    // ── 9. Mark job complete ──────────────────────────────────────────────
    await dbPatch(env, 'puzzle_queue', job.id, {
      status: 'completed', completed_at: new Date().toISOString(), quiz_id: puzzleId,
      payload: { ...(job.payload || {}), puzzle_id: puzzleId, slug: baseSlug, format: assignedFormat }
    });

    // ── 10. Fire the render workflow ──────────────────────────────────────
    await fireRenderDispatch(env);

    console.log(`[PGEN] Job ${job.id} done.`);
  } catch (err) {
    console.error(`[PGEN] Job ${job.id} FAILED: ${err.message}`);
    await failJob(env, job, err.message);
  }
}

async function failJob(env, job, message) {
  const newRetry = (job.retry_count || 0) + 1;
  const maxRetries = job.max_retries || 3;
  const backoff = Math.min(5 * Math.pow(2, newRetry), 360);
  const nextRetryAt = newRetry < maxRetries ? new Date(Date.now() + backoff * 60000).toISOString() : null;
  await dbPatch(env, 'puzzle_queue', job.id, {
    status: 'failed', last_error: String(message).slice(0, 700),
    retry_count: newRetry, next_retry_at: nextRetryAt, started_at: null,
  }).catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════════
// LLM
// ════════════════════════════════════════════════════════════════════════════
async function generatePuzzlesWithLLM(env, puzzleType, difficulty, seedHint, lang) {
  // Reuse the SAME working LLM credentials the trending pipeline uses.
  let config = null;
  try {
    const rows = await dbGet(env, 'quiz_generation_settings?id=eq.1&limit=1');
    if (rows?.length) config = rows[0];
  } catch (e) { console.error('[PGEN] load settings:', e.message); }
  if (!config) throw new Error('quiz_generation_settings row not found');

  const apiKey   = config.llm_api_key;
  const model    = config.llm_model;
  const endpoint = config.llm_api_endpoint || 'https://ai-gateway.vercel.sh/v1/chat/completions';
  const temperature = Number(config.temperature) || 0.7;
  const maxTokens   = Number(config.max_tokens) || 2600;
  if (!apiKey || !model) throw new Error('llm_api_key / llm_model empty in quiz_generation_settings');

  const prompt = buildPrompt(puzzleType, difficulty, seedHint);

  const MODELS = [{ model, endpoint, apiKey }];
  if (config.fallback_llm_model && config.fallback_llm_provider !== 'none' && config.fallback_llm_api_key) {
    MODELS.push({ model: config.fallback_llm_model, endpoint: config.fallback_llm_api_endpoint || endpoint, apiKey: config.fallback_llm_api_key });
  }

  let lastErr;
  for (let attempt = 0; attempt < MODELS.length; attempt++) {
    const { model: m, endpoint: ep, apiKey: key } = MODELS[attempt];
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || `LLM HTTP ${res.status}`);
      const raw = data.choices?.[0]?.message?.content || '';
      const parsed = parseJsonArray(raw);
      if (!parsed?.length) throw new Error('Empty/invalid JSON from LLM');
      return { puzzles: parsed, model: m };
    } catch (e) {
      lastErr = e; console.warn(`[PGEN] LLM attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt < MODELS.length - 1) await sleep(1500);
    }
  }
  throw new Error(`All LLM attempts failed. Last: ${lastErr?.message}`);
}

// ── Shared viral philosophy (mirrors worker8's tricky-not-hard rules) ────────
const PHILOSOPHY = `
You write puzzles for a viral short-form video channel (YouTube Shorts / Reels).
Each puzzle flashes on screen for ~10 seconds. It MUST be:
  • SELF-CONTAINED — a stranger understands it from the visual + prompt alone.
  • TRICKY, NOT HARD — most viewers THINK they can solve it, then hesitate.
    If an average person would say "I have no idea" → too hard, rewrite.
    If they'd say "obviously X" → too easy, rewrite. Aim for "wait... let me think".
  • VIRAL — the kind of puzzle people TAG a friend on or argue about in comments.
Options: exactly 4, all plausible, with at least one "obvious trap" (feels right,
is wrong). The correct answer must NOT be the most obvious-looking option.
prompt/question: <= 15 words, ends with "?", instantly readable.
hint: 2-10 words, teases without revealing.
explanation: > 15 words, a satisfying standalone reason the answer is correct.
youtube_title: 5-12 words with a curiosity hook (e.g. "99% Get This Wrong!").
keep_5050: [correctIndex, mostPlausibleWrongIndex] (two indexes 0-3).
`;

function buildPrompt(type, difficulty, seedHint) {
  const block = TYPE_PROMPTS[type](difficulty, seedHint || '');
  return `You are a world-class visual puzzle designer.
${PHILOSOPHY}
DIFFICULTY: ${difficulty}
${seedHint ? `THEME NUDGE: ${seedHint}\n` : ''}
PUZZLE TYPE: ${type}
${block}

OUTPUT — ONLY a valid JSON array with 1 or 2 puzzle objects, no markdown, no preamble.
Each object MUST have exactly these keys:
  "title", "spec", "question", "options", "correct", "hint", "explanation", "keep_5050", "youtube_title"
"spec" must EXACTLY match the schema shown above for this type.
"correct" must be an EXACT string from "options".`;
}

// Per-type prompt blocks. Each documents the EXACT spec schema puzzleRenderers.js
// expects, plus a worked example, so the LLM fills the visual correctly.
const TYPE_PROMPTS = {
  matchstick: (d) => `
Design a matchstick equation puzzle. Show a WRONG equation made of matchsticks;
the viewer must move ONE matchstick to make it true.
spec schema:  { "equation": "6+4=4", "instruction": "Move 1 matchstick to make it true", "title": "Matchstick Move" }
  - equation: 3-7 characters using digits 0-9 and the symbols + - =  (NO spaces).
  - It must be currently FALSE but fixable by moving exactly ONE stick.
options: 4 candidate CORRECTED equations (strings), only ONE is actually reachable
  by moving a single matchstick. correct = that one.
Example question: "Move ONE matchstick to make the equation true — which works?"`,

  visual_math: (d) => `
Design an emoji/icon algebra puzzle (the classic "fruit math" viral format).
Use ONLY these icon names: apple, banana, cherry, grape, star, heart, lemon, orange.
spec schema: { "equations": [
    { "items":[{"icon":"apple","count":3}], "result":"30" },
    { "items":[{"icon":"apple","count":1},{"icon":"banana","count":2}], "result":"18" },
    { "items":[{"icon":"banana","count":1},{"icon":"apple","count":1}], "result":"?" }
  ], "title": "Solve the Puzzle" }
  - 2 to 3 rows. Use at most 2 distinct icons. count is 1-3 per item.
  - The first row(s) must let a solver deduce each icon's integer value.
  - The LAST row's result MUST be "?" — that is what the viewer solves.
  - Verify your arithmetic: the "?" value must be an integer.
options: 4 numbers (as strings). correct = the true value of the "?" row.`,

  geometry_triangle: (d) => `
Design a "find the missing angle in a triangle" puzzle. Angles sum to 180.
spec schema: { "labels":[
    {"at":"A","text":"x","highlight":true},
    {"at":"B","text":"55°"},
    {"at":"C","text":"65°"} ], "title":"Find the Angle" }
  - Exactly ONE label is the unknown (text "x", highlight true). The other two are
    numeric angles ending in "°". All three must sum to 180.
options: 4 angle values like "55°","60°","65°","70°" — all plausible, close together.
correct = the true missing angle (180 - the two known angles), formatted like "60°".`,

  geometry_right_triangle: (d) => `
Design a right-triangle "find the missing side" puzzle (Pythagoras).
STRONGLY prefer Pythagorean triples: 3-4-5, 6-8-10, 5-12-13, 8-15-17, 9-12-15, 7-24-25.
spec schema: { "leg_a":"6", "leg_b":"8", "hypotenuse":"?", "unknown":"hypotenuse", "title":"Missing Side" }
  - Two sides numeric, one is "?" and "unknown" names which ("leg_a"|"leg_b"|"hypotenuse").
  - Values must satisfy leg_a² + leg_b² = hypotenuse².
options: 4 numbers (strings). correct = the true missing side length.`,

  geometry_straight_line: (d) => `
Design an "angles on a straight line" puzzle (they sum to 180).
spec schema: { "known_angle":"125°", "unknown_glyph":"x", "title":"Find x" }
options: 4 angle values (strings ending "°"). correct = 180 - known_angle, like "55°".`,

  number_sequence: (d) => `
Design a "what number comes next" sequence puzzle with a clear single rule
(arithmetic, geometric, squares, +1/+2/+3..., Fibonacci-like, etc.).
spec schema: { "cells":["3","6","11","18","?"], "title":"What comes next?" }
  - 4 to 6 cells, the LAST cell MUST be "?".
options: 4 numbers (strings). correct = the next number by the rule.
explanation MUST state the rule (e.g. "differences grow by 1 each step").`,

  number_grid: (d) => `
Design a 3x3 number-grid puzzle where one cell is "?" and a rule links the numbers
(row sums, column products, a hidden operation, etc.).
spec schema: { "rows":[["8","3","5"],["4","2","6"],["?","5","1"]], "title":"Missing Number" }
  - Exactly ONE cell is "?".
options: 4 numbers (strings). correct = the value that satisfies the rule.
explanation MUST state the rule clearly.`,

  odd_one_out: (d) => `
Design a "spot the odd one out" grid. Use ONLY these shape names:
circle, star, heart, triangle, square, pentagon.
spec schema: { "cols":4, "items":[ {"shape":"circle"}, ... (16 items) ...,
  {"shape":"star"} (exactly ONE differs) ], "title":"Spot the Odd One" }
  - cols is 4, provide 16 items. Exactly ONE item has a different shape from the rest.
  - You may optionally add "color" (hex) to items, but keep exactly one true outlier.
options: 4 cell NUMBERS (1-16 as strings) including the real odd position.
correct = the 1-based index of the odd item. (The system will re-verify this.)`,

  rebus: (d) => `
Design a rebus / word puzzle where stacked or combined word-tokens spell a phrase.
spec schema: { "tokens":["SEA","+","SUN"], "title":"Guess the Phrase" }
  - tokens: 2-4 short UPPERCASE word tokens, optionally joined by "+".
options: 4 candidate phrases (strings). correct = the intended phrase.
Keep it fun and guessable (e.g. SEA+SUN → "Season"? no — pick genuinely solvable ones).`,

  detective: (d) => `
Design a bite-size whodunit "case file". Short, solvable purely from the clues.
spec schema: {
  "case_title":"The Vanishing Ruby",
  "scenario":"One-sentence setup of what was stolen / happened.",
  "clues":["clue 1","clue 2","clue 3","clue 4"],   (3-4 short clues)
  "suspects":["The Butler","The Maid","The Guest","The Cook"]  (EXACTLY 4)
}
  - The clues must logically point to exactly ONE suspect (fair-play deduction).
options: MUST equal the 4 suspects, in the same order.
correct = the guilty suspect (one of the suspects). 
question: "Whodunit? Who is the culprit?"  hint: a nudge toward the deduction.
explanation: name the culprit and the clue chain that proves it.`,
};

// ════════════════════════════════════════════════════════════════════════════
// VALIDATION (+ authoritative fixes for odd_one_out / detective)
// ════════════════════════════════════════════════════════════════════════════
function wc(s) { return (s || '').trim().split(/\s+/).filter(Boolean).length; }
function num(s) { const m = String(s).match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; }

function validatePuzzle(type, p) {
  // Common structural checks
  if (!p || typeof p !== 'object') return { ok: false, reason: 'not an object' };
  if (!p.spec || typeof p.spec !== 'object') return { ok: false, reason: 'missing spec' };
  if (!p.question || !String(p.question).trim().endsWith('?')) return { ok: false, reason: 'question missing/!? ' };
  if (!Array.isArray(p.options) || p.options.length < 4) return { ok: false, reason: 'need 4 options' };
  p.options = p.options.slice(0, 4).map(o => String(o));
  if (p.correct == null) return { ok: false, reason: 'missing correct' };
  p.correct = String(p.correct);

  // For most types correct must be in options (detective/odd handled below first)
  const ensureCorrectInOptions = () => {
    const idx = p.options.findIndex(o => o.trim().toLowerCase() === p.correct.trim().toLowerCase());
    if (idx === -1) return false;
    p.correct = p.options[idx];
    return true;
  };

  // hint / explanation soft rules
  if (p.hint && (wc(p.hint) < 2 || wc(p.hint) > 12)) return { ok: false, reason: `hint ${wc(p.hint)}w out of range` };
  if (!p.explanation || wc(p.explanation) <= 12) return { ok: false, reason: 'explanation too short' };
  if (wc(p.question) > 16) return { ok: false, reason: 'question too long' };

  // ── Type-specific ─────────────────────────────────────────────────────
  switch (type) {
    case 'geometry_triangle': {
      const labels = p.spec.labels;
      if (!Array.isArray(labels) || labels.length !== 3) return { ok: false, reason: 'triangle needs 3 labels' };
      const known = labels.filter(l => !l.highlight).map(l => num(l.text)).filter(n => !isNaN(n));
      if (known.length !== 2) return { ok: false, reason: 'triangle needs 2 numeric angles' };
      const missing = 180 - known[0] - known[1];
      if (missing <= 0 || missing >= 180) return { ok: false, reason: 'triangle angles invalid' };
      if (Math.abs(num(p.correct) - missing) > 0.5) return { ok: false, reason: `triangle correct≠${missing}` };
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'geometry_right_triangle': {
      const a = num(p.spec.leg_a), b = num(p.spec.leg_b), h = num(p.spec.hypotenuse);
      const unk = p.spec.unknown;
      let expect;
      if (unk === 'hypotenuse') expect = Math.sqrt(a * a + b * b);
      else if (unk === 'leg_a') expect = Math.sqrt(h * h - b * b);
      else if (unk === 'leg_b') expect = Math.sqrt(h * h - a * a);
      else return { ok: false, reason: 'unknown side not specified' };
      if (!isFinite(expect) || expect <= 0) return { ok: false, reason: 'right-triangle invalid' };
      if (Math.abs(num(p.correct) - expect) > 0.6) return { ok: false, reason: `right-triangle correct≠${expect.toFixed(2)}` };
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'geometry_straight_line': {
      const known = num(p.spec.known_angle);
      const expect = 180 - known;
      if (expect <= 0 || expect >= 180) return { ok: false, reason: 'straight-line invalid' };
      if (Math.abs(num(p.correct) - expect) > 0.5) return { ok: false, reason: `straight-line correct≠${expect}` };
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'visual_math': {
      const eqs = p.spec.equations;
      if (!Array.isArray(eqs) || eqs.length < 2) return { ok: false, reason: 'visual_math needs ≥2 rows' };
      const last = eqs[eqs.length - 1];
      if (String(last.result).trim() !== '?') return { ok: false, reason: 'last row must be "?"' };
      // best-effort solve: rows with a single distinct icon pin its value
      const val = {};
      for (const eq of eqs.slice(0, -1)) {
        const items = eq.items || [];
        const icons = [...new Set(items.map(it => it.icon))];
        if (icons.length === 1) {
          const totalCount = items.reduce((s, it) => s + (Number(it.count) || 0), 0);
          if (totalCount > 0) val[icons[0]] = num(eq.result) / totalCount;
        }
      }
      // try to evaluate "?" row if all icons known
      const lastItems = last.items || [];
      if (lastItems.every(it => val[it.icon] != null)) {
        const total = lastItems.reduce((s, it) => s + (Number(it.count) || 0) * val[it.icon], 0);
        if (Math.abs(num(p.correct) - total) > 0.01) return { ok: false, reason: `visual_math correct≠${total}` };
      }
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'number_sequence': {
      const cells = p.spec.cells;
      if (!Array.isArray(cells) || cells.length < 4) return { ok: false, reason: 'sequence needs ≥4 cells' };
      if (String(cells[cells.length - 1]).trim() !== '?') return { ok: false, reason: 'last cell must be "?"' };
      const nums = cells.slice(0, -1).map(num);
      if (nums.some(isNaN)) return { ok: false, reason: 'non-numeric sequence' };
      const predicted = predictNext(nums);
      if (predicted != null && Math.abs(num(p.correct) - predicted) > 0.01)
        return { ok: false, reason: `sequence correct≠${predicted}` };
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'number_grid': {
      const rows = p.spec.rows;
      if (!Array.isArray(rows) || !rows.length) return { ok: false, reason: 'grid missing rows' };
      const qCount = rows.flat().filter(v => String(v).trim() === '?').length;
      if (qCount !== 1) return { ok: false, reason: 'grid needs exactly one "?"' };
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'matchstick': {
      if (!p.spec.equation || !/^[0-9+\-=]{3,7}$/.test(String(p.spec.equation).replace(/\s+/g, '')))
        return { ok: false, reason: 'matchstick equation invalid' };
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'rebus': {
      if (!Array.isArray(p.spec.tokens) || p.spec.tokens.length < 2) return { ok: false, reason: 'rebus needs tokens' };
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'odd_one_out': {
      const items = p.spec.items;
      if (!Array.isArray(items) || items.length < 6) return { ok: false, reason: 'odd_one_out needs ≥6 items' };
      // authoritatively determine the odd shape by majority vote
      const counts = {};
      items.forEach(it => { counts[it.shape] = (counts[it.shape] || 0) + 1; });
      const shapes = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (shapes.length < 2) return { ok: false, reason: 'no odd shape present' };
      const oddShape = shapes[shapes.length - 1][0];
      if (shapes[shapes.length - 1][1] !== 1) return { ok: false, reason: 'must be exactly one outlier' };
      const oddIdx = items.findIndex(it => it.shape === oddShape);
      // system OWNS correct + options here (removes LLM error)
      p.correct = String(oddIdx + 1);
      const opts = new Set([p.correct]);
      while (opts.size < 4) { const r = 1 + Math.floor(Math.random() * items.length); opts.add(String(r)); }
      p.options = [...opts].sort(() => Math.random() - 0.5).slice(0, 4);
      if (!p.options.includes(p.correct)) p.options[0] = p.correct;
      break;
    }
    case 'detective': {
      const s = p.spec;
      if (!s.case_title || !s.scenario || !Array.isArray(s.suspects) || s.suspects.length !== 4)
        return { ok: false, reason: 'detective needs title/scenario/4 suspects' };
      if (!Array.isArray(s.clues) || s.clues.length < 2) return { ok: false, reason: 'detective needs ≥2 clues' };
      // options MUST be the suspects; correct must be one of them
      p.options = s.suspects.map(String).slice(0, 4);
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'culprit not among suspects' };
      break;
    }
    default:
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
  }
  return { ok: true };
}

// Detect arithmetic / geometric / second-difference-constant sequences.
function predictNext(nums) {
  const n = nums.length;
  if (n < 2) return null;
  const diffs = nums.slice(1).map((v, i) => v - nums[i]);
  if (diffs.every(d => d === diffs[0])) return nums[n - 1] + diffs[0];           // arithmetic
  if (nums.every(v => v !== 0) && nums.slice(1).every((v, i) => v / nums[i] === diffs[0] / 1 ? false : true)) {
    const ratio = nums[1] / nums[0];
    if (nums.slice(1).every((v, i) => Math.abs(v / nums[i] - ratio) < 1e-9)) return nums[n - 1] * ratio; // geometric
  }
  const dd = diffs.slice(1).map((v, i) => v - diffs[i]);
  if (dd.length && dd.every(x => x === dd[0])) {                                  // quadratic (const 2nd diff)
    const nextDiff = diffs[diffs.length - 1] + dd[0];
    return nums[n - 1] + nextDiff;
  }
  return null; // unknown rule → trust the LLM
}

// ════════════════════════════════════════════════════════════════════════════
// AUDIO / DESIGN POOLS (reused tables — same loaders as worker8)
// ════════════════════════════════════════════════════════════════════════════
async function loadAllPools(env, lang, niche) {
  const [hooks, timeup, cta1, cta2, cta3, cta4, qIntro, optsIntro,
    sfxQuestionAppear, sfxOptionsAppear, sfxCountdownLoop, sfxCorrectAnswer, bgMusic, bgAnim] = await Promise.all([
    pickCuePool(env, 'quiz_hooks', lang, niche, true),
    pickCuePool(env, 'timeup_cues', lang, null, false),
    pickCuePool(env, 'cta1_audio_cues', lang, niche, true),
    pickCuePool(env, 'cta2_audio_cues', lang, niche, true),
    pickCuePool(env, 'cta3_audio_cues', lang, null, false),
    pickCta4Pool(env, lang),
    pickCuePool(env, 'question_intro_cues', lang, null, false),
    pickCuePool(env, 'options_intro_cues', lang, null, false),
    pickSfxPool(env, 'question_appear', niche),
    pickSfxPool(env, 'options_appear', niche),
    pickSfxPool(env, 'countdown_loop', niche),
    pickSfxPool(env, 'correct_answer', niche),
    pickBgMusicPool(env, niche),
    pickBgAnimPool(env, niche),
  ]);
  return { hooks, timeup, cta1, cta2, cta3, cta4, qIntro, optsIntro,
    sfxQuestionAppear, sfxOptionsAppear, sfxCountdownLoop, sfxCorrectAnswer, bgMusic, bgAnim };
}
async function pickCuePool(env, table, lang, niche, hasNicheCol) {
  try {
    let rows = await dbGet(env, `${table}?is_active=eq.true&or=(language_code.eq.${lang},language_code.is.null)&limit=50`).catch(() => null);
    if (!rows?.length) rows = await dbGet(env, `${table}?is_active=eq.true&limit=50`).catch(() => null);
    if (!rows?.length) return [];
    if (niche && hasNicheCol) { const nr = rows.filter(r => r.niche === niche || !r.niche); if (nr.length) return nr; }
    return rows;
  } catch { return []; }
}
async function pickSfxPool(env, cueName, niche) {
  try {
    const filter = niche ? `&or=(niche.eq.${encodeURIComponent(niche)},niche.is.null)` : '';
    const rows = await dbGet(env, `sfx_cues?is_active=eq.true&cue_name=eq.${encodeURIComponent(cueName)}${filter}&limit=20`).catch(() => null);
    return rows || [];
  } catch { return []; }
}
async function pickBgMusicPool(env, niche) {
  try {
    const filter = niche ? `&or=(niche.eq.${encodeURIComponent(niche)},niche.is.null)` : '';
    const rows = await dbGet(env, `background_music_tracks?is_active=eq.true${filter}&order=usage_count.asc&limit=20`).catch(() => null);
    return rows || [];
  } catch { return []; }
}
async function pickBgAnimPool(env, niche) {
  try {
    const filter = niche ? `or=(niche.eq.${encodeURIComponent(niche)},niche.eq.general,niche.is.null)` : 'niche.eq.general';
    let rows = await dbGet(env, `background_animation?is_active=eq.true&${filter}&limit=20`).catch(() => null);
    if (rows?.length) return rows;
    rows = await dbGet(env, `background_animation?is_active=eq.true&limit=20`).catch(() => null);
    return rows || [];
  } catch { return []; }
}
async function pickCta4Pool(env, lang) {
  try {
    let rows = await dbGet(env, `cta4_cues?is_active=eq.true&or=(lang_code.eq.${encodeURIComponent(lang)},lang_code.is.null)&order=usage_count.asc&limit=20`).catch(() => null);
    if (rows?.length) return rows;
    rows = await dbGet(env, `cta4_cues?is_active=eq.true&order=usage_count.asc&limit=20`).catch(() => null);
    return rows || [];
  } catch { return []; }
}

async function bumpUsage(env, map) {
  const proms = [];
  for (const [table, row] of Object.entries(map)) {
    if (!row?.id) continue;
    proms.push(dbPatch(env, table, row.id, {
      usage_count: (row.usage_count || 0) + 1, last_used_at: new Date().toISOString()
    }).catch(() => {}));
  }
  await Promise.all(proms);
}

// ── repository_dispatch → puzzle render workflow ────────────────────────────
async function fireRenderDispatch(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) { console.log('[PGEN] No GITHUB_TOKEN/REPO — skipping dispatch.'); return; }
  try {
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'JaasX-PuzzleGen',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'trigger-puzzle-render' }),
    });
    console.log(`[PGEN] repository_dispatch trigger-puzzle-render → ${res.status}`);
  } catch (e) { console.warn(`[PGEN] dispatch failed: ${e.message}`); }
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════
function randomPick(a) { return a?.length ? a[Math.floor(Math.random() * a.length)] : null; }
function pickAccents() {
  const P = ['#00cfff','#00ff88','#c9a227','#ff2d78','#007aff','#ff1c44','#a78bfa','#cc0000','#ff00ff','#ff6b00'];
  const S = ['#0080ff','#ff3c00','#e8c84a','#bf00ff','#5ac8fa','#ffcc00','#60a5fa','#ff4444','#00ffff','#ffd700'];
  const T = ['#a0f0ff','#ffdd00','#f5e17a','#ff9d00','#34c759','#1a8cff','#f472b6','#ffffff','#ffff00','#00e676'];
  return [randomPick(P), randomPick(S), randomPick(T)];
}
function normaliseKeep5050(raw, options, correct) {
  const correctIdx = options.findIndex(o => o?.trim().toLowerCase() === correct?.trim().toLowerCase());
  let keep = Array.isArray(raw) ? raw.map(v => parseInt(v, 10)).filter(n => !isNaN(n) && n >= 0 && n <= 3) : [];
  if (correctIdx >= 0 && !keep.includes(correctIdx)) keep = [correctIdx];
  keep = [...new Set(keep)];
  if (keep.length < 2) for (let i = 0; i < 4; i++) if (!keep.includes(i)) { keep.push(i); break; }
  if (keep.length > 2) keep = keep.slice(0, 2);
  return keep.map(String);
}
function buildIntroSpeech(name) {
  const t = [`Today's brain teaser: ${name}. Can you crack it?`, `Here's a ${name} to test your mind. Ready?`,
    `Think you're smart? Try this ${name}!`, `Most people fail this ${name}. Can you solve it?`];
  return t[Math.floor(Math.random() * t.length)];
}
function buildSfxJson(m) { try { return JSON.stringify(m); } catch { return null; } }
function makeSlug(t) { return (t || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function parseJsonArray(text) {
  let s = String(text).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const m = s.match(/\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  try { const one = JSON.parse(s); return Array.isArray(one) ? one : [one]; } catch {}
  return null;
}

// ── Supabase REST ───────────────────────────────────────────────────────────
function sbHeaders(env) {
  return { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
}
async function dbGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  const txt = await res.text(); return txt.trim() ? JSON.parse(txt) : [];
}
async function dbPatch(env, table, id, data) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: { ...sbHeaders(env), Prefer: 'return=minimal' }, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`PATCH ${table}/${id} → ${res.status}: ${await res.text()}`);
}
async function dbInsert(env, table, data) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}`, {
    method: 'POST', headers: { ...sbHeaders(env), Prefer: 'return=representation' }, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`INSERT ${table} → ${res.status}: ${await res.text()}`);
  const txt = await res.text(); return txt.trim() ? JSON.parse(txt) : null;
}
async function dbRpc(env, fn, params = {}) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: sbHeaders(env), body: JSON.stringify(params) });
  if (!res.ok) throw new Error(`RPC ${fn} → ${res.status}: ${await res.text()}`);
  const txt = await res.text(); return txt.trim() ? JSON.parse(txt) : null;
}
