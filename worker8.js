/**
 * worker8.js — Quiz Generation Worker (Cloudflare Worker)
 *
 * PER JOB: reads 1 pending quiz_queue row → Groq LLM → 2–3 quiz rows in quiz table.
 *
 * RULES (v3):
 *  - question_1:           <= 15 words (short, instantly readable on screen —
 *                          viewers have ~10s and will skip long text)
 *  - options_1 (each):     no length limit (not read aloud, readability of
 *                          the question itself is the actual constraint)
 *  - hint_1:               2–10 words (target 4–8, ±2 tolerance)
 *  - explanation_1:        > 15 words (target >20, -5 tolerance)
 *  - Mission Impossible:   question <= 15 words (same reasoning); mandatory
 *                          for every question — a question is REJECTED
 *                          entirely if MI question/options/correct/hint/
 *                          explanation/trigger_line are missing or invalid.
 *                          Stored with full options/correct/explanation/
 *                          keep_5050 for downstream quiz generation.
 *  - quiz_background_css:  fetched from background_animation table (niche-matched)
 *  - Generates ≥2 questions per job (no upper cap); questions unique per job
 *
 * SUBREQUEST BUDGET (Cloudflare free plan: 50 limit):
 *   All cue POOLS + bg_anim pool fetched ONCE before the loop (~26 fetches).
 *   bumpUsage batched to one PATCH per table at end (~8 fetches).
 *   3 × dbInsert + 5 fixed (poll/mark/groq/affiliate/complete) = ~42 total.
 */

const QUESTIONS_MIN = 1; // default fallback — overridden by quiz_generation_settings.min_valid_questions

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/generate-quiz') {
      await processQuizQueue(env);
      return new Response('OK', { status: 200 });
    }
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processQuizQueue(env));
  }
};

