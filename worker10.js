/**
 * worker10.js — Quiz Video Renderer
 * Reads from quiz_queue (job_type=video_render) and quiz table.
 * Produces a 35-55s MP4 following the 15-step storyboard.
 *
 * SYNC STRATEGY
 * ─────────────
 * Static slides  → Puppeteer screenshot + imageToClip()
 *                  clip duration = TTS audio duration (padded to minimum)
 * Timer phase    → PuppeteerScreenRecorder (CSS animations play in real-time)
 *                  duration = thinking_time seconds, audio = suspense SFX
 * All clips are FFmpeg-concatenated in order at the end.
 */

const { exec }    = require('child_process');
const util        = require('util');
const execPromise = util.promisify(exec);
const fs          = require('fs').promises;
const path        = require('path');
const puppeteer   = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const { v4: uuidv4 } = require('uuid');

// ── ENV ───────────────────────────────────────────────────────────
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

console.log('SUPABASE_URL from env:', SUPABASE_URL);
console.log('SUPABASE_SERVICE_KEY from env:', SUPABASE_KEY ? '*** (set)' : 'NOT SET');

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing Supabase credentials'); process.exit(1);
}

const BASE_HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

// ── VOICE MAP ─────────────────────────────────────────────────────
const VOICE_MAP = {
  en: 'en-US-JennyNeural',
  hi: 'hi-IN-SwaraNeural',
  es: 'es-ES-ElviraNeural',
  pt: 'pt-BR-FranciscaNeural'
};

// ── DIRS ──────────────────────────────────────────────────────────
const FIXED_AUDIO_DIR = path.join(__dirname, 'fixed_audio');
const SFX_DIR         = path.join(__dirname, 'sfx');

// ── SUPABASE ──────────────────────────────────────────────────────
async function db(endpoint, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${endpoint}`;
  console.log(`[DB] ${opts.method || 'GET'} ${url}`);
  const headers = { ...BASE_HEADERS, ...(opts.headers || {}) };
  if (opts.method && ['POST','PATCH','PUT'].includes(opts.method)) {
    headers.Prefer = 'return=representation';
  }
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  console.log(`[DB] response ${txt.length} chars`);
  if (!txt || txt.trim() === '') return null;
  return JSON.parse(txt);
}

// ── UTILITIES ─────────────────────────────────────────────────────
async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function audioDur(p) {
  const { stdout } = await execPromise(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`
  );
  return parseFloat(stdout.trim());
}

async function videoDur(p) {
  const { stdout } = await execPromise(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`
  );
  return parseFloat(stdout.trim());
}

async function tts(text, voice, out, minSec = 1) {
  const clean = (text || '').trim();
  if (!clean) { await silence(out, minSec); return minSec; }
  const tmp = out + '.txt';
  await fs.writeFile(tmp, clean, 'utf8');
  await execPromise(`edge-tts --voice "${voice}" --file "${tmp}" --write-media "${out}"`);
  await fs.unlink(tmp).catch(() => {});
  const d = await audioDur(out);
  if (d < minSec) {
    const padded = out + '.pad.mp3';
    await execPromise(
      `ffmpeg -y -i "${out}" -af "apad=whole_dur=${minSec}" -acodec libmp3lame "${padded}"`
    );
    await fs.rename(padded, out);
    return minSec;
  }
  return d;
}

async function silence(out, sec) {
  await execPromise(
    `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${sec} -q:a 9 -acodec libmp3lame "${out}"`
  );
}

async function fixedPhrase(key, text, voice, lang) {
  await ensureDir(FIXED_AUDIO_DIR);
  const p = path.join(FIXED_AUDIO_DIR, `${key}_${lang}.mp3`);
  if (await exists(p)) return p;
  await tts(text, voice, p, 1);
  return p;
}

async function sfx(niche) {
  await ensureDir(SFX_DIR);
  for (const c of [path.join(SFX_DIR, `${niche||'default'}.mp3`), path.join(SFX_DIR, 'default.mp3')]) {
    if (await exists(c)) return c;
  }
  return null;
}

async function imgClip(imgPath, audioPath, dur, workDir, name) {
  const out = path.join(workDir, `${name}.mp4`);
  await execPromise(
    `ffmpeg -y -loop 1 -i "${imgPath}" -i "${audioPath}" ` +
    `-c:v libx264 -t ${dur} -pix_fmt yuv420p -c:a aac -shortest "${out}"`
  );
  return { path: out, duration: dur };
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── JOB RUNNER ────────────────────────────────────────────────────
async function run() {
  console.log('Checking for pending video jobs...');
  const jobs = await db(
    'quiz_queue?job_type=eq.video_render&status=eq.pending&order=created_at.asc&limit=1'
  );
  if (!jobs || !jobs.length) { console.log('No pending jobs.'); return; }

  const job = jobs[0];
  console.log(`Processing job ${job.id} for quiz ${job.quiz_id}`);

  await db(`quiz_queue?id=eq.${job.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'processing', started_at: new Date().toISOString() })
  });

  try {
    const rows = await db(`quiz?id=eq.${job.quiz_id}`);
    if (!rows || !rows.length) throw new Error('Quiz not found');
    const quiz = rows[0];

    const qIdx    = (job.payload && job.payload.question_index) || 1;
    const lang    = quiz.lang_code || 'en';
    const workDir = `/tmp/vid_${uuidv4()}`;
    await ensureDir(workDir);

    const outPath = await buildVideo(quiz, qIdx, lang, workDir);
    const stats   = await fs.stat(outPath);
    const dur     = await videoDur(outPath);

    console.log(`Video ready: ${outPath} | ${(stats.size/1e6).toFixed(2)} MB | ${dur.toFixed(1)}s`);

    const artifact = `/tmp/${job.id}_video.mp4`;
    await fs.copyFile(outPath, artifact);
    await fs.writeFile('/tmp/artifact_ready', artifact);

    await db(`quiz_queue?id=eq.${job.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString() })
    });
    await db(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ render_duration_sec: Math.round(dur), video_status: 'rendered' })
    });

    await fs.rm(workDir, { recursive: true, force: true });
    console.log(`Job ${job.id} done.`);

  } catch (err) {
    console.error('Job failed:', err);
    await db(`quiz_queue?id=eq.${job.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'failed',
        last_error: String(err.message || err),
        retry_count: (job.retry_count || 0) + 1
      })
    }).catch(e => console.error('Queue update failed:', e));
    throw err;
  }
}

