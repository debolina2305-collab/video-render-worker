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
const SHORT_COUNTDOWN   = 6;    // countdown length (was 5)
const SHORT_FIFTY_AT    = 3;    // 50/50 fires at t=3s INTO the countdown
const SHORT_HINT_AT     = 2;
// Avatar circle size (px) — matches CSS below
// Circle diameter = 33% of the 1080px video width (host and dog each).
const VIDEO_W           = 1080;
const VIDEO_H           = 1920;
const AVATAR_SIZE       = Math.round(VIDEO_W * 0.33);   // 356px
const AVATAR_PAD_X      = 32;   // px from left/right frame edge to circle edge
const AVATAR_PAD_Y      = 36;   // px from bottom frame edge to circle edge

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

// ─── AVATAR SET: pick ONE dress_code, then one clip per section ───────
//
// avatar_assets schema (see avatar_assets.sql):
//   section          'hook' | 'silent' | 'cta4'
//   dress_code       integer 1..N  (the outfit the host is wearing)
//   video_url        R2 URL
//   timeup_split_sec numeric|null  (cta4 only: when timeup speech ends)
//
// A "complete" dress_code is one that has at least one active clip for
// ALL THREE sections. We pick a complete dress_code at random, then pick
// one random clip within each section for that dress_code. This keeps the
// host wearing the same outfit for the whole video, while still rotating
// across the 20-50 takes you record per section.
function pickRandom(arr) {
  if (!arr || !arr.length) return null;
  return arr[Math.floor(Math.random() * arr.length)];
}

const AVATAR_SECTIONS = ['hook', 'silent', 'cta4'];

