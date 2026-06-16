/**
 * Worker 10 — Quiz Video Renderer
 * Reads directly from quiz table (video_status='pending', quiz_enriched=true)
 * Produces a 9:16 (1080x1920) MP4 per quiz row.
 *
 * Sequence (matches spec exactly):
 *  1.  Hook         : hook_phrase (text+logo) + hook_audio_url (prerecorded)     2-3s
 *  2.  Challenge    : question_intro_audio_url (audio only, no text)
 *  3.  Question     : question_1 text + TTS                                       0.3s gap after step2
 *  4.  Options Intro: options_intro_audio_url (audio only, no text)              0.7s gap after step3
 *  5.  Options      : options_1 text + TTS + sfx_audio_url                      0.3s gap after step4
 *  6.  Countdown    : countdown_music + animated timer (thinking_time_sec)
 *  7.  Hint         : hint_1 text + sfx_audio_url                               at 1/4 of countdown
 *  8.  50/50        : keep_5050_1 text + sfx_audio_url                          at 1/2 of countdown
 *  9.  Timeup       : timeup_text + timeup_audio_url
 * 10.  Answer Rev   : correct_answer_1 highlight + correct_answer_sfx + TTS     0.5s gap
 * 11.  Explanation  : explanation_1 text + TTS                                   0.5s gap
 * 12.  CTA1 or CTA2 : affiliate_text+cta1_audio_url  OR  cta2_text+cta2_audio_url
 * 13.  MI Intro     : mission_intro_text + mission_intro_audio_url
 * 14.  MI Question  : mission_impossible_question (text, screen hold 1s)
 * 15.  MI Hint      : mission_impossible_hint + sfx_audio_url                   after 1s
 * 16.  CTA3/Final   : cta3_text + cta3_audio_url + url                          after 2.5s; hold 1s
 *
 * Audio rules:
 *   - background_music loops entire video at ~25% volume, ducked further during voice
 *   - No overlap between voice/prerecorded/SFX layers (sequential)
 *   - Human-like silence gaps between TTS segments (0.3-0.7s as per spec)
 *   - Each quiz gets a unique visual theme
 */
'use strict';
const { exec }  = require('child_process');
const util      = require('util');
const execP     = util.promisify(exec);
const fs        = require('fs').promises;
const path      = require('path');
const puppeteer = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const { v4: uuidv4 } = require('uuid');

// ── Env ──────────────────────────────────────────────────────────────────────
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SB_URL || !SB_KEY) { console.error('[W10] Missing Supabase env vars'); process.exit(1); }

const LOGO_PATH   = path.join(__dirname, 'assets', 'jaasX-logo-saved-for-web.png');
const TMPL_PATH   = path.join(__dirname, 'quiz_template.html');
const CACHE_DIR   = path.join(__dirname, 'fixed_audio');

// Edge-TTS voices
const VOICE = {
  en: 'en-US-JennyNeural',
  hi: 'hi-IN-SwaraNeural',
  es: 'es-ES-ElviraNeural',
  pt: 'pt-BR-FranciscaNeural',
};

// 8 unique visual themes — stable per quiz (hashed from topic_slug)
const THEMES = [
  { id:'cosmic',   bg:'#0a0820,#1b0a3d 55%,#05030f', o1:'#ff2ec4', o2:'#00e0ff', o3:'#7b2ff7' },
  { id:'ocean',    bg:'#021a10,#053d28 55%,#020d08', o1:'#00ff8c', o2:'#0099ff', o3:'#00e0ff' },
  { id:'ember',    bg:'#1a0a00,#3d1a00 55%,#0f0500', o1:'#ffcc00', o2:'#ff6b00', o3:'#ff2e2e' },
  { id:'midnight', bg:'#000d1a,#00183d 55%,#00080f', o1:'#00cfff', o2:'#7b2ff7', o3:'#ff2ec4' },
  { id:'rose',     bg:'#1a0010,#3d0025 55%,#0f000a', o1:'#ff6584', o2:'#ff9a3c', o3:'#ffcc00' },
  { id:'forest',   bg:'#00100a,#00251a 55%,#000805', o1:'#3cffa0', o2:'#00bfff', o3:'#9b59ff' },
  { id:'aurora',   bg:'#050020,#120050 55%,#020010', o1:'#a78bfa', o2:'#34d399', o3:'#f472b6' },
  { id:'solar',    bg:'#120000,#2a0a00 55%,#080000', o1:'#fbbf24', o2:'#f87171', o3:'#a78bfa' },
];

