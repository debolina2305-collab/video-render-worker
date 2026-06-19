'use strict';
/**
 * worker10.js — Video Render Worker (GitHub Actions)
 *
 * VIDEO FLOW (matches quiz_video_flow_checklist_v2.xlsx):
 *
 * ── MAIN QUIZ SEGMENT ──────────────────────────────────────────────────────
 * S1  HOOK SCREEN
 *     • Animated logo (fly-in) + hook_phrase (fade-in)
 *     • Audio: hook_audio_url (pre-recorded) or TTS fallback
 *     • quiz_background_css active on all screens
 *
 * S2  QUESTION SCREEN  (single screen, sequential reveals with effects)
 *     • question appears (fly-in from top)          → NO TTS
 *     • options appear below (staggered fade-in)    → NO TTS
 *     • Audio: question_intro_audio_url then options_intro_audio_url (pre-recorded)
 *       followed by "time starts now" TTS
 *     • Countdown timer visible (thinking_time_sec)
 *     • At ½ time: 50/50 eliminates wrong options (CSS class)
 *
 * S3  TIMEUP SCREEN
 *     • Audio: timeup_audio_url or TTS
 *
 * S4  ANSWER SCREEN
 *     • Correct answer highlighted (fly-in)
 *     • Audio: correct_answer_sfx + TTS correct answer text
 *
 * ── MISSION IMPOSSIBLE SEGMENT (skip entirely if mission_impossible_question is null) ──
 * S5  MI SCREEN  (single screen, timed reveals — points 1–7 of checklist)
 *     t=0.0s  "MISSION IMPOSSIBLE" (XXL, styled) + mission_intro_text (normal)
 *             sfx_mission_impossible plays simultaneously
 *     t=after SFX: mission_intro_audio_url plays (pre-recorded)
 *     t=after intro audio: mission_impossible_question appears (NO TTS, fly-in)
 *     t=+0.5s: mission_impossible_options appear (NO TTS, staggered fade-in)
 *     t=+2.5s from question appear: cta3_text appears (slide-up)
 *     t=cta3 appear: cta3_audio_url plays (pre-recorded) or TTS
 *     t=cta3 audio end + 1s: screen freezes (hold frame)
 *
 * ── END SEGMENT ─────────────────────────────────────────────────────────────
 * S6  CTA2 SCREEN  (single screen — points 8–10 of checklist)
 *     • cta2_text (only shown if NO cta1_description_text) — fade-in
 *     • cta2_audio_url (pre-recorded) or TTS
 *     • Platform URL with finger pointer: https://jaasblog.online/quiz/<niche>
 *     • 1s freeze after audio ends
 *
 * ── BACKGROUND MUSIC ────────────────────────────────────────────────────────
 *     background_music ducked under all voice audio (BG_VOL_BASE=0.10, BG_VOL_DUCK=0.035)
 *     quiz_background_css from DB applied to EVERY screen
 */

const { exec }    = require('child_process');
const util        = require('util');
const execPromise = util.promisify(exec);
const fs          = require('fs').promises;
const path        = require('path');
const puppeteer   = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const { v4: uuidv4 } = require('uuid');

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
console.log('SUPABASE_URL:', supabaseUrl);
console.log('SUPABASE_SERVICE_KEY:', supabaseKey ? '*** (set)' : 'NOT SET');
const cleanUrl = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;
if (!cleanUrl || !supabaseKey) { console.error('Missing Supabase credentials'); process.exit(1); }

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const VOICE_MAP = {
  en: 'en-US-JennyNeural', hi: 'hi-IN-SwaraNeural',
  es: 'es-ES-ElviraNeural', pt: 'pt-BR-FranciscaNeural'
};
const THEMES_DIR    = path.join(__dirname, 'themes');
const CACHE_DIR     = path.join(__dirname, 'audio_cache');
const DEFAULT_THEME = 'particle_field';
const LOGO_PATH     = path.join(__dirname, 'assets', 'jaasX-logo-saved-for-web.png');
const DEFAULT_BG_MUSIC = 'https://pub-3578d297d3904e1d8ffedfc9dd4102f2.r2.dev/audio/background_music/The_Midnight_Audit.mp3';
const PLATFORM_URL_BASE = 'https://jaasblog.online/quiz/';

const BG_VOL_BASE  = 0.10;
const BG_VOL_DUCK  = 0.035;
const DUCK_RAMP    = 0.12;

const GAP_DEFAULT  = 0.25;
const GAP_OPTIONS  = 0.40;
const GAP_ANSWER   = 0.30;

const DEFAULT_THINKING_TIME = 10;

