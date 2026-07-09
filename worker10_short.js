'use strict';
// ═══════════════════════════════════════════════════════════════════════
// WORKER 10-SHORT  v3 — 20-Second Quiz Short Format with Avatar Strip
//
// FLOW (all durations 100% dynamic from actual audio file lengths):
//
//  Step 1+2 — COMBINED  Full-screen human host .mp4 (hook + question
//             intro audio embedded in the clip). Single screen-record.
//
//  Step 3   — Q+OPTIONS screen.
//             Avatar strip at bottom (always visible from step 3 onward):
//               LEFT  : human circle 140px — silent, idle expression video
//               RIGHT : dog circle 140px   — CSS amplitude pulse while
//                       TTS plays (question + "5 sec, time starts now!")
//
//  Step 4   — COUNTDOWN screen (same quiz layout).
//             Avatar strip: both human and dog silent / idle. No pulse.
//             5-second countdown, 50/50 at 3s, countdown_music loops.
//
//  Step 5   — TIMEUP screen.
//             Avatar strip: human circle plays timeup clip + audio.
//             Dog silent/idle.
//
//  Step 6   — CTA screen ("write your answer in comments").
//             Avatar strip: human circle plays cta4 clip + audio.
//             Dog silent/idle.
//
//  NO answer reveal. NO correct answer shown.
//
// ASSETS (from avatar_assets Supabase table, R2 URLs):
//   human_hook   — full-screen .mp4 for steps 1+2
//   human_idle   — looping idle .mp4 for human circle (steps 3+4)
//   human_timeup — speaking .mp4 for human circle (step 5)
//   human_cta4   — speaking .mp4 for human circle (step 6)
//   Dog          — pure CSS animation placeholder (no file needed yet)
// ═══════════════════════════════════════════════════════════════════════

const { exec }    = require('child_process');
const util        = require('util');
const execPromise = util.promisify(exec);
const fs          = require('fs').promises;
const path        = require('path');
const puppeteer   = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ─── ENV ──────────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const cleanUrl    = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;
if (!cleanUrl || !supabaseKey) { console.error('[SHORT] Missing Supabase credentials'); process.exit(1); }

const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_ENDPOINT   = process.env.R2_ENDPOINT;
const R2_BUCKET     = process.env.R2_BUCKET;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const R2_CONFIGURED = !!(R2_ACCESS_KEY && R2_SECRET_KEY && R2_ENDPOINT && R2_BUCKET && R2_PUBLIC_URL);
const s3Client = R2_CONFIGURED ? new S3Client({
  region: 'auto', endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY }
}) : null;

// ─── CONSTANTS ────────────────────────────────────────────────────────
const VOICE_MAP = {
  en: 'en-US-JennyNeural', hi: 'hi-IN-SwaraNeural',
  es: 'es-ES-ElviraNeural', pt: 'pt-BR-FranciscaNeural'
};
const THEMES_DIR        = path.join(__dirname, 'themes');
const CACHE_DIR         = '/tmp/audio_cache_short';
const DEFAULT_THEME     = 'particle_field';
const LOGO_PATH         = path.join(__dirname, 'assets', 'jaasX-logo-saved-for-web.png');
const DEFAULT_BG_MUSIC  = 'https://pub-3578d297d3904e1d8ffedfc9dd4102f2.r2.dev/audio/background_music/The_Midnight_Audit.mp3';
const PLATFORM_URL_BASE = 'https://jaasblog.online/quiz';
const TIMEOUT_JOB       = 25 * 60 * 1000;
const TIMEOUT_RECORDER  = 90 * 1000;
const BG_VOL_BASE       = 0.10;
const BG_VOL_DUCK       = 0.035;
const SHORT_COUNTDOWN   = 5;
const SHORT_FIFTY_AT    = 3;
const SHORT_HINT_AT     = 2;
// Avatar circle size (px) — matches CSS below
const AVATAR_SIZE       = 140;

// ─── SUPABASE ─────────────────────────────────────────────────────────
async function fetchSupabase(pathStr, opts = {}) {
  const url    = `${cleanUrl}/rest/v1/${pathStr}`;
  const method = opts.method || 'GET';
  const res    = await fetch(url, {
    method,
    headers: {
      'apikey':        supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type':  'application/json',
      'Prefer':        method === 'POST' ? 'return=representation' : 'return=minimal',
      ...(opts.headers || {})
    },
    body: opts.body
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Supabase ${method} ${pathStr} → ${res.status}: ${t.slice(0, 300)}`);
  }
  const txt = await res.text();
  try { return txt ? JSON.parse(txt) : null; } catch { return txt; }
}

// Fetch all avatar asset URLs from the avatar_assets table in one call
async function fetchAvatarAssets() {
  const assets = {
    human_hook:   null,   // full-screen clip for steps 1+2
    human_idle:   null,   // looping idle for human circle
    human_timeup: null,   // speaking clip for step 5
    human_cta4:   null,   // speaking clip for step 6
  };
  try {
    const rows = await fetchSupabase(
      'avatar_assets?is_active=eq.true&select=asset_key,video_url'
    );
    for (const row of (rows || [])) {
      if (row.asset_key in assets && row.video_url) {
        assets[row.asset_key] = row.video_url;
      }
    }
    console.log('[AVATAR] Loaded asset URLs:', Object.entries(assets).map(([k,v])=>`${k}=${v?'OK':'missing'}`).join(' '));
  } catch (e) {
    console.warn('[AVATAR] Could not fetch avatar_assets table (non-fatal):', e.message);
  }
  return assets;
}

// ─── FS / UTILITY ─────────────────────────────────────────────────────
async function ensureDir(d)  { await fs.mkdir(d, { recursive: true }); }
async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

function withTimeout(promise, ms, label = '') {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`Timeout ${ms}ms: ${label}`)), ms);
    promise.then(v => { clearTimeout(t); res(v); }).catch(e => { clearTimeout(t); rej(e); });
  });
}

// ─── FFMPEG ───────────────────────────────────────────────────────────
async function ffmpeg(args, label = '') {
  const cmd = `ffmpeg ${args}`;
  console.log(`[FF:${label}] ${cmd.slice(0, 150)}`);
  return execPromise(cmd, { maxBuffer: 100 * 1024 * 1024 });
}

// ─── AUDIO PRIMITIVES ─────────────────────────────────────────────────
async function silence(sec, outPath) {
  await ffmpeg(
    `-y -f lavfi -i anullsrc=r=44100:cl=mono -t ${sec} -ar 44100 -ac 1 -acodec libmp3lame "${outPath}"`,
    'sil'
  );
}

async function probeNum(filePath) {
  try {
    const { stdout } = await execPromise(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${filePath}"`
    );
    const d = parseFloat(stdout.trim());
    return isNaN(d) ? 0 : d;
  } catch { return 0; }
}
const audioDur = probeNum;
const videoDur = probeNum;

