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
const THEMES_DIR = path.join(__dirname, 'themes');
const CACHE_DIR  = path.join(__dirname, 'audio_cache');
const DEFAULT_THEME = 'particle_field';

// FIX #1: Logo path resolved from assets folder
const LOGO_PATH = path.join(__dirname, 'assets', 'jaasX-logo-saved-for-web.png');

// Background music: default R2 URL (used if quiz.background_music is null)
const DEFAULT_BG_MUSIC = 'https://pub-3578d297d3904e1d8ffedfc9dd4102f2.r2.dev/audio/background_music/The_Midnight_Audit.mp3';

// Audio levels
const BG_VOL_BASE  = 0.10;   // very soft background
const BG_VOL_DUCK  = 0.035;  // ducked ~65% when voice plays
const DUCK_RAMP    = 0.12;   // fade window in seconds

// Human-like gaps
const GAP_DEFAULT     = 0.35;
const GAP_AFTER_STEP2 = 0.30;
const GAP_OPTIONS     = 0.70;
const GAP_ANSWER      = 0.50;
const GAP_EXPL        = 0.50;

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

// Some columns (e.g. sfx_audio_url) may contain a JSON object string instead
// of a plain URL, like {"question_appear":"...","countdown_loop":"..."}.
// This extracts a usable URL: if JSON, prefer the given key, else first URL value.
function extractUrl(raw, preferKey) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Looks like JSON object?
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (preferKey && obj[preferKey]) return obj[preferKey];
      // fall back to first non-null string value that looks like a URL
      for (const v of Object.values(obj)) {
        if (typeof v === 'string' && v.startsWith('http')) return v;
      }
      return null;
    } catch {
      return null; // malformed JSON → treat as no URL
    }
  }
  return s; // plain URL
}

