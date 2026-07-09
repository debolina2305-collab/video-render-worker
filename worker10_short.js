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

async function concatAudio(parts, outPath, workDir) {
  const valid = (parts || []).filter(Boolean);
  if (!valid.length) { await silence(0.5, outPath); return; }
  if (valid.length === 1) {
    await ffmpeg(`-y -i "${valid[0]}" -ar 44100 -ac 1 -acodec libmp3lame "${outPath}"`, 'cat1');
    return;
  }
  const lst = path.join(workDir, `cat_${Date.now()}.txt`);
  await fs.writeFile(lst, valid.map(p => `file '${p.replace(/'/g,"'\\''")}' `).join('\n'));
  await ffmpeg(`-y -f concat -safe 0 -i "${lst}" -ar 44100 -ac 1 -acodec libmp3lame "${outPath}"`, 'cat');
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
// Records `dur` seconds of the Puppeteer page, muxes with audioPath.
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

  // Re-encode VP8→H264
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

// ─── SHOW SCREEN (hide all .screen, activate selector) ────────────────
async function showScreen(page, sel) {
  await page.evaluate(s => {
    document.querySelectorAll('.screen').forEach(e => e.classList.remove('active'));
    const el = document.querySelector(s);
    if (el) el.classList.add('active');
  }, sel);
  await new Promise(r => setTimeout(r, 80));
}

// ─── SET AVATAR MODE ──────────────────────────────────────────────────
// mode: 'human_speaking' | 'dog_speaking' | 'both_silent'
// humanVideoPath: local path to the .mp4 clip to show in the human circle.
//   Pass null to keep the current src unchanged.
//   Pass a path to swap to a different clip (idle → timeup → cta4 etc).
async function setAvatarMode(page, mode, humanVideoPath) {
  // Step 1: swap video src if a new clip is provided
  if (humanVideoPath) {
    const fileUrl = `file://${humanVideoPath}`;
    await page.evaluate((src) => {
      let v = document.getElementById('av-human');
      if (!v) return;
      if (v.tagName !== 'VIDEO') {
        // Replace placeholder div with a proper <video> element
        const vid = document.createElement('video');
        vid.id        = 'av-human';
        vid.className = v.className;
        vid.autoplay  = true;
        vid.loop      = true;
        vid.muted     = true;
        vid.setAttribute('playsinline', '');
        vid.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;';
        v.parentNode.replaceChild(vid, v);
        v = vid;
      }
      // Only reload if src actually changed — avoids flicker on same-clip steps
      if (v.getAttribute('src') !== src) {
        v.pause();
        v.setAttribute('src', src);
        v.load();
        v.play().catch(() => {});
      }
    }, fileUrl);
    await new Promise(r => setTimeout(r, 150)); // let first frame paint
  }

  // Step 2: apply speaking / silent CSS classes
  await page.evaluate((mode) => {
    const human = document.getElementById('av-human');
    const dog   = document.getElementById('av-dog');
    if (human) human.classList.toggle('av-speaking',     mode === 'human_speaking');
    if (dog)   dog.classList.toggle('av-dog-speaking',   mode === 'dog_speaking');
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
// STEP 1+2 — FULL-SCREEN HUMAN VIDEO (hook + question intro combined)
//
// The human_hook .mp4 clip plays full-screen. We overlay it on the
// Puppeteer page, record for its actual duration (dynamic), and mux
// the clip's own audio track using ffmpeg (not TTS — the audio is
// already embedded in the .mp4).
// ═══════════════════════════════════════════════════════════════════════
async function recordHookIntroStep(page, humanHookPath, workDir) {
  const stepName = 'sh_step12';

  // Get the actual duration of the human host clip
  const hostDur = humanHookPath ? Math.max(await videoDur(humanHookPath), 1.0) : 3.0;
  console.log(`[SHORT] Step 1+2 duration from host clip: ${hostDur.toFixed(2)}s`);

  // Inject a full-screen video overlay on top of the current page
  // We use a fixed-position overlay <video> so the quiz template
  // background/theme is still rendered behind it.
  if (humanHookPath) {
    const fileUrl = `file://${humanHookPath}`;
    await page.evaluate((src) => {
      // Remove existing overlay if any
      document.getElementById('host-fullscreen')?.remove();
      const vid = document.createElement('video');
      vid.id = 'host-fullscreen';
      vid.src = src;
      vid.autoplay = true;
      vid.muted = true;         // audio muxed separately by ffmpeg
      vid.setAttribute('playsinline', '');
      vid.style.cssText = [
        'position:fixed', 'inset:0', 'width:100%', 'height:100%',
        'object-fit:cover', 'z-index:8888', 'background:#000'
      ].join(';');
      document.body.appendChild(vid);
      vid.play().catch(() => {});
    }, fileUrl);
    await new Promise(r => setTimeout(r, 200)); // let first frame paint
  } else {
    // No host clip — show hook slide from the quiz template as fallback
    await showScreen(page, '.hook-slide');
  }

  // Record the screen for the clip's full duration
  const rawPath  = path.join(workDir, `${stepName}_raw.mp4`);
  const h264Path = path.join(workDir, `${stepName}_h264.mp4`);
  const outPath  = path.join(workDir, `${stepName}.mp4`);

  const rec = new PuppeteerScreenRecorder(page, {
    fps: 30, videoFrame: { width: 1080, height: 1920 },
    aspectRatio: '9:16', followNewTab: false
  });
  await rec.start(rawPath);
  await new Promise(r => setTimeout(r, hostDur * 1000));
  await withTimeout(rec.stop(), TIMEOUT_RECORDER, `${stepName}.stop`);

  await ffmpeg(
    `-y -i "${rawPath}" -an -c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 -vf "scale=1080:1920" "${h264Path}"`,
    `${stepName}_enc`
  );

  // Audio source: extract audio from the host clip itself (contains hook+intro audio)
  // If no host clip, use silence (pre-recorded audio is in the video)
  if (humanHookPath && await fileExists(humanHookPath)) {
    // Re-encode audio to AAC mono 44100Hz — handles any source codec (aac, mp3, pcm, opus)
    const extractedAudio = path.join(workDir, `${stepName}_audio.m4a`);
    await ffmpeg(
      `-y -i "${humanHookPath}" -vn -ar 44100 -ac 1 -c:a aac -b:a 128k "${extractedAudio}"`,
      `${stepName}_audio_extract`
    );
    if (await fileExists(extractedAudio) && await audioDur(extractedAudio) > 0) {
      await ffmpeg(
        `-y -stream_loop -1 -i "${h264Path}" -i "${extractedAudio}" ` +
        `-map 0:v:0 -map 1:a:0 ` +
        `-c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
        `-c:a aac -b:a 128k -ar 44100 -ac 1 ` +
        `-t ${hostDur} "${outPath}"`,
        `${stepName}_mux`
      );
    } else {
      console.warn(`[SHORT] Step 1+2: host clip has no audio track — video only`);
      await ffmpeg(`-y -i "${h264Path}" -c:v copy -an -t ${hostDur} "${outPath}"`, `${stepName}_noaudio`);
    }
  } else {
    // No host clip — fallback hook slide, no audio (bg music fills in)
    await ffmpeg(`-y -i "${h264Path}" -c:v copy -an -t ${hostDur} "${outPath}"`, `${stepName}_noaudio`);
  }

  // Remove the fullscreen overlay so it doesn't appear in subsequent steps
  await page.evaluate(() => { document.getElementById('host-fullscreen')?.remove(); });

  return { path: outPath, dur: hostDur };
}

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
    humanHookFile,    // full-screen for steps 1+2
    humanIdleFile,    // looping idle for steps 3+4
    humanTimeupFile,  // speaking for step 5
    humanCta4File,    // speaking for step 6
  ] = await Promise.all([
    download(avatarUrls.human_hook,   'av_hook'),
    download(avatarUrls.human_idle,   'av_idle'),
    download(avatarUrls.human_timeup, 'av_timeup'),
    download(avatarUrls.human_cta4,   'av_cta4'),
  ]);

  let resolvedBgFile = bgFile;
  if (!resolvedBgFile) {
    console.log('[SHORT][BG] Retrying default track...');
    resolvedBgFile = await download(DEFAULT_BG_MUSIC, 'sh_bg_default');
  }

  // ── Theme ──────────────────────────────────────────────────────────
  const { themeCss, decoHtml } = await resolveTheme(quiz);

  // ── Build HTML (reuse quiz_template.html) ─────────────────────────
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
    // No answer reveal — blank all reveal classes
    '{{rev0_class}}': '', '{{rev1_class}}': '', '{{rev2_class}}': '', '{{rev3_class}}': '',
    '{{hint}}':            quiz.hint_1 || '',
    '{{correct_answer}}':  '',   // deliberately blank
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

  // ── Inject avatar CSS + short-format overrides into <head> ─────────
  const shortCss = `
<style id="short-fmt-css">
/* Slide bottom padding so content doesn't sit behind avatar strip */
.short-fmt .question-phase,
.short-fmt .pre-reveal-slide,
.short-fmt .comment-cta-screen {
  padding-bottom: ${AVATAR_SIZE + 60}px !important;
}
/* Q+Options appear simultaneously */
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
/* Hide hint — too much info for short */
.short-fmt .hint-wrap,
.short-fmt .hint-text { display: none !important; }
/* Eliminated options fade at right time via existing template logic */
.short-fmt .option-btn.eliminate {
  opacity: 0 !important;
  pointer-events: none !important;
}
</style>
${AVATAR_CSS}`;

  html = html.replace('</head>', `${shortCss}\n</head>`);

  // ── Inject avatar strip HTML into body (hidden initially) ──────────
  // It uses humanIdleFile for the circle video.
  // We convert to data URI so Puppeteer can load it via file:// policy.
  // Large videos are handled via file:// URL instead to avoid base64 bloat.
  const idleFileUrl = humanIdleFile ? `file://${humanIdleFile}` : null;
  const avatarStripHtml = buildAvatarStripHtml(null, humanIdleFile, 'both_silent');
  html = html.replace('</body>', `${avatarStripHtml}\n</body>`);

  // If idle video exists, patch the src to use file:// URL
  if (idleFileUrl) {
    html = html.replace(
      'id="av-human"',
      `id="av-human" src="${idleFileUrl}"`
    );
  }

  const htmlPath = path.join(workDir, 'short_index.html');
  await fs.writeFile(htmlPath, html);

  // ── Launch Puppeteer ────────────────────────────────────────────────
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
      '--disable-gpu','--disable-web-security','--allow-file-access-from-files',
      '--autoplay-policy=no-user-gesture-required',  // allow video autoplay
    ]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 800));
  await page.evaluate(() => { document.body.classList.add('short-fmt'); });

  // Start idle video playing
  await page.evaluate(() => {
    const v = document.getElementById('av-human');
    if (v?.tagName === 'VIDEO') v.play().catch(() => {});
  });

  // ── Hide avatar strip until step 3 ─────────────────────────────────
  await page.evaluate(() => {
    const strip = document.getElementById('avatar-strip');
    if (strip) strip.style.display = 'none';
  });

  // Clip accumulator
  const clips       = [];
  const voiceRanges = [];
  let cursor = 0;

  function pushClip(clip, isVoice = true) {
    if (isVoice) voiceRanges.push({ start: cursor, end: cursor + clip.dur });
    cursor += clip.dur;
    clips.push(clip);
    console.log(`[SHORT] + ${path.basename(clip.path)} ${clip.dur.toFixed(2)}s  (Σ ${cursor.toFixed(2)}s)`);
  }

  // ══ STEP 1+2 — COMBINED FULL-SCREEN HUMAN HOST CLIP ════════════════
  // The human_hook.mp4 plays full-screen. Its own audio track contains
  // both the hook line and the question intro. Dynamic duration.
  console.log('[SHORT] ── Step 1+2: Full-screen host clip');
  // Show hook slide behind the video overlay
  await showScreen(page, '.hook-slide');
  const step12Clip = await recordHookIntroStep(page, humanHookFile, workDir);
  // Step 1+2 audio comes from the host clip — mark as voice so bg music ducks
  pushClip(step12Clip, true);

  // ══ STEP 3 — QUESTION + OPTIONS + DOG TTS ══════════════════════════
  // Avatar strip appears. Dog speaking. Question + options both visible.
  // TTS reads question, then "5 seconds, time starts now!"
  console.log('[SHORT] ── Step 3: Q + Options + Dog TTS');

  // Show avatar strip, set dog to speaking mode, human idle
  await page.evaluate(() => {
    const strip = document.getElementById('avatar-strip');
    if (strip) strip.style.display = 'flex';
  });
  await setAvatarMode(page, 'dog_speaking', humanIdleFile);
  await showScreen(page, '.question-phase');

  // Freeze countdown timer — it only ticks in step 4
  await page.evaluate(() => {
    document.querySelectorAll(
      '.countdown-timer,.timer-ring,.timer-bar,[class*="countdown"],[class*="timer"]'
    ).forEach(el => { el.style.animationPlayState = 'paused'; });
  });

  // Build step 3 audio
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
  pushClip(await recordedClip(page, step3Audio, step3Dur, workDir, 'sh_step3'));

  // ══ STEP 4 — COUNTDOWN 5s (both silent) ════════════════════════════
  console.log('[SHORT] ── Step 4: Countdown 5s');

  // Switch both to silent/idle
  await setAvatarMode(page, 'both_silent', humanIdleFile);

  // Resume countdown timer from the start
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
    // Update CSS vars for 5s countdown
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
  // Countdown is not a voice range — bg music stays at base volume
  pushClip(await recordedClip(page, cdAudioPath, SHORT_COUNTDOWN, workDir, 'sh_step4'), false);

  // ══ STEP 5 — TIMEUP (human speaking, dog silent) ═══════════════════
  console.log('[SHORT] ── Step 5: Timeup');

  // Switch to timeup clip on human circle, set human speaking mode
  await setAvatarMode(page, 'human_speaking', humanTimeupFile || humanIdleFile);
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
  pushClip(await recordedClip(page, timeupAudioPath, timeupDur, workDir, 'sh_step5'));

  // ══ STEP 6 — CTA (human speaking, dog silent) ══════════════════════
  console.log('[SHORT] ── Step 6: CTA');

  // Switch to cta4 clip on human circle, keep human speaking mode
  await setAvatarMode(page, 'human_speaking', humanCta4File || humanIdleFile);

  // Show comment CTA screen if it exists, otherwise stay on pre-reveal
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
  pushClip(await recordedClip(page, cta4Path, cta4Dur, workDir, 'sh_step6'));

  await browser.close();

  // ══ FINAL ASSEMBLY ════════════════════════════════════════════════
  const totalDur = cursor;
  console.log(`\n[SHORT] ── Assembling ${clips.length} clips — ${totalDur.toFixed(2)}s total`);

  const concatTxt  = path.join(workDir,'sh_concat.txt');
  await fs.writeFile(concatTxt, clips.map(c => `file '${c.path.replace(/'/g,"'\\''")}' `).join('\n'));
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