// ── VIDEO BUILDER ─────────────────────────────────────────────────
async function buildVideo(quiz, qIdx, lang, workDir) {
  const voice = VOICE_MAP[lang] || VOICE_MAP.en;

  const question    = quiz[`question_${qIdx}`]      || '';
  const options     = quiz[`options_${qIdx}`]       || [];
  const correct     = quiz[`correct_answer_${qIdx}`] || '';
  const hint        = quiz[`hint_${qIdx}`]          || '';
  const keep5050    = quiz[`keep_5050_${qIdx}`]     || [];
  const explanation = quiz[`explanation_${qIdx}`]   || '';

  const THINK_TIME = quiz.thinking_time || 18;
  const HINT_AT    = Math.round(THINK_TIME / 3);
  const F50_AT     = Math.round((THINK_TIME * 2) / 3);

  const allIdx    = [0,1,2,3];
  const keepSet   = new Set(keep5050.map(v => parseInt(v, 10)));
  const eliminate = allIdx.filter(i => !keepSet.has(i));
  const eClass    = i => eliminate.includes(i) ? 'eliminate' : '';
  const rClass    = i => (options[i] === correct ? 'correct' : 'wrong');

  const ctaUrl = `jaasblog.online/q/${quiz.niche||'quiz'}/${lang}/${quiz.topic_slug||quiz.blog_slug||''}`;

  // ── Build HTML ───────────────────────────────────────────
  let html = await fs.readFile(path.join(__dirname, 'quiz_template.html'), 'utf8');
  const rep = {
    '{{hook_phrase}}':       quiz.hook_phrase || quiz.topic || 'Think fast!',
    '{{topic}}':             quiz.topic || '',
    '{{quiz_intro_speech}}': quiz.quiz_intro_speech || `Today's topic: ${quiz.topic}`,
    '{{question}}':          question,
    '{{options[0]}}':  options[0]||'', '{{options[1]}}': options[1]||'',
    '{{options[2]}}':  options[2]||'', '{{options[3]}}': options[3]||'',
    '{{e0}}': eClass(0), '{{e1}}': eClass(1), '{{e2}}': eClass(2), '{{e3}}': eClass(3),
    '{{r0}}': rClass(0), '{{r1}}': rClass(1), '{{r2}}': rClass(2), '{{r3}}': rClass(3),
    '{{hint}}':              hint,
    '{{correct_answer}}':    correct,
    '{{cta_text}}':          quiz.cta_text || 'Like, Share & Subscribe!',
    '{{cta_url}}':           ctaUrl,
    '{{final_cta_text}}':    quiz.cta_description_text || 'Play live & earn ONS tokens!',
    '{{mission_question}}':  quiz.mission_impossible_question  || '',
    '{{mission_hint}}':      quiz.mission_impossible_hint      || '',
    '{{mission_trigger}}':   quiz.mission_impossible_trigger_line || '',
    '{{thinking_time}}':     `${THINK_TIME}`,
    '{{hint_time}}':         `${HINT_AT}`,
    '{{fiftyfifty_time}}':   `${F50_AT}`
  };
  for (const [k,v] of Object.entries(rep)) html = html.split(k).join(String(v));
  const htmlPath = path.join(workDir, 'quiz.html');
  await fs.writeFile(htmlPath, html, 'utf8');

  // ── Launch Puppeteer ─────────────────────────────────────
  let executablePath;
  try   { executablePath = puppeteer.executablePath(); }
  catch { executablePath = '/usr/bin/chromium-browser'; }

  const browser = await puppeteer.launch({
    headless: 'new', executablePath,
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--disable-software-rasterizer','--disable-extensions',
      '--run-all-compositor-stages-before-draw'
    ]
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(300);

  // Show one screen by its HTML id
  async function show(id) {
    await page.evaluate(id => {
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      const el = document.getElementById(id);
      if (el) el.classList.add('active');
    }, id);
  }

  // Screenshot a screen → audio → clip
  async function snap(screenId, audioPath, dur, clipName, settleMs = 900) {
    await show(screenId);
    await wait(settleMs);
    const img = path.join(workDir, `${clipName}.png`);
    await page.screenshot({ path: img });
    return imgClip(img, audioPath, dur, workDir, clipName);
  }

  const clips = [];

  // ── STEP 1: HOOK (2-4s) ─────────────────────────────────
  console.log('[step 1] hook');
  const hookAudio = path.join(workDir, 'hook.mp3');
  const hookDur   = Math.min(Math.max(
    await tts(quiz.hook_phrase || quiz.topic || 'Think fast!', voice, hookAudio, 3),
    2), 4);
  clips.push(await snap('s-hook', hookAudio, hookDur, 'c1_hook', 1100));

  // ── STEP 2: INTRODUCTION (4-8s) ─────────────────────────
  console.log('[step 2] intro');
  const introAudio = path.join(workDir, 'intro.mp3');
  const introDur   = Math.min(Math.max(
    await tts(quiz.quiz_intro_speech || `Today's topic: ${quiz.topic}`, voice, introAudio, 4),
    4), 8);
  clips.push(await snap('s-intro', introAudio, introDur, 'c2_intro', 900));

  // ── STEP 3: "HERE IS YOUR CHALLENGE" + question appears ──
  console.log('[step 3] challenge phrase');
  const challengeAudio = await fixedPhrase('here_is_your_challenge',
    'Here is your challenge. Solve it!', voice, lang);
  const challengeDur = await audioDur(challengeAudio);
  clips.push(await snap('s-q-appear', challengeAudio, challengeDur, 'c3_challenge', 700));

  // ── STEP 4+5: "AND YOUR OPTIONS ARE…" + options slide in ─
  console.log('[step 4+5] options appear');
  const optionsAudio = await fixedPhrase('and_your_options_are',
    'And your options are…', voice, lang);
  const optionsDur = await audioDur(optionsAudio);
  clips.push(await snap('s-opts-appear', optionsAudio, optionsDur, 'c4_options', 700));

  // ── STEP 6: "YOUR TIME STARTS NOW!" ─────────────────────
  console.log('[step 6] time starts now');
  const startsAudio = await fixedPhrase('your_time_starts_now',
    'Your time starts now!', voice, lang);
  const startsDur = await audioDur(startsAudio);
  // Reuse the already-taken options screenshot
  const optsImg = path.join(workDir, 'c4_options.png');
  clips.push(await imgClip(optsImg, startsAudio, startsDur, workDir, 'c5_starts'));

  // ── STEPS 7-9: TIMER PHASE (screen-recorded) ─────────────
  console.log(`[steps 7-9] timer phase — ${THINK_TIME}s`);
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await wait(200);
  await show('s-timer');
  await wait(150);

  const sfxFile    = await sfx(quiz.niche);
  const timerAudio = path.join(workDir, 'timer_sfx.mp3');
  if (sfxFile) {
    await execPromise(
      `ffmpeg -y -stream_loop -1 -i "${sfxFile}" -t ${THINK_TIME} -af "volume=0.65" -acodec libmp3lame "${timerAudio}"`
    );
  } else {
    await silence(timerAudio, THINK_TIME);
  }

  const rawTimerVideo = path.join(workDir, 'timer_raw.mp4');
  const recorder = new PuppeteerScreenRecorder(page, {
    fps: 30, videoFrame: { width: 1080, height: 1920 }, aspectRatio: '9:16'
  });
  await recorder.start(rawTimerVideo);
  await wait(THINK_TIME * 1000);
  await recorder.stop();

  const timerClip = path.join(workDir, 'c6_timer.mp4');
  await execPromise(
    `ffmpeg -y -i "${rawTimerVideo}" -i "${timerAudio}" ` +
    `-c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${timerClip}"`
  );
  clips.push({ path: timerClip, duration: THINK_TIME });

  // ── STEP 10: ANSWER REVEAL ───────────────────────────────
  console.log('[step 10] answer reveal');
  await show('s-answer');
  await wait(300);
  const answerImg   = path.join(workDir, 'c7_answer.png');
  await page.screenshot({ path: answerImg });
  const answerAudio = path.join(workDir, 'answer.mp3');
  const answerDur   = await tts(
    `Time's up! The correct answer is ${correct}.`, voice, answerAudio, 3
  );
  clips.push(await imgClip(answerImg, answerAudio, answerDur, workDir, 'c7_answer'));

  // Explanation spoken over the answer slide (no separate screen needed)
  if (explanation) {
    console.log('[step 10b] explanation');
    const explAudio = path.join(workDir, 'expl.mp3');
    const explDur   = await tts(explanation, voice, explAudio, 3);
    clips.push(await imgClip(answerImg, explAudio, explDur, workDir, 'c8_expl'));
  }

  // ── STEPS 11-12: CTA ─────────────────────────────────────
  console.log('[steps 11-12] CTA');
  const ctaText  = quiz.cta_description_text || quiz.cta_text ||
    'Like, share, and subscribe! Tap the link in the description for the exclusive offer.';
  const ctaAudio = path.join(workDir, 'cta.mp3');
  const ctaDur   = await tts(ctaText, voice, ctaAudio, 4);
  clips.push(await snap('s-cta', ctaAudio, ctaDur, 'c9_cta', 800));

  // ── STEPS 13-14: MISSION IMPOSSIBLE ─────────────────────
  if (quiz.mission_impossible_enabled !== false && quiz.mission_impossible_question) {
    console.log('[steps 13-14] mission impossible');

    const mQAudio = path.join(workDir, 'mq.mp3');
    const mQDur   = Math.max(await tts(
      quiz.mission_impossible_question, voice, mQAudio, 2.5), 2.5);
    clips.push(await snap('s-mission-q', mQAudio, mQDur, 'c10_mq', 600));

    const mHintText  = [quiz.mission_impossible_hint, quiz.mission_impossible_trigger_line]
      .filter(Boolean).join(' ') || 'Here is your hint!';
    const mHintAudio = path.join(workDir, 'mhint.mp3');
    const mHintDur   = Math.max(await tts(mHintText, voice, mHintAudio, 2.5), 2.5);
    clips.push(await snap('s-mission-hint', mHintAudio, mHintDur, 'c11_mhint', 500));
  }

  // ── STEP 15: FINAL CTA ───────────────────────────────────
  console.log('[step 15] final CTA');
  const fctaText  = `Like this video and subscribe to see the Mission Impossible answer. ` +
    `Challenge your friends! Play the live quiz and earn ONS tokens at ${ctaUrl}`;
  const fctaAudio = path.join(workDir, 'fcta.mp3');
  const fctaDur   = await tts(fctaText, voice, fctaAudio, 4);
  clips.push(await snap('s-final-cta', fctaAudio, fctaDur, 'c12_fcta', 1000));

  await browser.close();

  // ── CONCAT ───────────────────────────────────────────────
  console.log(`[concat] ${clips.length} clips`);
  const listPath = path.join(workDir, 'concat.txt');
  await fs.writeFile(listPath, clips.map(c => `file '${c.path}'`).join('\n'));

  const finalPath = path.join(workDir, 'final.mp4');
  await execPromise(
    `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:v libx264 -c:a aac -movflags +faststart "${finalPath}"`
  );

  const total = clips.reduce((s,c) => s + c.duration, 0);
  console.log(`[done] total duration: ${total.toFixed(1)}s`);
  if (total < 35 || total > 60) {
    console.warn(`[warn] ${total.toFixed(1)}s — target 35-55s`);
  }
  return finalPath;
}

// ── ENTRY ─────────────────────────────────────────────────────────
run()
  .then(() => { console.log('Worker finished.'); process.exit(0); })
  .catch(err => { console.error('Fatal:', err); process.exit(1); });