const TIMEOUT_FFMPEG   = 120_000;
const TIMEOUT_CURL     = 35_000;
const TIMEOUT_TTS      = 40_000;
const TIMEOUT_RECORDER = 90_000;
const TIMEOUT_JOB      = 45 * 60 * 1000;

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT after ${ms}ms: ${label}`)), ms)
    )
  ]);
}

const baseHeaders = {
  apikey: supabaseKey,
  Authorization: `Bearer ${supabaseKey}`,
  'Content-Type': 'application/json'
};
async function fetchSupabase(p, opts = {}) {
  const url = `${cleanUrl}/rest/v1/${p}`;
  console.log(`[DB] ${opts.method || 'GET'} ${url}`);
  const hdrs = { ...baseHeaders, ...(opts.headers || {}) };
  if (opts.method && ['POST','PATCH','PUT'].includes(opts.method))
    hdrs.Prefer = 'return=representation';
  const res = await fetch(url, { ...opts, headers: hdrs });
  if (!res.ok) { const t = await res.text(); throw new Error(`HTTP ${res.status}: ${t}`); }
  const text = await res.text();
  if (!text || text.trim() === '') return null;
  return JSON.parse(text);
}

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
      for (const v of Object.values(obj))
        if (typeof v === 'string' && v.startsWith('http')) return v;
      return null;
    } catch { return null; }
  }
  return s;
}

function encodeR2Url(url) {
  if (!url) return url;
  const si = url.indexOf('://');
  if (si === -1) return url;
  const ps = url.indexOf('/', si + 3);
  if (ps === -1) return url;
  const origin = url.slice(0, ps);
  let out = '';
  for (let i = ps; i < url.length; i++) {
    const c = url[i];
    if (c === '%' && /^[0-9A-Fa-f]{2}$/.test(url.substr(i+1,2))) {
      out += url.substr(i,3); i+=2;
    } else if (/[A-Za-z0-9/?&=#.\-_~]/.test(c)) {
      out += c;
    } else {
      out += encodeURIComponent(c);
    }
  }
  return origin + out;
}

async function downloadAudio(url, cacheKey, preferKey) {
  const resolved = extractUrl(url, preferKey);
  if (!resolved) return null;
  await ensureDir(CACHE_DIR);
  const encoded = encodeR2Url(resolved);
  const safe    = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_');
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
    if (st.size === 0) { await fs.unlink(rawFile).catch(()=>{}); return null; }
    await withTimeout(
      execPromise(
        `ffmpeg -y -i "${rawFile}" -ar 44100 -ac 2 -acodec libmp3lame -q:a 4 "${local}"`
      ),
      TIMEOUT_FFMPEG, `convert ${safe}`
    );
    await fs.unlink(rawFile).catch(()=>{});
    if (await fileExists(local)) return local;
  } catch (e) {
    console.warn(`[DOWNLOAD FAIL] ${safe}: ${e.message}`);
    await fs.unlink(rawFile).catch(()=>{});
    await fs.unlink(local).catch(()=>{});
  }
  return null;
}

async function audioDur(p) {
  try {
    const { stdout } = await withTimeout(
      execPromise(
        `ffprobe -v error -show_entries format=duration ` +
        `-of default=noprint_wrappers=1:nokey=1 "${p}"`
      ),
      10_000, 'audioDur'
    );
    const d = parseFloat(stdout.trim());
    return isNaN(d) ? 0 : d;
  } catch { return 0; }
}
async function videoDur(p) { return audioDur(p); }

async function silence(sec, out) {
  const s = Math.max(parseFloat(sec) || 0.1, 0.05);
  await withTimeout(
    execPromise(
      `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo ` +
      `-t ${s} -q:a 9 -acodec libmp3lame "${out}"`
    ),
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
      TIMEOUT_TTS, 'tts'
    );
    if (!(await fileExists(out)) || (await audioDur(out)) === 0) {
      await silence(fallbackSec, out);
    }
  } catch (e) {
    console.warn(`[TTS WARN] ${e.message}`);
    await silence(fallbackSec, out);
  }
  await fs.unlink(tmp).catch(()=>{});
}

async function ffmpeg(args, label) {
  await withTimeout(execPromise(`ffmpeg ${args}`), TIMEOUT_FFMPEG, label || 'ffmpeg');
}

async function concatAudio(parts, out, workDir) {
  const vp = [];
  for (const p of parts) if (p && await fileExists(p)) vp.push(p);
  if (vp.length === 0) { await silence(0.5, out); return; }
  if (vp.length === 1) { await fs.copyFile(vp[0], out); return; }
  const listP = path.join(workDir, `cat_${uuidv4()}.txt`);
  await fs.writeFile(
    listP,
    vp.map(p => `file '${p.replace(/\\/g,'/').replace(/'/g,"'\\''")}' `).join('\n')
  );
  await ffmpeg(
    `-y -f concat -safe 0 -i "${listP}" -ar 44100 -ac 2 -acodec libmp3lame "${out}"`,
    'concatAudio'
  );
  await fs.unlink(listP).catch(()=>{});
}

/** Combine pre-recorded + optional gap, fall back to TTS. */
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
  return { path: outP, dur: await audioDur(outP) };
}

/** Screenshot a single static image into an mp4 clip. */
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

// ─────────────────────────────────────────────
// BACKGROUND MUSIC DUCKING
// ─────────────────────────────────────────────
async function applyBgMusic(concatMp4, totalDur, voiceRanges, bgFile, workDir) {
  if (!bgFile || !(await fileExists(bgFile))) {
    console.log('[BGMUSIC] No bg music — skipping'); return concatMp4;
  }
  const bgLooped   = path.join(workDir, 'bg_looped.mp3');
  const bgDucked   = path.join(workDir, 'bg_ducked.mp3');
  const fgAudio    = path.join(workDir, 'fg_audio.mp3');
  const mixedAudio = path.join(workDir, 'mixed_audio.mp3');
  const finalMp4   = path.join(workDir, 'final_with_music.mp4');

  await ffmpeg(
    `-y -stream_loop -1 -i "${bgFile}" -t ${totalDur} ` +
    `-af "volume=${BG_VOL_BASE}" -ar 44100 -acodec libmp3lame "${bgLooped}"`,
    'bgLoop'
  );
  if (voiceRanges.length > 0) {
    const ratio   = (BG_VOL_DUCK / BG_VOL_BASE).toFixed(4);
    const filters = voiceRanges.map(r => {
      const s = Math.max(0, r.start - DUCK_RAMP).toFixed(3);
      const e = (r.end + DUCK_RAMP).toFixed(3);
      return `volume=enable='between(t,${s},${e})':volume=${ratio}`;
    }).join(',');
    await ffmpeg(
      `-y -i "${bgLooped}" -af "${filters}" -ar 44100 -acodec libmp3lame "${bgDucked}"`,
      'bgDuck'
    );
  } else {
    await fs.copyFile(bgLooped, bgDucked);
  }
  await ffmpeg(
    `-y -i "${concatMp4}" -vn -ar 44100 -acodec libmp3lame "${fgAudio}"`,
    'extractFg'
  );
  await ffmpeg(
    `-y -i "${fgAudio}" -i "${bgDucked}" ` +
    `-filter_complex "[0:a]volume=1.0[fg];[1:a]volume=1.0[bg];` +
    `[fg][bg]amix=inputs=2:duration=first:dropout_transition=0[a]" ` +
    `-map "[a]" -ar 44100 -acodec libmp3lame "${mixedAudio}"`,
    'mixAudio'
  );
  await ffmpeg(
    `-y -i "${concatMp4}" -i "${mixedAudio}" -c:v copy ` +
    `-map 0:v:0 -map 1:a:0 -c:a aac -b:a 192k -t ${totalDur} ` +
    `-movflags +faststart "${finalMp4}"`,
    'remux'
  );
  return finalMp4;
}

// ─────────────────────────────────────────────
// THEME + quiz_background_css
// ─────────────────────────────────────────────
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

  // quiz_background_css from background_animation table applies to ALL screens
  if (quiz.quiz_background_css && quiz.quiz_background_css.trim()) {
    console.log('[THEME] Applying quiz_background_css to all screens');
    themeCss += '\n/* === QUIZ-SPECIFIC BACKGROUND === */\n' + quiz.quiz_background_css;
  }
  return { themeCss, decoHtml: buildDecoHtml(themeId) };
}

function buildDecoHtml(id) {
  if (id === 'particle_field') {
    return '<div class="theme-deco">' +
      Array.from({length:18}, (_,i) => {
        const l=(i*5+2)%100, sz=6+(i%5)*3, d=8+(i%6)*2, dy=(i*0.7)%10;
        return `<div class="particle" style="left:${l}%;bottom:-20px;` +
          `width:${sz}px;height:${sz}px;` +
          `animation-duration:${d}s;animation-delay:${dy}s;"></div>`;
      }).join('') + '</div>';
  }
  return '';
}