// CRITICAL: FFmpeg's concat DEMUXER (-f concat) requires every input to have
// an IDENTICAL codec/samplerate/channel layout. Our parts are a mix of:
//   - .wav  (sfx_cues, timeup_cues, cta4_cues downloaded from R2)
//   - .mp3  (edge-tts output, generated silence)
// Feeding mixed codecs to the demuxer silently drops all but the first stream
// -- which is exactly why the question TTS never played in step 3.
//
// Fix: normalise EVERY part to mp3/44100Hz/mono FIRST, then concat.
async function concatAudio(parts, outPath, workDir) {
  const valid = (parts || []).filter(Boolean);
  if (!valid.length) { await silence(0.5, outPath); return; }

  if (valid.length === 1) {
    await ffmpeg(`-y -i "${valid[0]}" -ar 44100 -ac 1 -acodec libmp3lame "${outPath}"`, 'cat1');
    return;
  }

  // Step 1 -- normalise each part to a uniform mp3 so the demuxer is happy
  const stamp = Date.now();
  const normDir = path.join(workDir, `norm_${stamp}`);
  await ensureDir(normDir);

  const normalised = [];
  for (let i = 0; i < valid.length; i++) {
    const src = valid[i];
    if (!await fileExists(src)) {
      console.warn(`[CAT] part ${i} missing, skipping: ${src}`);
      continue;
    }
    const dst = path.join(normDir, `p${String(i).padStart(2,'0')}.mp3`);
    try {
      await ffmpeg(
        `-y -i "${src}" -vn -ar 44100 -ac 1 -b:a 128k -acodec libmp3lame "${dst}"`,
        `catnorm${i}`
      );
      const d = await audioDur(dst);
      if (d > 0) {
        normalised.push(dst);
        console.log(`[CAT] part ${i}: ${path.basename(src)} -> ${d.toFixed(2)}s`);
      } else {
        console.warn(`[CAT] part ${i} normalised to 0s, skipping`);
      }
    } catch (e) {
      console.warn(`[CAT] part ${i} normalise failed: ${e.message.slice(0,80)}`);
    }
  }

  if (!normalised.length) { await silence(0.5, outPath); return; }
  if (normalised.length === 1) {
    await ffmpeg(`-y -i "${normalised[0]}" -ar 44100 -ac 1 -acodec libmp3lame "${outPath}"`, 'cat1n');
    return;
  }

  // Step 2 -- concat the now-uniform mp3 parts
  const lst = path.join(workDir, `cat_${stamp}.txt`);
  await fs.writeFile(lst, normalised.map(p => `file '${p.replace(/'/g,"'\\''")}'`).join('\n'));
  await ffmpeg(
    `-y -f concat -safe 0 -i "${lst}" -ar 44100 -ac 1 -acodec libmp3lame "${outPath}"`,
    'cat'
  );

  const finalDur = await audioDur(outPath);
  console.log(`[CAT] concatenated ${normalised.length} parts -> ${finalDur.toFixed(2)}s`);
}

