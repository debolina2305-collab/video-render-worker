'use strict';
const { exec }   = require('child_process');
const util       = require('util');
const execPromise = util.promisify(exec);
const fs         = require('fs').promises;
const path       = require('path');
const puppeteer  = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const { v4: uuidv4 } = require('uuid');

// ──────────────────────────────────────────────
// ENV
// ──────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
console.log('SUPABASE_URL:', supabaseUrl);
console.log('SUPABASE_SERVICE_KEY:', supabaseKey ? '*** (set)' : 'NOT SET');

const cleanUrl = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;
if (!cleanUrl || !supabaseKey) { console.error('Missing Supabase credentials'); process.exit(1); }

// ──────────────────────────────────────────────
// CONSTANTS
// ──────────────────────────────────────────────
const VOICE_MAP = {
  en: 'en-US-JennyNeural',
  hi: 'hi-IN-SwaraNeural',
  es: 'es-ES-ElviraNeural',
  pt: 'pt-BR-FranciscaNeural'
};
const THEMES_DIR    = path.join(__dirname, 'themes');
const CACHE_DIR     = path.join(__dirname, 'audio_cache');
const DEFAULT_THEME = 'particle_field';
const LOGO_PATH     = path.join(__dirname, 'assets', 'jaasX-logo-saved-for-web.png');
const DEFAULT_BG_MUSIC = 'https://pub-3578d297d3904e1d8ffedfc9dd4102f2.r2.dev/audio/background_music/The_Midnight_Audit.mp3';

const BG_VOL_BASE = 0.10;
const BG_VOL_DUCK = 0.035;
const DUCK_RAMP   = 0.12;

const GAP_DEFAULT     = 0.35;
const GAP_AFTER_STEP2 = 0.30;
const GAP_OPTIONS     = 0.70;
const GAP_ANSWER      = 0.50;
const GAP_EXPL        = 0.50;

const TIMEOUT_FFMPEG   = 120_000;
const TIMEOUT_CURL     = 35_000;
const TIMEOUT_TTS      = 40_000;
const TIMEOUT_RECORDER = 60_000;
const TIMEOUT_JOB      = 45 * 60 * 1000;

// ──────────────────────────────────────────────
// TIMEOUT WRAPPER
// ──────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms)
    )
  ]);
}

// ──────────────────────────────────────────────
// SUPABASE HELPER
// ──────────────────────────────────────────────
const baseHeaders = {
  apikey: supabaseKey,
  Authorization: `Bearer ${supabaseKey}`,
  'Content-Type': 'application/json'
};

async function fetchSupabase(p, opts = {}) {
  const url = `${cleanUrl}/rest/v1/${p}`;
  console.log(`[DB] ${opts.method || 'GET'} ${url}`);
  const hdrs = { ...baseHeaders, ...(opts.headers || {}) };
  if (opts.method && ['POST','PATCH','PUT'].includes(opts.method)) hdrs.Prefer = 'return=representation';
  const res = await fetch(url, { ...opts, headers: hdrs });
  if (!res.ok) { const t = await res.text(); throw new Error(`HTTP ${res.status}: ${t}`); }
  const text = await res.text();
  if (!text || text.trim() === '') return null;
  return JSON.parse(text);
}

// ──────────────────────────────────────────────
// AUDIO UTILITIES
// ──────────────────────────────────────────────
async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function extractUrl(raw, preferKey) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (preferKey && obj[preferKey]) return obj[preferKey];
      for (const v of Object.values(obj)) {
        if (typeof v === 'string' && v.startsWith('http')) return v;
      }
      return null;
    } catch { return null; }
  }
  return s;
}