// ================================================================
// MAIN JOB PROCESSOR
// ================================================================
async function processQuizQueue(env) {
  console.log('[W8] Checking pending quiz_generation jobs...');

  const nowIso = new Date().toISOString();

  // 1) Fresh pending jobs first (highest priority wins, as before).
  let jobs = await dbGet(env,
    'quiz_queue?job_type=eq.quiz_generation&status=eq.pending&order=priority.desc,created_at.asc&limit=1'
  );

  // 2) BUG FIX: previously, once a job failed it was set to status='failed'
  // and NEVER looked at again -- retry_count/max_retries/next_retry_at
  // existed in the schema (and quiz_queue even has a matching index,
  // idx_queue_retry) but nothing ever queried them. A topic that failed
  // quiz generation once (transient LLM/network error, temporary rate
  // limit, etc.) was permanently lost even though the underlying trend
  // data (searched_text, tavily_sources/images) was still perfectly
  // usable. Now: if no pending job is waiting, look for a failed job
  // that hasn't exhausted its retries and whose backoff window has
  // elapsed, and give it another attempt.
  if (!jobs?.length) {
    jobs = await dbGet(env,
      `quiz_queue?job_type=eq.quiz_generation&status=eq.failed` +
      `&retry_count=lt.10` +                         // coarse pre-filter; exact check below
      `&or=(next_retry_at.is.null,next_retry_at.lte.${encodeURIComponent(nowIso)})` +
      `&order=priority.desc,created_at.asc&limit=1`
    );
    // Exact per-row max_retries check (PostgREST can't compare two columns
    // of the same row in a filter, so retry_count=lt.10 above is just a
    // safety net -- this is the real gate).
    if (jobs?.length && jobs[0].retry_count >= (jobs[0].max_retries || 3)) {
      console.log(`[W8] Job ${jobs[0].id} has exhausted retries (${jobs[0].retry_count}/${jobs[0].max_retries || 3}) -- not retrying.`);
      jobs = [];
    }
    if (jobs?.length) {
      console.log(`[W8] No pending jobs -- retrying failed job ${jobs[0].id} (attempt ${(jobs[0].retry_count || 0) + 1}/${jobs[0].max_retries || 3}): "${jobs[0].trnding_topic}"`);
    }
  }

  if (!jobs?.length) { console.log('[W8] No pending or retryable jobs.'); return; }

  const job = jobs[0];
  console.log(`[W8] Job ${job.id}: "${job.trnding_topic}" niche=${job.niche}`);

  await dbPatch(env, 'quiz_queue', job.id, {
    status: 'processing',
    started_at: new Date().toISOString()
  });

  try {
    const lang         = job.lang_code     || 'en';
    const countryCode  = job.country_code  || 'US';
    const niche        = (job.niche || 'general').toLowerCase();
    const topic        = job.trnding_topic || '';
    const trendKeywords = job.trend_keywords || '';
    const channelName  = job.channel_name  || 'USA Trending Challenge';
    const baseSlug = makeSlug(topic);

    // ── 1. Fetch affiliate link ──────────────────────────────────────────
    let affiliateUrl = null;
    const affRows = await dbGet(env,
      `affiliate_links?topic_slug=eq.${encodeURIComponent(baseSlug)}&is_active=eq.true&limit=1`
    ).catch(() => null);
    if (affRows?.length) affiliateUrl = affRows[0].affiliate_url;
    console.log(`[W8] Affiliate: ${affiliateUrl || 'none'}`);

    // ── 2. Generate 2–3 questions via Groq ──────────────────────────────
    const { questions: allQ, model: groqModel, limits } = await generateQuestionsWithGroq(job, env);
    console.log(`[W8] LLM returned ${allQ.length} questions (model: ${groqModel})`);

    // Validate each question against word-count rules from settings table
    const validQ = allQ.filter(q => validateQuestion(q, limits));
    const minValid = limits.min_valid_questions || QUESTIONS_MIN;
    if (validQ.length < minValid) {
      throw new Error(
        `Need at least ${minValid} valid questions, got ${validQ.length}. Failing job.`
      );
    }
    const finalQ = validQ;
    console.log(`[W8] Using ${finalQ.length} validated questions (min_required=${minValid}).`);

    // ── 3. POOL FETCH — load all cue tables + bg_anim ONCE ──────────────
    console.log('[W8] Loading audio cue pools + background_animation pool...');
    const pools = await loadAllPools(env, lang, niche);

    // ── Generate quiz_no prefix: YYMMDD based on today's UTC date ─────────
    const nowDate  = new Date();
    const yy       = String(nowDate.getUTCFullYear()).slice(-2);  // e.g. "26"
    const mm       = String(nowDate.getUTCMonth() + 1).padStart(2, '0');
    const dd       = String(nowDate.getUTCDate()).padStart(2, '0');
    const datePrefix = `${yy}${mm}${dd}`;  // e.g. "260627"

    // Count how many quiz rows already exist today to get serial number
    let todayCount = 0;
    try {
      const today     = `${nowDate.getUTCFullYear()}-${mm}-${dd}`;
      const countRows = await dbGet(env,
        `quiz?created_at=gte.${today}T00%3A00%3A00Z&select=id`
      ).catch(() => null);
      todayCount = countRows?.length || 0;
    } catch {}
    console.log(`[W8] quiz_no prefix=${datePrefix} todayCount=${todayCount}`);

    // ── Count existing quizzes per niche for niche_challenge_no ──────────
    // This gives each niche its own incrementing challenge number independent
    // of date or other niches. e.g. sports gets #1,#2,#3... and tech gets #1,#2...
    let nicheCount = 0;
    try {
      const nicheRows = await dbGet(env,
        `quiz?niche=eq.${encodeURIComponent(niche)}&select=id&limit=5000`
      ).catch(() => null);
      nicheCount = nicheRows?.length || 0;
    } catch {}
    console.log(`[W8] niche=${niche} nicheCount=${nicheCount}`);

    // ── 4. For each question: pick from pools, build row ─────────────────
    const now = nowDate.toISOString();
    const bumpCounts = {};
    const rowsToInsert = [];

    for (let idx = 0; idx < finalQ.length; idx++) {
      const q = finalQ[idx];
      const variantSlug = `${baseSlug}-q${idx + 1}`;
      // Serial = existing today + 1-based index for this batch (e.g. 0001, 0002...)
      const serial  = String(todayCount + idx + 1).padStart(4, '0');
      const quizNo  = Number(`${datePrefix}${serial}`); // e.g. 2606270005
      // niche_challenge_no: per-niche counter, 1-based, used in marquee/thumbnail
      const nicheChallengeNo = nicheCount + idx + 1;

      // Pick audio cues from pre-loaded pools (zero extra fetches)
      const hook       = randomPick(pools.hooks);
      const timeup     = randomPick(pools.timeup);
      const cta1       = randomPick(pools.cta1);
      const cta2       = randomPick(pools.cta2);
      const cta3       = randomPick(pools.cta3);
      const cta4       = randomPick(pools.cta4);
      const qIntro     = randomPick(pools.qIntro);
      const optsIntro  = randomPick(pools.optsIntro);
      const hasMission = !!(q.mission_impossible_question);
      const missionCue = hasMission ? randomPick(pools.mission) : null;
      const sfxQApp    = randomPick(pools.sfxQuestionAppear);
      const sfxOApp    = randomPick(pools.sfxOptionsAppear);
      const sfxCdown   = randomPick(pools.sfxCountdownLoop);
      const sfxCorrect = randomPick(pools.sfxCorrectAnswer);
      const bgMusic    = randomPick(pools.bgMusic);
      const bgAnim     = randomPick(pools.bgAnim);      // ← background animation CSS

      // Collect bumps (batched at end, only for tables WITH last_used_at)
      collectBump(bumpCounts, 'quiz_hooks',              hook);
      collectBump(bumpCounts, 'timeup_cues',             timeup);
      collectBump(bumpCounts, 'cta1_audio_cues',         cta1);
      collectBump(bumpCounts, 'cta2_audio_cues',         cta2);
      collectBump(bumpCounts, 'cta3_audio_cues',         cta3);
      // cta4_cues has NO last_used_at — collectBump increments usage_count only
      if (cta4?.id) {
        const key = `cta4_cues:${cta4.id}`;
        if (!bumpCounts[key]) bumpCounts[key] = { table:'cta4_cues', id:cta4.id, newCount:(cta4.usage_count||0) };
        bumpCounts[key].newCount += 1;
      }
      collectBump(bumpCounts, 'question_intro_cues',     qIntro);
      collectBump(bumpCounts, 'options_intro_cues',      optsIntro);
      if (hasMission) collectBump(bumpCounts, 'mission_impossible_cues', missionCue);
      // background_music_tracks: no last_used_at — bump usage_count directly
      if (bgMusic?.id) {
        const key = `background_music_tracks:${bgMusic.id}`;
        if (!bumpCounts[key]) bumpCounts[key] = { table:'background_music_tracks', id:bgMusic.id, newCount:(bgMusic.usage_count||0) };
        bumpCounts[key].newCount += 1;
      }
      // background_animation has no last_used_at → no bump

      // ── Mission Impossible: full quiz fields ──────────────────────────
      // mi_options, mi_correct, mi_explanation, mi_keep_5050 are now stored
      // as dedicated columns so the downstream pipeline can spawn a quiz row.
      const miOptions       = hasMission ? (q.mission_impossible_options || null)       : null;
      const miCorrect       = hasMission ? (q.mission_impossible_correct || null)       : null;
      const miExplanation   = hasMission ? (q.mission_impossible_explanation || null)   : null;
      const miKeep5050Raw   = hasMission ? (q.mission_impossible_keep_5050 || null)     : null;
      const miKeep5050Norm  = (hasMission && Array.isArray(miOptions) && miCorrect)
        ? normaliseKeep5050(miKeep5050Raw, miOptions, miCorrect)
        : null;

      rowsToInsert.push({
        slug: variantSlug,
        row: {
          // Identity
          topic, topic_slug: variantSlug, niche,
          source_type: 'trending', lang_code: lang, country_code: countryCode,
          channel_name: channelName,
          is_active: true, is_human_approved: true,
          quiz_enriched: true, video_status: 'pending',
          blog_linked: false, created_at: now, updated_at: now,

          // Quiz number: YYMMDD + 4-digit serial (e.g. 2606270005)
          quiz_no: quizNo,

          // Per-niche challenge number: each niche has its own counter starting at 1.
          // Used in marquee ("Sports Challenge No #18") and thumbnail.
          niche_challenge_no: nicheChallengeNo,

          // YouTube title — LLM-generated per question: SEO-optimised, click-triggering,
          // unique per row. Used as: YouTube upload title + thumbnail headline.
          // Falls back to topic name if LLM didn't generate one.
          youtube_title: q.youtube_title?.trim() || topic,

          // Wikipedia thumbnail image URL — blurred background on the video thumbnail.
          // Fetched by fetch_trends.py at queue time. CC-licensed, free, no copyright risk.
          // null means the animated CSS background is used instead (graceful fallback).
          topic_image_url: job.topic_image_url || null,

          // SEO / YouTube tags — related search keywords from Google Trends breakdown
          // Used downstream for: YouTube video tags, blog meta keywords,
          // video description, quiz prompt enrichment
          trend_keywords: trendKeywords || null,

          // Timing
          thinking_time_sec: job.thinking_time_sec || 10,
          question_appearance_text: 'Here Is Your Challenge — Solve It',
          quiz_intro_speech: buildIntroSpeech(topic, niche),

          // Question (one per row — ≤10 words, options ≤6 words each)
          question_1:       q.question,
          options_1:        q.options.slice(0, 4),
          correct_answer_1: q.correct,
          explanation_1:    q.explanation || '',          // >20 words enforced in prompt
          hint_1:           q.hint || '',                 // 4–8 words enforced in prompt
          keep_5050_1:      normaliseKeep5050(q.keep_5050, q.options, q.correct),

          // Mission Impossible — standard fields (question/hint/trigger)
          mission_impossible_enabled:      hasMission,
          mission_impossible_question:     q.mission_impossible_question     || null,
          mission_impossible_hint:         q.mission_impossible_hint         || null,
          mission_impossible_trigger_line: q.mission_impossible_trigger_line || null,
          mission_intro_text:      hasMission ? (missionCue?.intro_text || null) : null,
          mission_intro_audio_url: hasMission ? (missionCue?.audio_url  || null) : null,

          // Mission Impossible — full-quiz columns (for downstream quiz spawning)
          mission_options_1:        miOptions   ? miOptions.slice(0, 4) : null,
          mission_correct_answer_1: miCorrect   || null,
          mission_explanation_1:    miExplanation || null,
          mission_keep_5050_1:      miKeep5050Norm || null,

          // Hook
          hook_phrase:    hook?.hook_text  || null,
          hook_audio_url: hook?.audio_url  || null,

          // Timeup
          timeup_text:      timeup?.lead_in_text || null,
          timeup_audio_url: timeup?.audio_url    || null,

          // Question + options intro
          question_intro_audio_url: qIntro?.audio_url    || null,
          options_intro_audio_url:  optsIntro?.audio_url || null,

          // SFX (JSON for worker10 to extract via extractUrl)
          sfx_audio_url: buildSfxJson({
            question_appear: sfxQApp?.audio_url   || null,
            options_appear:  sfxOApp?.audio_url   || null,
            countdown_loop:  sfxCdown?.audio_url  || null,
          }),

          // Dedicated audio columns (plain URLs)
          countdown_music:              sfxCdown?.audio_url   || null,
          correct_answer_sfx_audio_url: sfxCorrect?.audio_url || null,
          background_music:             bgMusic?.audio_url    || null,

          // Background animation CSS — niche-matched
          quiz_background_css: bgAnim?.background_css || null,

          // CTA1 (affiliate)
          cta1_description_text: cta1?.cta_text  || null,
          cta1_audio_url:        cta1?.audio_url  || null,
          cta1_affiliate_url:    affiliateUrl     || null,
          affiliate_url:         affiliateUrl     || null,
          affiliate_text:        cta1?.cta_text   || null,

          // CTA2 (ONS challenge)
          cta2_text:      cta2?.cta_text  || null,
          cta2_audio_url: cta2?.audio_url || null,

          // CTA3 (like/share/subscribe)
          cta3_text:      cta3?.cta_text  || null,
          cta3_audio_url: cta3?.audio_url || null,

          cta4_text:      cta4?.cue_text  || 'Write your answer in the comments below!',
          cta4_audio_url: cta4?.audio_url || null,

          // Blog
          blog_page_url: `jaasblog.online/quiz/${niche}`,
          blog_slug:     variantSlug,

          // ── DESIGN ENGINE: 4 independent dimensions ──────────────────────
          // 10 themes × 8 layouts × 6 countdowns × 6 transitions = 2,880 combos
          visual_theme_id: randomPick([
            'glass','gaming','luxury','cyberpunk','minimal',
            'comic','space','news','neon','retro'
          ]),
          layout_variant: randomPick([
            'standard','bold','compact','cinematic',
            'split','card','overlay','spotlight'
          ]),
          countdown_style: randomPick([
            'ring','bar','digital','bomb','hourglass','pulse'
          ]),
          transition_style: randomPick([
            'fade','slide_up','zoom_in','flip','blur_in','bounce'
          ]),
          // Accent colours — driven by theme, but also stored for thumbnail use
          theme_accent_primary:   randomPick(['#00cfff','#00ff88','#c9a227','#ff2d78','#007aff','#ff1c44','#a78bfa','#cc0000','#ff00ff','#ff6b00']),
          theme_accent_secondary: randomPick(['#0080ff','#ff3c00','#e8c84a','#bf00ff','#5ac8fa','#ffcc00','#60a5fa','#ff4444','#00ffff','#ffd700']),
          theme_accent_tertiary:  randomPick(['#a0f0ff','#ffdd00','#f5e17a','#ff9d00','#34c759','#1a8cff','#f472b6','#ffffff','#ffff00','#00e676']),
          // ─────────────────────────────────────────────────────────────────

          // LLM
          llm_provider: 'vercel-ai-gateway',
          llm_model:    groqModel,
        }
      });
    }

    // ── 5. Insert rows (2–3 fetches) ─────────────────────────────────────
    let inserted = 0;
    const insertedSlugs = [];

    for (const { slug, row } of rowsToInsert) {
      try {
        await dbInsert(env, 'quiz', row);
        console.log(`[W8] Inserted: ${slug}`);
        inserted++;
        insertedSlugs.push(slug);
      } catch (err) {
        if (err.message.includes('23505') || err.message.includes('unique')) {
          console.warn(`[W8] Slug collision: ${slug}, skipping.`);
        } else {
          throw err;
        }
      }
    }

    // ── 6. Batch bump usage counts — ONE PATCH per table ─────────────────
    // Only tables WITH last_used_at. NOT: sfx_cues, background_music_tracks,
    // background_animation (no last_used_at column).
    const bumpPromises = Object.values(bumpCounts).map(({ table, id, newCount }) =>
      dbPatch(env, table, id, {
        usage_count:  newCount,
        last_used_at: new Date().toISOString()
      }).catch(() => {})
    );
    await Promise.all(bumpPromises);
    console.log(`[W8] Bumped usage on ${bumpPromises.length} cue rows.`);

    // ── 7. Mark job complete ─────────────────────────────────────────────
    // BUG FIX: this used to be `payload: JSON.stringify({...})`. Two bugs:
    //   1. It REPLACED the whole payload column, destroying the
    //      tavily_sources/tavily_images/tavily_score/trend_breakdown that
    //      fetch_trends.py wrote when the row was first queued — which is
    //      exactly why Worker 12 always saw `payload.tavily_images = []`.
    //   2. dbPatch() already JSON.stringifies the whole `data` object before
    //      sending it — wrapping payload in its own JSON.stringify() here
    //      double-encoded it, so Postgres stored it as a quoted JSON *string*
    //      scalar instead of a jsonb object.
    // Fix: merge onto the EXISTING job.payload (spread first) and pass a
    // plain object, not a pre-stringified one.
    await dbPatch(env, 'quiz_queue', job.id, {
      status:       'completed',
      completed_at: new Date().toISOString(),
      payload:      { ...(job.payload || {}), questions_created: inserted, base_slug: baseSlug, slugs: insertedSlugs }
    });
    console.log(`[W8] Job ${job.id} done. Inserted ${inserted} rows.`);

  } catch (err) {
    console.error(`[W8] Job ${job.id} FAILED:`, err.message);
    const newRetryCount = (job.retry_count || 0) + 1;
    const maxRetries    = job.max_retries || 3;
    // BUG FIX: this used to just set status='failed' and stop -- the row
    // was never picked up again by anything, even though retry_count/
    // max_retries/next_retry_at exist specifically for this. Now: as long
    // as retries remain, schedule the next attempt with exponential backoff
    // (10m, 20m, 40m...) via next_retry_at. The polling query above picks
    // these back up automatically once that window elapses. Status stays
    // 'failed' either way (matches the existing idx_queue_retry index,
    // which is defined as `where status = 'failed' and retry_count < max_retries`)
    // -- retryability is determined by retry_count vs max_retries, not by status.
    const backoffMinutes = Math.min(5 * Math.pow(2, newRetryCount), 360); // 10, 20, 40, 80... capped at 6h
    const nextRetryAt = newRetryCount < maxRetries
      ? new Date(Date.now() + backoffMinutes * 60000).toISOString()
      : null; // retries exhausted -- next_retry_at stays null, query above will skip it for good

    await dbPatch(env, 'quiz_queue', job.id, {
      status:         'failed',
      last_error:     err.message,
      retry_count:    newRetryCount,
      next_retry_at:  nextRetryAt,
      started_at:     null,   // clear so it doesn't look like a stuck "processing" job
    }).catch(() => {});

    if (nextRetryAt) {
      console.log(`[W8] Job ${job.id} will retry (attempt ${newRetryCount}/${maxRetries}) after ${nextRetryAt}`);
    } else {
      console.log(`[W8] Job ${job.id} permanently failed after ${newRetryCount} attempts (max_retries=${maxRetries}).`);
    }
  }
}