function pickTheme(quiz) {
  if (quiz.visual_theme_id) {
    const t = THEMES.find(t => t.id === quiz.visual_theme_id);
    if (t) return t;
  }
  if (quiz.theme_accent_primary) return {
    id:'custom', bg:'#050010,#100030 55%,#030008',
    o1: quiz.theme_accent_primary,
    o2: quiz.theme_accent_secondary || '#00e0ff',
    o3: quiz.theme_accent_tertiary  || '#7b2ff7',
  };
  const seed = quiz.topic_slug || quiz.id || '';
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return THEMES[Math.abs(h) % THEMES.length];
}

// ── Supabase ─────────────────────────────────────────────────────────────────
async function sbFetch(endpoint, opts = {}) {
  const hdrs = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  if (['POST','PATCH','PUT'].includes(opts.method)) hdrs.Prefer = 'return=representation';
  const res = await fetch(`${SB_URL}/rest/v1/${endpoint}`, { ...opts, headers: hdrs });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt ? JSON.parse(txt) : null;
}
const sbPatch = (table, id, data) =>
  sbFetch(`${table}?id=eq.${id}`, { method:'PATCH', body: JSON.stringify(data) });

// ── Audio helpers ─────────────────────────────────────────────────────────────
const ensureDir = d => fs.mkdir(d, { recursive: true });
const fileExists = async p => { try { await fs.access(p); return true; } catch { return false; } };

