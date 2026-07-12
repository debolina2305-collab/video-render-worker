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
const SHORT_COUNTDOWN   = 5;    // countdown length (5 sec per spec)
const SHORT_FIFTY_AT    = 2.5;  // 50/50 fires at t=2.5s INTO the countdown (halfway)
const SHORT_HINT_AT     = 1;    // hint appears t=1s INTO the countdown
// Avatar circle size (px) — matches CSS below
// Circle diameter = 40% of the 1080px video width (host and dog each).
const VIDEO_W           = 1080;
const VIDEO_H           = 1920;
const AVATAR_SIZE       = Math.round(VIDEO_W * 0.40);   // 432px
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

// 'dog_image' is NOT a required section (no dress_code constraint on it).
// It is a single shared image used for ALL dress codes.
const AVATAR_SECTIONS = ['hook', 'silent', 'cta4'];
const DOG_SECTIONS    = ['dog_image', 'dog_gif_talking', 'dog_gif_idle'];

async function fetchAvatarSet() {
  const empty = { dressCode: null, hook: null, silent: null, cta4: null, timeupSplitSec: null, dogImage: null, dogIdle: null, dogSpeaking: null, dogCountdown: null, dogCta4: null };

  let rows;
  try {
    rows = await fetchSupabase(
      'avatar_assets?is_active=eq.true&select=section,dress_code,video_url,timeup_split_sec'
    );
  } catch (e) {
    console.warn('[AVATAR] avatar_assets fetch failed (non-fatal):', e.message);
    return empty;
  }

  // Dog assets: shared across dress codes. One per type, picked at random.
  const pickDogUrl = sec => {
    const dr = (rows||[]).filter(r=>r.section===sec && r.video_url);
    return dr.length ? dr[Math.floor(Math.random()*dr.length)].video_url : null;
  };
  const dogImageUrl    = pickDogUrl('dog_image');
  const dogIdleUrl     = pickDogUrl('dog_idle');
  const dogSpeakingUrl = pickDogUrl('dog_speaking');
  const dogCdUrl       = pickDogUrl('dog_countdown');
  const dogCta4Url     = pickDogUrl('dog_cta4');
  console.log('[AVATAR] dog MP4s: idle='+(dogIdleUrl?'OK':'none')+
    ' speaking='+(dogSpeakingUrl?'OK':'none')+
    ' countdown='+(dogCdUrl?'OK':'none')+
    ' cta4='+(dogCta4Url?'OK':'none'));

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
    fb.dogImage = dogImageUrl; fb.dogIdle = dogIdleUrl; fb.dogSpeaking = dogSpeakingUrl; fb.dogCountdown = dogCdUrl; fb.dogCta4 = dogCta4Url;
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

  set.dogImage = dogImageUrl; set.dogIdle = dogIdleUrl; set.dogSpeaking = dogSpeakingUrl; set.dogCountdown = dogCdUrl; set.dogCta4 = dogCta4Url;
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
  <!-- HOST: placeholder — FFmpeg composites real host clip here -->
  <div id="av-human" class="av-circle av-human av-placeholder">
    <span class="av-placeholder-icon">&#128100;</span>
  </div>

  <!-- DOG: placeholder — FFmpeg composites real dog clip here.
       No GIF/CSS animation needed; the MP4 clips contain the real movement.
       The CSS rig below is a last-resort fallback if no dog clips exist. -->
  <div id="av-dog" class="av-circle av-dog av-placeholder">
    <span class="av-placeholder-icon" style="font-size:56px;opacity:0.15">&#128054;</span>
    <!-- CSS fallback rig (hidden when dog MP4 clips are available) -->
    <div class="dog-stage dog-css-only">
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
.av-dog { background:radial-gradient(circle at 50% 40%,#3a2a12,#1a1206 70%,#100b04 100%); --dog-eye-y:38%; --dog-eye-h:7%; }

/* LAYER A: GIF pair */
.dog-gif-wrap { position:absolute;inset:0;border-radius:50%;overflow:hidden;display:none;z-index:1; }
.dog-gif { width:100%;height:100%;object-fit:cover;object-position:center top;border-radius:50%;display:block; }
.dog-gif-talk { display:none; }
.dog-gif-idle { display:block; }
.av-dog.dog-talking .dog-gif-talk { display:block !important; }
.av-dog.dog-talking .dog-gif-idle { display:none  !important; }
.av-dog.dog-talking::after { content:'';position:absolute;inset:-4px;border-radius:50%;border:3px solid rgba(255,200,50,0.85);animation:gifRingPulse 0.55s ease-out infinite;pointer-events:none;z-index:10; }
@keyframes gifRingPulse { 0%{opacity:1;transform:scale(1.00)} 100%{opacity:0;transform:scale(1.18)} }

/* LAYER B: HD photo + CSS overlays */
.dog-photo-wrap { position:absolute;inset:0;border-radius:50%;display:none;z-index:1; }
.dog-photo { position:absolute;inset:0;border-radius:50%;background-size:cover;background-position:center top;animation:dogHeadShake 2.8s ease-in-out infinite alternate;transform-origin:50% 80%; }
.dog-talking .dog-photo { animation-duration:1.05s; }
@keyframes dogHeadShake { from{transform:rotate(-2.6deg) scale(1.03)} to{transform:rotate(2.6deg) scale(1.03)} }
.dog-blink { display:none;position:absolute;left:12%;right:12%;top:var(--dog-eye-y);height:var(--dog-eye-h);border-radius:40%;background:rgba(30,18,8,0.92);transform:scaleY(0);transform-origin:50% 0;z-index:2;animation:dogBlink 4.2s ease-in-out infinite; }
@keyframes dogBlink { 0%,90%,100%{transform:scaleY(0)} 93%{transform:scaleY(1)} 96%{transform:scaleY(0)} }
.dog-overlay { position:absolute;inset:0;border-radius:50%;z-index:2;pointer-events:none;overflow:visible; }
.dog-ring { position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);border-radius:50%;border:3px solid rgba(255,200,50,0);width:var(--av);height:var(--av); }
.dog-talking .dog-ring-1{animation:dogRing 0.50s ease-out infinite 0.00s}
.dog-talking .dog-ring-2{animation:dogRing 0.50s ease-out infinite 0.17s}
.dog-talking .dog-ring-3{animation:dogRing 0.50s ease-out infinite 0.34s}
@keyframes dogRing { 0%{transform:translate(-50%,-50%) scale(1.00);border-color:rgba(255,200,50,0.80);opacity:1} 100%{transform:translate(-50%,-50%) scale(1.60);border-color:rgba(255,200,50,0.00);opacity:0} }
.dog-mouth-slit { position:absolute;bottom:22%;left:50%;transform:translateX(-50%);width:calc(var(--av)*0.30);height:calc(var(--av)*0.02);background:rgba(20,8,4,0.70);border-radius:0 0 50% 50%; }
.dog-talking .dog-mouth-slit { animation:photoMouth 0.28s steps(1,end) infinite; }
@keyframes photoMouth { 0%{height:calc(var(--av)*0.02)} 25%{height:calc(var(--av)*0.07)} 50%{height:calc(var(--av)*0.13)} 75%{height:calc(var(--av)*0.07)} }
.dog-tail-anim { position:absolute;top:12%;right:8%;width:calc(var(--av)*0.14);height:calc(var(--av)*0.32);background:linear-gradient(180deg,rgba(180,120,40,.90),rgba(140,90,30,.70));border-radius:calc(var(--av)*0.07);transform-origin:50% 100%;animation:tailWagOverlay 0.72s ease-in-out infinite alternate;z-index:3; }
.dog-talking .dog-tail-anim { animation-duration:0.26s; }
@keyframes tailWagOverlay { from{transform:rotate(-28deg)} to{transform:rotate(28deg)} }
.av-dog.dog-talking { border-color:#ffc832;box-shadow:0 0 0 5px rgba(255,200,50,0.22),0 6px 30px rgba(0,0,0,0.5); }

/* LAYER C: pure CSS rig fallback */
.dog-stage { position:absolute;inset:0;display:flex;align-items:center;justify-content:center; }
.dog-css-only { display:flex; }
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

// ─── MEASURE THE DOG SLOT FROM THE LIVE PAGE ─────────────────────────
async function measureDogSlot(page) {
  try {
    const box = await page.evaluate(() => {
      const el = document.getElementById('av-dog');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: Math.round(r.left), y: Math.round(r.top), size: Math.round(r.width) };
    });
    if (box) { console.log(`[AVATAR] dog slot: x=${box.x} y=${box.y} size=${box.size}`); return box; }
  } catch (e) { console.warn(`[AVATAR] dog measure failed: ${e.message.slice(0,60)}`); }
  return null;
}

// ─── COMPOSITE A DOG MP4 CLIP INTO THE DOG CIRCLE SLOT ───────────────
// loop=true  → stream_loop -1  (speaking: loops to fill `dur` exactly)
// loop=false → plays once (idle, countdown, cta4 clips have fixed duration)
async function compositeDogCircle(baseClipPath, dogClipPath, dur, outPath, geom, loop = false) {
  const size = geom?.size ?? AVATAR_SIZE;
  const r    = size / 2;
  const gx   = geom?.x ?? (VIDEO_W - AVATAR_PAD_X - size);
  const gy   = geom?.y ?? (VIDEO_H - AVATAR_PAD_Y - size);

  const filter = [
    `[1:v]scale=${size}:${size}:force_original_aspect_ratio=increase,` +
      `crop=${size}:${size}[dogsq]`,
    `[dogsq]format=yuva420p,geq=` +
      `lum='p(X,Y)':cb='p(X,Y)':cr='p(X,Y)':` +
      `a='if(lte(pow(X-${r}\,2)+pow(Y-${r}\,2)\,pow(${r}\,2))\,255\,0)'` +
      `[dogcircle]`,
    `[0:v][dogcircle]overlay=${gx}:${gy}:shortest=1[vout]`
  ].join(';');

  const loopFlag = loop ? '-stream_loop -1' : '';
  await ffmpeg(
    `-y -i "${baseClipPath}" ${loopFlag} -i "${dogClipPath}" ` +
    `-filter_complex "${filter}" ` +
    `-map "[vout]" -map 0:a? ` +
    `-c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
    `-c:a aac -b:a 128k -ar 44100 -ac 1 -t ${dur} "${outPath}"`,
    'composite_dog'
  );
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
// ─── RECORD UI WITH MID-CLIP EVENTS ──────────────────────────────────
// Uses PuppeteerScreenRecorder (Chrome's Page.screencast API). Verified to
// deliver fully-rendered frames under headless + --disable-gpu on CI.
//
// An earlier revision replaced this with page.screenshot() after blaming the
// recorder for black video. The true cause was an unclosed </style> in
// AVATAR_CSS which left the page empty; screenshots were ~8x slower and
// could not show the countdown ticking. Recorder restored.
//
// events: [{ at: <seconds into the clip>, fn: async (page) => {...} }]
//   fired WHILE recording, so the 50/50 fade, the hint reveal and the
//   timeup->CTA slide switch are all captured as real motion.
async function recordUiWithEvents(page, audioPath, dur, workDir, name, events = []) {
  const rawPath  = path.join(workDir, `${name}_raw.mp4`);
  const h264Path = path.join(workDir, `${name}_h264.mp4`);
  const outPath  = path.join(workDir, `${name}.mp4`);

  const rec = new PuppeteerScreenRecorder(page, {
    fps: 30,
    videoFrame: { width: VIDEO_W, height: VIDEO_H },
    aspectRatio: '9:16',
    followNewTab: false
  });
  await rec.start(rawPath);

  const t0 = Date.now();
  const queue = [...events].sort((a, b) => a.at - b.at);

  for (const ev of queue) {
    const waitMs = ev.at * 1000 - (Date.now() - t0);
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    try {
      await ev.fn(page);
      console.log(`[REC:${name}] event fired at t=${((Date.now() - t0) / 1000).toFixed(2)}s`);
    } catch (e) {
      console.warn(`[REC:${name}] event failed: ${e.message.slice(0, 90)}`);
    }
  }

  const remainMs = dur * 1000 - (Date.now() - t0);
  if (remainMs > 0) await new Promise(r => setTimeout(r, remainMs));

  await withTimeout(rec.stop(), TIMEOUT_RECORDER, `${name}.stop`);

  // PuppeteerScreenRecorder emits VP8; re-encode to H264 before any concat.
  await ffmpeg(
    `-y -i "${rawPath}" -an ` +
    `-c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
    `-vf "scale=${VIDEO_W}:${VIDEO_H}" "${h264Path}"`,
    `${name}_enc`
  );

  if (audioPath && await fileExists(audioPath)) {
    // -stream_loop on the video guards against a recording that came out a
    // few frames short of `dur`; -t clamps the result to the audio length.
    await ffmpeg(
      `-y -stream_loop -1 -i "${h264Path}" -i "${audioPath}" ` +
      `-map 0:v:0 -map 1:a:0 ` +
      `-c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
      `-c:a aac -b:a 128k -ar 44100 -ac 1 -t ${dur} "${outPath}"`,
      `${name}_mux`
    );
  } else {
    await ffmpeg(
      `-y -stream_loop -1 -i "${h264Path}" -an ` +
      `-c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 -t ${dur} "${outPath}"`,
      `${name}_vid`
    );
  }

  console.log(`[REC:${name}] recorded ${dur.toFixed(2)}s (${queue.length} event(s))`);
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

  // ── Dog HD image download ─────────────────────────────────────────
  let dogImageFileUrl  = null;
  let dogGifTalkingUrl = null;
  let dogGifIdleUrl    = null;
  // ── Dog MP4 clips (4 sections, all downloaded in parallel) ──────────
  // No GIFs needed — all dog animation is now driven by real MP4 clips
  // composited by FFmpeg into the dog circle slot, just like the host clips.
  const [dogImgFile, dogIdleFile, dogSpeakingFile, dogCdFile, dogCta4File_d] = await Promise.all([
    avatarSet.dogImage    ? download(avatarSet.dogImage,    'av_dog_img')  : Promise.resolve(null),
    avatarSet.dogIdle     ? download(avatarSet.dogIdle,     'av_dog_idle') : Promise.resolve(null),
    avatarSet.dogSpeaking ? download(avatarSet.dogSpeaking, 'av_dog_spk')  : Promise.resolve(null),
    avatarSet.dogCountdown? download(avatarSet.dogCountdown,'av_dog_cd')   : Promise.resolve(null),
    avatarSet.dogCta4     ? download(avatarSet.dogCta4,     'av_dog_cta4') : Promise.resolve(null),
  ]);
  if (dogImgFile)       { dogImageFileUrl  = `file://${dogImgFile}`;   console.log('[SHORT] Dog HD image OK (photo fallback)'); }
  if (dogIdleFile)      console.log('[SHORT] Dog idle MP4 OK');
  if (dogSpeakingFile)  console.log('[SHORT] Dog speaking MP4 OK (will loop to match TTS)');
  if (dogCdFile)        console.log('[SHORT] Dog countdown MP4 OK');
  if (dogCta4File_d)    console.log('[SHORT] Dog CTA4 MP4 OK');
  console.log('[SHORT] Dog MP4 set:', {
    idle:      dogIdleFile      ? 'OK' : 'missing',
    speaking:  dogSpeakingFile  ? 'OK' : 'missing',
    countdown: dogCdFile        ? 'OK' : 'missing',
    cta4:      dogCta4File_d    ? 'OK' : 'missing',
  });

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

  // ── Background photo overlay (30% opacity, same logic as worker10 long) ──
  // Priority: hero_image_url -> topic_image_url -> none.
  // Written as a temp file (file://) because Puppeteer can't use large
  // base64 data URIs as CSS custom properties.
  let videoPhotoStyleBlock = '';
  let videoPhotoClass      = 'no-photo';

  // Same image worker10 (long) puts behind the video at 30% opacity.
  // Order: topic_image_url (what worker10 uses) -> hero -> inline -> thumbnail
  //        -> the blog post's hero/inline image for this quiz.
  let bgImageUrl = null, bgImageSrc = null;
  for (const [srcName, url] of [
    ['topic_image_url',  quiz.topic_image_url],
    ['hero_image_url',   quiz.hero_image_url],
    ['inline_image_url', quiz.inline_image_url],
    ['thumbnail_url',    quiz.thumbnail_url],
  ]) {
    if (url && String(url).startsWith('http')) { bgImageUrl = url; bgImageSrc = srcName; break; }
  }
  if (!bgImageUrl) {
    try {
      const bp = await fetchSupabase(
        `quiz_blog_posts?quiz_id=eq.${quiz.id}&select=hero_image_url,inline_image_url&limit=1`
      );
      const cand = bp?.[0]?.hero_image_url || bp?.[0]?.inline_image_url || null;
      if (cand) { bgImageUrl = cand; bgImageSrc = 'quiz_blog_posts'; }
    } catch (e) {
      console.warn(`[SHORT-BG] blog-post lookup failed: ${e.message.slice(0,60)}`);
    }
  }
  if (bgImageUrl) console.log(`[SHORT-BG] source=${bgImageSrc}`);

  if (bgImageUrl) {
    try {
      const imgRes = await fetch(bgImageUrl, { headers: { 'User-Agent': 'AutoQuiz/1.0 short renderer' } });
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer();
        if (buf.byteLength > 500) {
          const imgPath = path.join(workDir, 'sh_bg_photo.jpg');
          await fs.writeFile(imgPath, Buffer.from(buf));
          videoPhotoStyleBlock = `<style>:root{--topic-photo-url:url("file://${imgPath}");}</style>`;
          videoPhotoClass = '';
          console.log(`[SHORT-BG] ${(buf.byteLength/1024).toFixed(0)}KB from ${bgImageUrl.slice(0,60)}`);
        }
      } else { console.log(`[SHORT-BG] HTTP ${imgRes.status}`); }
    } catch (e) { console.warn(`[SHORT-BG] ${e.message.slice(0,80)}`); }
  } else { console.log('[SHORT-BG] No image on quiz row or blog post — background photo skipped'); }

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
    '{{VIDEO_PHOTO_STYLE_BLOCK}}': videoPhotoStyleBlock,
    '{{VIDEO_PHOTO_CLASS}}':       videoPhotoClass,
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
/* ── LAYOUT ──────────────────────────────────────────────────────────────
   The template places a spinning logo (position:absolute; top:38px; h=100px)
   and challenge-no (position:absolute; top:155px; ~30px tall) on every screen.
   In LONG format the .niche-marquee (margin-top:220px, ~88px tall, in normal
   flow) is the natural spacer that pushes .content below that header. SHORT
   format hides the marquee, so we reserve the header space explicitly on
   EVERY top-aligned screen. 240px = header height + breathing room.        ── */
.short-fmt .question-phase,
.short-fmt .pre-reveal-slide,
.short-fmt .question-appear-slide,
.short-fmt .options-waiting-slide,
.short-fmt .question-static {
  padding-top:    240px !important;
  padding-bottom: ${AVATAR_SIZE + 80}px !important;
  box-sizing: border-box !important;
}

/* ── QUESTION TEXT: base 52px × 1.35 = 70px ── */
.short-fmt .qp-question {
  font-size:   70px !important;
  font-weight: 800 !important;
  line-height: 1.25 !important;
  text-align:  center !important;
  padding:     0 24px !important;
  margin:      0 0 18px 0 !important;
}

/* ── "OPTIONS" LABEL — appears below the question, before option A ──────
   The worker injects this element and reveals it 0.5s after the question.  ── */
.short-fmt .qp-options-label,
.short-fmt .short-options-label {
  font-size:      40px !important;   /* ~30px × 1.35 */
  font-weight:    900 !important;
  letter-spacing: 4px !important;
  text-transform: uppercase !important;
  text-align:     center !important;
  color:          #ffd24a !important;
  text-shadow:    0 0 18px rgba(255,210,74,0.7), 0 2px 8px rgba(0,0,0,0.8) !important;
  margin:         4px 0 14px 0 !important;
}
/* label hidden until the worker reveals it */
.short-fmt .short-options-label.lbl-hidden { opacity: 0 !important; }
.short-fmt .short-options-label.lbl-show {
  animation: lblPop 0.35s cubic-bezier(0.34,1.56,0.64,1) both !important;
}
@keyframes lblPop {
  from { opacity:0; transform: translateY(10px) scale(0.96); }
  to   { opacity:1; transform: none; }
}

/* ── OPTIONS container + sizing (base 50px × 1.35 = 68px) ── */
.short-fmt .qp-options {
  display:        flex !important;
  flex-direction: column !important;
  gap:            16px !important;
  padding:        0 18px !important;
  opacity:        1 !important;
}
.short-fmt .qp-option {
  font-size:     68px !important;   /* 50px × 1.35 */
  font-weight:   700 !important;
  padding:       36px 42px !important;
  border-radius: 22px !important;
  text-align:    left !important;
  line-height:   1.2 !important;
}
.short-fmt .qp-option-badge {
  width:        62px !important;    /* ~46px × 1.35 */
  height:       62px !important;
  font-size:    32px !important;    /* ~24px × 1.35 */
  flex-shrink:  0 !important;
  margin-right: 18px !important;
}

/* ── FAIL-SAFE STAGGERED OPTION REVEAL ─────────────────────────────────
   Options are VISIBLE by default. The worker adds .opt-hidden to each at
   step-3 start, then removes it one-by-one (0.5s apart) with soft sfx. If a
   reveal event never fires, the option simply stays visible — it can never
   get permanently stuck hidden. .opt-hidden is the ONLY thing that hides.  ── */
.short-fmt .qp-option.opt-hidden {
  opacity:    0 !important;
  transform:  translateX(-22px) scale(0.97) !important;
  transition: none !important;
}
.short-fmt .qp-option.opt-reveal {
  animation: shortOptSlide 0.38s cubic-bezier(0.34,1.56,0.64,1) both !important;
}
@keyframes shortOptSlide {
  from { opacity:0; transform: translateX(-26px) scale(0.97); }
  to   { opacity:1; transform: none; }
}

/* ── QUESTION entry animation ── */
.short-fmt .qp-question {
  animation: shortQSlide 0.45s cubic-bezier(0.34,1.56,0.64,1) both !important;
}
@keyframes shortQSlide {
  from { opacity:0; transform: translateY(26px) scale(0.97); }
  to   { opacity:1; transform: none; }
}

/* ── HINT: shown 1s AFTER the countdown starts ── */
.short-fmt .qp-hint {
  position: static !important;
  left: auto !important;
  right: auto !important;
  bottom: auto !important;
  margin: 14px 34px 0 !important;
  z-index: auto !important;
  animation: none !important;
  opacity: 1 !important;
  visibility: hidden !important;   /* space reserved, not painted */
  font-size: 40px !important;      /* ~30px × 1.35 */
  font-weight: 700 !important;
  padding: 18px 26px !important;
}
.short-fmt .qp-hint.hint-visible {
  visibility: visible !important;
  animation: hintPop 0.35s ease-out both !important;
}
@keyframes hintPop {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}

/* ── Black marquee bar removed in short format ── */
.short-fmt .niche-marquee { display: none !important; }

/* ── CHALLENGE ID: base ~20px × 1.35 ≈ 27px ── */
.short-fmt .challenge-no {
  font-size: 27px !important;
  letter-spacing: 2px !important;
  font-weight: 900 !important;
}

/* ── No answer colour reveal in this format ── */
.short-fmt .qp-option.correct,
.short-fmt .qp-option.wrong {
  background: unset !important;
  border-color: unset !important;
  color: unset !important;
}

/* ── 50/50 ── */
.short-fmt .qp-option.opt-elim-target { animation: none !important; }
.short-fmt .qp-option.opt-eliminated {
  animation: fiftyFade 0.45s ease-out forwards !important;
  pointer-events: none !important;
}
@keyframes fiftyFade {
  0%   { opacity: 1; transform: scale(1);    filter: blur(0); }
  100% { opacity: 0; transform: scale(0.90); filter: blur(3px); }
}

/* ── COUNTDOWN TIMER: BIG ring / digital / hourglass / bar ──────────────
   All sizes scaled up (~1.5×) for readability at Shorts size.            ── */
.short-fmt .qp-timer-wrap {
  display: flex !important;
  visibility: visible !important;
  opacity: 1   !important;
  width:  150px !important;
  height: 150px !important;
  min-width:  150px !important;
  min-height: 150px !important;
  margin: 14px auto !important;
  position: relative !important;
}
.short-fmt .qp-timer-ring {
  width:  150px !important;
  height: 150px !important;
}
.short-fmt .qp-timer-ring svg,
.short-fmt .qp-timer-ring circle {
  width:  150px !important;
  height: 150px !important;
}
.short-fmt .qp-timer-number {
  font-size: 56px !important;
  font-weight: 900 !important;
  line-height: 1 !important;
}
/* cd-digital: large block countdown number */
.short-fmt .cd-digital {
  font-size: 80px !important;
  font-weight: 900 !important;
  text-align: center !important;
  line-height: 150px !important;
  color: #fff !important;
  text-shadow: 0 0 20px rgba(255,200,0,0.9), 0 2px 8px rgba(0,0,0,0.8) !important;
}
/* cd-hourglass: show emoji + number */
.short-fmt .cd-hourglass     { font-size: 66px !important; }
.short-fmt .cd-hourglass-num { font-size: 58px !important; font-weight: 900 !important; }
/* cd-bar: thicker full-width progress bar */
.short-fmt .cd-bar-wrap {
  width: 100% !important; height: 20px !important;
  background: rgba(255,255,255,0.18) !important;
  border-radius: 99px !important; overflow: hidden !important;
}
.short-fmt .cd-bar-fill {
  height: 100% !important;
  background: linear-gradient(90deg,#ffc832,#ff4444) !important;
  animation: cdBarDrain ${SHORT_COUNTDOWN}s linear forwards !important;
}
@keyframes cdBarDrain { from { width:100%; } to { width:0%; } }

/* ── CTA SCREEN (comment-cta-screen) layout fix ─────────────────────────
   Hide the floating logo + challenge-no, centre the pills, and add extra
   TOP padding (+150px) so the LIKE pill sits lower / more central.        ── */
.short-fmt .comment-cta-screen .persistent-logo  { display: none !important; }
.short-fmt .comment-cta-screen .challenge-no     { display: none !important; }

.short-fmt .comment-cta-screen {
  padding-bottom: ${AVATAR_SIZE + 80}px !important;
  box-sizing: border-box !important;
}
/* Push content down: +150px extra top padding per request */
.short-fmt .comment-cta-screen .content {
  justify-content: center !important;
  padding-top: 210px !important;     /* 60 + 150 extra */
  padding-bottom: ${AVATAR_SIZE + 80}px !important;
  gap: 26px !important;
}

/* Pills (base 56px × 1.35 ≈ 68px, but cap at 60 to fit width) */
.short-fmt .comment-cta-screen .cta-pill {
  padding: 26px 38px !important;
  font-size: 60px !important;
  margin: 0 !important;
  width: 88% !important;
  text-align: center !important;
}
.short-fmt .comment-cta-screen .cta-combined-card {
  padding: 24px 32px !important;
  gap: 16px !important;
  text-align: center !important;
  width: 88% !important;
}
.short-fmt .comment-cta-screen .cta-combined-text {
  font-size: 52px !important;
  line-height: 1.25 !important;
  text-align: center !important;
}
.short-fmt .comment-cta-screen .cta-combined-icon {
  font-size: 60px !important;
}
.short-fmt .comment-cta-screen .cta-divider {
  margin: 4px 0 !important;
}
.short-fmt .comment-cta-screen .cta-combined-arrow {
  font-size: 60px !important;
  margin-top: 4px !important;
}
</style>
${AVATAR_CSS}`;

  html = html.replace('</head>', `${shortCss}\n</head>`);

  // ── Avatar strip ───────────────────────────────────────────────────
  // Host = placeholder div (FFmpeg composites the real clip on top later).
  // Dog  = full CSS rig (head/ears/eyes/snout/mouth/tail) that Puppeteer
  //        captures for real. Defined once as AVATAR_STRIP_HTML.
  // Build avatar strip HTML — dog image URL is injected via a CSS var
  // so the const AVATAR_STRIP_HTML doesn't need to change per quiz.
  // When dog MP4 clips exist, hide the CSS fallback rig — the real dog
  // video will be composited by FFmpeg so the placeholder shows nothing.
  // When no clips exist, the CSS rig animates as a last resort.
  const hasDogMp4 = !!(dogIdleFile || dogSpeakingFile || dogCdFile || dogCta4File_d);
  const dogImgCssOverride = hasDogMp4
    ? `<style>
        #av-dog .dog-css-only { display: none !important; }
        #av-dog .av-placeholder-icon { opacity: 0.05 !important; }
       </style>`
    : '';
  if (hasDogMp4) console.log('[SHORT] Dog: MP4 clip mode (CSS rig hidden)');
  else           console.log('[SHORT] Dog: CSS rig fallback mode (no dog MP4 clips in DB)');

  html = html.replace('</body>', `${dogImgCssOverride}${AVATAR_STRIP_HTML}\n</body>`);

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

  // If the HD dog photo loaded, hide the CSS-only fallback rig so they
  // don't stack. The inline <style> already sets .dog-photo { display:block }.
  // The CSS override block has already hidden the unused layers via
  // display:none !important on .dog-gif-wrap / .dog-photo-wrap / .dog-css-only.
  // Nothing further needed here.

  // Avatar strip is laid out from the very first frame so both circle slots
  // can be measured BEFORE step 1+2 uses them. Previously `dogSlot` was
  // declared down in step 3 while step 1+2 referenced it -> a temporal-dead-zone
  // ReferenceError that the surrounding try/catch swallowed, which is why the
  // dog never appeared on the hook clip.
  await page.evaluate(() => {
    const strip = document.getElementById('avatar-strip');
    if (strip) strip.style.display = 'flex';
  });
  // quiz_template.html gives every screen a .topic-photo-overlay EXCEPT
  // .question-phase -- the exact screen steps 3 and 4 use. Without this div
  // the background photo can never appear there. Inject it into any screen
  // that lacks one.
  const injected = await page.evaluate((photoClass) => {
    let added = 0;
    document.querySelectorAll('.screen').forEach(sc => {
      if (!sc.querySelector('.topic-photo-overlay')) {
        const d = document.createElement('div');
        d.className = 'topic-photo-overlay' + (photoClass ? ' ' + photoClass : '');
        sc.insertBefore(d, sc.firstChild);
        added++;
      }
    });
    return added;
  }, videoPhotoClass);
  console.log(`[SHORT-BG] injected overlay into ${injected} screen(s)`);

  const hostSlot = await measureHostSlot(page);
  const dogSlot  = await measureDogSlot(page);

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
    // Composite idle dog onto the full-screen hook clip
    let step12Final = step12Result;
    if (dogIdleFile && await fileExists(dogIdleFile)) {
      try {
        const cp = path.join(workDir, 'sh_step12_final.mp4');
        // loop=true: idle clip loops to fill the full hook duration
        await compositeDogCircle(step12Result.path, dogIdleFile, step12Result.dur, cp, dogSlot, true);
        step12Final = { path: cp, dur: step12Result.dur };
        console.log('[SHORT] Step 1+2: dog idle clip looped onto hook clip');
      } catch (e) {
        console.warn(`[SHORT] Step 1+2 dog composite non-fatal: ${e.message.slice(0,80)}`);
      }
    }
    pushClip(step12Final, true);
  } else {
    console.log('[SHORT] Step 1+2 fallback: recording hook slide');
    await showScreen(page, '.hook-slide');
    const fbDur = 3.0;
    const fb = await recordUiWithEvents(page, null, fbDur, workDir, 'sh_step12');
    let fbFinal = fb;
    if (dogIdleFile && await fileExists(dogIdleFile)) {
      try {
        const cp = path.join(workDir, 'sh_step12_dog.mp4');
        await compositeDogCircle(fb.path, dogIdleFile, fbDur, cp, dogSlot, true);
        fbFinal = { path: cp, dur: fbDur };
      } catch (e) {}
    }
    pushClip(fbFinal, false);
  }

  // ══ STEP 3 — QUESTION appears + TTS, then "OPTIONS" label, then options ══
  //
  // Timeline (per spec):
  //   t=0.0s : question-phase shown; question slides in; question TTS starts
  //            immediately and plays concurrently (we do NOT wait for it).
  //   t=0.5s : "OPTIONS" label appears below the question.
  //   t=1.0s : Option A slides in + very soft sfx.
  //   t=1.5s : Option B slides in + soft sfx.
  //   t=2.0s : Option C slides in + soft sfx.
  //   t=2.5s : Option D slides in + soft sfx.
  //   then   : short gap → "You have only 5 seconds, time starts now!" TTS.
  //
  // The question TTS length is independent of the reveal cadence — reveals are
  // purely time-based every 0.5s. The soft option sfx are mixed into the audio
  // at the exact reveal timestamps.
  console.log('[SHORT] -- Step 3: question + TTS, then staggered options + sfx');

  await setAvatarMode(page, 'dog_speaking');
  await showScreen(page, '.question-phase');

  // Freeze the countdown — it must not tick until step 4
  await page.evaluate(() => {
    document.querySelectorAll(
      '.countdown-timer,.timer-ring,.timer-bar,[class*="countdown"],[class*="timer"]'
    ).forEach(el => { el.style.animationPlayState = 'paused'; });
  });

  // Inject the "OPTIONS" label (hidden) just before the options container, and
  // hide every option with .opt-hidden. FAIL-SAFE: only .opt-hidden hides them.
  const optSetup = await page.evaluate(() => {
    const scope = document.querySelector('.screen.active') || document;
    const optionsBox = scope.querySelector('.qp-options');
    let labelAdded = false;
    if (optionsBox && !scope.querySelector('.short-options-label')) {
      const lbl = document.createElement('div');
      lbl.className = 'short-options-label lbl-hidden';
      lbl.textContent = 'OPTIONS';
      optionsBox.parentNode.insertBefore(lbl, optionsBox);
      labelAdded = true;
    }
    const opts = scope.querySelectorAll('.qp-option');
    opts.forEach(el => el.classList.add('opt-hidden'));
    return { labelAdded, optCount: opts.length };
  });
  console.log(`[SHORT] Step 3: label=${optSetup.labelAdded}, ${optSetup.optCount} options hidden`);

  // ── Reveal cadence (seconds from clip start) ──
  const LABEL_AT = 0.5;                       // "OPTIONS" label
  const OPT_GAP  = 0.5;                        // gap between reveals
  const OPT0_AT  = LABEL_AT + OPT_GAP;         // 1.0s — Option A
  const OPT1_AT  = OPT0_AT + OPT_GAP;          // 1.5s
  const OPT2_AT  = OPT1_AT + OPT_GAP;          // 2.0s
  const OPT3_AT  = OPT2_AT + OPT_GAP;          // 2.5s
  const revealEnd = OPT3_AT;                   // 2.5s — last option in

  // ── Audio base: question sfx + question TTS, padded to cover the reveal
  //    window, then a small gap, then the timer prompt. ──
  const qTts = path.join(workDir, 'sh_q_tts.mp3');
  await tts(question, voice, qTts, 3);
  const qTtsDur = await audioDur(qTts);

  // Question segment = optional sfx + question TTS (starts at t=0).
  const qSegParts = [];
  if (sfxFile) {
    qSegParts.push(sfxFile);
    const sg = path.join(workDir, 'sh_sfxgap.mp3');
    await silence(0.10, sg);
    qSegParts.push(sg);
  }
  qSegParts.push(qTts);
  const qSeg = path.join(workDir, 'sh_q_seg.mp3');
  await concatAudio(qSegParts, qSeg, workDir);
  const qSegDur = await audioDur(qSeg);

  // The reveal window must last at least until the last option lands (2.5s)
  // AND until the question TTS has finished, whichever is longer, + 0.3s.
  const revealWindow = Math.max(revealEnd, qSegDur) + 0.3;

  // Pad the question segment out to revealWindow with trailing silence so the
  // timer prompt only starts AFTER all options are on screen.
  const qPad = path.join(workDir, 'sh_q_pad.mp3');
  const padSec = Math.max(0.05, revealWindow - qSegDur);
  await silence(padSec, qPad);

  // Timer prompt
  const timerPrompt = path.join(workDir, 'sh_timerprompt.mp3');
  await tts(
    `You have only ${SHORT_COUNTDOWN} seconds and your time starts now!`,
    voice, timerPrompt, 3
  );
  const microGap = path.join(workDir, 'sh_microgap.mp3');
  await silence(0.22, microGap);

  // Base track = [qSeg | pad | microgap | timerPrompt]
  const step3Base = path.join(workDir, 'sh_step3_base.mp3');
  await concatAudio([qSeg, qPad, microGap, timerPrompt], step3Base, workDir);
  const step3Dur = Math.max(await audioDur(step3Base), 3.0);

  // Mix SOFT option sfx into the base at each reveal timestamp (volume 0.25).
  let step3Audio = step3Base;
  if (sfxFile) {
    const o0 = Math.round(OPT0_AT * 1000);
    const o1 = Math.round(OPT1_AT * 1000);
    const o2 = Math.round(OPT2_AT * 1000);
    const o3 = Math.round(OPT3_AT * 1000);
    const mixed = path.join(workDir, 'sh_step3_sfxmix.mp3');
    await ffmpeg(
      `-y -i "${step3Base}" ` +
      `-i "${sfxFile}" -i "${sfxFile}" -i "${sfxFile}" -i "${sfxFile}" ` +
      `-filter_complex ` +
      `"[1:a]volume=0.25,adelay=${o0}|${o0}[s0];` +
       `[2:a]volume=0.25,adelay=${o1}|${o1}[s1];` +
       `[3:a]volume=0.25,adelay=${o2}|${o2}[s2];` +
       `[4:a]volume=0.25,adelay=${o3}|${o3}[s3];` +
       `[0:a][s0][s1][s2][s3]amix=inputs=5:duration=first:normalize=0[a]" ` +
      `-map "[a]" -ar 44100 -ac 1 -acodec libmp3lame -t ${step3Dur} "${mixed}"`,
      'sh_step3_sfxmix'
    );
    step3Audio = mixed;
  }
  console.log(`[SHORT] Step 3 audio: ${step3Dur.toFixed(2)}s (qTTS=${qTtsDur.toFixed(2)}s, reveals end@${revealEnd}s)`);

  // Timed reveal events fired MID-RECORDING (captured as real motion)
  const revealEvents = [
    { at: LABEL_AT, fn: async (pg) => {
        await pg.evaluate(() => {
          const l = document.querySelector('.screen.active .short-options-label');
          if (l) { l.classList.remove('lbl-hidden'); l.classList.add('lbl-show'); }
        });
        console.log(`[SHORT] "OPTIONS" label shown at t=${LABEL_AT}s`);
      } },
    ...[OPT0_AT, OPT1_AT, OPT2_AT, OPT3_AT].map((at, i) => ({
      at,
      fn: async (pg) => {
        await pg.evaluate((idx) => {
          const opts = document.querySelectorAll('.screen.active .qp-option');
          if (opts[idx]) { opts[idx].classList.remove('opt-hidden'); opts[idx].classList.add('opt-reveal'); }
        }, i);
        console.log(`[SHORT] Option ${i} revealed at t=${at}s`);
      }
    })),
    // SAFETY NET: 0.3s before end, reveal anything still hidden + label
    { at: Math.max(0.1, step3Dur - 0.3), fn: async (pg) => {
        const n = await pg.evaluate(() => {
          const l = document.querySelector('.screen.active .short-options-label.lbl-hidden');
          if (l) { l.classList.remove('lbl-hidden'); l.classList.add('lbl-show'); }
          const hid = document.querySelectorAll('.screen.active .qp-option.opt-hidden');
          hid.forEach(el => { el.classList.remove('opt-hidden'); el.classList.add('opt-reveal'); });
          return hid.length;
        });
        if (n > 0) console.log(`[SHORT] Safety net revealed ${n} option(s)`);
      } },
    // Dog goes silent shortly after the question TTS finishes
    { at: Math.min(qSegDur + 0.1, step3Dur - 0.1), fn: async (pg) => { await setAvatarMode(pg, 'both_silent'); } },
  ];

  const step3Ui = await recordUiWithEvents(page, step3Audio, step3Dur, workDir, 'sh_step3_ui', revealEvents);

  // Composite host then dog onto the UI recording (two FFmpeg passes)
  let step3Final = step3Ui;
  if (hostSilentFile && await fileExists(hostSilentFile)) {
    const cp = path.join(workDir, 'sh_step3_host.mp4');
    await compositeHumanCircle(step3Ui.path, hostSilentFile, step3Dur, cp, hostSlot);
    step3Final = { path: cp, dur: step3Dur };
    console.log('[SHORT] Step 3: silent host composited');
  }
  if (dogSpeakingFile && await fileExists(dogSpeakingFile)) {
    const cp = path.join(workDir, 'sh_step3.mp4');
    // loop=true: speaking clip loops to fill the exact TTS duration
    await compositeDogCircle(step3Final.path, dogSpeakingFile, step3Dur, cp, dogSlot, true);
    step3Final = { path: cp, dur: step3Dur };
    console.log(`[SHORT] Step 3: dog speaking clip looped to ${step3Dur.toFixed(2)}s`);
  }
  pushClip(step3Final, true);

  // ══ STEP 4 — COUNTDOWN (5s), 50/50 FIRES AT t=2.5s ═════════════════
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
    [
      {
        // HINT — exactly 1s after the countdown begins
        at: SHORT_HINT_AT,
        fn: async (pg) => {
          const shown = await pg.evaluate(() => {
            const scope = document.querySelector('.screen.question-phase') || document;
            const hint  = scope.querySelector('.qp-hint');
            if (!hint) return false;
            // Don't show an empty hint box
            const txt = (hint.textContent || '').replace(/[^a-zA-Z0-9]/g, '').trim();
            if (txt.length < 3 || /^Hint$/i.test(txt)) return false;
            hint.classList.add('hint-visible');
            return true;
          });
          console.log(shown
            ? `[SHORT] hint revealed at t=${SHORT_HINT_AT}s`
            : '[SHORT] hint skipped (empty)');
        }
      },
      {
        // 50/50 — at t=3s
        at: SHORT_FIFTY_AT,
        fn: async (pg) => {
          const n = await pg.evaluate(() => {
            const scope = document.querySelector('.screen.question-phase') || document;
            const targets = scope.querySelectorAll('.qp-option.opt-elim-target');
            targets.forEach(el => { el.classList.remove('opt-elim-target'); el.classList.add('opt-eliminated'); });
            return targets.length;
          });
          console.log(`[SHORT] 50/50 eliminated ${n} options at t=${SHORT_FIFTY_AT}s`);
        }
      }
    ]
  );

  let step4Final = step4Ui;
  if (hostSilentFile && await fileExists(hostSilentFile)) {
    const cp = path.join(workDir, 'sh_step4_host.mp4');
    await compositeHumanCircle(step4Ui.path, hostSilentFile, SHORT_COUNTDOWN, cp, hostSlot);
    step4Final = { path: cp, dur: SHORT_COUNTDOWN };
    console.log('[SHORT] Step 4: silent host composited');
  }
  if (dogCdFile && await fileExists(dogCdFile)) {
    const cp = path.join(workDir, 'sh_step4.mp4');
    // loop=false: countdown clip is exactly SHORT_COUNTDOWN seconds long
    await compositeDogCircle(step4Final.path, dogCdFile, SHORT_COUNTDOWN, cp, dogSlot, false);
    step4Final = { path: cp, dur: SHORT_COUNTDOWN };
    console.log('[SHORT] Step 4: dog countdown clip composited');
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

  // The CTA screen staggers LIKE / SHARE / SUBSCRIBE / CTA4 / arrow with
  // animation-delay up to 2.8s. It only becomes visible at `splitAt`, so on a
  // short clip the later pills would never appear (you'd see only "LIKE").
  // On switch we compress every delay to fit the remaining time.
  const ctaRemaining = Math.max(0.6, step56Dur - splitAt);

  const step56Ui = await recordUiWithEvents(
    page, step56Audio, step56Dur, workDir, 'sh_step56_ui',
    [{
      at: splitAt,
      fn: async (pg) => {
        const info = await pg.evaluate((sel, remaining) => {
          document.querySelectorAll('.screen').forEach(e => e.classList.remove('active'));
          const screen = document.querySelector(sel);
          if (!screen) return { switched: false, scaled: 0 };
          screen.classList.add('active');

          // Longest original delay in the template is 2.8s (the arrow).
          const LAST_DELAY = 2.8;
          // Leave ~35% of the window after the final element lands.
          const target = remaining * 0.65;
          const scale  = Math.min(1, Math.max(0.08, target / LAST_DELAY));

          const els = screen.querySelectorAll(
            '.cta-pill, .cta-divider, .cta-combined-card, .cta-combined-arrow'
          );
          els.forEach(el => {
            const cur = parseFloat(el.style.animationDelay) || 0;
            // Restart the animation before re-timing it. Mutating
            // animation-delay on an already-running animation does not
            // retroactively reschedule it.
            el.style.animation = 'none';
            void el.offsetHeight;            // force reflow
            el.style.animation = '';
            el.style.animationDelay    = (cur * scale).toFixed(3) + 's';
            el.style.animationFillMode = 'both';
          });
          return { switched: true, scaled: els.length, scale: +scale.toFixed(3) };
        }, ctaSel, ctaRemaining);

        console.log(`[SHORT] CTA slide shown; ${info.scaled} elements re-timed ` +
                    `(scale=${info.scale}, window=${ctaRemaining.toFixed(2)}s)`);
      }
    }]
  );

  let step56Final = step56Ui;
  const step56Host = (hostCta4File && await fileExists(hostCta4File))
    ? hostCta4File
    : (hostSilentFile && await fileExists(hostSilentFile) ? hostSilentFile : null);

  if (step56Host) {
    const cp = path.join(workDir, 'sh_step56_host.mp4');
    await compositeHumanCircle(step56Ui.path, step56Host, step56Dur, cp, hostSlot);
    step56Final = { path: cp, dur: step56Dur };
    console.log(`[SHORT] Step 5+6: ${hostCta4File ? 'cta4' : 'silent'} host composited`);
  }
  if (dogCta4File_d && await fileExists(dogCta4File_d)) {
    const cp = path.join(workDir, 'sh_step56.mp4');
    // loop=false: dog cta4 clip matches the host cta4 clip duration
    await compositeDogCircle(step56Final.path, dogCta4File_d, step56Dur, cp, dogSlot, false);
    step56Final = { path: cp, dur: step56Dur };
    console.log('[SHORT] Step 5+6: dog cta4 clip composited');
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