// ================================================================
// QUESTION VALIDATION — tolerance-based, reject-only (no truncation/padding)
// ================================================================
function wordCount(str) {
  return (str || '').trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Validates a Groq question object against relaxed word-count tolerances.
 *
 * HARD rejects (structurally unusable):
 *   - missing question / options array with <4 entries / missing correct
 *   - correct answer string not found in options
 *
 * SOFT rejects (word-count tolerance exceeded — question dropped, others kept):
 *   - question         > 12 words  (target ≤10, +2 tolerance)
 *   - any option       > 7 words   (target ≤6,  +1 tolerance)
 *   - hint             < 2 or > 10 words (target 4–8, ±2 tolerance)
 *   - explanation      ≤ 15 words  (target >20, -5 tolerance)
 *
 * Mission Impossible fields follow the same tolerances.
 * If MI fails, MI is nullified but the main question is still kept.
 *
 * No data is modified — questions are accepted or rejected as-is.
 */
function validateQuestion(q, limits = {}) {
  const {
    question_max_words       = 15,
    hint_min_words           = 2,
    hint_max_words           = 10,
    explanation_min_words    = 15,
    mi_question_max_words    = 15,
    mi_hint_min_words        = 2,
    mi_hint_max_words        = 10,
    mi_explanation_min_words = 15,
    title_min_words          = 5,
    title_max_words          = 12,
  } = limits;

  // ── Hard structural checks ──────────────────────────────────────────────
  if (!q.question || typeof q.question !== 'string') {
    console.warn('[W8] REJECT: missing question text');
    return false;
  }
  if (!Array.isArray(q.options) || q.options.length < 4) {
    console.warn('[W8] REJECT: need 4 options, got ' + (q.options?.length ?? 0) + ' for: "' + q.question + '"');
    return false;
  }
  if (!q.correct) {
    console.warn('[W8] REJECT: missing correct answer for: "' + q.question + '"');
    return false;
  }
  const correctLower = q.correct.trim().toLowerCase();
  const matchIdx = q.options.findIndex(o => (o || '').trim().toLowerCase() === correctLower);
  if (matchIdx === -1) {
    console.warn('[W8] REJECT: correct "' + q.correct + '" not found in options for: "' + q.question + '"');
    return false;
  }
  q.correct = q.options[matchIdx]; // normalise casing to match option exactly

  // ── Quality checks — catch lazy/malformed Groq output ──────────────────
  // Must end with "?" — single-word non-questions like "Bag growth" fail this
  if (!q.question.trim().endsWith('?')) {
    console.warn('[W8] REJECT: not a proper question (no "?"): "' + q.question + '"');
    return false;
  }
  // Must have at least 4 words — filters out "Bag growth", "AI topic" etc.
  if (wordCount(q.question) < 4) {
    console.warn('[W8] REJECT: question too short (< 4 words): "' + q.question + '"');
    return false;
  }
  // Hint must not directly contain the correct answer text (gives it away)
  if (q.hint && q.correct && q.hint.toLowerCase().includes(q.correct.toLowerCase())) {
    console.warn('[W8] REJECT: hint contains the correct answer: "' + q.hint + '"');
    return false;
  }
  // Hint must not be a bare search-growth stat (e.g. "Search growth 7,000%")
  if (q.hint && /search\s+growth/i.test(q.hint)) {
    console.warn('[W8] REJECT: hint reveals search growth directly: "' + q.hint + '"');
    return false;
  }
  // Question must not use vague context-dependent references that assume prior reading
  // e.g. "the formula", "the recall", "some families", "the act", "the agency"
  const vaguePatterns = [
    /^(what|where|why|who|which|how)\s+(formula|recall|agency|act|families|company|brand|product|policy|law|decision|case|incident|event)\b/i,
    /\bthe\s+(recalled|formula|act|agency|subsidies|families|incident|case)\b/i,
    /\bsome\s+(families|people|companies|workers)\b/i
  ];
  for (const pat of vaguePatterns) {
    if (pat.test(q.question.trim())) {
      console.warn('[W8] REJECT: question has vague context-dependent reference: "' + q.question + '"');
      return false;
    }
  }

  // ── Soft word-count checks (tolerance-based) ────────────────────────────
  // question must stay short — a 25+ word question made the on-screen text
  // unreadably dense/cluttered for a viewer with ~10s to read it. Options
  // remain uncapped (not the reported problem, and not read aloud via TTS).
  const qw = wordCount(q.question);
  if (qw > question_max_words) {
    console.warn(`[W8] REJECT: question ${qw}w > ${question_max_words}w limit: "${q.question}"`);
    return false;
  }

  // youtube_title word count (soft — truncate/pad rather than reject entire question)
  if (q.youtube_title) {
    const tw = wordCount(q.youtube_title);
    if (tw < title_min_words || tw > title_max_words) {
      console.warn(`[W8] WARN: youtube_title ${tw}w outside ${title_min_words}–${title_max_words}w range: "${q.youtube_title}" — keeping question but flagging`);
      // Don't reject — title issues are minor; question is still usable
    }
  }

  const hw = wordCount(q.hint);
  if (hw < hint_min_words || hw > hint_max_words) {
    console.warn(`[W8] REJECT: hint ${hw}w out of ${hint_min_words}–${hint_max_words}w range: "${q.hint}"`);
    return false;
  }

  const ew = wordCount(q.explanation);
  if (ew <= explanation_min_words) {
    console.warn(`[W8] REJECT: explanation ${ew}w ≤ ${explanation_min_words}w min: "${q.explanation}"`);
    return false;
  }

  // ── Mission Impossible validation — NOW MANDATORY ───────────────────────
  // Per requirement: a question without complete, valid Mission Impossible
  // data must NOT be generated at all. Previously MI failures only nullified
  // the MI fields while keeping the main question; now any MI failure
  // rejects the entire question.
  if (!q.mission_impossible_question || !q.mission_impossible_question.trim()) {
    console.warn('[W8] REJECT: missing mission_impossible_question (MI is mandatory): "' + q.question + '"');
    return false;
  }

  const miOpts    = q.mission_impossible_options;
  const miCorrect = q.mission_impossible_correct;

  if (!Array.isArray(miOpts) || miOpts.length < 4 || !miCorrect) {
    console.warn('[W8] REJECT: MI missing options or correct answer (MI is mandatory): "' + q.question + '"');
    return false;
  }

  const miIdx = miOpts.findIndex(o => (o || '').trim().toLowerCase() === miCorrect.trim().toLowerCase());
  if (miIdx === -1) {
    console.warn('[W8] REJECT: MI correct answer not found in MI options (MI is mandatory): "' + q.question + '"');
    return false;
  }
  q.mission_impossible_correct = miOpts[miIdx]; // normalise casing

  if (!q.mission_impossible_trigger_line || !q.mission_impossible_trigger_line.trim()) {
    console.warn('[W8] REJECT: missing mission_impossible_trigger_line (MI is mandatory): "' + q.question + '"');
    return false;
  }

  // MI question must stay short — same readability reasoning as the main question.
  const miqw = wordCount(q.mission_impossible_question);
  if (miqw > mi_question_max_words) {
    console.warn(`[W8] REJECT: MI question ${miqw}w > ${mi_question_max_words}w limit: "${q.mission_impossible_question}"`);
    return false;
  }

  const mihw = wordCount(q.mission_impossible_hint);
  if (mihw < mi_hint_min_words || mihw > mi_hint_max_words) {
    console.warn(`[W8] REJECT: MI hint ${mihw}w out of ${mi_hint_min_words}–${mi_hint_max_words}w range: "${q.mission_impossible_hint}"`);
    return false;
  }

  if (wordCount(q.mission_impossible_explanation) <= mi_explanation_min_words) {
    console.warn(`[W8] REJECT: MI explanation ≤ ${mi_explanation_min_words}w: "${q.question}"`);
    return false;
  }

  return true;
}
// ================================================================
// POOL LOADER — fetches all cue tables + background_animation ONCE
// ================================================================
async function loadAllPools(env, lang, niche) {
  const [
    hooks, timeup, cta1, cta2, cta3, cta4, qIntro, optsIntro, mission,
    sfxQuestionAppear, sfxOptionsAppear, sfxCountdownLoop, sfxCorrectAnswer,
    bgMusic, bgAnim
  ] = await Promise.all([
    pickCuePool(env, 'quiz_hooks',              lang, niche, true),
    pickCuePool(env, 'timeup_cues',             lang, null,  false),
    pickCuePool(env, 'cta1_audio_cues',         lang, niche, true),
    pickCuePool(env, 'cta2_audio_cues',         lang, niche, true),
    pickCuePool(env, 'cta3_audio_cues',         lang, null,  false),
    pickCta4Pool(env, lang),
    pickCuePool(env, 'question_intro_cues',     lang, null,  false),
    pickCuePool(env, 'options_intro_cues',      lang, null,  false),
    pickCuePool(env, 'mission_impossible_cues', lang, null,  false),
    pickSfxPool(env, 'question_appear', niche),
    pickSfxPool(env, 'options_appear',  niche),
    pickSfxPool(env, 'countdown_loop',  niche),
    pickSfxPool(env, 'correct_answer',  niche),
    pickBgMusicPool(env, niche),
    pickBgAnimPool(env, niche),
  ]);

  console.log(
    `[W8] Pools: hooks=${hooks.length} timeup=${timeup.length} cta4=${cta4.length} ` +
    `sfxQApp=${sfxQuestionAppear.length} bg=${bgMusic.length} bgAnim=${bgAnim.length}`
  );
  return {
    hooks, timeup, cta1, cta2, cta3, cta4, qIntro, optsIntro, mission,
    sfxQuestionAppear, sfxOptionsAppear, sfxCountdownLoop, sfxCorrectAnswer,
    bgMusic, bgAnim
  };
}

async function pickCuePool(env, table, lang, niche, hasNicheCol) {
  try {
    // Single query with OR fallback baked into Postgres-side language filter,
    // instead of 2 sequential round-trips (lang-specific, then any-lang).
    // PostgREST supports or=() for this.
    let rows = await dbGet(env,
      `${table}?is_active=eq.true&or=(language_code.eq.${lang},language_code.is.null)&limit=50`
    ).catch(() => null);
    if (!rows?.length) {
      // Only one fallback left: ignore language filter entirely (rare path)
      rows = await dbGet(env, `${table}?is_active=eq.true&limit=50`).catch(() => null);
    }
    if (!rows?.length) return [];
    if (niche && hasNicheCol) {
      const nicheRows = rows.filter(r => r.niche === niche || !r.niche);
      if (nicheRows.length) return nicheRows;
    }
    return rows;
  } catch {
    return [];
  }
}

async function pickSfxPool(env, cueName, niche) {
  try {
    // Single query: niche match OR null niche, instead of 2 sequential round-trips.
    const filter = niche
      ? `or=(niche.eq.${encodeURIComponent(niche)},niche.is.null)`
      : '';
    const rows = await dbGet(env,
      `sfx_cues?is_active=eq.true&cue_name=eq.${encodeURIComponent(cueName)}${filter ? '&' + filter : ''}&limit=20`
    ).catch(() => null);
    return rows || [];
  } catch {
    return [];
  }
}

async function pickBgMusicPool(env, niche) {
  try {
    // Single query: niche match OR null niche, instead of 2 sequential round-trips.
    const filter = niche
      ? `&or=(niche.eq.${encodeURIComponent(niche)},niche.is.null)`
      : '';
    const rows = await dbGet(env,
      `background_music_tracks?is_active=eq.true${filter}&order=usage_count.asc&limit=20`
    ).catch(() => null);
    return rows || [];
  } catch {
    return [];
  }
}

/**
 * Fetches background_animation rows, preferring niche match, then any active row.
 * Falls back to general if niche-specific pool is empty.
 */
async function pickBgAnimPool(env, niche) {
  try {
    // Single query: niche match OR general OR null, instead of up to 3
    // sequential round-trips (niche-specific → general → any).
    const filter = niche
      ? `or=(niche.eq.${encodeURIComponent(niche)},niche.eq.general,niche.is.null)`
      : 'niche.eq.general';
    const rows = await dbGet(env,
      `background_animation?is_active=eq.true&${filter}&limit=20`
    ).catch(() => null);
    if (rows?.length) return rows;
    // Last resort fallback (rare — only if table has zero matching/general/null rows)
    const anyRows = await dbGet(env,
      `background_animation?is_active=eq.true&limit=20`
    ).catch(() => null);
    return anyRows || [];
  } catch {
    return [];
  }
}

// cta4_cues — "write your answer in comments" screen pool.
// No last_used_at column — rotate by usage_count (lowest-used first), then random.
async function pickCta4Pool(env, lang) {
  try {
    // Single query: lang match OR null lang, instead of 2 sequential round-trips.
    const rows = await dbGet(env,
      `cta4_cues?is_active=eq.true&or=(lang_code.eq.${encodeURIComponent(lang)},lang_code.is.null)&order=usage_count.asc&limit=20`
    ).catch(() => null);
    if (rows?.length) return rows;
    // Last resort fallback (rare — only if table has zero matching/null rows)
    const anyRows = await dbGet(env,
      `cta4_cues?is_active=eq.true&order=usage_count.asc&limit=20`
    ).catch(() => null);
    return anyRows || [];
  } catch {
    return [];
  }
}

function randomPick(arr) {
  if (!arr?.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

// ================================================================
// BATCH BUMP HELPERS
// ================================================================
function collectBump(bumpCounts, table, row) {
  if (!row?.id) return;
  const key = `${table}:${row.id}`;
  if (!bumpCounts[key]) {
    bumpCounts[key] = { table, id: row.id, newCount: (row.usage_count || 0) };
  }
  bumpCounts[key].newCount += 1;
}

// ================================================================
// LLM via quiz_generation_settings TABLE (mirrors blog_generation_settings pattern)
// ================================================================
async function generateQuestionsWithGroq(job, env) {

  // ── Load settings from quiz_generation_settings table (id=1) ──────────
  let config = null;
  try {
    const rows = await dbGet(env, 'quiz_generation_settings?id=eq.1&limit=1');
    if (rows?.length) config = rows[0];
  } catch (e) {
    console.error('[W8] Failed to load quiz_generation_settings:', e.message);
  }

  if (!config) throw new Error('quiz_generation_settings row not found — run quiz_generation_settings.sql first');
  if (!config.quiz_generation_enabled) throw new Error('Quiz generation is disabled in quiz_generation_settings');

  const apiKey      = config.llm_api_key;
  const model       = config.llm_model;
  const endpoint    = config.llm_api_endpoint || 'https://ai-gateway.vercel.sh/v1/chat/completions';
  const temperature = Number(config.temperature) || 0.65;
  const maxTokens   = Number(config.max_tokens)  || 4096;

  if (!apiKey) throw new Error('llm_api_key is empty in quiz_generation_settings — update it in Supabase');
  if (!model)  throw new Error('llm_model is empty in quiz_generation_settings');

  // ── Word-count limits from settings table ─────────────────────────────
  const limits = {
    question_max_words:       Number(config.question_max_words)       || 15,
    hint_min_words:           Number(config.hint_min_words)           || 2,
    hint_max_words:           Number(config.hint_max_words)           || 10,
    explanation_min_words:    Number(config.explanation_min_words)    || 15,
    mi_question_max_words:    Number(config.mi_question_max_words)    || 15,
    mi_hint_min_words:        Number(config.mi_hint_min_words)        || 2,
    mi_hint_max_words:        Number(config.mi_hint_max_words)        || 10,
    mi_explanation_min_words: Number(config.mi_explanation_min_words) || 15,
    title_min_words:          Number(config.title_min_words)          || 5,
    title_max_words:          Number(config.title_max_words)          || 12,
    min_valid_questions:      Number(config.min_valid_questions)      || 1,
  };
  console.log(`[W8] Limits: q_max=${limits.question_max_words}w expl_min=${limits.explanation_min_words}w mi_q_max=${limits.mi_question_max_words}w title=${limits.title_min_words}-${limits.title_max_words}w min_valid=${limits.min_valid_questions}`);

  console.log(`[W8] Settings: provider=${config.llm_provider} model=${model} endpoint=${endpoint.slice(0,50)}`);
  console.log(`[W8] Key prefix=${apiKey.slice(0,8)}... length=${apiKey.length}`);

  const topic         = job.trnding_topic  || '';
  const grounding     = (job.searched_text || '').slice(0, 3000);
  const niche         = job.niche          || 'general';
  const trendKws      = job.trend_keywords || '';
  const langCode      = job.lang_code      || 'en';
  const countryCode   = job.country_code   || 'US';

  // Build a country/language context note for the prompt
  const countryName = { US: 'United States', IN: 'India' }[countryCode] || countryCode;
  const langNote    = langCode !== 'en'
    ? `\nNote: This quiz is for a ${countryName} audience. Write all content in English but focus on facts relevant to ${countryName} viewers.`
    : `\nNote: This quiz is for a United States audience. Focus on facts, names, and context relevant to US viewers.`;

  const prompt = `You are a world-class quiz writer for a viral short-form video quiz app (think KBC / Who Wants To Be A Millionaire).
Your questions flash on screen for 10 seconds to a viewer who has NEVER read any background article or news story.
They must be instantly understandable, self-contained, and feel like a real TV quiz show question.

TOPIC: "${topic}"
NICHE: ${niche}${langNote}

GROUNDING FACTS (use ONLY these facts, do not invent):
${grounding || '(use general knowledge about the topic)'}
${trendKws ? `\nRELATED SEARCH KEYWORDS (people also searched for these — use them to write more specific questions and better options):
${trendKws}` : ''}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
THE GOLDEN RULE — THIS IS THE MOST IMPORTANT INSTRUCTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EVERY question must be 100% SELF-CONTAINED.
A random stranger who has never seen the topic or grounding facts must read the question
alone and immediately understand WHO/WHAT it is about and WHAT is being asked.

THE TEST: Cover the grounding facts. Read only the question. Does it make complete sense?
Can a stranger answer it with just general knowledge? If not — rewrite it.

THESE QUESTION PATTERNS ARE FORBIDDEN (they assume the viewer has read the article):
  "What formula caused infant botulism?"        ← Which formula? What incident? No context.
  "Where was the recalled formula sold?"        ← Which recall? The viewer has no idea.
  "Why did some families cancel health coverage?" ← Which families? What happened?
  "What agency issued the recall notice?"       ← What recall? For what?
  "What is the name of the act that provided these subsidies?" ← Which act? Which subsidies?

REWRITE THOSE AS SELF-CONTAINED QUESTIONS:
  "Which baby formula type was recalled for US infant botulism in 2026?"
  "Which US stores sold the organic formula recalled for botulism in 2026?"
  "Why did US families drop ACA health plans after subsidies expired in 2026?"
  "Which US agency recalled the infant formula linked to botulism in 2026?"
  "Which US health law's subsidies expired causing families to lose coverage in 2026?"

THE PATTERN: Always embed WHO/WHAT + WHEN + WHY in the question itself.
Never use vague references like "the formula", "the recall", "some families", "the act",
"the agency" — these all assume prior reading. Replace with specific names and context.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ADDITIONAL QUALITY RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Complete sentence ending "?" — subject + verb + enough context to stand alone.
   WRONG: "Bag growth" / "AI topic" / "Tub search"
   CORRECT: "Which bag type surged 7,000% in Google searches in June 2026?"

2. Options: specific complete noun phrases — never single vague words.
   WRONG: ["Shoe", "Luxury", "Travel", "Gym"]
   CORRECT: ["Shoe Washing Bag", "Gym Duffel Bag", "Luxury Tote Bag", "Travel Carry-on"]

3. Hint: nudge without revealing the answer. Self-contained — never says "the recall",
   "the act", "the agency". Must make sense without any prior context.
   WRONG: "Think about expensive healthcare" (too vague, no context)
   WRONG: "Law behind the subsidies" (assumes viewer knows about subsidies)
   CORRECT: "ACA subsidy cuts hit low-income families hardest"
   CORRECT: "Organic label does not guarantee sterile production"

4. Explanation: > 20 words, a standalone interesting fact. Must make full sense to
   someone who has never read the article. Include names, dates, context.
   WRONG: "Top cost drivers" (3 words, meaningless)
   CORRECT: "When US Republicans let ACA expanded subsidies expire in 2026, monthly
   premiums surged beyond what low-income families could afford, forcing thousands to drop coverage."

5. Different facts per question — no overlap.
6. All 4 options must be plausible — not 3 obvious wrong answers.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
WORD-COUNT LIMITS (questions outside these are dropped automatically)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
youtube_title                   : ${limits.title_min_words}–${limits.title_max_words} words — punchy, SEO-friendly, emoji optional
question                        : <= ${limits.question_max_words} words — must be short and instantly readable on screen
options each                    : no length limit — write as long as needed for clarity
hint                            : ${limits.hint_min_words}-${limits.hint_max_words} words (count carefully)
explanation                     : > ${limits.explanation_min_words} words (be thorough and informative)
mission_impossible_question     : <= ${limits.mi_question_max_words} words — must be short and instantly readable on screen
mission_impossible_options each : no length limit — write as long as needed for clarity
mission_impossible_hint         : ${limits.mi_hint_min_words}-${limits.mi_hint_max_words} words (count carefully)
mission_impossible_explanation  : > ${limits.mi_explanation_min_words} words (be thorough and informative)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
MISSION IMPOSSIBLE — MANDATORY for every question
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Every single question MUST include a complete Mission Impossible bonus question.
This is NOT optional — a question without complete MI data will be REJECTED entirely.
Hard question only 1% would know. Apply the same Golden Rule — fully self-contained.
Complete sentence ending "?". 4 plausible options. Same hint/explanation word-count rules.
mission_impossible_trigger_line: always exactly "Reply with your answer in the comments!"
Never omit mission_impossible_question, mission_impossible_options,
mission_impossible_correct, mission_impossible_hint, mission_impossible_explanation,
or mission_impossible_trigger_line — all are required on every question.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TECHNICAL RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
correct / mission_impossible_correct: EXACT string from its options array
keep_5050 / mission_impossible_keep_5050: exactly 2 indexes [0-3]
  -> correct answer index + most plausible wrong answer index

IMPORTANT — GENERATE GENEROUSLY:
Target at least 4–5 questions per topic (more is better).
Some questions may be rejected during validation for word-count or completeness issues.
The system needs at least 2 to pass validation — so generate 4–5 to ensure enough survive.
Cover every distinct fact from the grounding text. Do not stop at 2.
If the topic is a person: cover their career, records, teams, achievements, nationality, age.
If the topic is an event: cover the result, location, date, key people, consequences.
If the topic is a match: cover the score, scorers, venue, group/round, implications.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
YOUTUBE TITLE — required on every question
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Each question needs a "youtube_title" — the title used for both the YouTube
video upload AND displayed as the headline on the video thumbnail.

RULES for youtube_title:
  - Max 70 characters (YouTube truncates beyond this in search results)
  - Must be UNIQUE per question — each question in the array gets its own title
  - Must include the core topic keyword naturally (for YouTube search SEO)
  - Must have a curiosity/challenge hook — one of these patterns:
      "99% Can't Answer This [topic] Question!"
      "Can You Solve This [topic] Challenge?"
      "Only [X]% Know This About [topic]"
      "Most People Get This [topic] Question Wrong!"
      "How Much Do You Know About [topic]?"
      "[Specific fact from question]? Take the Quiz!"
  - Do NOT use the raw topic name alone — always add the hook
  - Do NOT reveal the correct answer in the title
  - May use 1 relevant emoji at the START (not middle, not end)
  - Make each question's title DIFFERENT — if generating 3 questions on the
    same topic, use different hooks so the 3 videos feel unique on the channel

GOOD EXAMPLES:
  "🔥 99% Can't Name the US Channel Airing Korea vs South Africa!"
  "🏆 Can You Solve This World Cup Challenge? Most Fans Fail!"
  "⚡ Which City Hosts Korea vs South Africa? Take the Quiz!"
  "🌍 Only 1% Know This About the 2026 Earthquake — Do You?"
  "🤯 Most People Get This MSTR Stock Question Wrong!"

BAD EXAMPLES (do not do these):
  "korea vs south africa" — raw topic, no hook, not clickable
  "Quiz about earthquake near me" — boring, no curiosity
  "Which US channel airs South Korea vs South Africa World Cup?" — that's the question, not the title

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUTPUT — ONLY a valid JSON array, no markdown, no preamble, no trailing text
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[
  {
    "youtube_title": "🔥 99% Can't Name the Formula Behind US Infant Botulism in 2026!",
    "question": "Which baby formula type was recalled for US infant botulism in 2026?",
    "options": ["Organic Milk Formula", "Soy-Based Formula", "Hydrolyzed Formula", "Goat Milk Formula"],
    "correct": "Organic Milk Formula",
    "explanation": "In 2026 the US FDA recalled an organic milk infant formula after three babies were diagnosed with botulism, revealing critical safety gaps in organic baby food production and testing.",
    "hint": "Organic label does not mean sterile",
    "keep_5050": [0, 1],
    "mission_impossible_question": "Which bacterium produces the toxin causing infant botulism?",
    "mission_impossible_options": ["Clostridium Botulinum", "Bacillus Cereus", "E. Coli O157", "Listeria Monocytogenes"],
    "mission_impossible_correct": "Clostridium Botulinum",
    "mission_impossible_explanation": "Clostridium botulinum produces a powerful neurotoxin that blocks nerve signals, making it especially dangerous for infants whose immune systems cannot neutralise bacterial spores as effectively as adults can.",
    "mission_impossible_hint": "A spore-forming neurotoxin-producing bacterium",
    "mission_impossible_keep_5050": [0, 1],
    "mission_impossible_trigger_line": "Reply with your answer in the comments!"
  }
]`

  // Build model chain: primary from settings table, then fallback from settings table
  const MODELS = [{ model, endpoint, apiKey }];
  if (config.fallback_llm_model && config.fallback_llm_provider !== 'none' && config.fallback_llm_api_key) {
    MODELS.push({
      model:    config.fallback_llm_model,
      endpoint: config.fallback_llm_api_endpoint || endpoint,
      apiKey:   config.fallback_llm_api_key
    });
  }

  let lastError;
  for (let attempt = 0; attempt < MODELS.length; attempt++) {
    const { model: m, endpoint: ep, apiKey: key } = MODELS[attempt];
    try {
      console.log(`[LLM] Attempt ${attempt + 1}: model=${m} endpoint=${ep.slice(0,50)}`);
      const res = await fetch(ep, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${key}`,
          'Content-Type':  'application/json',
        },
        body: JSON.stringify({
          model: m,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          max_tokens: maxTokens
        })
      });
      const data = await res.json();
      if (!res.ok) {
        console.error(`[LLM] HTTP ${res.status} from ${m}: ${JSON.stringify(data).slice(0,400)}`);
        throw new Error(data.error?.message || `LLM HTTP ${res.status}`);
      }

      const raw = data.choices?.[0]?.message?.content || '';
      console.log('[LLM] Snippet:', raw.slice(0, 200));

      const parsed = parseGroqJson(raw);
      if (!parsed || !Array.isArray(parsed) || parsed.length < 1) {
        throw new Error(`Parsed ${parsed?.length ?? 0} questions from LLM, got empty response`);
      }
      return { questions: parsed, model: m, limits };

    } catch (err) {
      lastError = err;
      console.warn(`[LLM] Attempt ${attempt + 1} failed: ${err.message}`);
      if (attempt < MODELS.length - 1) await sleep(2000);
    }
  }
  throw new Error(`All Groq attempts failed. Last: ${lastError?.message}`);
}

function parseGroqJson(text) {
  let s = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const arrMatch = s.match(/\[[\s\S]*\]/);
  if (arrMatch) { try { return JSON.parse(arrMatch[0]); } catch {} }
  try { return JSON.parse(s); } catch {}
  return null;
}

// ================================================================
// UTILITY HELPERS
// ================================================================
function normaliseKeep5050(raw, options, correct) {
  const correctIdx = options.findIndex(o =>
    o?.trim().toLowerCase() === correct?.trim().toLowerCase()
  );
  let keep = [];
  if (Array.isArray(raw)) {
    keep = raw.map(v => parseInt(v, 10)).filter(n => !isNaN(n) && n >= 0 && n <= 3);
  }
  if (correctIdx >= 0 && !keep.includes(correctIdx)) keep = [correctIdx];
  keep = [...new Set(keep)];
  if (keep.length < 2) {
    for (let i = 0; i < 4; i++) {
      if (!keep.includes(i)) { keep.push(i); break; }
    }
  }
  if (keep.length > 2) keep = keep.slice(0, 2);
  return keep.map(String);
}

function buildIntroSpeech(topic, niche) {
  const templates = [
    `Today we're testing your knowledge on ${topic}. Get ready!`,
    `Think you know everything about ${topic}? Let's find out!`,
    `Here's a ${niche} quiz on ${topic}. How well do you know it?`,
    `${topic} is today's topic. Let's see if you can ace this!`,
    `How much do you really know about ${topic}? Time to prove it!`
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}

function buildSfxJson(sfxMap) {
  try { return JSON.stringify(sfxMap); } catch { return null; }
}

function makeSlug(text) {
  return (text || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').trim()
    .replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ================================================================
// SUPABASE REST CLIENT
// ================================================================
function sbHeaders(env) {
  return {
    'apikey':        env.SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type':  'application/json'
  };
}

async function dbGet(env, path) {
  const url = `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`;
  const res = await fetch(url, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt.trim() ? JSON.parse(txt) : [];
}

async function dbPatch(env, table, id, data) {
  const url = `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?id=eq.${id}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { ...sbHeaders(env), Prefer: 'return=minimal' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`PATCH ${table}/${id} → ${res.status}: ${await res.text()}`);
}

async function dbInsert(env, table, data) {
  const url = `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...sbHeaders(env), Prefer: 'return=representation' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`INSERT ${table} → ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt.trim() ? JSON.parse(txt) : null;
}