async function audioDur(p) {
  const { stdout } = await execP(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`
  );
  return parseFloat(stdout.trim()) || 0;
}

async function mkSilence(outPath, sec) {
  await execP(
    `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${sec} -q:a 9 -acodec libmp3lame "${outPath}"`
  );
  return outPath;
}

async function mkTTS(text, voice, outPath, fallbackSec = 1) {
  const clean = (text || '').trim();
  if (!clean) return mkSilence(outPath, fallbackSec);
  const tmp = `${outPath}.txt`;
  await fs.writeFile(tmp, clean, 'utf8');
  await execP(`edge-tts --voice "${voice}" --file "${tmp}" --write-media "${outPath}"`);
  await fs.unlink(tmp).catch(() => {});
  return outPath;
}

async function cachedTTS(key, text, voice, lang) {
  await ensureDir(CACHE_DIR);
  const p = path.join(CACHE_DIR, `${key}_${lang}.mp3`);
  if (!(await fileExists(p))) await mkTTS(text, voice, p);
  return p;
}

async function downloadAudio(url, dest) {
  if (!url) return null;
  if (await fileExists(dest)) return dest;
  try {
    await execP(`curl -sL --max-time 30 -o "${dest}" "${url}"`);
    return (await fileExists(dest)) ? dest : null;
  } catch { return null; }
}

// Join audio files sequentially into one MP3
async function joinAudio(files, outPath) {
  const valid = files.filter(Boolean);
  if (!valid.length) return mkSilence(outPath, 0.5);
  if (valid.length === 1) { await fs.copyFile(valid[0], outPath); return outPath; }
  const list = `${outPath}.lst`;
  await fs.writeFile(list, valid.map(f => `file '${f}'`).join('\n'));
  await execP(`ffmpeg -y -f concat -safe 0 -i "${list}" -acodec libmp3lame "${outPath}"`);
  await fs.unlink(list).catch(() => {});
  return outPath;
}

/**
 * Mix FG audio (voice/SFX) with BG music (ducked to 25%).
 * FG stays full volume. BG is looped to match fgDur.
 * Uses sidechaining-style amix so BG never drowns speech.
 */
async function mixWithBG(fgPath, bgPath, fgDur, outPath) {
  if (!bgPath || !(await fileExists(bgPath))) {
    await fs.copyFile(fgPath, outPath);
    return outPath;
  }
  const bgLooped = `${outPath}_bgloop.mp3`;
  await execP(`ffmpeg -y -stream_loop -1 -i "${bgPath}" -t ${fgDur + 0.5} -acodec libmp3lame "${bgLooped}"`);
  // FG at 100%, BG at 25%
  await execP(
    `ffmpeg -y -i "${fgPath}" -i "${bgLooped}" ` +
    `-filter_complex "[1:a]volume=0.25[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[out]" ` +
    `-map "[out]" -t ${fgDur} -acodec libmp3lame "${outPath}"`
  );
  await fs.unlink(bgLooped).catch(() => {});
  return outPath;
}

// ── Clip builders ─────────────────────────────────────────────────────────────
async function imageClip(imgPath, audioPath, dur, outPath) {
  await execP(
    `ffmpeg -y -loop 1 -i "${imgPath}" -i "${audioPath}" ` +
    `-c:v libx264 -t ${dur} -pix_fmt yuv420p -c:a aac -shortest -movflags +faststart "${outPath}"`
  );
  return outPath;
}

async function videoClip(vidPath, audioPath, dur, outPath) {
  await execP(
    `ffmpeg -y -i "${vidPath}" -i "${audioPath}" ` +
    `-c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -t ${dur} -shortest -movflags +faststart "${outPath}"`
  );
  return outPath;
}

// ── Puppeteer helper ──────────────────────────────────────────────────────────
async function showSlide(page, selector) {
  await page.evaluate(sel => {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const el = document.querySelector(sel);
    if (el) el.classList.add('active');
  }, selector);
  await new Promise(r => setTimeout(r, 100));
}

// ── Job poller ────────────────────────────────────────────────────────────────
async function processNext() {
  console.log('[W10] Polling quiz table for pending renders...');
  const rows = await sbFetch(
    'quiz?quiz_enriched=eq.true&video_status=eq.pending&is_active=eq.true&order=created_at.asc&limit=1'
  );
  if (!rows?.length) { console.log('[W10] No pending quizzes.'); return; }

  const quiz = rows[0];
  console.log(`[W10] Rendering quiz ${quiz.id} — "${quiz.topic}"`);
  await sbPatch('quiz', quiz.id, { video_status: 'rendering' });

  const workDir = `/tmp/qvid_${uuidv4()}`;
  await ensureDir(workDir);

  try {
    const videoPath = await buildVideo(quiz, workDir);
    const stats  = await fs.stat(videoPath);
    const dur    = await audioDur(videoPath);
    const sizeMb = +(stats.size / 1048576).toFixed(2);

    const artifact = `/tmp/${quiz.id}.mp4`;
    await fs.copyFile(videoPath, artifact);
    await fs.writeFile('/tmp/artifact_path', artifact);
    console.log(`[W10] Saved → ${artifact}  (${dur.toFixed(1)}s, ${sizeMb}MB)`);

    await sbPatch('quiz', quiz.id, {
      video_status: 'rendered',
      render_duration_sec: Math.round(dur),
      file_size_mb: sizeMb,
    });
  } catch (err) {
    console.error('[W10] Render failed:', err);
    await sbPatch('quiz', quiz.id, {
      video_status: 'failed',
      generation_error: String(err.message || err).slice(0, 500),
    }).catch(() => {});
    throw err;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Main video builder ────────────────────────────────────────────────────────
async function buildVideo(quiz, workDir) {
  const lang  = quiz.lang_code || 'en';
  const voice = VOICE[lang] || VOICE.en;
  const niche = quiz.niche || 'general';
  const theme = pickTheme(quiz);

  const options   = quiz.options_1 || [];
  const correct   = quiz.correct_answer_1 || '';
  const hint      = quiz.hint_1 || '';
  const expl      = quiz.explanation_1 || '';
  const question  = quiz.question_1 || '';
  const thinkSec  = quiz.thinking_time_sec || 18;
  const HINT_AT   = thinkSec / 4;
  const FIFTY_AT  = thinkSec / 2;
  const ctaNiche  = `https://jaasblog.online/quiz/${niche}`;
  const useCTA1   = !!quiz.affiliate_url;

  // ── Resolve keep_5050 → option text ──
  const k5050raw  = quiz.keep_5050_1 || [];
  const k5050text = k5050raw.map(v => {
    const i = parseInt(v, 10);
    return (!isNaN(i) && options[i] !== undefined) ? options[i] : v;
  });
  // options to visually eliminate (grey/cross out)
  const dimOpts = options.filter(o => o !== correct && !k5050text.includes(o));

  // ── Download all remote audio once ──
  const dl = async (url, name) => downloadAudio(url, path.join(workDir, name));
  const bgMusicPath    = await dl(quiz.background_music,            'bg_music.mp3');
  const cdMusicPath    = await dl(quiz.countdown_music,             'cd_music.mp3');
  const hookAuPath     = await dl(quiz.hook_audio_url,              'hook_au.mp3');
  const qIntroAuPath   = await dl(quiz.question_intro_audio_url,    'qintro_au.mp3');
  const optIntroAuPath = await dl(quiz.options_intro_audio_url,     'optintro_au.mp3');
  const sfxPath        = await dl(quiz.sfx_audio_url,               'sfx.mp3');
  const timeupAuPath   = await dl(quiz.timeup_audio_url,            'timeup_au.mp3');
  const correctSfxPath = await dl(quiz.correct_answer_sfx_audio_url,'correct_sfx.mp3');
  const cta1AuPath     = await dl(quiz.cta1_audio_url,              'cta1_au.mp3');
  const cta2AuPath     = await dl(quiz.cta2_audio_url,              'cta2_au.mp3');
  const miIntroAuPath  = await dl(quiz.mission_intro_audio_url,     'mi_intro_au.mp3');
  const cta3AuPath     = await dl(quiz.cta3_audio_url,              'cta3_au.mp3');

  // ── Build HTML ──
  const logoB64 = await (async () => {
    if (await fileExists(LOGO_PATH)) {
      const b = await fs.readFile(LOGO_PATH);
      return `data:image/png;base64,${b.toString('base64')}`;
    }
    return '';
  })();

  const revClass = i => options[i] === correct ? 'correct' : 'wrong';
  const dimClass = i => dimOpts.includes(options[i]) ? 'eliminate' : '';

  let html = await fs.readFile(TMPL_PATH, 'utf8');
  const VARS = {
    '{{LOGO_SRC}}':           logoB64,
    '{{hook_phrase}}':        quiz.hook_phrase || quiz.topic || '',
    '{{topic}}':              quiz.topic || '',
    '{{question}}':           question,
    '{{opt_a}}':              options[0] || '', '{{opt_b}}': options[1] || '',
    '{{opt_c}}':              options[2] || '', '{{opt_d}}': options[3] || '',
    '{{dim_a}}':              dimClass(0),      '{{dim_b}}': dimClass(1),
    '{{dim_c}}':              dimClass(2),      '{{dim_d}}': dimClass(3),
    '{{rev_a}}':              revClass(0),      '{{rev_b}}': revClass(1),
    '{{rev_c}}':              revClass(2),      '{{rev_d}}': revClass(3),
    '{{correct_answer}}':     correct,
    '{{hint}}':               hint,
    '{{explanation}}':        expl,
    '{{affiliate_text}}':     quiz.affiliate_text || '',
    '{{affiliate_url}}':      quiz.affiliate_url  || '',
    '{{cta1_desc}}':          quiz.cta1_description_text || '',
    '{{cta2_text}}':          quiz.cta2_text || '',
    '{{cta2_url}}':           ctaNiche,
    '{{mission_intro_text}}': quiz.mission_intro_text || '🔥 Mission Impossible',
    '{{mission_question}}':   quiz.mission_impossible_question || '',
    '{{mission_hint}}':       quiz.mission_impossible_hint || '',
    '{{cta3_text}}':          quiz.cta3_text || 'Like · Share · Subscribe!',
    '{{cta3_url}}':           ctaNiche,
    '{{timeup_text_display}}':  quiz.timeup_text || "Time's up!",
    '{{THINK_SEC}}':          String(thinkSec),
    '{{HINT_AT}}':            String(HINT_AT),
    '{{FIFTY_AT}}':           String(FIFTY_AT),
    '{{THEME_BG}}':           theme.bg,
    '{{THEME_O1}}':           theme.o1,
    '{{THEME_O2}}':           theme.o2,
    '{{THEME_O3}}':           theme.o3,
  };
  for (const [k,v] of Object.entries(VARS)) html = html.split(k).join(String(v ?? ''));
  const htmlPath = path.join(workDir, 'quiz.html');
  await fs.writeFile(htmlPath, html);

  // ── Puppeteer ──
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu']
  });
  const page = await browser.newPage();
  await page.setViewport({ width:1080, height:1920 });

  const clips = [];
  let clipIdx = 0;

  // ── Per-clip pipeline:
  //    1. screenshot or screen-record
  //    2. build FG audio (join silence + voice/SFX as needed)
  //    3. mixWithBG → final audio
  //    4. imageClip / videoClip → push to clips[]
  async function addImgClip(slide, waitMs, buildAudio) {
    if (slide) {
      await showSlide(page, slide);
      if (waitMs) await new Promise(r => setTimeout(r, waitMs));
    }
    const img  = path.join(workDir, `sc${clipIdx}.png`);
    await page.screenshot({ path: img });
    const fgAu = path.join(workDir, `fg${clipIdx}.mp3`);
    const dur  = await buildAudio(fgAu);
    const mixAu = path.join(workDir, `mix${clipIdx}.mp3`);
    await mixWithBG(fgAu, bgMusicPath, dur, mixAu);
    const clipPath = path.join(workDir, `clip${clipIdx}.mp4`);
    await imageClip(img, mixAu, dur, clipPath);
    clips.push({ path: clipPath, dur });
    clipIdx++;
  }

  async function addVidClip(rawVid, buildAudio, dur) {
    const fgAu = path.join(workDir, `fg${clipIdx}.mp3`);
    await buildAudio(fgAu);
    const mixAu = path.join(workDir, `mix${clipIdx}.mp3`);
    await mixWithBG(fgAu, bgMusicPath, dur, mixAu);
    const clipPath = path.join(workDir, `clip${clipIdx}.mp4`);
    await videoClip(rawVid, mixAu, dur, clipPath);
    clips.push({ path: clipPath, dur });
    clipIdx++;
  }

  async function sil(sec) {
    const p = path.join(workDir, `sil${clipIdx}_${Date.now()}.mp3`);
    await mkSilence(p, sec);
    return p;
  }

  // ──────────────────────────────────────────────────────────────────────
  // LOAD PAGE
  // ──────────────────────────────────────────────────────────────────────
  await page.goto(`file://${htmlPath}`, { waitUntil:'networkidle0' });

  // ──────────────────────────────────────────────────────────────────────
  // STEP 1: HOOK — hook_phrase + brand logo + hook_audio_url (prerecorded)
  // ──────────────────────────────────────────────────────────────────────
  await addImgClip('.slide-hook', 900, async fgAu => {
    const au = hookAuPath || await (async () => {
      const p = path.join(workDir, 'hook_tts.mp3');
      return mkTTS(quiz.hook_phrase || quiz.topic, voice, p, 3);
    })();
    await fs.copyFile(au, fgAu);
    return Math.max(await audioDur(fgAu), 2.5);
  });

  // ──────────────────────────────────────────────────────────────────────
  // STEP 2: "Here is your challenge" — question_intro_audio_url (audio only)
  // Slide shows blank/ambient background only
  // ──────────────────────────────────────────────────────────────────────
  await addImgClip('.slide-ambient', 100, async fgAu => {
    const au = qIntroAuPath ||
      await cachedTTS('q_intro', 'Here is your challenge. Can you solve it?', voice, lang);
    await fs.copyFile(au, fgAu);
    return await audioDur(fgAu);
  });

  // ──────────────────────────────────────────────────────────────────────
  // STEP 3: Question appears — 0.3s gap, then question text + TTS
  // ──────────────────────────────────────────────────────────────────────
  await addImgClip('.slide-question-only', 400, async fgAu => {
    const s03  = await sil(0.3);
    const qTTS = path.join(workDir, 'q_tts.mp3');
    await mkTTS(question, voice, qTTS);
    await joinAudio([s03, qTTS], fgAu);
    return await audioDur(fgAu);
  });

  // ──────────────────────────────────────────────────────────────────────
  // STEP 4: "And your options are" — 0.7s gap then options_intro_audio_url (audio only)
  // Question still visible on screen
  // ──────────────────────────────────────────────────────────────────────
  await addImgClip('.slide-question-only', 0, async fgAu => {
    const s07 = await sil(0.7);
    const au  = optIntroAuPath ||
      await cachedTTS('opt_intro', 'And your options are', voice, lang);
    await joinAudio([s07, au], fgAu);
    return await audioDur(fgAu);
  });

  // ──────────────────────────────────────────────────────────────────────
  // STEP 5: Options appear — 0.3s gap, then sfx + TTS reads options
  // ──────────────────────────────────────────────────────────────────────
  await addImgClip('.slide-options', 400, async fgAu => {
    const s03  = await sil(0.3);
    const optsTTS = path.join(workDir, 'opts_tts.mp3');
    const optsText = options.map((o,i)=>`Option ${['A','B','C','D'][i]}: ${o}`).join('. ');
    await mkTTS(optsText, voice, optsTTS);
    const parts = [s03, sfxPath, optsTTS].filter(Boolean);
    await joinAudio(parts, fgAu);
    return await audioDur(fgAu);
  });

  // ──────────────────────────────────────────────────────────────────────
  // STEPS 6+7+8: COUNTDOWN — screen-recorded, countdown_music + sfx overlays
  // Hint CSS appears at HINT_AT, 50/50 CSS eliminates at FIFTY_AT (via template CSS vars)
  // ──────────────────────────────────────────────────────────────────────
  await page.goto(`file://${htmlPath}`, { waitUntil:'networkidle0' });
  await showSlide(page, '.slide-countdown');

  const cdRaw = path.join(workDir, 'cd_raw.mp4');
  const rec   = new PuppeteerScreenRecorder(page, {
    fps:30, videoFrame:{ width:1080, height:1920 }, aspectRatio:'9:16'
  });
  await rec.start(cdRaw);
  await new Promise(r => setTimeout(r, thinkSec * 1000));
  await rec.stop();

  await addVidClip(cdRaw, async fgAu => {
    if (!cdMusicPath) { await mkSilence(fgAu, thinkSec); return; }
    // Loop countdown music
    const cdLooped = path.join(workDir, 'cd_looped.mp3');
    await execP(
      `ffmpeg -y -stream_loop -1 -i "${cdMusicPath}" -t ${thinkSec} -af "volume=0.80" -acodec libmp3lame "${cdLooped}"`
    );
    if (sfxPath && await fileExists(sfxPath)) {
      // Overlay sfx at HINT_AT and FIFTY_AT using adelay
      const hMs = Math.round(HINT_AT  * 1000);
      const fMs = Math.round(FIFTY_AT * 1000);
      await execP(
        `ffmpeg -y -i "${cdLooped}" -i "${sfxPath}" -i "${sfxPath}" ` +
        `-filter_complex ` +
        `"[1:a]adelay=${hMs}|${hMs},aformat=fltp:44100:stereo,volume=0.85[s1];` +
        ` [2:a]adelay=${fMs}|${fMs},aformat=fltp:44100:stereo,volume=0.85[s2];` +
        ` [0:a][s1][s2]amix=inputs=3:duration=first:normalize=0[out]" ` +
        `-map "[out]" -t ${thinkSec} -acodec libmp3lame "${fgAu}"`
      );
    } else {
      await fs.copyFile(cdLooped, fgAu);
    }
  }, thinkSec);

  // ──────────────────────────────────────────────────────────────────────
  // STEP 9: TIME UP — timeup_text + timeup_audio_url (prerecorded preferred)
  // ──────────────────────────────────────────────────────────────────────
  await page.goto(`file://${htmlPath}`, { waitUntil:'networkidle0' });
  await addImgClip('.slide-timeup', 200, async fgAu => {
    const au = timeupAuPath || (() => {
      const p = path.join(workDir, 'timeup_tts.mp3');
      return mkTTS(quiz.timeup_text || "Time's up! Here comes the correct answer!", voice, p, 3);
    })();
    const resolved = typeof au === 'string' ? au : await au;
    await fs.copyFile(resolved, fgAu);
    return Math.max(await audioDur(fgAu), 2);
  });

  // ──────────────────────────────────────────────────────────────────────
  // STEP 10: ANSWER REVEAL — 0.5s gap, correct_answer_sfx + TTS
  // Correct highlighted, wrong dimmed
  // ──────────────────────────────────────────────────────────────────────
  await addImgClip('.slide-answer', 300, async fgAu => {
    const s05   = await sil(0.5);
    const sfx   = correctSfxPath || sfxPath;
    const ansTTS = path.join(workDir, 'ans_tts.mp3');
    await mkTTS(`The correct answer is: ${correct}`, voice, ansTTS, 2);
    await joinAudio([s05, sfx, ansTTS].filter(Boolean), fgAu);
    return Math.max(await audioDur(fgAu), 3);
  });

  // ──────────────────────────────────────────────────────────────────────
  // STEP 11: EXPLANATION — 0.5s gap, text + TTS (max 20 words per spec)
  // ──────────────────────────────────────────────────────────────────────
  await addImgClip('.slide-explanation', 200, async fgAu => {
    const s05    = await sil(0.5);
    const exTTS  = path.join(workDir, 'expl_tts.mp3');
    await mkTTS(expl, voice, exTTS, 2);
    await joinAudio([s05, exTTS], fgAu);
    return Math.max(await audioDur(fgAu), 3.5);
  });

  // ──────────────────────────────────────────────────────────────────────
  // STEP 12: CTA1 or CTA2
  // ──────────────────────────────────────────────────────────────────────
  if (useCTA1) {
    await addImgClip('.slide-cta1', 200, async fgAu => {
      const au = cta1AuPath || (() => {
        const p = path.join(workDir, 'cta1_tts.mp3');
        return mkTTS(quiz.affiliate_text || '', voice, p, 3);
      })();
      const r = typeof au === 'string' ? au : await au;
      await fs.copyFile(r, fgAu);
      return Math.max(await audioDur(fgAu), 3);
    });
  } else {
    await addImgClip('.slide-cta2', 200, async fgAu => {
      const au = cta2AuPath || (() => {
        const p = path.join(workDir, 'cta2_tts.mp3');
        return mkTTS(quiz.cta2_text || '', voice, p, 3);
      })();
      const r = typeof au === 'string' ? au : await au;
      await fs.copyFile(r, fgAu);
      return Math.max(await audioDur(fgAu), 3);
    });
  }

  // ──────────────────────────────────────────────────────────────────────
  // STEPS 13-16: MISSION IMPOSSIBLE (skip if not enabled)
  // ──────────────────────────────────────────────────────────────────────
  if (quiz.mission_impossible_enabled !== false && quiz.mission_impossible_question) {

    // STEP 13: MI Intro — mission_intro_text + mission_intro_audio_url (huge bold)
    await addImgClip('.slide-mi-intro', 300, async fgAu => {
      const au = miIntroAuPath || (() => {
        const p = path.join(workDir, 'mi_intro_tts.mp3');
        return mkTTS(
          quiz.mission_intro_text || 'Mission Impossible! Only a genius can answer this.',
          voice, p, 2
        );
      })();
      const r = typeof au === 'string' ? au : await au;
      await fs.copyFile(r, fgAu);
      return Math.max(await audioDur(fgAu), 2.5);
    });

    // STEP 14: MI Question appears — hold 1s (per spec: question on screen, no audio)
    await addImgClip('.slide-mi-question', 300, async fgAu => {
      await mkSilence(fgAu, 1.0);
      return 1.0;
    });

    // STEP 15: MI Hint — after 1s, hint text + sfx_audio_url
    await addImgClip('.slide-mi-hint', 200, async fgAu => {
      const sfx = sfxPath;
      const s03 = await sil(0.3);
      await joinAudio([s03, sfx].filter(Boolean), fgAu);
      return Math.max(await audioDur(fgAu), 2.5);
    });

    // STEP 16: CTA3 — 2.5s gap after MI hint, cta3_text + cta3_audio_url + url, hold 1s
    await addImgClip('.slide-cta3', 200, async fgAu => {
      const s25  = await sil(2.5);
      const cta3 = cta3AuPath || (() => {
        const p = path.join(workDir, 'cta3_tts.mp3');
        return mkTTS(
          quiz.cta3_text || 'Like, share, and challenge a friend! Subscribe for the answer!',
          voice, p, 4
        );
      })();
      const r    = typeof cta3 === 'string' ? cta3 : await cta3;
      const s10  = await sil(1.0); // hold 1s after audio
      await joinAudio([s25, r, s10], fgAu);
      return await audioDur(fgAu);
    });
  }

  await browser.close();

  // ──────────────────────────────────────────────────────────────────────
  // FINAL CONCAT
  // ──────────────────────────────────────────────────────────────────────
  const listPath = path.join(workDir, 'final.txt');
  await fs.writeFile(listPath, clips.map(c=>`file '${c.path}'`).join('\n'));
  const finalOut = path.join(workDir, 'final.mp4');
  await execP(
    `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:v libx264 -c:a aac -movflags +faststart "${finalOut}"`
  );
  console.log(`[W10] ${clips.length} clips | total ${clips.reduce((s,c)=>s+c.dur,0).toFixed(1)}s`);
  return finalOut;
}

// ── Run ───────────────────────────────────────────────────────────────────────
processNext()
  .then(() => { console.log('[W10] Done.'); process.exit(0); })
  .catch(err => { console.error('[W10] Fatal:', err); process.exit(1); });