async function tts(text, voice, outPath, retries = 3) {
  if (!text?.trim()) { await silence(0.5, outPath); return; }
  const safe = text.replace(/"/g, "'").replace(/[^\x00-\x7F]/g, ' ').slice(0, 500);
  for (let i = 0; i < retries; i++) {
    try {
      await execPromise(`edge-tts --voice "${voice}" --text "${safe}" --write-media "${outPath}"`);
      if (await fileExists(outPath)) return;
    } catch (e) {
      console.warn(`[TTS] attempt ${i+1}: ${e.message.slice(0,80)}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  await silence(1, outPath);
}

// ─── DOWNLOAD (audio or video) ────────────────────────────────────────
async function download(url, name, jsonKey = null) {
  if (!url) return null;
  await ensureDir(CACHE_DIR);
  let resolvedUrl = url;
  if (typeof url === 'string' && url.trim().startsWith('{')) {
    try {
      const p = JSON.parse(url);
      resolvedUrl = jsonKey ? p[jsonKey] : (p.question_appear || p[Object.keys(p)[0]]);
    } catch { resolvedUrl = url; }
  }
  if (!resolvedUrl?.startsWith('http')) return null;
  const ext  = resolvedUrl.split('?')[0].split('.').pop().toLowerCase() || 'mp4';
  const safe = name.replace(/[^a-z0-9_]/gi, '_').slice(0, 40);
  const dest = path.join(CACHE_DIR, `${safe}.${ext}`);
  if (await fileExists(dest)) { console.log(`[DL] cache: ${safe}.${ext}`); return dest; }
  try {
    const res = await withTimeout(
      fetch(resolvedUrl, { headers: { 'User-Agent': 'Mozilla/5.0 JaasX/1.0' } }),
      45000, `dl:${name}`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(dest, buf);
    console.log(`[DL] ${safe}.${ext} ${(buf.length/1024).toFixed(0)}KB`);
    return dest;
  } catch (e) {
    console.warn(`[DL] FAILED ${name}: ${e.message.slice(0,80)}`);
    return null;
  }
}

// ─── LOGO ─────────────────────────────────────────────────────────────
async function getLogoDataUri() {
  try {
    const buf = await fs.readFile(LOGO_PATH);
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch (e) { console.warn('[LOGO]', e.message); return ''; }
}

// Convert a local video file to a base64 data URI for inline HTML injection
async function videoToDataUri(localPath) {
  if (!localPath || !await fileExists(localPath)) return null;
  try {
    const buf = await fs.readFile(localPath);
    const ext = path.extname(localPath).replace('.', '') || 'mp4';
    const mime = ext === 'webm' ? 'video/webm' : 'video/mp4';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (e) { console.warn(`[VIDEO-URI] ${e.message}`); return null; }
}

// ─── THEME ────────────────────────────────────────────────────────────
async function resolveTheme(quiz) {
  const id   = (quiz.visual_theme_id || DEFAULT_THEME).toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const base = await fs.readFile(path.join(THEMES_DIR, '_base.css'), 'utf8').catch(() => '');
  const th   = await fs.readFile(path.join(THEMES_DIR, `${id}.css`), 'utf8')
                 .catch(() => fs.readFile(path.join(THEMES_DIR, `${DEFAULT_THEME}.css`), 'utf8').catch(() => ''));
  const decoHtml = th.match(/\/\*\s*DECO_HTML\s*([\s\S]*?)\*\//)?.[1]?.trim() || '';
  return { themeCss: `${base}\n${th}`, decoHtml };
}

// ─── AVATAR STRIP HTML + CSS ──────────────────────────────────────────
// Injected into every screen from step 3 onward.
// humanVideoDataUri — base64 data URI of the human idle or speaking clip
// mode — 'human_speaking' | 'dog_speaking' | 'both_silent'
function buildAvatarStripHtml(humanVideoDataUri, humanVideoPath, mode) {
  const hasHuman = !!(humanVideoDataUri || humanVideoPath);
  // Human video element — muted (audio handled by separate ffmpeg mux)
  const humanVideoSrc = humanVideoDataUri || '';
  const humanEl = hasHuman
    ? `<video id="av-human" class="av-circle av-human ${mode === 'human_speaking' ? 'av-speaking' : ''}"
              src="${humanVideoSrc}" autoplay loop muted playsinline></video>`
    : `<div id="av-human" class="av-circle av-human av-placeholder ${mode === 'human_speaking' ? 'av-speaking' : ''}">
         <span class="av-placeholder-icon">👤</span>
       </div>`;

  // Dog — always CSS-only. .av-dog-speaking triggers the amplitude pulse.
  const dogClass = mode === 'dog_speaking' ? 'av-dog-speaking' : '';
  const dogEl = `
    <div id="av-dog" class="av-circle av-dog ${dogClass}">
      <span class="av-dog-face">🐶</span>
      <div class="av-dog-ring av-dog-ring-1"></div>
      <div class="av-dog-ring av-dog-ring-2"></div>
      <div class="av-dog-ring av-dog-ring-3"></div>
    </div>`;

  return `
<!-- AVATAR STRIP — injected for steps 3-6 -->
<div id="avatar-strip">
  ${humanEl}
  ${dogEl}
</div>`;
}

// CSS injected once into the HTML head
const AVATAR_CSS = `
<style id="avatar-strip-style">
/* ── Avatar strip container ── */
#avatar-strip {
  position: fixed;
  bottom: 36px;
  left: 0;
  right: 0;
  z-index: 9999;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 0 32px;
  pointer-events: none;
}

/* ── Shared circle style ── */
.av-circle {
  width:  ${AVATAR_SIZE}px;
  height: ${AVATAR_SIZE}px;
  border-radius: 50%;
  overflow: hidden;
  border: 3px solid rgba(255,255,255,0.55);
  box-shadow: 0 4px 24px rgba(0,0,0,0.45);
  background: #111;
  position: relative;
  flex-shrink: 0;
}

/* Human video fills the circle */
.av-human video,
video.av-human {
  width:  100%;
  height: 100%;
  object-fit: cover;
  border-radius: 50%;
}

/* Human placeholder icon (fallback when no video) */
.av-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #1a2340, #0d1520);
}
.av-placeholder-icon {
  font-size: 64px;
  line-height: 1;
}

/* ── Human speaking pulse (border glow) ── */
.av-human.av-speaking {
  border-color: #00cfff;
  animation: humanSpeak 0.5s ease-in-out infinite alternate;
}
@keyframes humanSpeak {
  from { box-shadow: 0 0 0  4px rgba(0,207,255,0.4), 0 4px 24px rgba(0,0,0,0.45); }
  to   { box-shadow: 0 0 0 10px rgba(0,207,255,0.15),0 4px 24px rgba(0,0,0,0.45); }
}

/* ── Dog face ── */
.av-dog {
  background: linear-gradient(135deg, #2a1a00, #1a1000);
  display: flex;
  align-items: center;
  justify-content: center;
}
.av-dog-face {
  font-size: 72px;
  line-height: 1;
  display: block;
  position: relative;
  z-index: 2;
  /* Idle: very subtle slow breath bob */
  animation: dogIdle 3s ease-in-out infinite;
}
@keyframes dogIdle {
  0%,100% { transform: scale(1.00) translateY(0); }
  50%      { transform: scale(1.02) translateY(-3px); }
}

/* ── Dog speaking — amplitude rings + face pulse ── */
/* Ring elements sit behind the emoji */
.av-dog-ring {
  position: absolute;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  border: 2px solid rgba(255,200,50,0.0);
  width:  ${AVATAR_SIZE}px;
  height: ${AVATAR_SIZE}px;
  z-index: 1;
}

/* When .av-dog-speaking is on the wrapper, all three rings animate */
.av-dog-speaking .av-dog-ring-1 {
  animation: dogRing 0.55s ease-out infinite 0.00s;
}
.av-dog-speaking .av-dog-ring-2 {
  animation: dogRing 0.55s ease-out infinite 0.18s;
}
.av-dog-speaking .av-dog-ring-3 {
  animation: dogRing 0.55s ease-out infinite 0.36s;
}
@keyframes dogRing {
  0%   { transform: translate(-50%,-50%) scale(1.00); border-color: rgba(255,200,50,0.70); opacity:1; }
  100% { transform: translate(-50%,-50%) scale(1.55); border-color: rgba(255,200,50,0.00); opacity:0; }
}

/* Dog face pulses to simulate mouth open/close during speaking */
.av-dog-speaking .av-dog-face {
  animation: dogSpeak 0.28s ease-in-out infinite alternate;
}
@keyframes dogSpeak {
  from { transform: scale(0.92) translateY( 2px); }
  to   { transform: scale(1.08) translateY(-2px); }
}

/* Border glow when dog is speaking */
.av-dog-speaking {
  border-color: #ffc832;
  box-shadow: 0 0 0 4px rgba(255,200,50,0.25), 0 4px 24px rgba(0,0,0,0.45);
}
</style>`;

// ─── SCREEN RECORDER CLIP ─────────────────────────────────────────────
// Records `dur` seconds of Puppeteer page (UI only — no video elements).
// The human clip is composited by FFmpeg AFTER recording, not inside Puppeteer.
// Returns { path, dur }.
async function recordedClip(page, audioPath, dur, workDir, name) {
  const rawPath  = path.join(workDir, `${name}_raw.mp4`);
  const h264Path = path.join(workDir, `${name}_h264.mp4`);
  const outPath  = path.join(workDir, `${name}.mp4`);

  const rec = new PuppeteerScreenRecorder(page, {
    fps: 30, videoFrame: { width: 1080, height: 1920 },
    aspectRatio: '9:16', followNewTab: false
  });
  await rec.start(rawPath);
  await new Promise(r => setTimeout(r, Math.max(dur, 0.5) * 1000));
  await withTimeout(rec.stop(), TIMEOUT_RECORDER, `${name}.stop`);

  // Re-encode VP8→H264 (PuppeteerScreenRecorder outputs VP8/WebM)
  await ffmpeg(
    `-y -i "${rawPath}" -an -c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 -vf "scale=1080:1920" "${h264Path}"`,
    `${name}_enc`
  );

  if (audioPath && await fileExists(audioPath)) {
    await ffmpeg(
      `-y -stream_loop -1 -i "${h264Path}" -i "${audioPath}" ` +
      `-map 0:v:0 -map 1:a:0 ` +
      `-c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
      `-c:a aac -b:a 128k -ar 44100 -ac 1 ` +
      `-t ${dur} "${outPath}"`,
      `${name}_mux`
    );
  } else {
    await ffmpeg(
      `-y -i "${h264Path}" -c:v copy -an -t ${dur} "${outPath}"`,
      `${name}_vid`
    );
  }
  return { path: outPath, dur };
}

// ─── FFMPEG COMPOSITE: overlay human circle onto a UI clip ────────────
// Takes a Puppeteer-recorded UI clip and overlays a circular crop of the
// human video clip in the bottom-left corner (matching the CSS avatar strip).
// The dog circle stays as CSS — it's in the UI recording already.
//
//  uiClipPath     — Puppeteer screen recording (H264, 1080x1920)
//  humanClipPath  — R2 downloaded .mp4 of the human host
//  dur            — target duration in seconds
//  outPath        — output file path
//  circleSize     — diameter in pixels (default 140)
//  padBottom      — px from bottom of frame to circle centre (default 106)
//  padLeft        — px from left edge to circle centre (default 172)
async function compositeHumanCircle(uiClipPath, humanClipPath, dur, outPath, circleSize = 140, padBottom = 106, padLeft = 172) {
  // Circle geometry
  const r  = circleSize / 2;
  // Position: bottom-left, matching CSS `bottom:36px; padding:0 32px`
  // Circle centre Y from top = 1920 - padBottom, centre X = padLeft
  const cx = padLeft;
  const cy = 1920 - padBottom;
  // Top-left corner of the bounding square in the output frame
  const ox = cx - r;
  const oy = cy - r;

  // FFmpeg filter_complex:
  // 1. Loop human clip to cover full duration
  // 2. Scale to circle size
  // 3. Crop to circle using an alpha mask (alphamerge with geq)
  // 4. Overlay onto UI clip at (ox, oy)
  const filter = [
    // Scale human clip to circleSize x circleSize
    `[1:v]scale=${circleSize}:${circleSize}[hscaled]`,
    // Create circular alpha mask: white inside circle, black outside
    `[hscaled]format=yuva420p,geq=` +
      `lum='p(X,Y)':` +
      `a='if(lte(pow(X-${r}\\,2)+pow(Y-${r}\\,2)\\,pow(${r}\\,2))\\,255\\,0)'` +
      `[hcircle]`,
    // Overlay circle onto UI at computed position
    `[0:v][hcircle]overlay=${ox}:${oy}:shortest=1[vout]`
  ].join(';');

  await ffmpeg(
    `-y -i "${uiClipPath}" -stream_loop -1 -i "${humanClipPath}" ` +
    `-filter_complex "${filter}" ` +
    `-map "[vout]" -map 0:a? ` +
    `-c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
    `-c:a aac -b:a 128k -ar 44100 -ac 1 ` +
    `-t ${dur} "${outPath}"`,
    'composite_circle'
  );
}

// ─── SHOW SCREEN (hide all .screen, activate selector) ────────────────
async function showScreen(page, sel) {
  await page.evaluate(s => {
    document.querySelectorAll('.screen').forEach(e => e.classList.remove('active'));
    const el = document.querySelector(s);
    if (el) el.classList.add('active');
  }, sel);
  await new Promise(r => setTimeout(r, 80));
}

// ─── SET AVATAR DOG MODE (CSS only — human handled by FFmpeg) ─────────
// mode: 'dog_speaking' | 'human_speaking' | 'both_silent'
// NOTE: Human video is NOT displayed inside Puppeteer. The av-human div
//       is a placeholder circle that is visually hidden behind the FFmpeg
//       composite step. The dog CSS animation IS real and appears in recording.
async function setAvatarMode(page, mode) {
  await page.evaluate((m) => {
    const dog = document.getElementById('av-dog');
    if (dog) dog.classList.toggle('av-dog-speaking', m === 'dog_speaking');

    // Human: just show the speaking glow border when human is speaking
    // The actual video is composited by FFmpeg, not displayed by Puppeteer.
    // The placeholder div shows a subtle glowing border to mark the slot.
    const human = document.getElementById('av-human');
    if (human) human.classList.toggle('av-speaking', m === 'human_speaking');
  }, mode);
}

// ─── BG MUSIC ─────────────────────────────────────────────────────────
async function applyBgMusic(videoPath, totalDur, voiceRanges, bgFile, workDir) {
  if (!bgFile || !await fileExists(bgFile)) {
    console.log('[BG] No file — skipping');
    return videoPath;
  }
  const outPath = path.join(workDir, 'final_with_music.mp4');
  const segs = [];
  let lastEnd = 0;
  for (const { start, end } of voiceRanges) {
    if (start > lastEnd) segs.push(`between(t,${lastEnd.toFixed(3)},${start.toFixed(3)})*${BG_VOL_BASE}`);
    segs.push(`between(t,${start.toFixed(3)},${end.toFixed(3)})*${BG_VOL_DUCK}`);
    lastEnd = end;
  }
  if (lastEnd < totalDur) segs.push(`between(t,${lastEnd.toFixed(3)},${totalDur.toFixed(3)})*${BG_VOL_BASE}`);
  const volFilter = segs.length
    ? `volume='${segs.join('+')}':eval=frame`
    : `volume=${BG_VOL_BASE}`;
  await ffmpeg(
    `-y -i "${videoPath}" -stream_loop -1 -i "${bgFile}" ` +
    `-filter_complex "[1:a]${volFilter}[bg];[0:a][bg]amix=inputs=2:duration=first:normalize=0[a]" ` +
    `-map 0:v -map "[a]" ` +
    `-c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
    `-c:a aac -b:a 128k -ar 44100 -ac 1 ` +
    `-t ${totalDur} -movflags +faststart "${outPath}"`,
    'bgMix'
  );
  return outPath;
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 1+2 — FULL-SCREEN HUMAN HOST VIDEO
//
// Architecture: do NOT use Puppeteer for this step at all.
// The human_hook.mp4 IS the video for steps 1+2. We just re-encode it
// to our target spec (1080x1920, H264) and use it directly.
// No screen-recording needed — the host clip is the full screen content.
// ═══════════════════════════════════════════════════════════════════════
async function buildHookStep(humanHookPath, workDir) {
  const stepName = 'sh_step12';
  const outPath  = path.join(workDir, `${stepName}.mp4`);

  if (humanHookPath && await fileExists(humanHookPath)) {
    const hostDur = Math.max(await videoDur(humanHookPath), 1.0);
    console.log(`[SHORT] Step 1+2: using host clip directly (${hostDur.toFixed(2)}s)`);

    // Re-encode to our exact spec: 1080x1920, 30fps, H264, AAC audio
    // The clip's own audio IS the hook+intro speech — no TTS needed.
    await ffmpeg(
      `-y -i "${humanHookPath}" ` +
      `-c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
      `-vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" ` +
      `-c:a aac -b:a 128k -ar 44100 -ac 1 ` +
      `-t ${hostDur} "${outPath}"`,
      `${stepName}_encode`
    );
    return { path: outPath, dur: hostDur };
  } else {
    // No host clip — Puppeteer fallback: record the hook slide for 3s
    console.log('[SHORT] Step 1+2: no host clip — using hook-slide fallback');
    return null; // caller handles null and records hook slide
  }
}

// ═══════════════════════════════════════════════════════════════════════
// STEPS 3+4 — Q+OPTIONS + COUNTDOWN
//
// Architecture:
//  1. Puppeteer records the UI (dog CSS rings animate — captured correctly)
//  2. FFmpeg composites humanIdleFile into the bottom-left circle
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// STEPS 5+6 — TIMEUP + CTA
//
// Architecture:
//  1. Puppeteer records the UI (dog idle, speaking glow border on human slot)
//  2. FFmpeg composites humanTimeupFile / humanCta4File into human circle
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// MAIN SHORT VIDEO BUILDER
// ═══════════════════════════════════════════════════════════════════════
async function buildShortVideo(quiz, workDir) {
  const lang     = quiz.lang_code || 'en';
  const voice    = VOICE_MAP[lang] || VOICE_MAP.en;
  const niche    = quiz.niche || 'general';
  const question = quiz.question_1     || '';
  const options  = quiz.options_1      || [];
  const keep5050 = quiz.keep_5050_1    || [];

  // 50/50 elimination classes
  const allIdx   = [0,1,2,3];
  const keepIdx  = keep5050.map(v => (typeof v === 'string' ? parseInt(v) : v));
  const elimIdx  = allIdx.filter(i => !keepIdx.includes(i));
  const optClass = i => elimIdx.includes(i) ? 'eliminate' : '';

  // ── Avatar assets from DB ──────────────────────────────────────────
  const avatarUrls = await fetchAvatarAssets();

  // ── Logo ───────────────────────────────────────────────────────────
  console.log('[SHORT] Loading logo...');
  const logoDataUri = await getLogoDataUri();

  // ── Audio downloads (quiz-specific) ───────────────────────────────
  console.log('[SHORT] Downloading audio...');
  const [
    countdownFile,
    timeupFile,
    cta4AudioFile,
    bgFile,
    sfxFile,
  ] = await Promise.all([
    download(quiz.countdown_music,   `sh_cd_${quiz.id}`),
    download(quiz.timeup_audio_url,  `sh_timeup_${quiz.id}`),
    download(quiz.cta4_audio_url,    `sh_cta4_${quiz.id}`),
    download(quiz.background_music || DEFAULT_BG_MUSIC, `sh_bg_${quiz.id}`),
    download(quiz.sfx_audio_url,     `sh_sfx_${quiz.id}`, 'question_appear'),
  ]);

  // ── Avatar video downloads (from R2 via avatar_assets table) ──────
  console.log('[SHORT] Downloading avatar clips...');
  const [
    humanHookFile,    // full-screen for steps 1+2 (used directly as video)
    humanIdleFile,    // composited into circle for steps 3+4
    humanTimeupFile,  // composited into circle for step 5
    humanCta4File,    // composited into circle for step 6
  ] = await Promise.all([
    download(avatarUrls.human_hook,   'av_hook'),
    download(avatarUrls.human_idle,   'av_idle'),
    download(avatarUrls.human_timeup, 'av_timeup'),
    download(avatarUrls.human_cta4,   'av_cta4'),
  ]);

  console.log('[SHORT] Avatar clips:', {
    hook:   humanHookFile   ? 'OK' : 'missing (will use fallback)',
    idle:   humanIdleFile   ? 'OK' : 'missing (circle will be placeholder)',
    timeup: humanTimeupFile ? 'OK' : 'missing (will use idle)',
    cta4:   humanCta4File   ? 'OK' : 'missing (will use idle)',
  });

  let resolvedBgFile = bgFile;
  if (!resolvedBgFile) {
    console.log('[SHORT][BG] Retrying default track...');
    resolvedBgFile = await download(DEFAULT_BG_MUSIC, 'sh_bg_default');
  }

  // ── Theme ──────────────────────────────────────────────────────────
  const { themeCss, decoHtml } = await resolveTheme(quiz);

  // ── Build HTML ─────────────────────────────────────────────────────
  const niceLabel = niche ? niche.charAt(0).toUpperCase() + niche.slice(1) : 'General';
  const nicheNo   = quiz.niche_challenge_no || 1;

  let html = await fs.readFile(path.join(__dirname, 'quiz_template.html'), 'utf8');
  const R = {
    '{{theme_css}}':         themeCss,
    '{{theme_deco_html}}':   decoHtml,
    '{{LOGO_DATA_URI}}':     logoDataUri,
    '{{design_engine_css}}': '',
    '{{transition_style}}':  quiz.transition_style || 'fade',
    '{{countdown_style}}':   quiz.countdown_style  || 'ring',
    '{{layout_variant}}':    quiz.layout_variant   || 'standard',
    '{{hook_phrase}}':       quiz.hook_phrase || 'Stop scrolling!',
    '{{quiz_no}}':           quiz.quiz_no ? `Challenge ID ${quiz.quiz_no}` : '',
    '{{question}}':          question,
    '{{options[0]}}': options[0]||'', '{{options[1]}}': options[1]||'',
    '{{options[2]}}': options[2]||'', '{{options[3]}}': options[3]||'',
    '{{opt0_class}}': optClass(0), '{{opt1_class}}': optClass(1),
    '{{opt2_class}}': optClass(2), '{{opt3_class}}': optClass(3),
    '{{rev0_class}}': '', '{{rev1_class}}': '', '{{rev2_class}}': '', '{{rev3_class}}': '',
    '{{hint}}':            quiz.hint_1 || '',
    '{{correct_answer}}':  '',
    '{{explanation_1}}':   '',
    '{{cta1_description_text}}': '',
    '{{cta2_text}}':       quiz.cta2_text || 'Play the full challenge!',
    '{{cta3_text}}':       quiz.cta3_text || 'Like, Share and Subscribe!',
    '{{cta4_text}}':       quiz.cta4_text || 'Write your answer in the comments!',
    '{{niche}}':           niche,
    '{{thumb_icon}}':      '❓',
    '{{thumb_badge_text}}':        '#Challenge',
    '{{thumb_catchphrase}}':       'Can you answer this?',
    '{{thumb_catchphrase_size}}':  '48',
    '{{thumb_mission_text}}':      question,
    '{{niche_challenge_no}}':      String(nicheNo),
    '{{niche_label}}':             niceLabel,
    '{{niche_challenge_label}}':   `${niceLabel} Challenge No #${nicheNo}`,
    '{{thumb_bg_style_block}}':    '',
    '{{thumb_bg_image_class}}':    'thumb-photo-bg-hidden',
    '{{VIDEO_PHOTO_STYLE_BLOCK}}': '',
    '{{VIDEO_PHOTO_CLASS}}':       'no-photo',
    '{{confetti_0}}':'🎉','{{confetti_1}}':'✨','{{confetti_2}}':'⭐',
    '{{confetti_3}}':'💫','{{confetti_4}}':'🎊','{{confetti_5}}':'🌟',
    '{{confetti_6}}':'🏆','{{confetti_7}}':'🎈',
    '{{marquee_text}}':   niceLabel + ' Challenge',
    '{{float_icon_0}}':'⭐','{{float_icon_1}}':'✨','{{float_icon_2}}':'💫',
    '{{float_icon_3}}':'🌟','{{float_icon_4}}':'🎯',
    '{{platform_url}}':   `${PLATFORM_URL_BASE}/${niche}`,
    '{{mission_intro_text}}': '',
    '{{mission_question}}':   '',
    '{{mi_option_0}}':'','{{mi_option_1}}':'','{{mi_option_2}}':'','{{mi_option_3}}':'',
    '{{qtime}}':           SHORT_COUNTDOWN,
    '{{hint_time}}':       SHORT_HINT_AT,
    '{{fiftyfifty_time}}': SHORT_FIFTY_AT,
  };
  for (const [k, v] of Object.entries(R)) html = html.split(k).join(String(v ?? ''));

  // ── Short-format CSS overrides ─────────────────────────────────────
  // IMPORTANT: The human circle is a PLACEHOLDER div that shows the slot.
  // The actual human video is composited by FFmpeg after Puppeteer recording.
  // The dog CSS animation IS real and will appear correctly in the recording.
  const shortCss = `
<style id="short-fmt-css">
/* Slide bottom padding so content stays above avatar strip */
.short-fmt .question-phase,
.short-fmt .pre-reveal-slide,
.short-fmt .comment-cta-screen {
  padding-bottom: ${AVATAR_SIZE + 60}px !important;
}
/* Q+Options appear simultaneously (no stagger animation) */
.short-fmt .question-phase .question-text,
.short-fmt .question-phase .options-grid,
.short-fmt .question-phase .option-btn {
  animation: none !important;
  opacity: 1 !important;
  transform: translateY(0) !important;
}
/* No answer colour reveal */
.short-fmt .option-btn.correct,
.short-fmt .option-btn.wrong {
  background: unset !important;
  border-color: unset !important;
  color: unset !important;
}
/* Hide hint — too much info for short format */
.short-fmt .hint-wrap,
.short-fmt .hint-text { display: none !important; }
/* Eliminated options disappear */
.short-fmt .option-btn.eliminate {
  opacity: 0 !important;
  pointer-events: none !important;
}
</style>
${AVATAR_CSS}`;

  html = html.replace('</head>', `${shortCss}\n</head>`);

  // ── Avatar strip: human is a styled placeholder div ────────────────
  // The actual video is composited by FFmpeg. The placeholder holds the
  // position and shows the speaking glow border via .av-speaking CSS.
  // The dog div with its ring elements IS real and captured by Puppeteer.
  const avatarStripHtml = `
<!-- AVATAR STRIP — human=placeholder (FFmpeg composites real video), dog=real CSS -->
<div id="avatar-strip">
  <div id="av-human" class="av-circle av-human av-placeholder">
    <span class="av-placeholder-icon" style="font-size:56px;opacity:0.15">👤</span>
  </div>
  <div id="av-dog" class="av-circle av-dog">
    <span class="av-dog-face">🐶</span>
    <div class="av-dog-ring av-dog-ring-1"></div>
    <div class="av-dog-ring av-dog-ring-2"></div>
    <div class="av-dog-ring av-dog-ring-3"></div>
  </div>
</div>`;

  html = html.replace('</body>', `${avatarStripHtml}\n</body>`);

  const htmlPath = path.join(workDir, 'short_index.html');
  await fs.writeFile(htmlPath, html);

  // ── Launch Puppeteer ───────────────────────────────────────────────
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--disable-web-security','--allow-file-access-from-files',
      '--autoplay-policy=no-user-gesture-required',
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });

  // CRITICAL: block ALL external network requests.
  // The theme CSS references Google Fonts / external assets which are
  // unreachable from the GitHub Actions runner. Those requests hang until
  // Puppeteer's navigation timeout fires. We abort them immediately so the
  // page settles instantly. Everything we actually need (CSS, logo) is
  // already inlined into the HTML as text / base64 data URIs.
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    // Allow only the local file:// page itself and inline data: URIs
    if (u.startsWith('file://') || u.startsWith('data:') || u.startsWith('about:')) {
      req.continue().catch(() => {});
    } else {
      req.abort().catch(() => {});
    }
  });

  // Use 'domcontentloaded' -- NOT 'networkidle0'. With external requests
  // aborted there is nothing to wait for, and networkidle0 was the direct
  // cause of the 30s navigation timeout.
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Give CSS + fonts + layout a moment to settle
  await new Promise(r => setTimeout(r, 1200));
  await page.evaluate(() => { document.body.classList.add('short-fmt'); });

  // Hide avatar strip until step 3
  await page.evaluate(() => {
    const strip = document.getElementById('avatar-strip');
    if (strip) strip.style.display = 'none';
  });

  const clips       = [];
  const voiceRanges = [];
  let cursor = 0;

  function pushClip(clip, isVoice = true) {
    if (isVoice) voiceRanges.push({ start: cursor, end: cursor + clip.dur });
    cursor += clip.dur;
    clips.push(clip);
    console.log(`[SHORT] + ${path.basename(clip.path)} ${clip.dur.toFixed(2)}s  (Σ ${cursor.toFixed(2)}s)`);
  }

  // ══ STEP 1+2 — FULL-SCREEN HOST CLIP (used directly, not Puppeteer) ══
  // The human_hook.mp4 IS the video for this step. FFmpeg re-encodes it
  // to our spec. No Puppeteer recording at all for this step.
  console.log('[SHORT] ── Step 1+2: Full-screen host clip');
  const step12Result = await buildHookStep(humanHookFile, workDir);

  if (step12Result) {
    // ✓ Have real host clip — use it directly
    pushClip(step12Result, true);
  } else {
    // ✗ No host clip — Puppeteer fallback: hook slide
    console.log('[SHORT] Step 1+2 fallback: recording hook slide');
    await showScreen(page, '.hook-slide');
    const fallbackDur = 3.0;
    const rawPath  = path.join(workDir, 'sh_step12_raw.mp4');
    const h264Path = path.join(workDir, 'sh_step12_h264.mp4');
    const outPath  = path.join(workDir, 'sh_step12.mp4');
    const rec = new PuppeteerScreenRecorder(page, {
      fps: 30, videoFrame: { width: 1080, height: 1920 },
      aspectRatio: '9:16', followNewTab: false
    });
    await rec.start(rawPath);
    await new Promise(r => setTimeout(r, fallbackDur * 1000));
    await withTimeout(rec.stop(), TIMEOUT_RECORDER, 'step12_fallback.stop');
    await ffmpeg(`-y -i "${rawPath}" -an -c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 -vf "scale=1080:1920" "${h264Path}"`, 'step12_fallback_enc');
    await ffmpeg(`-y -i "${h264Path}" -c:v copy -an -t ${fallbackDur} "${outPath}"`, 'step12_fallback_vid');
    pushClip({ path: outPath, dur: fallbackDur }, false);
  }

  // ══ STEP 3 — QUESTION + OPTIONS + DOG TTS ══════════════════════════
  // Puppeteer records: UI with dog CSS animation (real).
  // FFmpeg composites: humanIdleFile into human circle slot.
  console.log('[SHORT] ── Step 3: Q + Options + Dog TTS');

  await page.evaluate(() => {
    const strip = document.getElementById('avatar-strip');
    if (strip) strip.style.display = 'flex';
  });
  await setAvatarMode(page, 'dog_speaking');
  await showScreen(page, '.question-phase');

  // Freeze countdown timer — it only ticks in step 4
  await page.evaluate(() => {
    document.querySelectorAll(
      '.countdown-timer,.timer-ring,.timer-bar,[class*="countdown"],[class*="timer"]'
    ).forEach(el => { el.style.animationPlayState = 'paused'; });
  });

  // Build step 3 audio: sfx → question TTS → gap → "time starts now"
  const s3Parts = [];
  if (sfxFile) {
    s3Parts.push(sfxFile);
    const sg = path.join(workDir,'sh_sfxgap.mp3');
    await silence(0.12, sg);
    s3Parts.push(sg);
  }
  const qTtsPath = path.join(workDir,'sh_q_tts.mp3');
  await tts(question, voice, qTtsPath, 3);
  s3Parts.push(qTtsPath);
  const microGap = path.join(workDir,'sh_microgap.mp3');
  await silence(0.22, microGap);
  s3Parts.push(microGap);
  const timerPrompt = path.join(workDir,'sh_timerprompt.mp3');
  await tts('You have only 5 seconds and your time starts now!', voice, timerPrompt, 3);
  s3Parts.push(timerPrompt);

  const step3Audio = path.join(workDir,'sh_step3.mp3');
  await concatAudio(s3Parts, step3Audio, workDir);
  const step3Dur = Math.max(await audioDur(step3Audio), 2.0);
  console.log(`[SHORT] Step 3 audio: ${step3Dur.toFixed(2)}s`);

  // Record Puppeteer UI (dog animation is real here)
  const step3Ui = await recordedClip(page, step3Audio, step3Dur, workDir, 'sh_step3_ui');

  // FFmpeg: composite human idle video into circle slot (bottom-left)
  let step3Final;
  if (humanIdleFile && await fileExists(humanIdleFile)) {
    const step3CompPath = path.join(workDir, 'sh_step3.mp4');
    await compositeHumanCircle(step3Ui.path, humanIdleFile, step3Dur, step3CompPath);
    step3Final = { path: step3CompPath, dur: step3Dur };
    console.log('[SHORT] Step 3: human idle composited onto UI');
  } else {
    step3Final = step3Ui; // no idle clip — placeholder div stays visible
    console.log('[SHORT] Step 3: no idle clip — using placeholder');
  }
  pushClip(step3Final, true);

  // ══ STEP 4 — COUNTDOWN 5s (both silent) ════════════════════════════
  console.log('[SHORT] ── Step 4: Countdown 5s');

  await setAvatarMode(page, 'both_silent');

  // Resume countdown timer
  await page.evaluate((cd, fa, ft) => {
    document.querySelectorAll(
      '.countdown-timer,.timer-ring,.timer-bar,[class*="countdown"],[class*="timer"]'
    ).forEach(el => {
      el.style.animation = 'none';
      el.offsetHeight;
      el.style.animation = '';
      el.style.animationPlayState = 'running';
      el.style.animationDuration  = cd + 's';
    });
    const qp = document.querySelector('.question-phase');
    if (qp) {
      qp.style.setProperty('--qtime', cd);
      qp.style.setProperty('--fiftyfifty-time', ft);
      qp.style.setProperty('--hint-time', fa);
    }
  }, SHORT_COUNTDOWN, SHORT_HINT_AT, SHORT_FIFTY_AT);

  const cdAudioPath = path.join(workDir,'sh_cd.mp3');
  if (countdownFile) {
    await ffmpeg(
      `-y -stream_loop -1 -i "${countdownFile}" -t ${SHORT_COUNTDOWN} -af "volume=0.75" -ar 44100 -ac 1 -acodec libmp3lame "${cdAudioPath}"`,
      'sh_cdLoop'
    );
  } else {
    await silence(SHORT_COUNTDOWN, cdAudioPath);
  }

  // Record Puppeteer UI
  const step4Ui = await recordedClip(page, cdAudioPath, SHORT_COUNTDOWN, workDir, 'sh_step4_ui');

  // FFmpeg: composite human idle video into circle slot
  let step4Final;
  if (humanIdleFile && await fileExists(humanIdleFile)) {
    const step4CompPath = path.join(workDir, 'sh_step4.mp4');
    await compositeHumanCircle(step4Ui.path, humanIdleFile, SHORT_COUNTDOWN, step4CompPath);
    step4Final = { path: step4CompPath, dur: SHORT_COUNTDOWN };
    console.log('[SHORT] Step 4: human idle composited onto UI');
  } else {
    step4Final = step4Ui;
    console.log('[SHORT] Step 4: no idle clip — using placeholder');
  }
  // Countdown is not a voice range — bg music stays at base volume
  pushClip(step4Final, false);

  // ══ STEP 5 — TIMEUP (human speaking, dog silent) ═══════════════════
  console.log('[SHORT] ── Step 5: Timeup');

  await setAvatarMode(page, 'human_speaking'); // shows glow border in UI
  await showScreen(page, '.pre-reveal-slide');

  let timeupAudioPath;
  if (timeupFile) {
    timeupAudioPath = timeupFile;
    console.log(`[SHORT] Timeup: pre-recorded (${(await audioDur(timeupFile)).toFixed(2)}s)`);
  } else {
    timeupAudioPath = path.join(workDir,'sh_timeup_tts.mp3');
    await tts(quiz.timeup_text || "Time's up!", voice, timeupAudioPath, 3);
  }
  const timeupDur = Math.max(await audioDur(timeupAudioPath), 1.0);

  // Record Puppeteer UI (glow border shows, dog idle)
  const step5Ui = await recordedClip(page, timeupAudioPath, timeupDur, workDir, 'sh_step5_ui');

  // FFmpeg: composite human timeup (or idle fallback) into circle
  const step5HumanClip = (humanTimeupFile && await fileExists(humanTimeupFile))
    ? humanTimeupFile
    : (humanIdleFile && await fileExists(humanIdleFile)) ? humanIdleFile : null;

  let step5Final;
  if (step5HumanClip) {
    const step5CompPath = path.join(workDir, 'sh_step5.mp4');
    await compositeHumanCircle(step5Ui.path, step5HumanClip, timeupDur, step5CompPath);
    step5Final = { path: step5CompPath, dur: timeupDur };
    console.log(`[SHORT] Step 5: ${humanTimeupFile ? 'timeup' : 'idle'} clip composited`);
  } else {
    step5Final = step5Ui;
    console.log('[SHORT] Step 5: no human clip — using placeholder');
  }
  pushClip(step5Final, true);

  // ══ STEP 6 — CTA (human speaking, dog silent) ══════════════════════
  console.log('[SHORT] ── Step 6: CTA');

  await setAvatarMode(page, 'human_speaking');

  const ctaSel = await page.evaluate(() => {
    return document.querySelector('.comment-cta-screen') ? '.comment-cta-screen' : '.pre-reveal-slide';
  });
  await showScreen(page, ctaSel);

  let cta4Path;
  if (cta4AudioFile) {
    cta4Path = cta4AudioFile;
    console.log(`[SHORT] CTA4: pre-recorded (${(await audioDur(cta4AudioFile)).toFixed(2)}s)`);
  } else {
    cta4Path = path.join(workDir,'sh_cta4_tts.mp3');
    await tts(quiz.cta4_text || 'Write your answer in the comments right now!', voice, cta4Path, 3);
  }
  const cta4Dur = Math.max(await audioDur(cta4Path), 1.5);

  // Record Puppeteer UI
  const step6Ui = await recordedClip(page, cta4Path, cta4Dur, workDir, 'sh_step6_ui');

  // FFmpeg: composite human cta4 (or idle fallback) into circle
  const step6HumanClip = (humanCta4File && await fileExists(humanCta4File))
    ? humanCta4File
    : (humanIdleFile && await fileExists(humanIdleFile)) ? humanIdleFile : null;

  let step6Final;
  if (step6HumanClip) {
    const step6CompPath = path.join(workDir, 'sh_step6.mp4');
    await compositeHumanCircle(step6Ui.path, step6HumanClip, cta4Dur, step6CompPath);
    step6Final = { path: step6CompPath, dur: cta4Dur };
    console.log(`[SHORT] Step 6: ${humanCta4File ? 'cta4' : 'idle'} clip composited`);
  } else {
    step6Final = step6Ui;
    console.log('[SHORT] Step 6: no human clip — using placeholder');
  }
  pushClip(step6Final, true);

  await browser.close();

  // ══ FINAL ASSEMBLY ════════════════════════════════════════════════
  const totalDur = cursor;
  console.log(`\n[SHORT] ── Assembling ${clips.length} clips — ${totalDur.toFixed(2)}s total`);

  const concatTxt  = path.join(workDir,'sh_concat.txt');
  await fs.writeFile(concatTxt, clips.map(c => `file '${c.path.replace(/'/g,"'\\''")}'`).join('\n'));
  const concatenated = path.join(workDir,'sh_concatenated.mp4');
  await ffmpeg(
    `-y -f concat -safe 0 -i "${concatTxt}" ` +
    `-c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
    `-c:a aac -b:a 128k -ar 44100 -ac 1 -movflags +faststart "${concatenated}"`,
    'sh_concat'
  );

  const measured  = await videoDur(concatenated);
  const finalDur  = Math.max(measured, totalDur) + 0.2;
  console.log(`[SHORT] Measured ${measured.toFixed(2)}s → using ${finalDur.toFixed(2)}s`);

  let finalPath = concatenated;
  try {
    finalPath = await applyBgMusic(concatenated, finalDur, voiceRanges, resolvedBgFile, workDir);
  } catch (e) {
    console.warn(`[SHORT][BG] Failed (non-fatal): ${e.message}`);
  }

  return { videoPath: finalPath, durationSec: finalDur };
}


// ─── FORMAT ASSIGNER ──────────────────────────────────────────────────
const { pollMyFormat, markDone, markError } = require('./formatAssigner');

async function patchForAssigner(pathStr, body) {
  const res = await fetch(`${cleanUrl}/rest/v1/${pathStr}`, {
    method: 'PATCH',
    headers: {
      'apikey':        supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`PATCH ${pathStr} -> ${res.status}: ${await res.text()}`);
}

// ═══════════════════════════════════════════════════════════════════════
// JOB PROCESSOR
// ═══════════════════════════════════════════════════════════════════════
async function processJobs() {
  console.log('[SHORT-WORKER] Starting — avatar-strip short format');

  const result = await pollMyFormat(fetchSupabase, patchForAssigner, 'short', '[SHORT-WORKER]');
  if (!result) return;
  const { quiz, cfg } = result;

  const workDir = `/tmp/short_${uuidv4()}`;
  await ensureDir(workDir);

  try {
    const { videoPath, durationSec } = await withTimeout(
      buildShortVideo(quiz, workDir), TIMEOUT_JOB, `buildShortVideo ${quiz.id}`
    );
    const stats  = await fs.stat(videoPath);
    const sizeMb = parseFloat((stats.size / (1024*1024)).toFixed(2));
    console.log(`[SHORT-WORKER] ✓ ${durationSec.toFixed(1)}s ${sizeMb}MB`);

    const artifactPath = `/tmp/${quiz.id}_short_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);
    await fs.writeFile('/tmp/short_artifact_ready', artifactPath);

    let shortVideoUrl = null;
    if (R2_CONFIGURED) {
      try {
        const buf = await fs.readFile(artifactPath);
        const key = `videos/${quiz.id}_short.mp4`;
        await withTimeout(
          s3Client.send(new PutObjectCommand({ Bucket:R2_BUCKET, Key:key, Body:buf, ContentType:'video/mp4' })),
          60000, 'R2 short upload'
        );
        shortVideoUrl = `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
        console.log(`[R2] ${shortVideoUrl}`);
      } catch (e) { console.warn(`[R2] Upload failed: ${e.message}`); }
    }

    // markDone handles the status column + video URL column atomically
    await markDone(patchForAssigner, quiz.id, cfg, shortVideoUrl);

    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    console.log(`[SHORT-WORKER] Artifact: ${artifactPath}`);

  } catch (err) {
    console.error('[SHORT-WORKER] FAILED:', err.message);
    console.error(err.stack?.slice(0, 600) || '');
    await markError(patchForAssigner, quiz.id, cfg, err.message);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

processJobs()
  .then(() => { console.log('[SHORT-WORKER] Done.'); process.exit(0); })
  .catch(err => { console.error('[SHORT-WORKER] Fatal:', err.message); process.exit(1); });