async function fetchAvatarSet() {
  const empty = { dressCode: null, hook: null, silent: null, cta4: null, timeupSplitSec: null };

  let rows;
  try {
    rows = await fetchSupabase(
      'avatar_assets?is_active=eq.true&select=section,dress_code,video_url,timeup_split_sec'
    );
  } catch (e) {
    console.warn('[AVATAR] avatar_assets fetch failed (non-fatal):', e.message);
    return empty;
  }

  const usable = (rows || []).filter(r =>
    r.video_url && r.dress_code != null && AVATAR_SECTIONS.includes(r.section)
  );
  if (!usable.length) {
    console.warn('[AVATAR] No usable avatar_assets rows.');
    return empty;
  }

  // Group: byDress[dress_code][section] = [rows...]
  const byDress = {};
  for (const r of usable) {
    (byDress[r.dress_code] ??= {});
    (byDress[r.dress_code][r.section] ??= []).push(r);
  }

  // Keep only dress codes that have every section covered
  const complete = Object.keys(byDress).filter(dc =>
    AVATAR_SECTIONS.every(s => byDress[dc][s]?.length)
  );

  if (!complete.length) {
    const partial = Object.keys(byDress).map(dc =>
      `${dc}[${AVATAR_SECTIONS.filter(s => byDress[dc][s]?.length).join(',') || 'none'}]`
    ).join(' ');
    console.warn(`[AVATAR] No dress_code has all 3 sections. Have: ${partial}`);
    console.warn('[AVATAR] Falling back to best-effort mixed selection.');
    // Best effort: take whatever exists, per section, ignoring consistency
    const fb = { ...empty };
    for (const s of AVATAR_SECTIONS) {
      const anyRow = pickRandom(usable.filter(r => r.section === s));
      if (anyRow) {
        fb[s] = anyRow.video_url;
        if (s === 'cta4') fb.timeupSplitSec = anyRow.timeup_split_sec ?? null;
      }
    }
    return fb;
  }

  // Pick one dress_code at random, then one clip per section within it
  const dressCode = pickRandom(complete);
  const set = { ...empty, dressCode: Number(dressCode) };

  for (const s of AVATAR_SECTIONS) {
    const pool = byDress[dressCode][s];
    const chosen = pickRandom(pool);
    set[s] = chosen.video_url;
    if (s === 'cta4') set.timeupSplitSec = chosen.timeup_split_sec ?? null;
    console.log(`[AVATAR] dress=${dressCode} ${s}: picked 1 of ${pool.length} takes`);
  }

  console.log(`[AVATAR] Host outfit locked to dress_code=${dressCode} for entire video`);
  return set;
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
//
// Host  = placeholder <div> only. The real host video is composited on top
//         by FFmpeg (Puppeteer cannot decode video reliably in headless CI).
// Dog   = fully real CSS. Puppeteer captures it correctly.
//
// Dog states:
//   .dog-talking  → mouth cycles closed → half-open → full-open, fast tail
//   (default)     → mouth stays closed, tail wags slowly
// ──────────────────────────────────────────────────────────────────────
const AVATAR_STRIP_HTML = `
<div id="avatar-strip">
  <!-- HOST: placeholder; FFmpeg composites the real video into this circle -->
  <div id="av-human" class="av-circle av-human av-placeholder">
    <span class="av-placeholder-icon">&#128100;</span>
  </div>

  <!-- DOG: pure CSS, animates for real inside Puppeteer -->
  <div id="av-dog" class="av-circle av-dog">
    <div class="dog-stage">
      <div class="dog-tail"></div>
      <div class="dog-body"></div>
      <div class="dog-head">
        <div class="dog-ear dog-ear-l"></div>
        <div class="dog-ear dog-ear-r"></div>
        <div class="dog-eye dog-eye-l"></div>
        <div class="dog-eye dog-eye-r"></div>
        <div class="dog-snout">
          <div class="dog-nose"></div>
          <div class="dog-mouth"><div class="dog-tongue"></div></div>
        </div>
      </div>
    </div>
  </div>
</div>`;

// All dog geometry scales off --av (the circle diameter), so changing
// AVATAR_SIZE automatically resizes the whole dog.
const AVATAR_CSS = `
<style id="avatar-strip-style">
#avatar-strip {
  /* fixed => coordinates map 1:1 onto the 1080x1920 video frame.
     Safe here because the strip is a direct child of <body>, not nested
     inside any will-change:transform ancestor. */
  position: fixed;
  bottom: ${AVATAR_PAD_Y}px;
  left: 0; right: 0;
  z-index: 9999;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 0 ${AVATAR_PAD_X}px;
  pointer-events: none;
}

.av-circle {
  --av: ${AVATAR_SIZE}px;
  width: var(--av);
  height: var(--av);
  border-radius: 50%;
  overflow: hidden;
  border: 4px solid rgba(255,255,255,0.55);
  box-shadow: 0 6px 30px rgba(0,0,0,0.5);
  background: #111;
  position: relative;
  flex-shrink: 0;
}

/* ── HOST placeholder (real video composited by FFmpeg) ── */
.av-placeholder {
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #1a2340, #0d1520);
}
.av-placeholder-icon {
  font-size: calc(var(--av) * 0.40);
  line-height: 1;
  opacity: 0.12;
}
.av-human.av-speaking {
  border-color: #00cfff;
  animation: humanSpeak 0.5s ease-in-out infinite alternate;
}
@keyframes humanSpeak {
  from { box-shadow: 0 0 0  5px rgba(0,207,255,0.40), 0 6px 30px rgba(0,0,0,0.5); }
  to   { box-shadow: 0 0 0 14px rgba(0,207,255,0.12), 0 6px 30px rgba(0,0,0,0.5); }
}

/* ══════════════ DOG ══════════════ */
.av-dog {
  background: radial-gradient(circle at 50% 40%, #3a2a12 0%, #1a1206 70%, #100b04 100%);
}
.dog-stage {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
}

/* ── Tail: always wagging, faster while talking ── */
.dog-tail {
  position: absolute;
  right: calc(var(--av) * 0.10);
  bottom: calc(var(--av) * 0.26);
  width:  calc(var(--av) * 0.055);
  height: calc(var(--av) * 0.26);
  background: linear-gradient(180deg, #b5762e, #8a5620);
  border-radius: calc(var(--av) * 0.03);
  transform-origin: 50% 100%;
  animation: tailWag 0.72s ease-in-out infinite alternate;
  z-index: 1;
}
.dog-talking .dog-tail { animation-duration: 0.26s; }
@keyframes tailWag {
  from { transform: rotate(-32deg); }
  to   { transform: rotate( 32deg); }
}

/* ── Body ── */
.dog-body {
  position: absolute;
  bottom: calc(var(--av) * 0.10);
  width:  calc(var(--av) * 0.52);
  height: calc(var(--av) * 0.32);
  background: linear-gradient(180deg, #d08c39, #a56823);
  border-radius: 50% 50% 42% 42%;
  z-index: 2;
}

/* ── Head ── */
.dog-head {
  position: absolute;
  top: calc(var(--av) * 0.16);
  width:  calc(var(--av) * 0.58);
  height: calc(var(--av) * 0.54);
  background: linear-gradient(180deg, #e39a41, #c07c2c);
  border-radius: 48% 48% 44% 44%;
  z-index: 3;
  animation: headBob 3s ease-in-out infinite;
}
.dog-talking .dog-head { animation: headBob 0.9s ease-in-out infinite; }
@keyframes headBob {
  0%,100% { transform: translateY(0)   rotate(0deg); }
  50%     { transform: translateY(-2%) rotate(1.5deg); }
}

/* ── Ears ── */
.dog-ear {
  position: absolute;
  top: calc(var(--av) * -0.03);
  width:  calc(var(--av) * 0.16);
  height: calc(var(--av) * 0.26);
  background: linear-gradient(180deg, #8a5620, #6d4318);
  border-radius: 50% 50% 40% 40%;
}
.dog-ear-l { left:  calc(var(--av) * -0.035); transform: rotate(-18deg); transform-origin: 50% 0;
             animation: earL 1.6s ease-in-out infinite alternate; }
.dog-ear-r { right: calc(var(--av) * -0.035); transform: rotate( 18deg); transform-origin: 50% 0;
             animation: earR 1.6s ease-in-out infinite alternate; }
.dog-talking .dog-ear-l, .dog-talking .dog-ear-r { animation-duration: 0.5s; }
@keyframes earL { from { transform: rotate(-18deg); } to { transform: rotate(-26deg); } }
@keyframes earR { from { transform: rotate( 18deg); } to { transform: rotate( 26deg); } }

/* ── Eyes ── */
.dog-eye {
  position: absolute;
  top: calc(var(--av) * 0.16);
  width:  calc(var(--av) * 0.075);
  height: calc(var(--av) * 0.075);
  background: #14100a;
  border-radius: 50%;
  box-shadow: inset 0 0 0 2px rgba(255,255,255,0.12);
  animation: blink 4.2s infinite;
}
.dog-eye-l { left:  calc(var(--av) * 0.13); }
.dog-eye-r { right: calc(var(--av) * 0.13); }
@keyframes blink {
  0%, 92%, 100% { transform: scaleY(1); }
  95%           { transform: scaleY(0.1); }
}

/* ── Snout + nose ── */
.dog-snout {
  position: absolute;
  bottom: calc(var(--av) * 0.02);
  left: 50%;
  transform: translateX(-50%);
  width:  calc(var(--av) * 0.30);
  height: calc(var(--av) * 0.24);
  background: linear-gradient(180deg, #f2c88a, #dba965);
  border-radius: 44% 44% 50% 50%;
  display: flex; flex-direction: column; align-items: center;
}
.dog-nose {
  margin-top: calc(var(--av) * 0.012);
  width:  calc(var(--av) * 0.085);
  height: calc(var(--av) * 0.062);
  background: #16110b;
  border-radius: 50% 50% 46% 46%;
}

/* ── MOUTH — the talking element ──
   Closed by default (thin line). While .dog-talking is on the wrapper it
   cycles closed → half-open → full-open on a fast loop, which reads as
   speech at 30fps. */
.dog-mouth {
  margin-top: calc(var(--av) * 0.014);
  width:  calc(var(--av) * 0.145);
  height: calc(var(--av) * 0.014);          /* closed */
  background: #2a1408;
  border-radius: 0 0 50% 50%;
  overflow: hidden;
  position: relative;
  display: flex; justify-content: center;
}
.dog-talking .dog-mouth {
  animation: dogMouth 0.30s steps(1, end) infinite;
}
@keyframes dogMouth {
  0%   { height: calc(var(--av) * 0.014); }  /* closed    */
  33%  { height: calc(var(--av) * 0.055); }  /* half open */
  66%  { height: calc(var(--av) * 0.105); }  /* full open */
  100% { height: calc(var(--av) * 0.045); }  /* half close*/
}

/* Tongue only visible when the mouth is open enough */
.dog-tongue {
  position: absolute;
  bottom: 0;
  width:  calc(var(--av) * 0.085);
  height: calc(var(--av) * 0.075);
  background: linear-gradient(180deg, #e2607a, #c2405c);
  border-radius: 0 0 50% 50%;
}

/* Subtle glow ring while the dog speaks */
.av-dog.dog-talking {
  border-color: #ffc832;
  box-shadow: 0 0 0 5px rgba(255,200,50,0.22), 0 6px 30px rgba(0,0,0,0.5);
}
</style>`;

// ─── MEASURE THE HOST SLOT FROM THE LIVE PAGE ────────────────────────
// Read the real pixel box of the #av-human placeholder. FFmpeg then overlays
// the host clip at exactly those coordinates, so CSS and the composite can
// never drift apart.
async function measureHostSlot(page) {
  try {
    const box = await page.evaluate(() => {
      const el = document.getElementById('av-human');
      if (!el) return null;
      const prev = el.style.display;
      el.style.display = '';                    // ensure measurable
      const r = el.getBoundingClientRect();
      el.style.display = prev;
      if (!r.width || !r.height) return null;
      return { x: Math.round(r.left), y: Math.round(r.top), size: Math.round(r.width) };
    });
    if (box) {
      console.log(`[AVATAR] host slot measured: x=${box.x} y=${box.y} size=${box.size}`);
      return box;
    }
    console.warn('[AVATAR] host slot not measurable — using constants');
  } catch (e) {
    console.warn(`[AVATAR] measure failed: ${e.message.slice(0,60)} — using constants`);
  }
  return null;
}

// ─── FFMPEG COMPOSITE: overlay host circle onto a UI clip ─────────────
// Puppeteer records the UI (dog + question + countdown). FFmpeg then crops
// the host clip into a circle and overlays it in the bottom-LEFT slot,
// exactly where the #av-human placeholder sits.
//
// Geometry is derived from the same constants the CSS uses, so the overlay
// always lands on the placeholder no matter what AVATAR_SIZE is set to.
//   host circle: left edge  = AVATAR_PAD_X
//                bottom edge= AVATAR_PAD_Y
async function compositeHumanCircle(uiClipPath, humanClipPath, dur, outPath, geom = null) {
  // geom is measured from the live page (see measureHostSlot) so the overlay
  // always lands exactly on the #av-human placeholder. Falls back to the
  // constants if measurement failed.
  const size = geom?.size ?? AVATAR_SIZE;
  const r    = size / 2;
  const ox   = geom?.x ?? AVATAR_PAD_X;
  const oy   = geom?.y ?? (VIDEO_H - AVATAR_PAD_Y - size);

  // scale → crop-to-fill square → circular alpha mask → overlay
  const filter = [
    `[1:v]scale=${size}:${size}:force_original_aspect_ratio=increase,` +
      `crop=${size}:${size}[hscaled]`,
    `[hscaled]format=yuva420p,geq=` +
      `lum='p(X,Y)':` +
      `cb='p(X,Y)':` +
      `cr='p(X,Y)':` +
      `a='if(lte(pow(X-${r}\\,2)+pow(Y-${r}\\,2)\\,pow(${r}\\,2))\\,255\\,0)'` +
      `[hcircle]`,
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

// ─── RECORD UI WITH MID-RECORDING EVENTS ──────────────────────────────
// Records `dur` seconds of the page, firing timed callbacks WHILE recording.
// This is how the 50/50 elimination lands at exactly t=3s inside the
// countdown, and how the timeup→CTA screen switch happens mid-clip.
//
//   events: [{ at: <seconds into the clip>, fn: async (page) => {...} }]
async function recordUiWithEvents(page, audioPath, dur, workDir, name, events = []) {
  const rawPath  = path.join(workDir, `${name}_raw.mp4`);
  const h264Path = path.join(workDir, `${name}_h264.mp4`);
  const outPath  = path.join(workDir, `${name}.mp4`);

  const rec = new PuppeteerScreenRecorder(page, {
    fps: 30, videoFrame: { width: VIDEO_W, height: VIDEO_H },
    aspectRatio: '9:16', followNewTab: false
  });
  await rec.start(rawPath);

  const t0 = Date.now();
  const queue = [...events].sort((a, b) => a.at - b.at);
  for (const ev of queue) {
    const waitMs = Math.max(0, ev.at * 1000 - (Date.now() - t0));
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    try {
      await ev.fn(page);
      console.log(`[REC:${name}] event fired at t=${((Date.now()-t0)/1000).toFixed(2)}s`);
    } catch (e) {
      console.warn(`[REC:${name}] event failed: ${e.message.slice(0,80)}`);
    }
  }
  const remainMs = Math.max(0, dur * 1000 - (Date.now() - t0));
  if (remainMs > 0) await new Promise(r => setTimeout(r, remainMs));

  await withTimeout(rec.stop(), TIMEOUT_RECORDER, `${name}.stop`);

  await ffmpeg(
    `-y -i "${rawPath}" -an -c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 -vf "scale=${VIDEO_W}:${VIDEO_H}" "${h264Path}"`,
    `${name}_enc`
  );

  if (audioPath && await fileExists(audioPath)) {
    await ffmpeg(
      `-y -stream_loop -1 -i "${h264Path}" -i "${audioPath}" ` +
      `-map 0:v:0 -map 1:a:0 ` +
      `-c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
      `-c:a aac -b:a 128k -ar 44100 -ac 1 -t ${dur} "${outPath}"`,
      `${name}_mux`
    );
  } else {
    await ffmpeg(`-y -i "${h264Path}" -c:v copy -an -t ${dur} "${outPath}"`, `${name}_vid`);
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

// ─── SET AVATAR MODE (CSS only — host video handled by FFmpeg) ────────
// mode: 'dog_speaking' | 'human_speaking' | 'both_silent'
//   dog_speaking   → dog mouth cycles + fast tail  (TTS is playing)
//   both_silent    → dog mouth closed, tail wags slowly
//   human_speaking → host circle glows; dog mouth closed, tail wags slowly
async function setAvatarMode(page, mode) {
  await page.evaluate((m) => {
    const dog   = document.getElementById('av-dog');
    const human = document.getElementById('av-human');
    // Dog talks ONLY while TTS is speaking. Tail always wags (pure CSS default).
    if (dog)   dog.classList.toggle('dog-talking', m === 'dog_speaking');
    if (human) human.classList.toggle('av-speaking', m === 'human_speaking');
  }, mode);
  await new Promise(r => setTimeout(r, 60));
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
//  2. FFmpeg composites the SILENT host clip into the bottom-left circle
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// STEPS 5+6 — TIMEUP + CTA
//
// Architecture:
//  1. Puppeteer records the UI (dog idle, speaking glow border on human slot)
//  2. FFmpeg composites the CTA4 host clip into the host circle
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
  // NOTE: we deliberately do NOT stamp an 'eliminate' class into the HTML.
  // Doing so hid the two wrong options from the instant the options appeared.
  // Instead we tag them with .opt-elim-target and add .opt-eliminated via JS
  // at exactly t=SHORT_FIFTY_AT seconds into the countdown recording.
  const optClass = i => (elimIdx.includes(i) ? 'opt-elim-target' : '');

  // ── Avatar set: ONE dress_code, one random take per section ────────
  const avatarSet = await fetchAvatarSet();

  // ── Logo ───────────────────────────────────────────────────────────
  console.log('[SHORT] Loading logo...');
  const logoDataUri = await getLogoDataUri();

  // ── Audio downloads (quiz-specific) ───────────────────────────────
  // NOTE: timeup + cta4 speech now live INSIDE the cta4 host clip's own
  // audio track, so we no longer download timeup_audio_url / cta4_audio_url.
  console.log('[SHORT] Downloading audio...');
  const [countdownFile, bgFile, sfxFile] = await Promise.all([
    download(quiz.countdown_music, `sh_cd_${quiz.id}`),
    download(quiz.background_music || DEFAULT_BG_MUSIC, `sh_bg_${quiz.id}`),
    download(quiz.sfx_audio_url,   `sh_sfx_${quiz.id}`, 'question_appear'),
  ]);

  // ── Host clip downloads (all share one dress_code) ────────────────
  console.log('[SHORT] Downloading host clips...');
  const dc = avatarSet.dressCode ?? 'na';
  const [hostHookFile, hostSilentFile, hostCta4File] = await Promise.all([
    download(avatarSet.hook,   `av_hook_d${dc}`),
    download(avatarSet.silent, `av_silent_d${dc}`),
    download(avatarSet.cta4,   `av_cta4_d${dc}`),
  ]);

  console.log('[SHORT] Host clips (dress_code=' + dc + '):', {
    hook:   hostHookFile   ? 'OK' : 'missing (hook-slide fallback)',
    silent: hostSilentFile ? 'OK' : 'missing (placeholder circle)',
    cta4:   hostCta4File   ? 'OK' : 'missing (TTS fallback)',
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
/* 50/50 -- options marked as targets stay FULLY VISIBLE until JS adds
   .opt-eliminated mid-recording at t=SHORT_FIFTY_AT. Previously the
   template's own .eliminate class was stamped in at build time and forced
   to opacity:0, so the 50/50 "reveal" had already happened before the
   options were ever shown. */
.short-fmt .option-btn.opt-elim-target {
  opacity: 1;
}
.short-fmt .option-btn.opt-eliminated {
  animation: fiftyFade 0.45s ease-out forwards !important;
  pointer-events: none !important;
}
@keyframes fiftyFade {
  0%   { opacity: 1; transform: scale(1);    filter: blur(0); }
  100% { opacity: 0; transform: scale(0.90); filter: blur(3px); }
}
</style>
${AVATAR_CSS}`;

  html = html.replace('</head>', `${shortCss}\n</head>`);

  // ── Avatar strip ───────────────────────────────────────────────────
  // Host = placeholder div (FFmpeg composites the real clip on top later).
  // Dog  = full CSS rig (head/ears/eyes/snout/mouth/tail) that Puppeteer
  //        captures for real. Defined once as AVATAR_STRIP_HTML.
  html = html.replace('</body>', `${AVATAR_STRIP_HTML}\n</body>`);

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

  // ══ STEP 1+2 — FULL-SCREEN HOST CLIP (hook + question intro) ═══════
  // The hook clip IS the video for this step; its own audio track carries
  // both the hook line and the question intro. Not recorded by Puppeteer.
  console.log('[SHORT] -- Step 1+2: full-screen host clip');
  const step12Result = await buildHookStep(hostHookFile, workDir);

  if (step12Result) {
    pushClip(step12Result, true);
  } else {
    console.log('[SHORT] Step 1+2 fallback: recording hook slide');
    await showScreen(page, '.hook-slide');
    const fbDur = 3.0;
    const fb = await recordUiWithEvents(page, null, fbDur, workDir, 'sh_step12');
    pushClip(fb, false);
  }

  // ══ STEP 3 — QUESTION + OPTIONS, DOG SPEAKS THE TTS ════════════════
  // Options appear together with the question. Dog mouth cycles while TTS
  // plays. Host circle shows the SILENT clip (same dress_code).
  console.log('[SHORT] -- Step 3: Q + options + dog TTS');

  await page.evaluate(() => {
    const s = document.getElementById('avatar-strip');
    if (s) s.style.display = 'flex';
  });
  // Measure the real host-circle box ONCE, now that the strip is laid out.
  const hostSlot = await measureHostSlot(page);
  await setAvatarMode(page, 'dog_speaking');
  await showScreen(page, '.question-phase');

  // Freeze the countdown — it must not tick until step 4
  await page.evaluate(() => {
    document.querySelectorAll(
      '.countdown-timer,.timer-ring,.timer-bar,[class*="countdown"],[class*="timer"]'
    ).forEach(el => { el.style.animationPlayState = 'paused'; });
  });

  // Audio: sfx -> question TTS -> gap -> "you have only 6 seconds..."
  const s3Parts = [];
  if (sfxFile) {
    s3Parts.push(sfxFile);
    const sg = path.join(workDir, 'sh_sfxgap.mp3');
    await silence(0.12, sg);
    s3Parts.push(sg);
  }
  const qTts = path.join(workDir, 'sh_q_tts.mp3');
  await tts(question, voice, qTts, 3);
  s3Parts.push(qTts);

  const microGap = path.join(workDir, 'sh_microgap.mp3');
  await silence(0.22, microGap);
  s3Parts.push(microGap);

  const timerPrompt = path.join(workDir, 'sh_timerprompt.mp3');
  await tts(
    `You have only ${SHORT_COUNTDOWN} seconds and your time starts now!`,
    voice, timerPrompt, 3
  );
  s3Parts.push(timerPrompt);

  const step3Audio = path.join(workDir, 'sh_step3.mp3');
  await concatAudio(s3Parts, step3Audio, workDir);
  const step3Dur = Math.max(await audioDur(step3Audio), 2.0);
  console.log(`[SHORT] Step 3 audio: ${step3Dur.toFixed(2)}s`);

  const step3Ui = await recordUiWithEvents(page, step3Audio, step3Dur, workDir, 'sh_step3_ui');

  let step3Final = step3Ui;
  if (hostSilentFile && await fileExists(hostSilentFile)) {
    const cp = path.join(workDir, 'sh_step3.mp4');
    await compositeHumanCircle(step3Ui.path, hostSilentFile, step3Dur, cp, hostSlot);
    step3Final = { path: cp, dur: step3Dur };
    console.log('[SHORT] Step 3: silent host clip composited');
  }
  pushClip(step3Final, true);

  // ══ STEP 4 — COUNTDOWN (6s), 50/50 FIRES AT t=3s ═══════════════════
  // Dog stops talking (tail keeps wagging). Host stays on the silent clip.
  console.log(`[SHORT] -- Step 4: countdown ${SHORT_COUNTDOWN}s, 50/50 at ${SHORT_FIFTY_AT}s`);

  await setAvatarMode(page, 'both_silent');

  // Restart the countdown animation at the new duration
  await page.evaluate((cd, hintAt, fiftyAt) => {
    document.querySelectorAll(
      '.countdown-timer,.timer-ring,.timer-bar,[class*="countdown"],[class*="timer"]'
    ).forEach(el => {
      el.style.animation = 'none';
      void el.offsetHeight;                 // force reflow
      el.style.animation = '';
      el.style.animationDuration  = cd + 's';
      el.style.animationPlayState = 'running';
    });
    const qp = document.querySelector('.question-phase');
    if (qp) {
      qp.style.setProperty('--qtime', cd);
      qp.style.setProperty('--hint-time', hintAt);
      qp.style.setProperty('--fiftyfifty-time', fiftyAt);
    }
  }, SHORT_COUNTDOWN, SHORT_HINT_AT, SHORT_FIFTY_AT);

  // Countdown music, looped to exactly SHORT_COUNTDOWN seconds
  const cdAudio = path.join(workDir, 'sh_cd.mp3');
  if (countdownFile) {
    await ffmpeg(
      `-y -stream_loop -1 -i "${countdownFile}" -t ${SHORT_COUNTDOWN} -af "volume=0.75" -ar 44100 -ac 1 -acodec libmp3lame "${cdAudio}"`,
      'sh_cdLoop'
    );
  } else {
    await silence(SHORT_COUNTDOWN, cdAudio);
  }

  // THE 50/50: fire the elimination mid-recording, exactly at t=3s
  const step4Ui = await recordUiWithEvents(
    page, cdAudio, SHORT_COUNTDOWN, workDir, 'sh_step4_ui',
    [{
      at: SHORT_FIFTY_AT,
      fn: async (pg) => {
        const n = await pg.evaluate(() => {
          const targets = document.querySelectorAll('.option-btn.opt-elim-target');
          targets.forEach(el => el.classList.add('opt-eliminated'));
          return targets.length;
        });
        console.log(`[SHORT] 50/50 eliminated ${n} options`);
      }
    }]
  );

  let step4Final = step4Ui;
  if (hostSilentFile && await fileExists(hostSilentFile)) {
    const cp = path.join(workDir, 'sh_step4.mp4');
    await compositeHumanCircle(step4Ui.path, hostSilentFile, SHORT_COUNTDOWN, cp, hostSlot);
    step4Final = { path: cp, dur: SHORT_COUNTDOWN };
    console.log('[SHORT] Step 4: silent host clip composited');
  }
  pushClip(step4Final, false);   // countdown music != voice, no bg duck

  // ══ STEP 5+6 — TIMEUP + CTA4 (ONE host clip, one audio track) ══════
  // Section (c) is a single recording containing BOTH the time-up line and
  // the CTA4 line. We take its audio wholesale and switch the on-screen
  // slide from timeup -> CTA partway through.
  console.log('[SHORT] -- Step 5+6: timeup + CTA4 (single host clip)');

  await setAvatarMode(page, 'human_speaking');
  await showScreen(page, '.pre-reveal-slide');

  let step56Audio, step56Dur, splitAt;

  if (hostCta4File && await fileExists(hostCta4File)) {
    // Audio comes from the host clip itself
    step56Audio = path.join(workDir, 'sh_step56_audio.mp3');
    await ffmpeg(
      `-y -i "${hostCta4File}" -vn -ar 44100 -ac 1 -b:a 128k -acodec libmp3lame "${step56Audio}"`,
      'step56_audio'
    );
    step56Dur = Math.max(await videoDur(hostCta4File), await audioDur(step56Audio), 1.5);

    // When to swap timeup -> CTA slide. Prefer the DB value; else 45%.
    splitAt = (avatarSet.timeupSplitSec != null && avatarSet.timeupSplitSec > 0
               && avatarSet.timeupSplitSec < step56Dur)
      ? Number(avatarSet.timeupSplitSec)
      : step56Dur * 0.45;
    console.log(`[SHORT] Step 5+6: ${step56Dur.toFixed(2)}s, slide switch at ${splitAt.toFixed(2)}s`);
  } else {
    // No cta4 clip — fall back to TTS for both lines
    console.log('[SHORT] Step 5+6: no cta4 host clip — TTS fallback');
    const tuTts = path.join(workDir, 'sh_timeup_tts.mp3');
    await tts(quiz.timeup_text || "Time's up!", voice, tuTts, 3);
    const ctaTts = path.join(workDir, 'sh_cta4_tts.mp3');
    await tts(quiz.cta4_text || 'Write your answer in the comments!', voice, ctaTts, 3);
    splitAt = Math.max(await audioDur(tuTts), 0.8);
    step56Audio = path.join(workDir, 'sh_step56_audio.mp3');
    await concatAudio([tuTts, ctaTts], step56Audio, workDir);
    step56Dur = Math.max(await audioDur(step56Audio), 2.0);
  }

  // Which slide to switch TO at splitAt
  const ctaSel = await page.evaluate(() =>
    document.querySelector('.comment-cta-screen') ? '.comment-cta-screen' : '.pre-reveal-slide'
  );

  const step56Ui = await recordUiWithEvents(
    page, step56Audio, step56Dur, workDir, 'sh_step56_ui',
    [{
      at: splitAt,
      fn: async (pg) => {
        await pg.evaluate((sel) => {
          document.querySelectorAll('.screen').forEach(e => e.classList.remove('active'));
          document.querySelector(sel)?.classList.add('active');
        }, ctaSel);
        console.log('[SHORT] switched to CTA slide');
      }
    }]
  );

  let step56Final = step56Ui;
  const step56Host = (hostCta4File && await fileExists(hostCta4File))
    ? hostCta4File
    : (hostSilentFile && await fileExists(hostSilentFile) ? hostSilentFile : null);

  if (step56Host) {
    const cp = path.join(workDir, 'sh_step56.mp4');
    await compositeHumanCircle(step56Ui.path, step56Host, step56Dur, cp, hostSlot);
    step56Final = { path: cp, dur: step56Dur };
    console.log(`[SHORT] Step 5+6: ${hostCta4File ? 'cta4' : 'silent'} host clip composited`);
  }
  pushClip(step56Final, true);

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