// Make an R2 URL safe for curl WITHOUT double-encoding values that are already
// percent-encoded in the DB. We only touch the path, and only encode characters
// that curl/HTTP won't accept raw — while leaving existing %XX escapes intact.
function encodeR2Url(url) {
  if (!url) return url;
  const schemeIdx = url.indexOf('://');
  if (schemeIdx === -1) return url;
  const afterScheme = schemeIdx + 3;
  const pathStart = url.indexOf('/', afterScheme);
  if (pathStart === -1) return url; // no path to encode
  const origin = url.slice(0, pathStart);
  const pathAndRest = url.slice(pathStart);

  // Encode char-by-char. Preserve existing valid %XX escapes. Leave structural
  // chars (/ ? & = # . - _ ~) alone. Encode everything else that's unsafe.
  let out = '';
  for (let i = 0; i < pathAndRest.length; i++) {
    const c = pathAndRest[i];
    if (c === '%' && /^[0-9A-Fa-f]{2}$/.test(pathAndRest.substr(i + 1, 2))) {
      out += pathAndRest.substr(i, 3); // already-encoded escape, keep as-is
      i += 2;
    } else if (/[A-Za-z0-9\/?&=#.\-_~]/.test(c)) {
      out += c; // safe / structural char
    } else {
      out += encodeURIComponent(c); // raw unsafe char (space, %, comma, ', etc.)
    }
  }
  return origin + out;
}

async function downloadAudio(url, cacheKey, preferKey) {
  const resolved = extractUrl(url, preferKey);
  if (!resolved) return null;
  await ensureDir(CACHE_DIR);
  const encoded = encodeR2Url(resolved);
  let ext = '.mp3';
  try { ext = path.extname(new URL(encoded).pathname) || '.mp3'; } catch {}
  const safe = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const local = path.join(CACHE_DIR, `${safe}${ext}`);
  if (await fileExists(local)) { console.log(`[CACHE HIT] ${safe}`); return local; }
  console.log(`[DOWNLOAD] ${encoded}`);
  try {
    await execPromise(`curl -sL --fail "${encoded}" -o "${local}" --max-time 30`);
    if (await fileExists(local)) {
      const st = await fs.stat(local);
      if (st.size > 0) return local;
      await fs.unlink(local).catch(() => {});
    }
  } catch (e) {
    console.warn(`[DOWNLOAD FAIL] ${e.message}`);
    await fs.unlink(local).catch(() => {});
  }
  return null;
}

async function audioDur(p) {
  try {
    const { stdout } = await execPromise(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`
    );
    const d = parseFloat(stdout.trim());
    return isNaN(d) ? 0 : d;
  } catch { return 0; }
}

async function videoDur(p) {
  return audioDur(p); // same ffprobe call
}

async function silence(sec, out) {
  const s = Math.max(parseFloat(sec) || 0.1, 0.05);
  await execPromise(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${s} -q:a 9 -acodec libmp3lame "${out}"`);
}

async function tts(text, voice, out, fallbackSec = 1.5) {
  const t = (text || '').trim();
  if (!t) { await silence(fallbackSec, out); return; }
  const tmp = out + '.txt';
  await fs.writeFile(tmp, t, 'utf8');
  try {
    await execPromise(`edge-tts --voice "${voice}" --file "${tmp}" --write-media "${out}"`);
    // Verify edge-tts actually produced audio
    if (!(await fileExists(out)) || (await audioDur(out)) === 0) {
      console.warn(`[TTS WARN] edge-tts produced empty output, using silence`);
      await silence(fallbackSec, out);
    }
  } catch (e) {
    console.warn(`[TTS WARN] edge-tts failed: ${e.message}, using silence fallback`);
    await silence(fallbackSec, out);
  }
  await fs.unlink(tmp).catch(() => {});
}

// FIX #6: Concatenate audio files — filters out null/undefined/missing parts
async function concatAudio(parts, out, workDir) {
  const validParts = [];
  for (const p of parts) {
    if (p && await fileExists(p)) validParts.push(p);
  }
  if (validParts.length === 0) { await silence(0.5, out); return; }
  if (validParts.length === 1) { await fs.copyFile(validParts[0], out); return; }
  const listP = path.join(workDir, `cat_${uuidv4()}.txt`);
  const lines = validParts
    .map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
    .join('\n');
  await fs.writeFile(listP, lines);
  // re-encode (not copy) to normalise sample rate / codec across mixed sources
  await execPromise(`ffmpeg -y -f concat -safe 0 -i "${listP}" -ar 44100 -acodec libmp3lame "${out}"`);
  await fs.unlink(listP).catch(() => {});
}

// Build audio: optional leading silence + audio (prerecorded or TTS fallback)
async function buildAudio({ prerecorded, fallbackText, fallbackSec, voice, leadGap, workDir, name }) {
  const silP   = path.join(workDir, `${name}_gap.mp3`);
  const audioP = path.join(workDir, `${name}_src.mp3`);
  const outP   = path.join(workDir, `${name}_audio.mp3`);
  const gap    = leadGap != null ? leadGap : GAP_DEFAULT;

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

// Make a clip: static image + audio track → mp4 (h264/yuv420p/30fps)
async function imgClip(img, audioP, dur, workDir, name) {
  const out = path.join(workDir, `${name}.mp4`);
  await execPromise(
    `ffmpeg -y -loop 1 -i "${img}" -i "${audioP}" ` +
    `-c:v libx264 -t ${dur} -pix_fmt yuv420p -r 30 -vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" ` +
    `-c:a aac -b:a 128k -ar 44100 -shortest "${out}"`
  );
  return { path: out, dur };
}

// ──────────────────────────────────────────────
// BACKGROUND MUSIC DUCKING
// ──────────────────────────────────────────────
async function applyBgMusic(concatMp4, totalDur, voiceRanges, bgFile, workDir) {
  if (!bgFile || !(await fileExists(bgFile))) {
    console.log('[BGMUSIC] No bg music file — skipping ducking');
    return concatMp4;
  }

  const bgLooped = path.join(workDir, 'bg_looped.mp3');
  await execPromise(
    `ffmpeg -y -stream_loop -1 -i "${bgFile}" -t ${totalDur} -af "volume=${BG_VOL_BASE}" -ar 44100 -acodec libmp3lame "${bgLooped}"`
  );

  const bgDucked = path.join(workDir, 'bg_ducked.mp3');
  if (voiceRanges.length > 0) {
    const ratio = (BG_VOL_DUCK / BG_VOL_BASE).toFixed(4);
    const filters = voiceRanges.map(r => {
      const s = Math.max(0, r.start - DUCK_RAMP).toFixed(3);
      const e = (r.end + DUCK_RAMP).toFixed(3);
      return `volume=enable='between(t,${s},${e})':volume=${ratio}`;
    }).join(',');
    await execPromise(`ffmpeg -y -i "${bgLooped}" -af "${filters}" -ar 44100 -acodec libmp3lame "${bgDucked}"`);
  } else {
    await fs.copyFile(bgLooped, bgDucked);
  }

  const fgAudio = path.join(workDir, 'fg_audio.mp3');
  await execPromise(`ffmpeg -y -i "${concatMp4}" -vn -ar 44100 -acodec libmp3lame "${fgAudio}"`);

  const mixedAudio = path.join(workDir, 'mixed_audio.mp3');
  await execPromise(
    `ffmpeg -y -i "${fgAudio}" -i "${bgDucked}" ` +
    `-filter_complex "[0:a]volume=1.0[fg];[1:a]volume=1.0[bg];[fg][bg]amix=inputs=2:duration=first:dropout_transition=0[a]" ` +
    `-map "[a]" -ar 44100 -acodec libmp3lame "${mixedAudio}"`
  );

  const finalMp4 = path.join(workDir, 'final_with_music.mp4');
  await execPromise(
    `ffmpeg -y -i "${concatMp4}" -i "${mixedAudio}" -c:v copy -map 0:v:0 -map 1:a:0 -c:a aac -b:a 192k -shortest -movflags +faststart "${finalMp4}"`
  );
  return finalMp4;
}

// ──────────────────────────────────────────────
// THEME RESOLUTION
// ──────────────────────────────────────────────
async function resolveTheme(quiz) {
  const base = await fs.readFile(path.join(THEMES_DIR, '_base.css'), 'utf8');
  const themeId = quiz.visual_theme_id || DEFAULT_THEME;
  let themeFile = path.join(THEMES_DIR, `${themeId}.css`);
  if (!(await fileExists(themeFile))) {
    console.warn(`Theme '${themeId}' not found, using default`);
    themeFile = path.join(THEMES_DIR, `${DEFAULT_THEME}.css`);
  }
  let themeCss = base + '\n' + (await fs.readFile(themeFile, 'utf8'));
  const a1 = quiz.theme_accent_primary   || '#00e0ff';
  const a2 = quiz.theme_accent_secondary || '#7b2ff7';
  const a3 = quiz.theme_accent_tertiary  || '#ff2ec4';
  themeCss = themeCss.split('{{accent_primary}}').join(a1)
                     .split('{{accent_secondary}}').join(a2)
                     .split('{{accent_tertiary}}').join(a3);
  const decoHtml = buildDecoHtml(themeId);
  return { themeCss, decoHtml };
}

function buildDecoHtml(id) {
  switch (id) {
    case 'particle_field':
      return '<div class="theme-deco">' +
        Array.from({length:18},(_,i)=>{
          const left=(i*5+2)%100, size=6+(i%5)*3, dur=8+(i%6)*2, delay=(i*0.7)%10;
          return `<div class="particle" style="left:${left}%;bottom:-20px;width:${size}px;height:${size}px;animation-duration:${dur}s;animation-delay:${delay}s;"></div>`;
        }).join('') + '</div>';
    case 'confetti_pop':
      return '<div class="theme-deco">' +
        Array.from({length:14},(_,i)=>{
          const left=(i*7+3)%100, dur=3+(i%5), delay=(i*0.3)%4, size=10+(i%4)*4;
          const colors=['var(--accent-1)','var(--accent-2)','var(--accent-3)','#ffd166','#00ff8c'];
          return `<div class="confetti-bg" style="left:${left}%;width:${size}px;height:${size*1.6}px;background:${colors[i%5]};animation-duration:${dur}s;animation-delay:${delay}s;"></div>`;
        }).join('') + '</div>';
    default:
      return '';
  }
}

// ──────────────────────────────────────────────
// FIX #1: LOGO DATA URI
// ──────────────────────────────────────────────
async function getLogoDataUri() {
  try {
    const buf = await fs.readFile(LOGO_PATH);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn(`[LOGO] Could not read logo at ${LOGO_PATH}: ${e.message}`);
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }
}

// ──────────────────────────────────────────────
// JOB PROCESSING
// ──────────────────────────────────────────────
async function processJobs() {
  console.log('[WORKER] Checking for pending quizzes...');

  // NOTE: is_human_approved is intentionally NOT checked here.
  // Approval gates YouTube PUBLISHING (handled later), not rendering —
  // a human can only approve a video after it has been rendered.
  const rows = await fetchSupabase(
    'quiz?video_status=eq.pending&is_active=eq.true' +
    '&quiz_enriched=eq.true&select=*&order=created_at.asc&limit=1'
  );

  if (!rows || rows.length === 0) {
    console.log('[WORKER] No pending quizzes.');
    return;
  }

  const quiz = rows[0];
  console.log(`[WORKER] Processing quiz: ${quiz.id} — ${quiz.topic}`);

  await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ video_status: 'processing' })
  });

  const workDir = `/tmp/video_${uuidv4()}`;
  await ensureDir(workDir);

  try {
    const videoPath = await buildVideo(quiz, workDir);
    const stats     = await fs.stat(videoPath);
    const sizeMb    = parseFloat((stats.size / (1024 * 1024)).toFixed(2));
    const dur       = await videoDur(videoPath);

    console.log(`[WORKER] Done. Duration: ${dur.toFixed(2)}s, Size: ${sizeMb}MB`);

    const artifactPath = `/tmp/${quiz.id}_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);
    await fs.writeFile('/tmp/artifact_ready', artifactPath);

    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        video_status:        'rendered',
        render_duration_sec: Math.round(dur),
        file_size_mb:        sizeMb,
        updated_at:          new Date().toISOString()
      })
    });

    await fs.rm(workDir, { recursive: true, force: true });
    console.log(`[WORKER] Artifact: ${artifactPath}`);

  } catch (err) {
    console.error('[WORKER] FAILED:', err);
    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        video_status:     'error',
        generation_error: String(err.message || err).slice(0, 800),
        updated_at:       new Date().toISOString()
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

  const QTIME    = quiz.thinking_time_sec || 9;
  const HINT_AT  = QTIME / 4;
  const FIFTY_AT = QTIME / 2;

  const allIdx   = [0,1,2,3];
  const keepIdx  = keep5050.map(v => (typeof v === 'string' ? parseInt(v) : v));
  const elimIdx  = allIdx.filter(i => !keepIdx.includes(i));
  const optClass = i => elimIdx.includes(i) ? 'eliminate' : '';
  const revClass = i => options[i] === correct ? 'correct' : 'wrong';

  const hasCta1  = !!(quiz.affiliate_url && quiz.affiliate_url.trim());

  // FIX #1: Load logo as base64 data URI
  console.log('[LOGO] Loading logo as base64 data URI...');
  const logoDataUri = await getLogoDataUri();

  // ── DOWNLOAD ALL AUDIO IN PARALLEL ──
  console.log('[AUDIO] Downloading audio assets...');
  const [
    hookFile, questionIntroFile, optionsIntroFile,
    timeupFile, cta1AudioFile, cta2AudioFile,
    missionIntroFile, cta3AudioFile,          // FIX #2: cta3AudioFile (was cta3File)
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

  // ── RESOLVE THEME ──
  const { themeCss, decoHtml } = await resolveTheme(quiz);

  // ── BUILD HTML ──
  let html = await fs.readFile(path.join(__dirname, 'quiz_template.html'), 'utf8');
  const R = {
    '{{theme_css}}':          themeCss,
    '{{theme_deco_html}}':    decoHtml,
    '{{LOGO_DATA_URI}}':      logoDataUri,   // FIX #1
    '{{hook_phrase}}':        quiz.hook_phrase || 'Stop scrolling! Can you beat this?',
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
    '{{mission_intro_text}}': quiz.mission_intro_text || 'MISSION IMPOSSIBLE',
    '{{mission_question}}':   quiz.mission_impossible_question || '',
    '{{mission_hint}}':       quiz.mission_impossible_hint || '',
    '{{qtime}}':              QTIME,
    '{{hint_time}}':          HINT_AT,
    '{{fiftyfifty_time}}':    FIFTY_AT
  };
  for (const [k,v] of Object.entries(R)) html = html.split(k).join(String(v ?? ''));

  const htmlPath = path.join(workDir, 'index.html');
  await fs.writeFile(htmlPath, html);

  // ── LAUNCH PUPPETEER ──
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-web-security',          // FIX #7: allow data URIs on file:// pages
      '--allow-file-access-from-files'
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  // FIX #4 (revised): everything is inlined (CSS in <style>, logo as base64
  // data URI, no external fetches). The page also has infinite CSS animations
  // (particles/orbs/grid) so it NEVER reaches network-idle — networkidle0 would
  // time out. domcontentloaded + a fixed settle delay is correct and instant.
    await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 600));

  const showOnly = async sel => {
    await page.evaluate(s => {
      document.querySelectorAll('.screen').forEach(e => e.classList.remove('active'));
      const el = document.querySelector(s);
      if (el) el.classList.add('active');
    }, sel);
    await new Promise(r => setTimeout(r, 120));
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

  // ════════ STEP 1: HOOK ════════
  await showOnly('.hook-slide');
  await new Promise(r => setTimeout(r, 1100));
  const hookImg = await shot('hook');
  const hookAudio = await buildAudio({
    prerecorded: hookFile,
    fallbackText: quiz.hook_phrase || 'Stop scrolling! Can you beat this?',
    fallbackSec: 2.5, voice, leadGap: 0.1, workDir, name: 'hook'
  });
  pushClip(await imgClip(hookImg, hookAudio.path, Math.max(hookAudio.dur, 2.0), workDir, 'clip_hook'));

  // ════════ STEP 2: question_intro audio only ════════
  await showOnly('.waiting-slide');
  await new Promise(r => setTimeout(r, 200));
  const waitImg = await shot('waiting');
  const step2Audio = await buildAudio({
    prerecorded: questionIntroFile,
    fallbackText: 'Here is your challenge!',
    fallbackSec: 1.5, voice, leadGap: GAP_AFTER_STEP2, workDir, name: 'step2'
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

  // ════════ STEP 4-5: Options intro + each option TTS ════════
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
    await tts('And your options are...', voice, ointroTts, 1.5);
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
  const step45Combined = path.join(workDir, 'step45.mp3');
  await concatAudio(step45Parts, step45Combined, workDir);
  pushClip(await imgClip(optionsImg, step45Combined, Math.max(await audioDur(step45Combined), 3), workDir, 'clip_step45'));

  // ════════ STEP 6-8: COUNTDOWN (screen recorded) ════════
   await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 400));
  await showOnly('.question-phase');
  await page.evaluate(() => { const el = document.querySelector('.question-phase'); if (el) el.offsetHeight; });
  await new Promise(r => setTimeout(r, 100));

  const rawVideo = path.join(workDir, 'phase_raw.mp4');
  const recorder = new PuppeteerScreenRecorder(page, {
    fps: 30,
    videoFrame: { width: 1080, height: 1920 },
    aspectRatio: '9:16'
  });
  await recorder.start(rawVideo);
  await new Promise(r => setTimeout(r, QTIME * 1000));
  await recorder.stop();

  // Countdown audio bed
  const cdBase = path.join(workDir, 'cd_base.mp3');
  if (countdownFile) {
    await execPromise(`ffmpeg -y -stream_loop -1 -i "${countdownFile}" -t ${QTIME} -af "volume=0.75" -ar 44100 -acodec libmp3lame "${cdBase}"`);
  } else {
    await silence(QTIME, cdBase);
  }
  let cdFinal = cdBase;
  const stings = [];
  if (sfxFile) {
    stings.push({ file: sfxFile, delayMs: Math.round(HINT_AT  * 1000) });
    stings.push({ file: sfxFile, delayMs: Math.round(FIFTY_AT * 1000) });
  }
  if (stings.length > 0) {
    const stingMixed = path.join(workDir, 'cd_mixed.mp3');
    const ins  = [`-i "${cdBase}"`, ...stings.map(s => `-i "${s.file}"`)].join(' ');
    const dels = stings.map((s,i) => `[${i+1}:a]adelay=${s.delayMs}|${s.delayMs}[s${i}]`).join(';');
    const mix  = ['[0:a]', ...stings.map((_,i) => `[s${i}]`)].join('');
    await execPromise(`ffmpeg -y ${ins} -filter_complex "${dels};${mix}amix=inputs=${stings.length+1}:duration=first[a]" -map "[a]" -t ${QTIME} -ar 44100 -acodec libmp3lame "${stingMixed}"`);
    cdFinal = stingMixed;
  }

  // FIX #5: re-encode VP8/WebM screen recording to h264 before concat
  const qClipRaw = path.join(workDir, 'phase_h264.mp4');
  await execPromise(`ffmpeg -y -i "${rawVideo}" -c:v libx264 -pix_fmt yuv420p -r 30 -vf "scale=1080:1920" "${qClipRaw}"`);

  const qClipPath = path.join(workDir, 'clip_countdown.mp4');
  await execPromise(`ffmpeg -y -i "${qClipRaw}" -i "${cdFinal}" -c:v libx264 -c:a aac -b:a 128k -ar 44100 -map 0:v:0 -map 1:a:0 -shortest -t ${QTIME} "${qClipPath}"`);
  pushClip({ path: qClipPath, dur: await videoDur(qClipPath) });

  // ════════ STEP 9: timeup ════════
   await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
  let ctaAudio;
  if (hasCta1) {
    ctaAudio = await buildAudio({
      prerecorded: cta1AudioFile,
      fallbackText: quiz.affiliate_text || 'Check the link in description!',
      fallbackSec: 3, voice, leadGap: GAP_DEFAULT, workDir, name: 'cta1'
    });
  } else {
    ctaAudio = await buildAudio({
      prerecorded: cta2AudioFile,
      fallbackText: quiz.cta2_text || 'Play real quiz and earn ONS tokens!',
      fallbackSec: 3, voice, leadGap: GAP_DEFAULT, workDir, name: 'cta2'
    });
  }
  pushClip(await imgClip(ctaImg, ctaAudio.path, ctaAudio.dur, workDir, 'clip_cta'));

  // ════════ STEPS 14-18: MISSION IMPOSSIBLE ════════
  if (quiz.mission_impossible_enabled !== false && quiz.mission_impossible_question) {

    // STEP 14: MI intro
    await showOnly('.mission-intro-slide');
    await new Promise(r => setTimeout(r, 400));
    const miIntroImg = await shot('mi_intro');
    const miIntroAudio = await buildAudio({
      prerecorded: missionIntroFile,
      fallbackText: quiz.mission_intro_text || 'MISSION IMPOSSIBLE!',
      fallbackSec: 2, voice, leadGap: 0.3, workDir, name: 'mi_intro'
    });
    pushClip(await imgClip(miIntroImg, miIntroAudio.path, miIntroAudio.dur, workDir, 'clip_mi_intro'));

    // STEP 15: MI question (hint + cta3 hidden)
    await showOnly('.mission-final-slide');
    // FIX #3: force hint & cta3 hidden before screenshot
    await page.evaluate(() => {
      const hint = document.getElementById('mi-hint');
      const cta3 = document.getElementById('mi-cta3');
      if (hint) { hint.classList.remove('shown'); hint.style.opacity = '0'; hint.style.transform = 'scale(0.9)'; }
      if (cta3) { cta3.classList.remove('show-cta3'); cta3.style.opacity = '0'; cta3.style.transform = 'translateY(30px) scale(0.9)'; }
    });
    await new Promise(r => setTimeout(r, 500));
    const miQImg = await shot('mi_question');
    const miQTts = path.join(workDir, 'mi_q_tts.mp3');
    const miQSil = path.join(workDir, 'mi_q_sil.mp3');
    await tts(quiz.mission_impossible_question, voice, miQTts, 2);
    await silence(1.0, miQSil);
    const miQAudio = path.join(workDir, 'mi_q_audio.mp3');
    await concatAudio([miQTts, miQSil], miQAudio, workDir);
    pushClip(await imgClip(miQImg, miQAudio, Math.max(await audioDur(miQAudio), 2), workDir, 'clip_mi_q'));

    // STEP 16: Hint appears (SFX + 2.5s)
    await page.evaluate(() => {
      const hint = document.getElementById('mi-hint');
      if (hint) { hint.classList.add('shown'); hint.style.opacity = ''; hint.style.transform = ''; }
    });
    await new Promise(r => setTimeout(r, 400));
    const miHintImg = await shot('mi_hint');
    const miHintParts = [];
    if (sfxFile) miHintParts.push(sfxFile);
    const miHintSil = path.join(workDir, 'mi_hint_sil.mp3');
    await silence(2.5, miHintSil);
    miHintParts.push(miHintSil);
    const miHintAudio = path.join(workDir, 'mi_hint_audio.mp3');
    await concatAudio(miHintParts, miHintAudio, workDir);
    pushClip(await imgClip(miHintImg, miHintAudio, await audioDur(miHintAudio), workDir, 'clip_mi_hint'), false);

    // STEP 17: CTA3 revealed
    await page.evaluate(() => {
      const cta3 = document.getElementById('mi-cta3');
      if (cta3) { cta3.classList.add('show-cta3'); cta3.style.opacity = ''; cta3.style.transform = ''; }
    });
    await new Promise(r => setTimeout(r, 500));
    const cta3Img = await shot('cta3');
    // FIX #2: cta3AudioFile (was undefined cta3File)
    const cta3Audio = await buildAudio({
      prerecorded: cta3AudioFile,
      fallbackText: quiz.cta3_text || 'Like, share and challenge a friend! Subscribe!',
      fallbackSec: 4, voice, leadGap: 0.2, workDir, name: 'cta3'
    });
    pushClip(await imgClip(cta3Img, cta3Audio.path, cta3Audio.dur, workDir, 'clip_cta3'));

    // STEP 18: Hold 1s
    const holdSil = path.join(workDir, 'hold_sil.mp3');
    await silence(1.0, holdSil);
    pushClip(await imgClip(cta3Img, holdSil, 1.0, workDir, 'clip_hold'), false);
  }

  await browser.close();

  // ════════ FINAL ASSEMBLY ════════
  console.log(`[VIDEO] Assembling ${clips.length} clips...`);
  const concatTxt = path.join(workDir, 'concat.txt');
  await fs.writeFile(concatTxt, clips.map(c => `file '${c.path.replace(/'/g, "'\\''")}'`).join('\n'));

  const concatenated = path.join(workDir, 'concatenated.mp4');
  await execPromise(
    `ffmpeg -y -f concat -safe 0 -i "${concatTxt}" -c:v libx264 -pix_fmt yuv420p -r 30 -c:a aac -b:a 128k -ar 44100 -movflags +faststart "${concatenated}"`
  );

  const total = await videoDur(concatenated);
  console.log(`[VIDEO] Concatenated: ${total.toFixed(2)}s | voice ranges: ${voiceRanges.length}`);

  const finalPath = await applyBgMusic(concatenated, total, voiceRanges, bgFile, workDir);
  return finalPath;
}

// ──────────────────────────────────────────────
// ENTRY POINT
// ──────────────────────────────────────────────
processJobs()
  .then(() => { console.log('[WORKER] Run complete.'); process.exit(0); })
  .catch(err => { console.error('[WORKER] Fatal:', err); process.exit(1); });