async function getLogoDataUri() {
  try {
    const buf = await fs.readFile(LOGO_PATH);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (e) {
    console.warn(`[LOGO] ${e.message}`);
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }
}

// ─────────────────────────────────────────────
// INLINE HTML GENERATOR
// Builds the full single-page HTML with all screens and CSS animations
// ─────────────────────────────────────────────
function buildHtml({ themeCss, decoHtml, logoDataUri, quiz, options, keep5050, QTIME }) {
  const niche       = quiz.niche || 'general';
  const question    = quiz.question_1 || '';
  const correct     = quiz.correct_answer_1 || '';
  const hasCta1     = !!(quiz.cta1_description_text?.trim());
  const platformUrl = PLATFORM_URL_BASE + niche;

  const allIdx  = [0,1,2,3];
  const keepIdx = (quiz.keep_5050_1 || []).map(v => (typeof v === 'string' ? parseInt(v) : v));
  const elimIdx = allIdx.filter(i => !keepIdx.includes(i));

  const miOptions = quiz.mission_options_1 || [];
  const hasMI     = !!(quiz.mission_impossible_question?.trim());

  // CSS for all animations used across screens
  const animCss = `
    /* ── GLOBAL RESETS ── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 1080px; height: 1920px; overflow: hidden; font-family: 'Segoe UI', sans-serif; }
    .screen { display: none; width: 1080px; height: 1920px; position: relative;
              overflow: hidden; flex-direction: column; align-items: center; justify-content: center; }
    .screen.active { display: flex; }

    /* ── BACKGROUND ── */
    .bg-anim { position: absolute; inset: 0; z-index: 0; }

    /* ── TEXT ANIMATION KEYFRAMES ── */
    @keyframes flyInTop  { from { transform: translateY(-80px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    @keyframes flyInBot  { from { transform: translateY(80px);  opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    @keyframes fadeIn    { from { opacity: 0; } to { opacity: 1; } }
    @keyframes slideUp   { from { transform: translateY(40px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
    @keyframes popIn     { from { transform: scale(0.6); opacity: 0; } to { transform: scale(1); opacity: 1; } }
    @keyframes logoPop   { 0% { transform: scale(0) rotate(-15deg); opacity: 0; }
                           70% { transform: scale(1.1) rotate(2deg); opacity: 1; }
                           100% { transform: scale(1) rotate(0deg); opacity: 1; } }
    @keyframes pulse     { 0%,100% { transform: scale(1); } 50% { transform: scale(1.04); } }
    @keyframes shimmer   { 0% { background-position: -200% center; }
                           100% { background-position: 200% center; } }
    @keyframes fingerBounce { 0%,100% { transform: translateX(0); } 50% { transform: translateX(12px); } }
    @keyframes countdownTick { 0% { transform: scale(1.2); color: #ff4444; }
                               100% { transform: scale(1); color: inherit; } }

    /* ── LOGO (hook screen — animated fly-in) ── */
    .logo-wrap { position: relative; z-index: 10; margin-bottom: 24px;
                 animation: logoPop 0.7s cubic-bezier(.22,1.6,.5,1) both; }
    .logo-wrap img { width: 160px; height: auto; filter: drop-shadow(0 4px 24px rgba(0,224,255,0.5)); }

    /* ── HOOK SCREEN ── */
    .hook-content { position: relative; z-index: 5; display: flex; flex-direction: column;
                    align-items: center; justify-content: center; height: 100%; padding: 60px 80px; }
    .hook-phrase  { font-size: 58px; font-weight: 900; text-align: center; color: #fff;
                    line-height: 1.15; text-shadow: 0 4px 24px rgba(0,0,0,0.7);
                    animation: flyInTop 0.6s cubic-bezier(.22,1.4,.5,1) 0.3s both; }

    /* ── QUESTION SCREEN ── */
    .q-screen-content { position: relative; z-index: 5; display: flex; flex-direction: column;
                        align-items: center; justify-content: flex-start; height: 100%;
                        padding: 80px 60px 40px; gap: 32px; }
    .q-label  { font-size: 30px; font-weight: 700; color: rgba(255,255,255,0.6);
                text-transform: uppercase; letter-spacing: 4px;
                animation: fadeIn 0.4s ease 0.1s both; }
    .q-text   { font-size: 52px; font-weight: 800; color: #fff; text-align: center;
                line-height: 1.2; text-shadow: 0 3px 16px rgba(0,0,0,0.6);
                animation: flyInTop 0.5s cubic-bezier(.22,1.4,.5,1) 0.2s both; }
    .options-grid { width: 100%; display: flex; flex-direction: column; gap: 22px; margin-top: 16px; }
    .opt-row  { display: flex; align-items: center; gap: 20px; padding: 22px 32px;
                background: rgba(255,255,255,0.08); border: 2px solid rgba(255,255,255,0.15);
                border-radius: 20px; cursor: default; opacity: 0;
                transform: translateY(20px); transition: opacity 0.4s, transform 0.4s;
                backdrop-filter: blur(6px); }
    .opt-row.visible { opacity: 1; transform: translateY(0); }
    .opt-row.eliminate { opacity: 0.18 !important; filter: blur(1px); }
    .opt-letter { font-size: 32px; font-weight: 900; color: rgba(255,255,255,0.5);
                  min-width: 40px; text-align: center; }
    .opt-text   { font-size: 38px; font-weight: 700; color: #fff; flex: 1; }
    .countdown-bar { width: 100%; height: 10px; background: rgba(255,255,255,0.15);
                     border-radius: 6px; overflow: hidden; margin-top: auto; }
    .countdown-fill { height: 100%; background: linear-gradient(90deg, #00e0ff, #7b2ff7);
                      border-radius: 6px; transition: width linear; }

    /* ── TIMEUP / ANSWER / GENERIC SCREENS ── */
    .centered-screen { position: relative; z-index: 5; display: flex; flex-direction: column;
                       align-items: center; justify-content: center; height: 100%;
                       padding: 80px 70px; gap: 40px; text-align: center; }
    .section-label { font-size: 28px; font-weight: 700; color: rgba(255,255,255,0.55);
                     text-transform: uppercase; letter-spacing: 5px;
                     animation: fadeIn 0.4s ease both; }
    .timeup-text { font-size: 64px; font-weight: 900; color: #fff; line-height: 1.1;
                   animation: flyInTop 0.5s cubic-bezier(.22,1.4,.5,1) 0.15s both; }
    .correct-badge { display: flex; align-items: center; gap: 20px; padding: 28px 48px;
                     background: linear-gradient(135deg, rgba(0,200,80,0.25), rgba(0,200,80,0.08));
                     border: 3px solid rgba(0,200,80,0.6); border-radius: 24px;
                     animation: popIn 0.5s cubic-bezier(.22,1.6,.5,1) 0.2s both; }
    .correct-label { font-size: 26px; font-weight: 700; color: #00c850; text-transform: uppercase;
                     letter-spacing: 3px; }
    .correct-text  { font-size: 52px; font-weight: 900; color: #fff; }

    /* ── MISSION IMPOSSIBLE SCREEN ── */
    .mi-screen-content { position: relative; z-index: 5; display: flex; flex-direction: column;
                         align-items: center; justify-content: flex-start; height: 100%;
                         padding: 60px 60px 40px; gap: 28px; }
    .mi-title { font-size: 90px; font-weight: 900; text-align: center; line-height: 1;
                background: linear-gradient(135deg, #ff2020, #ff8800, #ffcc00);
                -webkit-background-clip: text; -webkit-text-fill-color: transparent;
                background-clip: text; text-shadow: none;
                filter: drop-shadow(0 4px 20px rgba(255,80,0,0.5));
                animation: popIn 0.6s cubic-bezier(.22,1.6,.5,1) both; }
    .mi-tagline { font-size: 34px; font-weight: 600; color: rgba(255,255,255,0.8);
                  text-align: center; letter-spacing: 1px;
                  animation: fadeIn 0.5s ease 0.3s both; }
    .mi-divider { width: 80%; height: 2px;
                  background: linear-gradient(90deg, transparent, rgba(255,120,0,0.6), transparent);
                  animation: fadeIn 0.4s ease 0.5s both; }
    .mi-question { font-size: 46px; font-weight: 800; color: #fff; text-align: center;
                   line-height: 1.25; opacity: 0; transform: translateY(-30px);
                   transition: opacity 0.5s ease, transform 0.5s ease; }
    .mi-question.visible { opacity: 1; transform: translateY(0); }
    .mi-options-grid { width: 100%; display: flex; flex-direction: column; gap: 18px; }
    .mi-opt-row { display: flex; align-items: center; gap: 16px; padding: 18px 28px;
                  background: rgba(255,80,0,0.08); border: 2px solid rgba(255,120,0,0.25);
                  border-radius: 18px; opacity: 0; transform: translateX(-20px);
                  transition: opacity 0.35s ease, transform 0.35s ease; }
    .mi-opt-row.visible { opacity: 1; transform: translateX(0); }
    .mi-opt-letter { font-size: 28px; font-weight: 900; color: rgba(255,150,0,0.7);
                     min-width: 36px; }
    .mi-opt-text { font-size: 34px; font-weight: 700; color: #fff; flex: 1; }
    .mi-cta3 { width: 100%; padding: 24px 32px;
               background: linear-gradient(135deg, rgba(255,80,0,0.2), rgba(255,180,0,0.1));
               border: 2px solid rgba(255,140,0,0.5); border-radius: 20px;
               font-size: 32px; font-weight: 700; color: #ffcc00; text-align: center;
               opacity: 0; transform: translateY(30px);
               transition: opacity 0.5s ease, transform 0.5s ease; }
    .mi-cta3.visible { opacity: 1; transform: translateY(0); }

    /* ── CTA2 / END SCREEN ── */
    .cta2-screen-content { position: relative; z-index: 5; display: flex; flex-direction: column;
                           align-items: center; justify-content: center; height: 100%;
                           padding: 80px 70px; gap: 40px; text-align: center; }
    .cta2-text  { font-size: 48px; font-weight: 800; color: #fff; line-height: 1.25;
                  animation: flyInBot 0.5s cubic-bezier(.22,1.4,.5,1) 0.1s both; }
    .platform-url-row { display: flex; align-items: center; gap: 16px; margin-top: 16px;
                        animation: slideUp 0.5s ease 0.4s both; }
    .finger-icon { font-size: 52px; animation: fingerBounce 0.8s ease-in-out infinite; }
    .platform-url { font-size: 34px; font-weight: 700; color: #00e0ff;
                    word-break: break-all; text-align: left;
                    text-decoration: underline; text-underline-offset: 4px; }

    /* ── QUIZ BACKGROUND CSS IS APPENDED IN themeCss ── */
  `;

  // Build options HTML for question screen
  const optRowsHtml = options.map((opt, i) => {
    const letter = String.fromCharCode(65 + i);
    return `<div class="opt-row" id="opt-${i}" data-idx="${i}">
      <span class="opt-letter">${letter}</span>
      <span class="opt-text">${opt || ''}</span>
    </div>`;
  }).join('\n');

  // Build MI options HTML
  const miOptRowsHtml = miOptions.map((opt, i) => {
    const letter = String.fromCharCode(65 + i);
    return `<div class="mi-opt-row" id="mi-opt-${i}">
      <span class="mi-opt-letter">${letter}</span>
      <span class="mi-opt-text">${opt || ''}</span>
    </div>`;
  }).join('\n');

  // CTA2 screen — only show cta2 if no cta1
  const cta2ScreenHtml = `
    <section class="screen" id="screen-cta2">
      <div class="bg-anim"></div>
      ${decoHtml}
      <div class="cta2-screen-content">
        ${!hasCta1 ? `<p class="cta2-text">${quiz.cta2_text || 'Play real quiz and earn ONS tokens!'}</p>` : ''}
        <div class="platform-url-row">
          <span class="finger-icon">👉</span>
          <span class="platform-url">${platformUrl}</span>
        </div>
      </div>
    </section>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<style>
${animCss}
${themeCss}
</style>
</head>
<body>

<!-- S1: HOOK -->
<section class="screen active" id="screen-hook">
  <div class="bg-anim"></div>
  ${decoHtml}
  <div class="hook-content">
    <div class="logo-wrap"><img src="${logoDataUri}" alt="logo"/></div>
    <p class="hook-phrase">${quiz.hook_phrase || 'Stop scrolling! Can you beat this?'}</p>
  </div>
</section>

<!-- S2: QUESTION + OPTIONS (single screen, JS-timed reveals) -->
<section class="screen" id="screen-question">
  <div class="bg-anim"></div>
  ${decoHtml}
  <div class="q-screen-content">
    <p class="q-label">Your Challenge</p>
    <p class="q-text">${question}</p>
    <div class="options-grid" id="options-grid">
      ${optRowsHtml}
    </div>
    <div class="countdown-bar">
      <div class="countdown-fill" id="cd-fill" style="width:100%;"></div>
    </div>
  </div>
</section>

<!-- S3: TIMEUP -->
<section class="screen" id="screen-timeup">
  <div class="bg-anim"></div>
  ${decoHtml}
  <div class="centered-screen">
    <p class="section-label">Time's Up!</p>
    <p class="timeup-text">${quiz.timeup_text || "Time's up! Let's reveal the correct answer."}</p>
  </div>
</section>

<!-- S4: ANSWER REVEAL -->
<section class="screen" id="screen-answer">
  <div class="bg-anim"></div>
  ${decoHtml}
  <div class="centered-screen">
    <p class="section-label">Correct Answer</p>
    <div class="correct-badge">
      <div>
        <p class="correct-label">✓ Correct</p>
        <p class="correct-text">${correct}</p>
      </div>
    </div>
  </div>
</section>

<!-- S5: MISSION IMPOSSIBLE (single screen, JS-timed reveals) -->
${hasMI ? `
<section class="screen" id="screen-mi">
  <div class="bg-anim"></div>
  ${decoHtml}
  <div class="mi-screen-content">
    <p class="mi-title">MISSION<br>IMPOSSIBLE</p>
    <p class="mi-tagline">${quiz.mission_intro_text || 'Are you smart enough to solve it?'}</p>
    <div class="mi-divider"></div>
    <p class="mi-question" id="mi-question">${quiz.mission_impossible_question || ''}</p>
    <div class="mi-options-grid" id="mi-options-grid">
      ${miOptRowsHtml}
    </div>
    <div class="mi-cta3" id="mi-cta3">${quiz.cta3_text || 'Like, Share & Subscribe!'}</div>
  </div>
</section>` : ''}

<!-- S6: CTA2 / END SCREEN -->
${cta2ScreenHtml}

<script>
// Expose helpers for Puppeteer page.evaluate() calls
window.showScreen = function(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
};

// Stagger-reveal all options on question screen
window.showOptions = function() {
  const rows = document.querySelectorAll('#options-grid .opt-row');
  rows.forEach((r, i) => {
    setTimeout(() => r.classList.add('visible'), i * 120);
  });
};

// Eliminate 50/50 options
window.eliminate5050 = function(elimIndexes) {
  elimIndexes.forEach(i => {
    const el = document.getElementById('opt-' + i);
    if (el) el.classList.add('eliminate');
  });
};

// Countdown bar animation
window.startCountdown = function(totalSec) {
  const fill = document.getElementById('cd-fill');
  if (!fill) return;
  const start = Date.now();
  const tick = () => {
    const elapsed = (Date.now() - start) / 1000;
    const pct = Math.max(0, 100 - (elapsed / totalSec) * 100);
    fill.style.width = pct + '%';
    fill.style.background = pct > 50
      ? 'linear-gradient(90deg,#00e0ff,#7b2ff7)'
      : pct > 25
        ? 'linear-gradient(90deg,#ffcc00,#ff8800)'
        : 'linear-gradient(90deg,#ff4444,#ff2020)';
    if (pct > 0) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
};

// MI timed reveals
window.showMiQuestion = function() {
  const el = document.getElementById('mi-question');
  if (el) el.classList.add('visible');
};
window.showMiOptions = function() {
  const rows = document.querySelectorAll('#mi-options-grid .mi-opt-row');
  rows.forEach((r, i) => setTimeout(() => r.classList.add('visible'), i * 140));
};
window.showMiCta3 = function() {
  const el = document.getElementById('mi-cta3');
  if (el) el.classList.add('visible');
};
</script>
</body>
</html>`;
}

// ─────────────────────────────────────────────
// SCREEN RECORDER HELPER
// ─────────────────────────────────────────────
async function recordScreen(page, durationSec, outPath) {
  const recorder = new PuppeteerScreenRecorder(page, {
    fps: 30,
    videoFrame: { width: 1080, height: 1920 },
    aspectRatio: '9:16'
  });
  await recorder.start(outPath);
  await new Promise(r => setTimeout(r, Math.round(durationSec * 1000)));
  await withTimeout(recorder.stop(), TIMEOUT_RECORDER, 'recorder.stop()');
  return outPath;
}

/** Re-encode VP8/WebM → H264 mp4 ready for concat */
async function reencodeToH264(rawPath, outPath) {
  await ffmpeg(
    `-y -i "${rawPath}" -c:v libx264 -pix_fmt yuv420p -r 30 -vf "scale=1080:1920" "${outPath}"`,
    'reencodeH264'
  );
  return outPath;
}

// ─────────────────────────────────────────────
// JOB PROCESSOR
// ─────────────────────────────────────────────
async function processJobs() {
  console.log('[WORKER] Checking for pending quizzes...');
  // Reset stuck rows (processing > 30 min)
  const stuckCutoff = new Date(Date.now() - 30*60*1000).toISOString();
  const stuckRows = await fetchSupabase(
    `quiz?video_status=eq.processing&is_active=eq.true&updated_at=lt.${stuckCutoff}&select=id&limit=5`
  ).catch(() => null);
  if (stuckRows?.length) {
    console.log(`[WORKER] Resetting ${stuckRows.length} stuck rows → pending`);
    for (const r of stuckRows)
      await fetchSupabase(
        `quiz?id=eq.${r.id}`,
        { method: 'PATCH', body: JSON.stringify({ video_status: 'pending', updated_at: new Date().toISOString() }) }
      ).catch(() => {});
  }

  const rows = await fetchSupabase(
    'quiz?video_status=eq.pending&is_active=eq.true&quiz_enriched=eq.true&select=*&order=created_at.asc&limit=1'
  );
  if (!rows?.length) { console.log('[WORKER] No pending quizzes.'); return; }

  const quiz = rows[0];
  console.log(`[WORKER] Processing: ${quiz.id} — ${quiz.topic}`);
  await fetchSupabase(
    `quiz?id=eq.${quiz.id}`,
    { method: 'PATCH', body: JSON.stringify({ video_status: 'processing', updated_at: new Date().toISOString() }) }
  );

  const workDir = `/tmp/video_${uuidv4()}`;
  await ensureDir(workDir);

  try {
    const videoPath = await withTimeout(
      buildVideo(quiz, workDir), TIMEOUT_JOB, `buildVideo ${quiz.id}`
    );
    const stats  = await fs.stat(videoPath);
    const sizeMb = parseFloat((stats.size / (1024*1024)).toFixed(2));
    const dur    = await videoDur(videoPath);
    console.log(`[WORKER] Done. ${dur.toFixed(1)}s, ${sizeMb}MB`);

    const artifactPath = `/tmp/${quiz.id}_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);
    await fs.writeFile('/tmp/artifact_ready', artifactPath);
    await fetchSupabase(
      `quiz?id=eq.${quiz.id}`,
      { method: 'PATCH', body: JSON.stringify({
        video_status: 'rendered',
        render_duration_sec: Math.round(dur),
        file_size_mb: sizeMb,
        updated_at: new Date().toISOString()
      })}
    );
    await fs.rm(workDir, { recursive: true, force: true });
    console.log(`[WORKER] Artifact: ${artifactPath}`);
  } catch (err) {
    console.error('[WORKER] FAILED:', err.message);
    await fetchSupabase(
      `quiz?id=eq.${quiz.id}`,
      { method: 'PATCH', body: JSON.stringify({
        video_status: 'error',
        generation_error: String(err.message || err).slice(0, 800),
        updated_at: new Date().toISOString()
      })}
    ).catch(() => {});
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ─────────────────────────────────────────────
// MAIN VIDEO BUILDER
// ─────────────────────────────────────────────
async function buildVideo(quiz, workDir) {
  const lang    = quiz.lang_code || 'en';
  const voice   = VOICE_MAP[lang] || VOICE_MAP.en;
  const options = quiz.options_1 || [];
  const correct = quiz.correct_answer_1 || '';

  const QTIME    = Math.min((quiz.thinking_time_sec && quiz.thinking_time_sec > 0)
                    ? quiz.thinking_time_sec : DEFAULT_THINKING_TIME, 12);
  const FIFTY_AT = QTIME / 2; // 50/50 fires at halfway

  const allIdx  = [0,1,2,3];
  const keepIdx = (quiz.keep_5050_1 || []).map(v => (typeof v === 'string' ? parseInt(v) : v));
  const elimIdx = allIdx.filter(i => !keepIdx.includes(i));

  const hasMI   = !!(quiz.mission_impossible_question?.trim());
  const hasCta1 = !!(quiz.cta1_description_text?.trim());

  // ── Download all audio in parallel ──────────────────────────────────────
  console.log('[AUDIO] Downloading all assets...');
  const [
    hookFile, questionIntroFile, optionsIntroFile,
    timeupFile, cta1AudioFile, cta2AudioFile,
    missionIntroFile, cta3AudioFile,
    sfxQAppearFile, sfxMIFile,
    countdownFile, bgFile, correctSfxFile
  ] = await Promise.all([
    downloadAudio(quiz.hook_audio_url,                   `hook_${quiz.id}`),
    downloadAudio(quiz.question_intro_audio_url,         `qintro_${quiz.id}`),
    downloadAudio(quiz.options_intro_audio_url,          `ointro_${quiz.id}`),
    downloadAudio(quiz.timeup_audio_url,                 `timeup_${quiz.id}`),
    downloadAudio(quiz.cta1_audio_url,                   `cta1_${quiz.id}`),
    downloadAudio(quiz.cta2_audio_url,                   `cta2_${quiz.id}`),
    downloadAudio(quiz.mission_intro_audio_url,          `missintro_${quiz.id}`),
    downloadAudio(quiz.cta3_audio_url,                   `cta3_${quiz.id}`),
    downloadAudio(quiz.sfx_audio_url,                    `sfxq_${quiz.id}`, 'question_appear'),
    downloadAudio(quiz.sfx_audio_url,                    `sfxmi_${quiz.id}`, 'question_appear'),
    downloadAudio(quiz.countdown_music,                  `countdown_${quiz.id}`),
    downloadAudio(quiz.background_music || DEFAULT_BG_MUSIC, `bgmusic_${quiz.id}`),
    downloadAudio(quiz.correct_answer_sfx_audio_url,     `correctsfx_${quiz.id}`)
  ]);

  // ── Build HTML ───────────────────────────────────────────────────────────
  console.log('[HTML] Building...');
  const logoDataUri      = await getLogoDataUri();
  const { themeCss, decoHtml } = await resolveTheme(quiz);
  const htmlContent      = buildHtml({ themeCss, decoHtml, logoDataUri, quiz, options, keep5050: quiz.keep_5050_1 || [], QTIME });
  const htmlPath         = path.join(workDir, 'index.html');
  await fs.writeFile(htmlPath, htmlContent);

  // ── Launch browser ───────────────────────────────────────────────────────
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-web-security', '--allow-file-access-from-files'
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });

  const loadPage = async () => {
    await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
    await new Promise(r => setTimeout(r, 500));
  };
  await loadPage();

  const shot = async name => {
    const p = path.join(workDir, `${name}.png`);
    await page.screenshot({ path: p });
    return p;
  };
  const showScreen = async id => {
    await page.evaluate(id => window.showScreen(id), id);
    await new Promise(r => setTimeout(r, 180));
  };

  const clips       = [];
  const voiceRanges = [];
  let cursor        = 0;

  function pushClip(clip, isVoice = true) {
    if (isVoice) voiceRanges.push({ start: cursor, end: cursor + clip.dur });
    cursor += clip.dur;
    clips.push(clip);
  }

  // ════════════════════════════════════════════
  // S1: HOOK SCREEN
  // Logo animates in (CSS), hook_phrase fades in
  // ════════════════════════════════════════════
  await showScreen('screen-hook');
  await new Promise(r => setTimeout(r, 800)); // let logo animation settle
  const hookImg = await shot('hook');
  const hookAudio = await buildAudio({
    prerecorded: hookFile,
    fallbackText: quiz.hook_phrase || 'Stop scrolling! Can you beat this?',
    fallbackSec: 2.5, voice, leadGap: 0.1, workDir, name: 'hook'
  });
  pushClip(await imgClip(hookImg, hookAudio.path, Math.max(hookAudio.dur, 2.5), workDir, 'clip_hook'));

  // ════════════════════════════════════════════
  // S2: QUESTION SCREEN
  // question_intro_audio → options_intro_audio → "time starts now" TTS
  // Countdown bar visible. At FIFTY_AT seconds, 50/50 fires.
  // Full screen-recorded so countdown + 50/50 are live.
  // ════════════════════════════════════════════

  // First: build the pre-countdown audio (intros + options readout)
  const preCountdownParts = [];
  const gap_pre = path.join(workDir, 'pre_gap.mp3');
  await silence(GAP_OPTIONS, gap_pre);
  preCountdownParts.push(gap_pre);

  if (questionIntroFile) {
    preCountdownParts.push(questionIntroFile);
    const gqi = path.join(workDir, 'gqi.mp3'); await silence(0.2, gqi);
    preCountdownParts.push(gqi);
  }
  if (sfxQAppearFile) {
    preCountdownParts.push(sfxQAppearFile);
    const gsfx = path.join(workDir, 'gsfx.mp3'); await silence(0.15, gsfx);
    preCountdownParts.push(gsfx);
  }
  if (optionsIntroFile) {
    preCountdownParts.push(optionsIntroFile);
  } else {
    const oiTts = path.join(workDir, 'oi_tts.mp3');
    await tts('Here are your options', voice, oiTts, 1.2);
    preCountdownParts.push(oiTts);
  }
  const gopts = path.join(workDir, 'gopts.mp3'); await silence(0.3, gopts);
  preCountdownParts.push(gopts);

  // Read each option aloud
  for (let i = 0; i < options.length; i++) {
    if (!options[i]) continue;
    const oSil = path.join(workDir, `osil_${i}.mp3`); await silence(0.18, oSil);
    const oTts = path.join(workDir, `otts_${i}.mp3`);
    await tts(`${String.fromCharCode(65+i)}. ${options[i]}`, voice, oTts, 1);
    preCountdownParts.push(oSil, oTts);
  }

  // "time starts now" TTS
  const startGap = path.join(workDir, 'startgap.mp3'); await silence(0.3, startGap);
  const startTts = path.join(workDir, 'startnow.mp3');
  await tts(`You have ${QTIME} seconds — time starts now!`, voice, startTts, 2);
  preCountdownParts.push(startGap, startTts);

  const preCountdownAudio = path.join(workDir, 'pre_countdown.mp3');
  await concatAudio(preCountdownParts, preCountdownAudio, workDir);
  const preCountdownDur = await audioDur(preCountdownAudio);

  // Screen-record the full question screen: pre-audio period + countdown
  await loadPage();
  await showScreen('screen-question');
  // Trigger option stagger immediately (they're visible from start of recording)
  await page.evaluate(() => window.showOptions());
  await new Promise(r => setTimeout(r, 200));

  const qRawVideo  = path.join(workDir, 'q_raw.mp4');
  const totalQTime = preCountdownDur + QTIME;

  const qRecorder  = new PuppeteerScreenRecorder(page, {
    fps: 30, videoFrame: { width: 1080, height: 1920 }, aspectRatio: '9:16'
  });
  await qRecorder.start(qRawVideo);

  // During pre-countdown: just wait
  await new Promise(r => setTimeout(r, Math.round(preCountdownDur * 1000)));

  // Start visible countdown bar + 50/50 at midpoint
  await page.evaluate((sec) => window.startCountdown(sec), QTIME);
  const fiftyFireAt = Math.round(FIFTY_AT * 1000);
  setTimeout(async () => {
    await page.evaluate((ei) => window.eliminate5050(ei), elimIdx).catch(() => {});
  }, fiftyFireAt);

  await new Promise(r => setTimeout(r, Math.round(QTIME * 1000)));
  await withTimeout(qRecorder.stop(), TIMEOUT_RECORDER, 'qRecorder.stop()');

  // Build countdown audio (loop countdown music for QTIME)
  const cdBase = path.join(workDir, 'cd_base.mp3');
  if (countdownFile) {
    await ffmpeg(
      `-y -stream_loop -1 -i "${countdownFile}" -t ${QTIME} -af "volume=0.75" -ar 44100 -acodec libmp3lame "${cdBase}"`,
      'cdLoop'
    );
  } else {
    await silence(QTIME, cdBase);
  }

  // Full Q-screen audio = pre-countdown audio + countdown music
  const fullQAudio = path.join(workDir, 'q_full_audio.mp3');
  await concatAudio([preCountdownAudio, cdBase], fullQAudio, workDir);

  // Re-encode recording to H264
  const qH264 = path.join(workDir, 'q_h264.mp4');
  await reencodeToH264(qRawVideo, qH264);

  // Merge audio onto video
  const qClip = path.join(workDir, 'clip_question.mp4');
  await ffmpeg(
    `-y -i "${qH264}" -i "${fullQAudio}" ` +
    `-c:v libx264 -c:a aac -b:a 128k -ar 44100 ` +
    `-map 0:v:0 -map 1:a:0 -shortest -t ${totalQTime} "${qClip}"`,
    'qClipMerge'
  );
  pushClip({ path: qClip, dur: await videoDur(qClip) });

  // ════════════════════════════════════════════
  // S3: TIMEUP SCREEN
  // ════════════════════════════════════════════
  await loadPage();
  await showScreen('screen-timeup');
  const timeupImg = await shot('timeup');
  const timeupAudio = await buildAudio({
    prerecorded: timeupFile,
    fallbackText: quiz.timeup_text || "Time's up! Let's reveal the correct answer.",
    fallbackSec: 2.0, voice, leadGap: GAP_DEFAULT, workDir, name: 'timeup'
  });
  pushClip(await imgClip(timeupImg, timeupAudio.path, timeupAudio.dur, workDir, 'clip_timeup'));

  // ════════════════════════════════════════════
  // S4: ANSWER REVEAL
  // ════════════════════════════════════════════
  await showScreen('screen-answer');
  const answerImg = await shot('answer');
  const answerParts = [];
  const silAns = path.join(workDir, 'sil_ans.mp3'); await silence(GAP_ANSWER, silAns);
  answerParts.push(silAns);
  if (correctSfxFile) {
    answerParts.push(correctSfxFile);
    const sg = path.join(workDir, 'sfxgap_ans.mp3'); await silence(0.15, sg);
    answerParts.push(sg);
  }
  const correctTts = path.join(workDir, 'correct_tts.mp3');
  await tts(correct, voice, correctTts, 1.5);
  answerParts.push(correctTts);
  const answerAudio = path.join(workDir, 'answer_audio.mp3');
  await concatAudio(answerParts, answerAudio, workDir);
  pushClip(await imgClip(answerImg, answerAudio, Math.max(await audioDur(answerAudio), 2), workDir, 'clip_answer'));

  // ════════════════════════════════════════════
  // S5: MISSION IMPOSSIBLE SCREEN
  // Checklist points 1–7, all on ONE screen with timed JS reveals.
  // Skipped entirely if mission_impossible_question is null/empty.
  // ════════════════════════════════════════════
  if (hasMI) {
    console.log('[MI] Building Mission Impossible segment...');
    await loadPage();
    await showScreen('screen-mi');

    // Start recording immediately — MI title + tagline are visible from t=0 (CSS animations)
    const miRawVideo = path.join(workDir, 'mi_raw.mp4');
    const miRecorder = new PuppeteerScreenRecorder(page, {
      fps: 30, videoFrame: { width: 1080, height: 1920 }, aspectRatio: '9:16'
    });
    await miRecorder.start(miRawVideo);

    // Build MI audio timeline
    // Phase A: sfx_mission_impossible plays simultaneously with title display
    const miAudioParts = [];
    const miSfxGap = path.join(workDir, 'mi_sfx_gap.mp3'); await silence(0.3, miSfxGap);
    miAudioParts.push(miSfxGap);
    if (sfxMIFile) {
      miAudioParts.push(sfxMIFile);
      const mg2 = path.join(workDir, 'mi_sfx_gap2.mp3'); await silence(0.2, mg2);
      miAudioParts.push(mg2);
    } else {
      const mg2 = path.join(workDir, 'mi_sfx_gap2.mp3'); await silence(0.5, mg2);
      miAudioParts.push(mg2);
    }

    // Phase B: mission_intro_audio_url (pre-recorded) plays after SFX
    if (missionIntroFile) {
      miAudioParts.push(missionIntroFile);
    } else {
      const miIntroTts = path.join(workDir, 'mi_intro_tts.mp3');
      await tts(quiz.mission_intro_text || 'MISSION IMPOSSIBLE! Are you smart enough?', voice, miIntroTts, 2.5);
      miAudioParts.push(miIntroTts);
    }

    // Gap before question appears
    const miQGap = path.join(workDir, 'mi_q_gap.mp3'); await silence(0.6, miQGap);
    miAudioParts.push(miQGap);

    // Calculate when question should appear (after sfx + intro audio)
    const phaseA_mp3 = path.join(workDir, 'mi_phase_a.mp3');
    await concatAudio(miAudioParts, phaseA_mp3, workDir);
    const phaseADur = await audioDur(phaseA_mp3);

    // Phase C: silence for question + options display (no TTS — points 4,5)
    // question appears, then 0.5s later options appear
    const miQDisplayDur  = 0.5;   // question appear
    const miOptDisplayDur = 0.5;  // options stagger
    const miBeforeCta3   = 2.5;   // wait before cta3 text appears (checklist point 6)

    const miDisplaySil = path.join(workDir, 'mi_display_sil.mp3');
    await silence(miQDisplayDur + miOptDisplayDur + miBeforeCta3, miDisplaySil);

    // Phase D: cta3_audio_url (checklist point 7)
    const cta3Audio = await buildAudio({
      prerecorded: cta3AudioFile,
      fallbackText: quiz.cta3_text || 'Like, share and subscribe!',
      fallbackSec: 3.5, voice, leadGap: 0.1, workDir, name: 'mi_cta3'
    });

    // Phase E: 1s freeze after cta3 audio (checklist point 11)
    const miFreezeSil = path.join(workDir, 'mi_freeze.mp3');
    await silence(1.0, miFreezeSil);

    // Full MI audio = phaseA + display silence + cta3 + freeze
    const miFullAudio = path.join(workDir, 'mi_full_audio.mp3');
    await concatAudio(
      [phaseA_mp3, miDisplaySil, cta3Audio.path, miFreezeSil],
      miFullAudio, workDir
    );
    const miTotalDur = await audioDur(miFullAudio);

    // Schedule JS reveals while recording plays
    // Question appear: after phaseADur ms
    const qAppearMs   = Math.round(phaseADur * 1000);
    // Options: 500ms after question
    const optAppearMs = qAppearMs + Math.round(miQDisplayDur * 1000);
    // CTA3: 2500ms after question (checklist: 2.5s from question appear)
    const cta3AppearMs = qAppearMs + 2500;

    setTimeout(() => page.evaluate(() => window.showMiQuestion()).catch(() => {}), qAppearMs);
    setTimeout(() => page.evaluate(() => window.showMiOptions()).catch(() => {}),  optAppearMs);
    setTimeout(() => page.evaluate(() => window.showMiCta3()).catch(() => {}),     cta3AppearMs);

    // Wait for full MI duration
    await new Promise(r => setTimeout(r, Math.round(miTotalDur * 1000)));
    await withTimeout(miRecorder.stop(), TIMEOUT_RECORDER, 'miRecorder.stop()');

    // Re-encode + merge audio
    const miH264 = path.join(workDir, 'mi_h264.mp4');
    await reencodeToH264(miRawVideo, miH264);
    const miClip = path.join(workDir, 'clip_mi.mp4');
    await ffmpeg(
      `-y -i "${miH264}" -i "${miFullAudio}" ` +
      `-c:v libx264 -c:a aac -b:a 128k -ar 44100 ` +
      `-map 0:v:0 -map 1:a:0 -shortest -t ${miTotalDur} "${miClip}"`,
      'miClipMerge'
    );
    pushClip({ path: miClip, dur: await videoDur(miClip) });
  } else {
    console.log('[MI] mission_impossible_question is null — skipping MI segment');
  }

  // ════════════════════════════════════════════
  // S6: CTA2 / END SCREEN  (checklist points 8–10)
  // cta2_text (if no cta1), platform URL with finger, 1s freeze
  // ════════════════════════════════════════════
  await loadPage();
  await showScreen('screen-cta2');
  await new Promise(r => setTimeout(r, 400));
  const cta2Img = await shot('cta2');

  const cta2AudioData = await buildAudio({
    prerecorded: hasCta1 ? cta1AudioFile : cta2AudioFile,
    fallbackText: hasCta1
      ? (quiz.cta1_description_text || 'Check the link in description!')
      : (quiz.cta2_text             || 'Play real quiz and earn ONS tokens!'),
    fallbackSec: 3.5, voice, leadGap: GAP_DEFAULT, workDir, name: 'cta2_end'
  });

  // 1s freeze after audio (checklist point 11)
  const cta2FreezeSil = path.join(workDir, 'cta2_freeze.mp3');
  await silence(1.0, cta2FreezeSil);
  const cta2FullAudio = path.join(workDir, 'cta2_full.mp3');
  await concatAudio([cta2AudioData.path, cta2FreezeSil], cta2FullAudio, workDir);
  const cta2Dur = await audioDur(cta2FullAudio);

  pushClip(await imgClip(cta2Img, cta2FullAudio, cta2Dur, workDir, 'clip_cta2'));

  await browser.close();

  // ════════════════════════════════════════════
  // FINAL CONCAT + BG MUSIC
  // ════════════════════════════════════════════
  console.log(`[VIDEO] Assembling ${clips.length} clips...`);
  const concatTxt = path.join(workDir, 'concat.txt');
  await fs.writeFile(
    concatTxt,
    clips.map(c => `file '${c.path.replace(/'/g, "'\\''")}' `).join('\n')
  );
  const concatenated = path.join(workDir, 'concatenated.mp4');
  await ffmpeg(
    `-y -f concat -safe 0 -i "${concatTxt}" ` +
    `-c:v libx264 -pix_fmt yuv420p -r 30 -c:a aac -b:a 128k -ar 44100 ` +
    `-movflags +faststart "${concatenated}"`,
    'finalConcat'
  );
  const total = await videoDur(concatenated);
  console.log(`[VIDEO] Total: ${total.toFixed(1)}s`);
  return applyBgMusic(concatenated, total, voiceRanges, bgFile, workDir);
}

processJobs()
  .then(() => { console.log('[WORKER] Run complete.'); process.exit(0); })
  .catch(err => { console.error('[WORKER] Fatal:', err); process.exit(1); });