function encodeR2Url(url) {
  if (!url) return url;
  const schemeIdx = url.indexOf('://');
  if (schemeIdx === -1) return url;
  const pathStart = url.indexOf('/', schemeIdx + 3);
  if (pathStart === -1) return url;
  const origin = url.slice(0, pathStart);
  const pathAndRest = url.slice(pathStart);
  let out = '';
  for (let i = 0; i < pathAndRest.length; i++) {
    const c = pathAndRest[i];
    if (c === '%' && /^[0-9A-Fa-f]{2}$/.test(pathAndRest.substr(i + 1, 2))) {
      out += pathAndRest.substr(i, 3); i += 2;
    } else if (/[A-Za-z0-9/?&=#.\-_~]/.test(c)) {
      out += c;
    } else {
      out += encodeURIComponent(c);
    }
  }
  return origin + out;
}

// ─────────────────────────────────────────────────────────────────
// FIX A: Download and ALWAYS convert to .mp3 (44100Hz stereo).
// Root cause of all "no audio" / "zig zig zig" issues:
// R2 stores files as .wav (various sample rates / mono / stereo).
// FFmpeg concat demuxer requires identical codec+samplerate across
// all inputs. Converting everything to mp3/44100/stereo on arrival
// ensures every piece fed to concatAudio is homogeneous.
// ─────────────────────────────────────────────────────────────────
async function downloadAudio(url, cacheKey, preferKey) {
  const resolved = extractUrl(url, preferKey);
  if (!resolved) return null;
  await ensureDir(CACHE_DIR);
  const encoded = encodeR2Url(resolved);
  const safe    = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  // Cache key always ends in .mp3 — we normalise on download
  const local   = path.join(CACHE_DIR, `${safe}.mp3`);
  if (await fileExists(local)) { console.log(`[CACHE HIT] ${safe}`); return local; }
  console.log(`[DOWNLOAD] ${encoded}`);
  const rawFile = path.join(CACHE_DIR, `${safe}_raw`);
  try {
    await withTimeout(
      execPromise(`curl -sL --fail "${encoded}" -o "${rawFile}" --max-time 30`),
      TIMEOUT_CURL, `download ${safe}`
    );
    if (!(await fileExists(rawFile))) return null;
    const st = await fs.stat(rawFile);
    if (st.size === 0) { await fs.unlink(rawFile).catch(() => {}); return null; }

    // Convert whatever format to normalised mp3 44100 stereo
    await withTimeout(
      execPromise(
        `ffmpeg -y -i "${rawFile}" -ar 44100 -ac 2 -acodec libmp3lame -q:a 4 "${local}"`
      ),
      TIMEOUT_FFMPEG, `convert ${safe}`
    );
    await fs.unlink(rawFile).catch(() => {});
    if (await fileExists(local)) return local;
  } catch (e) {
    console.warn(`[DOWNLOAD FAIL] ${safe}: ${e.message}`);
    await fs.unlink(rawFile).catch(() => {});
    await fs.unlink(local).catch(() => {});
  }
  return null;
}

async function audioDur(p) {
  try {
    const { stdout } = await withTimeout(
      execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`),
      10_000, `audioDur`
    );
    const d = parseFloat(stdout.trim());
    return isNaN(d) ? 0 : d;
  } catch { return 0; }
}
async function videoDur(p) { return audioDur(p); }

async function silence(sec, out) {
  const s = Math.max(parseFloat(sec) || 0.1, 0.05);
  await withTimeout(
    execPromise(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${s} -q:a 9 -acodec libmp3lame "${out}"`),
    15_000, `silence ${s}s`
  );
}

async function tts(text, voice, out, fallbackSec = 1.5) {
  const t = (text || '').trim();
  if (!t) { await silence(fallbackSec, out); return; }
  const tmp = out + '.txt';
  await fs.writeFile(tmp, t, 'utf8');
  try {
    await withTimeout(
      execPromise(`edge-tts --voice "${voice}" --file "${tmp}" --write-media "${out}"`),
      TIMEOUT_TTS, `tts`
    );
    if (!(await fileExists(out)) || (await audioDur(out)) === 0) {
      console.warn('[TTS WARN] Empty output, using silence');
      await silence(fallbackSec, out);
    }
  } catch (e) {
    console.warn(`[TTS WARN] ${e.message}`);
    await silence(fallbackSec, out);
  }
  await fs.unlink(tmp).catch(() => {});
}

async function ffmpeg(args, label) {
  await withTimeout(execPromise(`ffmpeg ${args}`), TIMEOUT_FFMPEG, label || 'ffmpeg');
}

async function concatAudio(parts, out, workDir) {
  const validParts = [];
  for (const p of parts) {
    if (p && await fileExists(p)) validParts.push(p);
  }
  if (validParts.length === 0) { await silence(0.5, out); return; }
  if (validParts.length === 1) { await fs.copyFile(validParts[0], out); return; }
  const listP = path.join(workDir, `cat_${uuidv4()}.txt`);
  await fs.writeFile(listP,
    validParts.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n')
  );
  await ffmpeg(`-y -f concat -safe 0 -i "${listP}" -ar 44100 -ac 2 -acodec libmp3lame "${out}"`, 'concatAudio');
  await fs.unlink(listP).catch(() => {});
}

async function buildAudio({ prerecorded, fallbackText, fallbackSec, voice, leadGap, workDir, name }) {
  const silP  = path.join(workDir, `${name}_gap.mp3`);
  const audioP= path.join(workDir, `${name}_src.mp3`);
  const outP  = path.join(workDir, `${name}_audio.mp3`);
  const gap   = leadGap != null ? leadGap : GAP_DEFAULT;
  await silence(gap, silP);
  if (prerecorded && await fileExists(prerecorded)) {
    await concatAudio([silP, prerecorded], outP, workDir);
  } else {
    await tts(fallbackText || '', voice, audioP, fallbackSec || 1.5);
    await concatAudio([silP, audioP], outP, workDir);
  }
  const dur = await audioDur(outP);
  return { path: outP, dur };
}

async function imgClip(img, audioP, dur, workDir, name) {
  const out = path.join(workDir, `${name}.mp4`);
  await ffmpeg(
    `-y -loop 1 -i "${img}" -i "${audioP}" ` +
    `-c:v libx264 -t ${dur} -pix_fmt yuv420p -r 30 ` +
    `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" ` +
    `-c:a aac -b:a 128k -ar 44100 -shortest "${out}"`,
    `imgClip ${name}`
  );
  return { path: out, dur };
}

// ──────────────────────────────────────────────
// BACKGROUND MUSIC DUCKING
// ──────────────────────────────────────────────
async function applyBgMusic(concatMp4, totalDur, voiceRanges, bgFile, workDir) {
  if (!bgFile || !(await fileExists(bgFile))) {
    console.log('[BGMUSIC] No bg music — skipping');
    return concatMp4;
  }
  const bgLooped   = path.join(workDir, 'bg_looped.mp3');
  const bgDucked   = path.join(workDir, 'bg_ducked.mp3');
  const fgAudio    = path.join(workDir, 'fg_audio.mp3');
  const mixedAudio = path.join(workDir, 'mixed_audio.mp3');
  const finalMp4   = path.join(workDir, 'final_with_music.mp4');

  await ffmpeg(`-y -stream_loop -1 -i "${bgFile}" -t ${totalDur} -af "volume=${BG_VOL_BASE}" -ar 44100 -acodec libmp3lame "${bgLooped}"`, 'bgLoop');

  if (voiceRanges.length > 0) {
    const ratio = (BG_VOL_DUCK / BG_VOL_BASE).toFixed(4);
    const filters = voiceRanges.map(r => {
      const s = Math.max(0, r.start - DUCK_RAMP).toFixed(3);
      const e = (r.end + DUCK_RAMP).toFixed(3);
      return `volume=enable='between(t,${s},${e})':volume=${ratio}`;
    }).join(',');
    await ffmpeg(`-y -i "${bgLooped}" -af "${filters}" -ar 44100 -acodec libmp3lame "${bgDucked}"`, 'bgDuck');
  } else {
    await fs.copyFile(bgLooped, bgDucked);
  }

  await ffmpeg(`-y -i "${concatMp4}" -vn -ar 44100 -acodec libmp3lame "${fgAudio}"`, 'extractFg');
  await ffmpeg(
    `-y -i "${fgAudio}" -i "${bgDucked}" ` +
    `-filter_complex "[0:a]volume=1.0[fg];[1:a]volume=1.0[bg];[fg][bg]amix=inputs=2:duration=first:dropout_transition=0[a]" ` +
    `-map "[a]" -ar 44100 -acodec libmp3lame "${mixedAudio}"`,
    'mixAudio'
  );
  // -t totalDur ensures bg music never extends the video beyond intended length
  await ffmpeg(
    `-y -i "${concatMp4}" -i "${mixedAudio}" -c:v copy -map 0:v:0 -map 1:a:0 ` +
    `-c:a aac -b:a 192k -t ${totalDur} -movflags +faststart "${finalMp4}"`,
    'remux'
  );
  return finalMp4;
}

// ──────────────────────────────────────────────
// THEME RESOLUTION (includes quiz_background_css)
// ──────────────────────────────────────────────
async function resolveTheme(quiz) {
  const base    = await fs.readFile(path.join(THEMES_DIR, '_base.css'), 'utf8');
  const themeId = quiz.visual_theme_id || DEFAULT_THEME;
  let themeFile = path.join(THEMES_DIR, `${themeId}.css`);
  if (!(await fileExists(themeFile))) {
    console.warn(`[THEME] '${themeId}' not found, using default`);
    themeFile = path.join(THEMES_DIR, `${DEFAULT_THEME}.css`);
  }
  let themeCss = base + '\n' + (await fs.readFile(themeFile, 'utf8'));
  const a1 = quiz.theme_accent_primary   || '#00e0ff';
  const a2 = quiz.theme_accent_secondary || '#7b2ff7';
  const a3 = quiz.theme_accent_tertiary  || '#ff2ec4';
  themeCss = themeCss
    .split('{{accent_primary}}').join(a1)
    .split('{{accent_secondary}}').join(a2)
    .split('{{accent_tertiary}}').join(a3);

  if (quiz.quiz_background_css && quiz.quiz_background_css.trim()) {
    console.log('[THEME] Applying quiz_background_css override');
    themeCss += '\n/* === QUIZ-SPECIFIC BACKGROUND OVERRIDE === */\n';
    themeCss += quiz.quiz_background_css;
  }
  return { themeCss, decoHtml: buildDecoHtml(themeId) };
}

function buildDecoHtml(id) {
  switch (id) {
    case 'particle_field':
      return '<div class="theme-deco">' +
        Array.from({length:18},(_,i)=>{
          const left=(i*5+2)%100, size=6+(i%5)*3, dur=8+(i%6)*2, delay=(i*0.7)%10;
          return `<div class="particle" style="left:${left}%;bottom:-20px;width:${size}px;height:${size}px;animation-duration:${dur}s;animation-delay:${delay}s;"></div>`;
        }).join('') + '</div>';
    default: return '';
  }
}

// ──────────────────────────────────────────────
// LOGO DATA URI
// ──────────────────────────────────────────────
async function getLogoDataUri() {
  try {
    const buf = await fs.readFile(LOGO_PATH);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn(`[LOGO] ${e.message}`);
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }
}

// ──────────────────────────────────────────────
// JOB PROCESSING
// ──────────────────────────────────────────────
async function processJobs() {
  console.log('[WORKER] Checking for pending quizzes...');

  // Recover stuck 'processing' rows older than 30 min
  const stuckCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const stuckRows = await fetchSupabase(
    `quiz?video_status=eq.processing&is_active=eq.true&updated_at=lt.${stuckCutoff}&select=id,topic&limit=5`
  ).catch(() => null);
  if (stuckRows?.length) {
    console.log(`[WORKER] Resetting ${stuckRows.length} stuck rows → pending`);
    for (const r of stuckRows) {
      await fetchSupabase(`quiz?id=eq.${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ video_status: 'pending', updated_at: new Date().toISOString() })
      }).catch(() => {});
    }
  }

  const rows = await fetchSupabase(
    'quiz?video_status=eq.pending&is_active=eq.true' +
    '&quiz_enriched=eq.true&select=*&order=created_at.asc&limit=1'
  );

  if (!rows || rows.length === 0) { console.log('[WORKER] No pending quizzes.'); return; }

  const quiz = rows[0];
  console.log(`[WORKER] Processing quiz: ${quiz.id} — ${quiz.topic}`);

  await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ video_status: 'processing', updated_at: new Date().toISOString() })
  });

  const workDir = `/tmp/video_${uuidv4()}`;
  await ensureDir(workDir);

  try {
    const videoPath = await withTimeout(
      buildVideo(quiz, workDir), TIMEOUT_JOB, `buildVideo ${quiz.id}`
    );
    const stats  = await fs.stat(videoPath);
    const sizeMb = parseFloat((stats.size / (1024 * 1024)).toFixed(2));
    const dur    = await videoDur(videoPath);
    console.log(`[WORKER] Done. Duration: ${dur.toFixed(2)}s, Size: ${sizeMb}MB`);

    const artifactPath = `/tmp/${quiz.id}_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);
    await fs.writeFile('/tmp/artifact_ready', artifactPath);

    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        video_status: 'rendered',
        render_duration_sec: Math.round(dur),
        file_size_mb: sizeMb,
        updated_at: new Date().toISOString()
      })
    });
    await fs.rm(workDir, { recursive: true, force: true });
    console.log(`[WORKER] Artifact: ${artifactPath}`);

  } catch (err) {
    console.error('[WORKER] FAILED:', err.message);
    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        video_status: 'error',
        generation_error: String(err.message || err).slice(0, 800),
        updated_at: new Date().toISOString()
      })
    });
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ──────────────────────────────────────────────
// MAIN VIDEO BUILDER
// ──────────────────────────────────────────────
async function buildVideo(quiz, workDir) {
  const lang  = quiz.lang_code || 'en';
  const voice = VOICE_MAP[lang] || VOICE_MAP.en;
  const niche = quiz.niche || 'general';

  const question    = quiz.question_1       || '';
  const options     = quiz.options_1        || [];
  const correct     = quiz.correct_answer_1 || '';
  const explanation = quiz.explanation_1    || '';
  const hint        = quiz.hint_1           || '';
  const keep5050    = quiz.keep_5050_1      || [];
  const introSpeech = quiz.quiz_intro_speech || '';

  const QTIME    = quiz.thinking_time_sec || 9;
  const HINT_AT  = QTIME / 4;
  const FIFTY_AT = QTIME / 2;

  const allIdx   = [0,1,2,3];
  const keepIdx  = keep5050.map(v => (typeof v === 'string' ? parseInt(v) : v));
  const elimIdx  = allIdx.filter(i => !keepIdx.includes(i));
  const optClass = i => elimIdx.includes(i) ? 'eliminate' : '';
  const revClass = i => options[i] === correct ? 'correct' : 'wrong';
  const hasCta1  = !!(quiz.affiliate_url && quiz.affiliate_url.trim());

  console.log('[LOGO] Loading...');
  const logoDataUri = await getLogoDataUri();

  console.log('[AUDIO] Downloading...');
  const [
    hookFile, questionIntroFile, optionsIntroFile,
    timeupFile, cta1AudioFile, cta2AudioFile,
    missionIntroFile, cta3AudioFile,
    sfxFile, countdownFile, bgFile, correctSfxFile
  ] = await Promise.all([
    downloadAudio(quiz.hook_audio_url,               `hook_${quiz.id}`),
    downloadAudio(quiz.question_intro_audio_url,     `qintro_${quiz.id}`),
    downloadAudio(quiz.options_intro_audio_url,      `ointro_${quiz.id}`),
    downloadAudio(quiz.timeup_audio_url,             `timeup_${quiz.id}`),
    downloadAudio(quiz.cta1_audio_url,               `cta1_${quiz.id}`),
    downloadAudio(quiz.cta2_audio_url,               `cta2_${quiz.id}`),
    downloadAudio(quiz.mission_intro_audio_url,      `missintro_${quiz.id}`),
    downloadAudio(quiz.cta3_audio_url,               `cta3_${quiz.id}`),
    downloadAudio(quiz.sfx_audio_url,                `sfx_${quiz.id}`, 'question_appear'),
    downloadAudio(quiz.countdown_music,              `countdown_${quiz.id}`),
    downloadAudio(quiz.background_music || DEFAULT_BG_MUSIC, `bgmusic_${quiz.id}`),
    downloadAudio(quiz.correct_answer_sfx_audio_url, `correctsfx_${quiz.id}`)
  ]);

  const { themeCss, decoHtml } = await resolveTheme(quiz);

  let html = await fs.readFile(path.join(__dirname, 'quiz_template.html'), 'utf8');
  const R = {
    '{{theme_css}}':          themeCss,
    '{{theme_deco_html}}':    decoHtml,
    '{{LOGO_DATA_URI}}':      logoDataUri,
    '{{hook_phrase}}':        quiz.hook_phrase || 'Stop scrolling! Can you beat this?',
    '{{quiz_intro_speech}}':  introSpeech,
    '{{question}}':           question,
    '{{options[0]}}':         options[0] || '',
    '{{options[1]}}':         options[1] || '',
    '{{options[2]}}':         options[2] || '',
    '{{options[3]}}':         options[3] || '',
    '{{opt0_class}}':         optClass(0),
    '{{opt1_class}}':         optClass(1),
    '{{opt2_class}}':         optClass(2),
    '{{opt3_class}}':         optClass(3),
    '{{rev0_class}}':         revClass(0),
    '{{rev1_class}}':         revClass(1),
    '{{rev2_class}}':         revClass(2),
    '{{rev3_class}}':         revClass(3),
    '{{hint}}':               hint,
    '{{correct_answer}}':     correct,
    '{{explanation}}':        explanation,
    '{{affiliate_text}}':     quiz.affiliate_text || 'Check the link in description!',
    '{{cta2_text}}':          quiz.cta2_text || 'Play real quiz and earn ONS tokens!',
    '{{cta3_text}}':          quiz.cta3_text || 'Like, Share & Challenge a friend! Subscribe!',
    '{{niche}}':              niche,
    '{{mission_intro_text}}': quiz.mission_intro_text || 'Are you smart enough?',
    '{{mission_question}}':   quiz.mission_impossible_question || '',
    '{{mission_hint}}':       quiz.mission_impossible_hint || '',
    '{{qtime}}':              QTIME,
    '{{hint_time}}':          HINT_AT,
    '{{fiftyfifty_time}}':    FIFTY_AT
  };
  for (const [k,v] of Object.entries(R)) html = html.split(k).join(String(v ?? ''));

  const htmlPath = path.join(workDir, 'index.html');
  await fs.writeFile(htmlPath, html);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--disable-web-security','--allow-file-access-from-files'
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 600));

  const showOnly = async sel => {
    await page.evaluate(s => {
      document.querySelectorAll('.screen').forEach(e => e.classList.remove('active'));
      const el = document.querySelector(s);
      if (el) el.classList.add('active');
    }, sel);
    await new Promise(r => setTimeout(r, 150));
  };

  const shot = async name => {
    const p = path.join(workDir, `${name}.png`);
    await page.screenshot({ path: p });
    return p;
  };

  const clips       = [];
  const voiceRanges = [];
  let cursor = 0;
  function pushClip(clip, isVoice = true) {
    if (isVoice) voiceRanges.push({ start: cursor, end: cursor + clip.dur });
    cursor += clip.dur;
    clips.push(clip);
  }

  // ════════ STEP 1: HOOK (min 3s) ════════
  await showOnly('.hook-slide');
  await new Promise(r => setTimeout(r, 1100)); // let logo animation start
  const hookImg = await shot('hook');
  const hookAudio = await buildAudio({
    prerecorded: hookFile,
    fallbackText: quiz.hook_phrase || 'Stop scrolling! Can you beat this?',
    fallbackSec: 2.5, voice, leadGap: 0.1, workDir, name: 'hook'
  });
  // FIX 1a: enforce minimum 3s so viewer can read hook text
  pushClip(await imgClip(hookImg, hookAudio.path, Math.max(hookAudio.dur, 3.0), workDir, 'clip_hook'));

  // ════════ STEP 2: quiz_intro_speech (text + TTS) ════════
  // FIX 2a/2b: show quiz_intro_speech text on waiting-slide + TTS
  await showOnly('.waiting-slide');
  await new Promise(r => setTimeout(r, 300));
  const waitImg = await shot('waiting');
  // Audio: question_intro prerecorded OR TTS of quiz_intro_speech
  const step2Audio = await buildAudio({
    prerecorded: questionIntroFile,
    fallbackText: introSpeech || 'Here is your challenge!',
    fallbackSec: 2.0, voice, leadGap: GAP_AFTER_STEP2, workDir, name: 'step2'
  });
  pushClip(await imgClip(waitImg, step2Audio.path, step2Audio.dur, workDir, 'clip_step2'));

  // ════════ STEP 3: Question appears (SFX + TTS) ════════
  await showOnly('.question-appear-slide');
  await new Promise(r => setTimeout(r, 700));
  const qAppearImg = await shot('question_appear');
  const qTtsPath = path.join(workDir, 'q_tts.mp3');
  await tts(question, voice, qTtsPath, 3);
  const step3Parts = [];
  if (sfxFile) {
    const sfxGap = path.join(workDir, 'sfx_gap.mp3');
    await silence(0.15, sfxGap);
    step3Parts.push(sfxFile, sfxGap, qTtsPath);
  } else {
    step3Parts.push(qTtsPath);
  }
  const step3Combined = path.join(workDir, 'step3.mp3');
  await concatAudio(step3Parts, step3Combined, workDir);
  pushClip(await imgClip(qAppearImg, step3Combined, Math.max(await audioDur(step3Combined), 2), workDir, 'clip_step3'));

  // ════════ STEP 4-5: Options appear ════════
  await showOnly('.question-static');
  await new Promise(r => setTimeout(r, 900));
  const optionsImg = await shot('options_static');
  const step45Parts = [];
  const gap4Path = path.join(workDir, 'gap4.mp3');
  await silence(GAP_OPTIONS, gap4Path);
  step45Parts.push(gap4Path);
  if (optionsIntroFile) {
    step45Parts.push(optionsIntroFile);
  } else {
    const ointroTts = path.join(workDir, 'ointro_tts.mp3');
    await tts('And your options are', voice, ointroTts, 1.5);
    step45Parts.push(ointroTts);
  }
  const gap5Path = path.join(workDir, 'gap5.mp3');
  await silence(0.3, gap5Path);
  step45Parts.push(gap5Path);
  if (sfxFile) {
    const sfxGap2 = path.join(workDir, 'sfxgap2.mp3');
    await silence(0.1, sfxGap2);
    step45Parts.push(sfxFile, sfxGap2);
  }
  for (let i = 0; i < options.length; i++) {
    if (!options[i]) continue;
    const oSil = path.join(workDir, `o_sil_${i}.mp3`);
    const oTts = path.join(workDir, `o_tts_${i}.mp3`);
    await silence(0.25, oSil);
    await tts(`${String.fromCharCode(65+i)}. ${options[i]}`, voice, oTts, 1);
    step45Parts.push(oSil, oTts);
  }

  // FIX 7: Add TTS "You have only X seconds to crack the challenge — time starts now!"
  const startNowTts = path.join(workDir, 'start_now.mp3');
  const startNowGap = path.join(workDir, 'start_now_gap.mp3');
  await silence(0.4, startNowGap);
  await tts(
    `You have only ${QTIME} seconds to crack the challenge — time starts now!`,
    voice, startNowTts, 2
  );
  step45Parts.push(startNowGap, startNowTts);

  const step45Combined = path.join(workDir, 'step45.mp3');
  await concatAudio(step45Parts, step45Combined, workDir);
  pushClip(await imgClip(optionsImg, step45Combined, Math.max(await audioDur(step45Combined), 3), workDir, 'clip_step45'));

  // ════════ STEP 6-8: COUNTDOWN (screen recorded) ════════
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 400));
  await showOnly('.question-phase');
  await page.evaluate(() => { document.querySelector('.question-phase')?.offsetHeight; });
  await new Promise(r => setTimeout(r, 100));

  const rawVideo = path.join(workDir, 'phase_raw.mp4');
  const recorder = new PuppeteerScreenRecorder(page, {
    fps: 30,
    videoFrame: { width: 1080, height: 1920 },
    aspectRatio: '9:16'
  });
  await recorder.start(rawVideo);
  await new Promise(r => setTimeout(r, QTIME * 1000));
  await withTimeout(recorder.stop(), TIMEOUT_RECORDER, 'recorder.stop()');

  const cdBase = path.join(workDir, 'cd_base.mp3');
  if (countdownFile) {
    await ffmpeg(`-y -stream_loop -1 -i "${countdownFile}" -t ${QTIME} -af "volume=0.75" -ar 44100 -acodec libmp3lame "${cdBase}"`, 'cdLoop');
  } else {
    await silence(QTIME, cdBase);
  }
  let cdFinal = cdBase;
  if (sfxFile) {
    const stingMixed = path.join(workDir, 'cd_mixed.mp3');
    const hMs = Math.round(HINT_AT  * 1000);
    const fMs = Math.round(FIFTY_AT * 1000);
    await ffmpeg(
      `-y -i "${cdBase}" -i "${sfxFile}" -i "${sfxFile}" ` +
      `-filter_complex "[1:a]adelay=${hMs}|${hMs}[s0];[2:a]adelay=${fMs}|${fMs}[s1];[0:a][s0][s1]amix=inputs=3:duration=first[a]" ` +
      `-map "[a]" -t ${QTIME} -ar 44100 -acodec libmp3lame "${stingMixed}"`,
      'cdStings'
    );
    cdFinal = stingMixed;
  }

  const qClipRaw  = path.join(workDir, 'phase_h264.mp4');
  const qClipPath = path.join(workDir, 'clip_countdown.mp4');
  await ffmpeg(`-y -i "${rawVideo}" -c:v libx264 -pix_fmt yuv420p -r 30 -vf "scale=1080:1920" "${qClipRaw}"`, 'reencodeRecording');
  await ffmpeg(`-y -i "${qClipRaw}" -i "${cdFinal}" -c:v libx264 -c:a aac -b:a 128k -ar 44100 -map 0:v:0 -map 1:a:0 -shortest -t ${QTIME} "${qClipPath}"`, 'countdownClip');
  pushClip({ path: qClipPath, dur: await videoDur(qClipPath) });

  // ════════ STEP 9: timeup (audio only, no text) ════════
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 300));
  await showOnly('.pre-reveal-slide');
  const preRevealImg = await shot('pre_reveal');
  const timeupAudio = await buildAudio({
    prerecorded: timeupFile,
    fallbackText: quiz.timeup_text || "Time's up! Let's reveal the correct answer.",
    fallbackSec: 2, voice, leadGap: GAP_DEFAULT, workDir, name: 'timeup'
  });
  pushClip(await imgClip(preRevealImg, timeupAudio.path, timeupAudio.dur, workDir, 'clip_timeup'));

  // ════════ STEP 10: Answer reveal ════════
  await showOnly('.answer-slide');
  await new Promise(r => setTimeout(r, 300));
  const answerImg = await shot('answer');
  const step10Parts = [];
  const silReveal = path.join(workDir, 'sil_reveal.mp3');
  await silence(GAP_ANSWER, silReveal);
  step10Parts.push(silReveal);
  if (correctSfxFile) {
    step10Parts.push(correctSfxFile);
    const sfxGap3 = path.join(workDir, 'sfxgap3.mp3');
    await silence(0.2, sfxGap3);
    step10Parts.push(sfxGap3);
  }
  const correctTts = path.join(workDir, 'correct_tts.mp3');
  await tts(correct, voice, correctTts, 1.5);
  step10Parts.push(correctTts);
  const step10Combined = path.join(workDir, 'step10.mp3');
  await concatAudio(step10Parts, step10Combined, workDir);
  pushClip(await imgClip(answerImg, step10Combined, Math.max(await audioDur(step10Combined), 2), workDir, 'clip_answer'));

  // ════════ STEP 11: Explanation ════════
  await showOnly('.explanation-slide');
  await new Promise(r => setTimeout(r, 400));
  const explImg = await shot('explanation');
  const explSil = path.join(workDir, 'expl_sil.mp3');
  const explTts = path.join(workDir, 'expl_tts.mp3');
  await silence(GAP_EXPL, explSil);
  await tts(explanation, voice, explTts, 3);
  const explCombined = path.join(workDir, 'expl.mp3');
  await concatAudio([explSil, explTts], explCombined, workDir);
  pushClip(await imgClip(explImg, explCombined, Math.max(await audioDur(explCombined), 3), workDir, 'clip_expl'));

  // ════════ STEP 12/13: CTA ════════
  const ctaSlide = hasCta1 ? '.cta1-slide' : '.cta2-slide';
  await showOnly(ctaSlide);
  await new Promise(r => setTimeout(r, 400));
  const ctaImg = await shot('cta');
  const ctaAudio = await buildAudio({
    prerecorded: hasCta1 ? cta1AudioFile : cta2AudioFile,
    fallbackText: hasCta1
      ? (quiz.affiliate_text || 'Check the link in description!')
      : (quiz.cta2_text || 'Play real quiz and earn ONS tokens!'),
    fallbackSec: 3, voice, leadGap: GAP_DEFAULT, workDir,
    name: hasCta1 ? 'cta1' : 'cta2'
  });
  pushClip(await imgClip(ctaImg, ctaAudio.path, ctaAudio.dur, workDir, 'clip_cta'));

  // ════════ STEPS 14-18: MISSION IMPOSSIBLE ════════
  if (quiz.mission_impossible_enabled !== false && quiz.mission_impossible_question) {

    // STEP 14: MI intro — FIX 21: play sfxFile on this slide
    await showOnly('.mission-intro-slide');
    await new Promise(r => setTimeout(r, 400));
    const miIntroImg = await shot('mi_intro');

    const miIntroParts = [];
    // FIX 21: SFX sting plays first on MI intro
    if (sfxFile) {
      const sfxGapMI = path.join(workDir, 'sfx_gap_mi.mp3');
      await silence(0.2, sfxGapMI);
      miIntroParts.push(sfxGapMI, sfxFile);
      const sfxGapMI2 = path.join(workDir, 'sfx_gap_mi2.mp3');
      await silence(0.3, sfxGapMI2);
      miIntroParts.push(sfxGapMI2);
    }
    if (missionIntroFile) {
      miIntroParts.push(missionIntroFile);
    } else {
      const miIntroTts = path.join(workDir, 'mi_intro_tts.mp3');
      await tts(quiz.mission_intro_text || 'MISSION IMPOSSIBLE!', voice, miIntroTts, 2);
      miIntroParts.push(miIntroTts);
    }
    const miIntroAudio = path.join(workDir, 'mi_intro_audio.mp3');
    if (miIntroParts.length > 0) {
      await concatAudio(miIntroParts, miIntroAudio, workDir);
    } else {
      await silence(2, miIntroAudio);
    }
    const miIntroDur = Math.max(await audioDur(miIntroAudio), 2);
    pushClip(await imgClip(miIntroImg, miIntroAudio, miIntroDur, workDir, 'clip_mi_intro'));

    // STEP 15: MI question — FIX 23: NO TTS, static image only
    await showOnly('.mission-final-slide');
    await page.evaluate(() => {
      const hint = document.getElementById('mi-hint');
      const cta3 = document.getElementById('mi-cta3');
      if (hint) { hint.classList.remove('shown'); hint.style.opacity = '0'; hint.style.transform = 'scale(0.9)'; }
      if (cta3) { cta3.classList.remove('show-cta3'); cta3.style.opacity = '0'; cta3.style.transform = 'translateY(30px) scale(0.9)'; }
    });
    await new Promise(r => setTimeout(r, 500));
    const miQImg = await shot('mi_question');
    // 1.0s silent hold before hint appears (no TTS)
    const miQSilPath = path.join(workDir, 'mi_q_sil.mp3');
    await silence(1.0, miQSilPath);
    pushClip(await imgClip(miQImg, miQSilPath, 1.0, workDir, 'clip_mi_q'), false);

    // STEP 16: Hint appears (FIX 24: add .shown, screenshot AFTER)
    await page.evaluate(() => {
      const hint = document.getElementById('mi-hint');
      if (hint) { hint.classList.add('shown'); hint.style.opacity = ''; hint.style.transform = ''; }
    });
    await new Promise(r => setTimeout(r, 400)); // let CSS transition finish
    const miHintImg = await shot('mi_hint');
    // SFX + 2.5s silence before CTA3 (FIX 25: this ensures CTA3 is separate)
    const miHintParts = [];
    if (sfxFile) miHintParts.push(sfxFile);
    const miHintSil = path.join(workDir, 'mi_hint_sil.mp3');
    await silence(2.5, miHintSil);
    miHintParts.push(miHintSil);
    const miHintAudio = path.join(workDir, 'mi_hint_audio.mp3');
    await concatAudio(miHintParts, miHintAudio, workDir);
    pushClip(await imgClip(miHintImg, miHintAudio, await audioDur(miHintAudio), workDir, 'clip_mi_hint'), false);

    // STEP 17: CTA3 revealed (its own clip → appears AFTER hint clip)
    await page.evaluate(() => {
      const cta3 = document.getElementById('mi-cta3');
      if (cta3) { cta3.classList.add('show-cta3'); cta3.style.opacity = ''; cta3.style.transform = ''; }
    });
    await new Promise(r => setTimeout(r, 500));
    const cta3Img = await shot('cta3');
    const cta3Audio = await buildAudio({
      prerecorded: cta3AudioFile,
      fallbackText: quiz.cta3_text || 'Like, share and challenge a friend! Subscribe!',
      fallbackSec: 4, voice, leadGap: 0.2, workDir, name: 'cta3'
    });
    pushClip(await imgClip(cta3Img, cta3Audio.path, cta3Audio.dur, workDir, 'clip_cta3'));

    // STEP 18: FIX 27 — hold exactly 1s (cta3Img reused)
    const holdSil = path.join(workDir, 'hold_sil.mp3');
    await silence(1.0, holdSil);
    pushClip(await imgClip(cta3Img, holdSil, 1.0, workDir, 'clip_hold'), false);
  }

  await browser.close();

  // ════════ FINAL ASSEMBLY ════════
  console.log(`[VIDEO] Assembling ${clips.length} clips...`);
  const concatTxt = path.join(workDir, 'concat.txt');
  await fs.writeFile(concatTxt,
    clips.map(c => `file '${c.path.replace(/'/g, "'\\''")}'`).join('\n')
  );
  const concatenated = path.join(workDir, 'concatenated.mp4');
  await ffmpeg(
    `-y -f concat -safe 0 -i "${concatTxt}" -c:v libx264 -pix_fmt yuv420p -r 30 ` +
    `-c:a aac -b:a 128k -ar 44100 -movflags +faststart "${concatenated}"`,
    'finalConcat'
  );
  const total = await videoDur(concatenated);
  console.log(`[VIDEO] Concatenated: ${total.toFixed(2)}s`);
  return applyBgMusic(concatenated, total, voiceRanges, bgFile, workDir);
}

processJobs()
  .then(() => { console.log('[WORKER] Run complete.'); process.exit(0); })
  .catch(err => { console.error('[WORKER] Fatal:', err); process.exit(1); });
