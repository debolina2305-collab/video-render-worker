'use strict';
const { exec }    = require('child_process');
const util        = require('util');
const execPromise = util.promisify(exec);
const fs          = require('fs').promises;
const path        = require('path');
const puppeteer   = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
console.log('SUPABASE_URL:', supabaseUrl);
console.log('SUPABASE_SERVICE_KEY:', supabaseKey ? '*** (set)' : 'NOT SET');
const cleanUrl = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;
if (!cleanUrl || !supabaseKey) { console.error('Missing Supabase credentials'); process.exit(1); }

// R2 thumbnail upload — uses existing repo secrets
const R2_ACCESS_KEY = process.env.R2_ACCESS_KEY;
const R2_SECRET_KEY = process.env.R2_SECRET_KEY;
const R2_ENDPOINT   = process.env.R2_ENDPOINT;
const R2_BUCKET     = process.env.R2_BUCKET;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL;
const R2_CONFIGURED = !!(R2_ACCESS_KEY && R2_SECRET_KEY && R2_ENDPOINT && R2_BUCKET && R2_PUBLIC_URL);
if (!R2_CONFIGURED) {
  console.warn('[R2] NOT configured — missing one of R2_ACCESS_KEY/R2_SECRET_KEY/R2_ENDPOINT/R2_BUCKET/R2_PUBLIC_URL.');
} else {
  console.log('[R2] Configured. Endpoint:', R2_ENDPOINT, '| Bucket:', R2_BUCKET);
}
const s3Client = R2_CONFIGURED ? new S3Client({
  region: 'auto', endpoint: R2_ENDPOINT,
  credentials: { accessKeyId: R2_ACCESS_KEY, secretAccessKey: R2_SECRET_KEY }
}) : null;

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const VOICE_MAP = {
  en: 'en-US-JennyNeural', hi: 'hi-IN-SwaraNeural',
  es: 'es-ES-ElviraNeural', pt: 'pt-BR-FranciscaNeural'
};
const THEMES_DIR        = path.join(__dirname, 'themes');
const CACHE_DIR         = path.join(__dirname, 'audio_cache');
const DEFAULT_THEME     = 'particle_field';
const LOGO_PATH         = path.join(__dirname, 'assets', 'jaasX-logo-saved-for-web.png');
const DEFAULT_BG_MUSIC  = 'https://pub-3578d297d3904e1d8ffedfc9dd4102f2.r2.dev/audio/background_music/The_Midnight_Audit.mp3';
const PLATFORM_URL_BASE = 'https://jaasblog.online/quiz';

// Niche-specific centerpiece icon for the thumbnail (checklist: make it lucrative, not generic)
const NICHE_ICON = {
  finance: '💰', tech: '🤖', health: '🧠', general: '🧠',
  science: '🔬', history: '🏛️', sports: '🏆', geography: '🌍',
  entertainment: '🎬', food: '🍔', nature: '🌿', space: '🚀'
};
function thumbIconFor(niche) {
  return NICHE_ICON[(niche||'general').toLowerCase()] || '❓';
}

// Confetti pieces for the answer-reveal celebration — niche-flavored pool plus
// universal celebratory objects, randomly sampled per render so every quiz's
// "falling objects" look different (money, notes, flowers, coins, stars, etc).
const CONFETTI_POOL = {
  finance:       ['💰','💵','🪙','💎','📈','💸','🤑','💳'],
  tech:          ['⚡','💡','🔧','🤖','💻','✨','🔌','🛰️'],
  health:        ['🧠','💊','❤️','🩺','🌿','✨','🧬','💪'],
  science:       ['🔬','🧪','⚛️','🌌','✨','🪐','🧬','💡'],
  history:       ['🏛️','📜','⚔️','👑','🗿','✨','🏺','🔱'],
  sports:        ['🏆','⚽','🥇','🏅','🔥','✨','🎯','💪'],
  geography:     ['🌍','🗺️','🏔️','🌋','✨','🧭','🏝️','🌊'],
  entertainment: ['🎬','🎭','🎤','🌟','✨','🎉','🎵','📽️'],
  food:          ['🍔','🍕','🍰','🍓','✨','🍩','🌮','🍎'],
  nature:        ['🌿','🌸','🍃','🌺','✨','🦋','🌻','🌳'],
  space:         ['🚀','🪐','⭐','🌌','✨','☄️','🛸','🌙'],
  general:       ['🎉','⭐','✨','🎊','💫','🏆','🌟','🎈']
};
const UNIVERSAL_CONFETTI = ['🎉','✨','⭐','💫','🎊'];

function pickConfettiSet(niche) {
  const pool = CONFETTI_POOL[(niche||'general').toLowerCase()] || CONFETTI_POOL.general;
  // Mix niche-specific pieces with a couple of universal celebratory ones for variety
  const combined = [...pool, ...UNIVERSAL_CONFETTI];
  const picked = [];
  for (let i = 0; i < 8; i++) picked.push(combined[Math.floor(Math.random() * combined.length)]);
  return picked;
}

// Marquee strip now shows the quiz TOPIC as static text with a per-word color
// shimmer (NOT scrolling) — a scroll animation always restarts from position 0
// at the start of every fresh screen-recording, which looked broken/reset on
// every segment. A looping color-shimmer per word has no "start position" to
// reset, so it looks continuous and intentional across every segment.
function buildMarqueeHtml(topic) {
  const t = (topic || '').trim() || 'TODAY\'S CHALLENGE';
  const words = t.split(/\s+/).filter(Boolean);
  return words.map((w, i) => {
    const delay = (i * 0.18).toFixed(2);
    const esc = w.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<span class="topic-word" style="animation-delay:${delay}s;">${esc}</span>`;
  }).join('');
}

// Large floating background icons — niche-specific, 3 per render, randomized
const FLOAT_ICON_POOL = {
  finance:       ['💰','📈','💎','🪙','💵','📊'],
  tech:          ['🤖','💻','⚡','🔧','🛰️','💡'],
  health:        ['🧠','❤️','🩺','💊','🧬','🌿'],
  science:       ['🔬','🧪','⚛️','🪐','🧬','✨'],
  history:       ['🏛️','📜','⚔️','👑','🗿','🏺'],
  sports:        ['🏆','⚽','🥇','🎯','🔥','💪'],
  geography:     ['🌍','🗺️','🏔️','🌋','🧭','🏝️'],
  entertainment: ['🎬','🎭','🎤','🌟','🎵','📽️'],
  food:          ['🍔','🍕','🍰','🌮','🍓','🍩'],
  nature:        ['🌿','🌸','🦋','🌻','🌳','🍃'],
  space:         ['🚀','🪐','⭐','🌌','☄️','🛸'],
  general:       ['❓','💡','⭐','🎯','🧩','✨']
};
function pickFloatIcons(niche) {
  const pool = FLOAT_ICON_POOL[(niche||'general').toLowerCase()] || FLOAT_ICON_POOL.general;
  const shuffled = [...pool].sort(()=>Math.random()-0.5);
  return shuffled.slice(0, 3);
}

// Thumbnail layout variety — checklist: 4 distinct layouts (A/B/C/D) randomly
// chosen per render, plus randomized badge/CTA text, so thumbnails stop
// looking identical across videos.
const THUMB_BADGE_TEXTS = ['CHALLENGE', 'QUIZ', 'PLAY REAL CHALLENGE', 'PLAY AND EARN ONS TOKEN'];
function pickThumbBadgeText() {
  return THUMB_BADGE_TEXTS[Math.floor(Math.random() * THUMB_BADGE_TEXTS.length)];
}
// Big, bold catchphrase banner shown on the thumbnail centerpiece — the main
// eye-catching element. Pool of punchy phrases, one randomly picked per render.
const THUMB_CATCHPHRASES = [
  'CHALLENGE', 'LEVEL UP QUIZ', 'EARN REAL TOKENS', 'BEAT YOUR FRIENDS',
  'CHALLENGE FRIENDS', 'ARE YOU SMART?', 'PROVE IT', 'TEST YOURSELF'
];
function pickThumbCatchphrase() {
  const phrase = THUMB_CATCHPHRASES[Math.floor(Math.random() * THUMB_CATCHPHRASES.length)];
  // Auto-shrink font size for longer phrases so nothing overflows the 1080px frame
  // at any rotation. Short words (≤10 chars) get the full punchy size.
  let fontSize;
  if (phrase.length <= 10)      fontSize = 92;
  else if (phrase.length <= 14) fontSize = 74;
  else if (phrase.length <= 18) fontSize = 60;
  else                          fontSize = 50;
  return { phrase, fontSize };
}
function pickThumbVariant(hasMI) {
  // Variant C only makes sense if this quiz actually has a Mission Impossible question
  const pool = hasMI ? ['a','b','c','d'] : ['a','b','d'];
  return pool[Math.floor(Math.random() * pool.length)];
}

const BG_VOL_BASE = 0.10;
const BG_VOL_DUCK = 0.035;
const DUCK_RAMP   = 0.12;

const GAP_DEFAULT     = 0.25;
const GAP_OPTIONS     = 0.30;
const GAP_ANSWER      = 0.35;
const DEFAULT_THINKING_TIME = 10;
const MAX_TTS_FALLBACK_SEC = 6; // hard cap so a MISSING audio file's fallback TTS can't run away

// NOTE: no per-segment duration caps. Every clip is recorded for the FULL
// actual length of its built audio — capping below that truncates real speech
// mid-sentence (confirmed bug). Total length is checked after render, not
// enforced mid-flow.

const TIMEOUT_FFMPEG   = 120_000;
const TIMEOUT_CURL     = 35_000;
const TIMEOUT_TTS      = 40_000;
const TIMEOUT_RECORDER = 60_000;
const TIMEOUT_JOB      = 45 * 60 * 1000;

function withTimeout(p, ms, lbl) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${ms}ms: ${lbl}`)), ms))]);
}

// ─────────────────────────────────────────────
// SUPABASE
// ─────────────────────────────────────────────
const baseHeaders = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
async function fetchSupabase(p, opts = {}) {
  const url = `${cleanUrl}/rest/v1/${p}`;
  console.log(`[DB] ${opts.method || 'GET'} ${url}`);
  const hdrs = { ...baseHeaders, ...(opts.headers || {}) };
  if (opts.method && ['POST','PATCH','PUT'].includes(opts.method)) hdrs.Prefer = 'return=representation';
  const res = await fetch(url, { ...opts, headers: hdrs });
  if (!res.ok) { const t = await res.text(); throw new Error(`HTTP ${res.status}: ${t}`); }
  const txt = await res.text();
  if (!txt || !txt.trim()) return null;
  return JSON.parse(txt);
}

// ─────────────────────────────────────────────
// AUDIO UTILS
// ─────────────────────────────────────────────
async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }
async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

function extractUrl(raw, preferKey) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (preferKey && obj[preferKey]) return obj[preferKey];
      for (const v of Object.values(obj)) if (typeof v === 'string' && v.startsWith('http')) return v;
      return null;
    } catch { return null; }
  }
  return s;
}

function encodeR2Url(url) {
  if (!url) return url;
  const si = url.indexOf('://'); if (si === -1) return url;
  const ps = url.indexOf('/', si + 3); if (ps === -1) return url;
  const origin = url.slice(0, ps);
  let out = '';
  for (let i = ps; i < url.length; i++) {
    const c = url[i];
    if (c === '%' && /^[0-9A-Fa-f]{2}$/.test(url.substr(i+1,2))) { out += url.substr(i,3); i+=2; }
    else if (/[A-Za-z0-9/?&=#.\-_~]/.test(c)) out += c;
    else out += encodeURIComponent(c);
  }
  return origin + out;
}

async function downloadAudio(url, cacheKey, preferKey) {
  const resolved = extractUrl(url, preferKey);
  if (!resolved) { console.log(`[AUDIO] ${cacheKey}: source URL is null/empty — will use fallback`); return null; }
  await ensureDir(CACHE_DIR);
  const encoded = encodeR2Url(resolved);
  const safe    = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const local   = path.join(CACHE_DIR, `${safe}.mp3`);
  if (await fileExists(local)) { console.log(`[CACHE HIT] ${safe}`); return local; }
  console.log(`[DOWNLOAD] ${safe} <- ${encoded}`);
  const rawFile = path.join(CACHE_DIR, `${safe}_raw`);
  try {
    await withTimeout(execPromise(`curl -sL --fail "${encoded}" -o "${rawFile}" --max-time 30`), TIMEOUT_CURL, `download ${safe}`);
    if (!(await fileExists(rawFile))) { console.warn(`[DOWNLOAD] ${safe}: curl produced no file`); return null; }
    const st = await fs.stat(rawFile);
    if (st.size === 0) { console.warn(`[DOWNLOAD] ${safe}: downloaded file is empty`); await fs.unlink(rawFile).catch(()=>{}); return null; }
    await withTimeout(execPromise(`ffmpeg -y -i "${rawFile}" -ar 44100 -ac 2 -acodec libmp3lame -q:a 4 "${local}"`), TIMEOUT_FFMPEG, `convert ${safe}`);
    await fs.unlink(rawFile).catch(()=>{});
    if (await fileExists(local)) { console.log(`[DOWNLOAD] ${safe}: OK (${(await audioDur(local)).toFixed(2)}s)`); return local; }
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
      execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`), 10_000, 'audioDur'
    );
    const d = parseFloat(stdout.trim()); return isNaN(d) ? 0 : d;
  } catch { return 0; }
}
async function videoDur(p) { return audioDur(p); }

async function silence(sec, out) {
  const s = Math.max(parseFloat(sec) || 0.1, 0.05);
  await withTimeout(execPromise(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${s} -q:a 9 -acodec libmp3lame "${out}"`), 15_000, `silence ${s}s`);
}

// TTS with a hard duration cap — prevents one missing audio file from
// silently ballooning a clip (root cause candidate for checklist item 27b)
async function tts(text, voice, out, fallbackSec = 1.5, rate = null) {
  const t = (text || '').trim();
  if (!t) { await silence(fallbackSec, out); return; }
  const tmp = out + '.txt';
  await fs.writeFile(tmp, t, 'utf8');
  const rateArg = rate ? ` --rate="${rate}"` : '';
  try {
    await withTimeout(execPromise(`edge-tts --voice "${voice}"${rateArg} --file "${tmp}" --write-media "${out}"`), TIMEOUT_TTS, 'tts');
    if (!(await fileExists(out)) || (await audioDur(out)) === 0) { console.warn('[TTS WARN] empty output'); await silence(fallbackSec, out); }
    else {
      const d = await audioDur(out);
      if (d > MAX_TTS_FALLBACK_SEC + 10) {
        console.warn(`[TTS WARN] unexpectedly long TTS (${d.toFixed(1)}s) for text: "${t.slice(0,60)}..."`);
      }
      // Volume sanity check: a file can have nonzero duration but be silent or
      // near-silent (corrupt/truncated TTS render) — duration alone wouldn't
      // catch that. mean_volume below -50dB is effectively inaudible.
      try {
        const { stderr } = await withTimeout(
          execPromise(`ffmpeg -i "${out}" -af volumedetect -f null -`), 10_000, 'volumeCheck'
        ).catch(e => ({ stderr: e.stderr || e.message || '' }));
        const m = String(stderr).match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
        const meanDb = m ? parseFloat(m[1]) : null;
        if (meanDb !== null && meanDb < -50) {
          console.warn(`[TTS WARN] near-silent output detected (mean_volume=${meanDb}dB) for: "${t.slice(0,60)}..." — boosting`);
          const boosted = out + '.boosted.mp3';
          await ffmpeg(`-y -i "${out}" -af "volume=10dB" -ar 44100 -acodec libmp3lame "${boosted}"`, 'ttsBoost');
          await fs.rename(boosted, out).catch(()=>{});
        }
      } catch (volErr) { console.warn(`[TTS WARN] volume check failed (non-fatal): ${volErr.message}`); }
    }
  } catch (e) { console.warn(`[TTS WARN] ${e.message}`); await silence(fallbackSec, out); }
  await fs.unlink(tmp).catch(()=>{});
}

async function ffmpeg(args, label) { await withTimeout(execPromise(`ffmpeg ${args}`), TIMEOUT_FFMPEG, label || 'ffmpeg'); }

async function concatAudio(parts, out, workDir) {
  const vp = [];
  for (const p of parts) if (p && await fileExists(p)) vp.push(p);
  if (vp.length === 0) { await silence(0.5, out); return; }
  if (vp.length === 1) { await fs.copyFile(vp[0], out); return; }
  const listP = path.join(workDir, `cat_${uuidv4()}.txt`);
  await fs.writeFile(listP, vp.map(p=>`file '${p.replace(/\\/g,'/').replace(/'/g,"'\\''")}' `).join('\n'));
  await ffmpeg(`-y -f concat -safe 0 -i "${listP}" -ar 44100 -ac 2 -acodec libmp3lame "${out}"`, 'concatAudio');
  await fs.unlink(listP).catch(()=>{});
}

async function buildAudio({ prerecorded, fallbackText, fallbackSec, voice, leadGap, workDir, name }) {
  const silP  = path.join(workDir, `${name}_gap.mp3`);
  const audioP= path.join(workDir, `${name}_src.mp3`);
  const outP  = path.join(workDir, `${name}_audio.mp3`);
  const gap   = leadGap != null ? leadGap : GAP_DEFAULT;
  await silence(gap, silP);
  if (prerecorded && await fileExists(prerecorded)) { await concatAudio([silP, prerecorded], outP, workDir); }
  else {
    const cappedFallback = Math.min(fallbackSec || 1.5, MAX_TTS_FALLBACK_SEC);
    await tts(fallbackText || '', voice, audioP, cappedFallback);
    await concatAudio([silP, audioP], outP, workDir);
  }
  const dur = await audioDur(outP);
  console.log(`[AUDIO] ${name}: ${dur.toFixed(2)}s (prerecorded=${!!prerecorded && await fileExists(prerecorded)})`);
  return { path: outP, dur };
}

// imgClip ALWAYS enforces the exact requested duration via -t — this guarantees
// no clip can silently run longer than intended (checklist item 27b root cause guard)
async function imgClip(img, audioP, dur, workDir, name) {
  const out = path.join(workDir, `${name}.mp4`);
  const safeDur = Math.max(0.3, dur);
  await ffmpeg(
    `-y -loop 1 -i "${img}" -i "${audioP}" -c:v libx264 -crf 18 -preset medium -t ${safeDur} -pix_fmt yuv420p -r 30 ` +
    `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" ` +
    `-c:a aac -b:a 128k -ar 44100 -shortest "${out}"`, `imgClip ${name}`
  );
  const actualDur = await videoDur(out);
  console.log(`[CLIP] ${name}: requested=${safeDur.toFixed(2)}s actual=${actualDur.toFixed(2)}s`);
  return { path: out, dur: actualDur };
}

// recordedClip: screen-records the CURRENT page state for exactly `dur` seconds,
// then muxes with the pre-built `audioP`. Used for EVERY segment so CSS animations
// (logo glow pulse, niche background motion) actually play instead of freezing on
// a single screenshot frame. `dur` is hard-clamped at mux time via -t.
async function recordedClip(page, audioP, dur, workDir, name) {
  const safeDur = Math.max(0.3, dur);
  const rawVideo = path.join(workDir, `${name}_raw.mp4`);
  // DIAGNOSTIC: confirm exactly what page/URL/title is about to be recorded.
  // If a render ever shows wrong content again, this log line pinpoints whether
  // `page` had drifted away from our file:// HTML at the moment of capture.
  try {
    const diagUrl = page.url();
    const diagTitle = await page.title().catch(()=>'(title fetch failed)');
    const diagPagesCount = (await page.browser().pages()).length;
    console.log(`[RECORD-DIAG] ${name}: url=${diagUrl} title="${diagTitle}" openPages=${diagPagesCount}`);
  } catch (e) {
    console.warn(`[RECORD-DIAG] ${name}: diagnostic check failed: ${e.message}`);
  }
  // Defensive: close any stray extra pages/tabs that may have appeared (popups,
  // redirects, etc.) so the recorder has zero ambiguity about which target to use.
  try {
    const allPages = await page.browser().pages();
    for (const p of allPages) {
      if (p !== page && !p.isClosed()) { console.warn(`[RECORD-DIAG] ${name}: closing stray page url=${p.url()}`); await p.close().catch(()=>{}); }
    }
  } catch (e) { console.warn(`[RECORD-DIAG] ${name}: stray page cleanup failed: ${e.message}`); }

  const recorder = new PuppeteerScreenRecorder(page, { fps:30, videoFrame:{width:1080,height:1920}, aspectRatio:'9:16', followNewTab:false });
  await recorder.start(rawVideo);
  await new Promise(r=>setTimeout(r, safeDur*1000));
  await withTimeout(recorder.stop(), TIMEOUT_RECORDER, `${name} recorder.stop()`);
  // Verify the raw recording actually has frames / non-trivial size before proceeding
  try {
    const rawStat = await fs.stat(rawVideo);
    console.log(`[RECORD-DIAG] ${name}: raw recording size=${(rawStat.size/1024).toFixed(1)}KB`);
  } catch (e) {
    console.warn(`[RECORD-DIAG] ${name}: raw recording stat failed: ${e.message}`);
  }

  const h264 = path.join(workDir, `${name}_h264.mp4`);
  await ffmpeg(`-y -i "${rawVideo}" -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -r 30 -vf "scale=1080:1920" "${h264}"`, `${name} reencode`);

  const out = path.join(workDir, `${name}.mp4`);
  // -stream_loop -1 on the (already-correct-length) recording is harmless padding
  // safety net in case the recording came in a hair short; -t hard-clamps either way.
  await ffmpeg(
    `-y -stream_loop -1 -i "${h264}" -i "${audioP}" -c:v libx264 -crf 18 -preset medium -t ${safeDur} -pix_fmt yuv420p -r 30 ` +
    `-c:a aac -b:a 128k -ar 44100 -map 0:v:0 -map 1:a:0 "${out}"`, `${name} mux`
  );
  const actualDur = await videoDur(out);
  console.log(`[CLIP] ${name}: requested=${safeDur.toFixed(2)}s actual=${actualDur.toFixed(2)}s (recorded)`);
  return { path: out, dur: actualDur };
}

// ─────────────────────────────────────────────
// BG MUSIC DUCKING
// ─────────────────────────────────────────────
async function applyBgMusic(concatMp4, totalDur, voiceRanges, bgFile, workDir) {
  if (!bgFile || !(await fileExists(bgFile))) { console.log('[BGMUSIC] skip'); return concatMp4; }
  const bgLooped=path.join(workDir,'bg_looped.mp3'), bgDucked=path.join(workDir,'bg_ducked.mp3');
  const fgAudio=path.join(workDir,'fg_audio.mp3'), mixedAudio=path.join(workDir,'mixed_audio.mp3');
  const finalMp4=path.join(workDir,'final_with_music.mp4');
  await ffmpeg(`-y -stream_loop -1 -i "${bgFile}" -t ${totalDur} -af "volume=${BG_VOL_BASE}" -ar 44100 -acodec libmp3lame "${bgLooped}"`, 'bgLoop');
  if (voiceRanges.length > 0) {
    const ratio = (BG_VOL_DUCK/BG_VOL_BASE).toFixed(4);
    const filters = voiceRanges.map(r => {
      const s=Math.max(0,r.start-DUCK_RAMP).toFixed(3), e=(r.end+DUCK_RAMP).toFixed(3);
      return `volume=enable='between(t,${s},${e})':volume=${ratio}`;
    }).join(',');
    await ffmpeg(`-y -i "${bgLooped}" -af "${filters}" -ar 44100 -acodec libmp3lame "${bgDucked}"`, 'bgDuck');
  } else { await fs.copyFile(bgLooped, bgDucked); }
  await ffmpeg(`-y -i "${concatMp4}" -vn -ar 44100 -acodec libmp3lame "${fgAudio}"`, 'extractFg');
  await ffmpeg(`-y -i "${fgAudio}" -i "${bgDucked}" -filter_complex "[0:a]volume=1.0[fg];[1:a]volume=1.0[bg];[fg][bg]amix=inputs=2:duration=first:dropout_transition=0[a]" -map "[a]" -ar 44100 -acodec libmp3lame "${mixedAudio}"`, 'mixAudio');
  // -t totalDur is a hard duration clamp — final video CANNOT exceed the sum of intended clips
  await ffmpeg(`-y -i "${concatMp4}" -i "${mixedAudio}" -c:v copy -map 0:v:0 -map 1:a:0 -c:a aac -b:a 192k -t ${totalDur} -movflags +faststart "${finalMp4}"`, 'remux');
  const finalDur = await videoDur(finalMp4);
  console.log(`[BGMUSIC] Final video duration after remux: ${finalDur.toFixed(2)}s (target was ${totalDur.toFixed(2)}s)`);
  return finalMp4;
}

// ─────────────────────────────────────────────
// THEME + quiz_background_css
// ─────────────────────────────────────────────
async function resolveTheme(quiz) {
  const base    = await fs.readFile(path.join(THEMES_DIR,'_base.css'),'utf8');
  const themeId = quiz.visual_theme_id || DEFAULT_THEME;
  let themeFile = path.join(THEMES_DIR,`${themeId}.css`);
  if (!(await fileExists(themeFile))) { console.warn(`[THEME] '${themeId}' not found`); themeFile = path.join(THEMES_DIR,`${DEFAULT_THEME}.css`); }
  let css = base + '\n' + (await fs.readFile(themeFile,'utf8'));
  const a1=quiz.theme_accent_primary||'#00e0ff', a2=quiz.theme_accent_secondary||'#7b2ff7', a3=quiz.theme_accent_tertiary||'#ff2ec4';
  css = css.split('{{accent_primary}}').join(a1).split('{{accent_secondary}}').join(a2).split('{{accent_tertiary}}').join(a3);
  if (quiz.quiz_background_css?.trim()) {
    console.log('[THEME] Applying quiz_background_css (per-quiz dynamic background)');
    css += '\n/* === QUIZ-SPECIFIC BACKGROUND === */\n' + quiz.quiz_background_css;
  } else {
    console.log('[THEME] No quiz_background_css set — using theme default');
  }
  return { themeCss: css, decoHtml: buildDecoHtml(themeId) };
}
function buildDecoHtml(id) {
  if (id === 'particle_field') {
    return '<div class="theme-deco">' + Array.from({length:18},(_,i)=>{
      const l=(i*5+2)%100,sz=6+(i%5)*3,d=8+(i%6)*2,dy=(i*0.7)%10;
      return `<div class="particle" style="left:${l}%;bottom:-20px;width:${sz}px;height:${sz}px;animation-duration:${d}s;animation-delay:${dy}s;"></div>`;
    }).join('') + '</div>';
  }
  return '';
}

async function getLogoDataUri() {
  try { const buf = await fs.readFile(LOGO_PATH); return `data:image/png;base64,${buf.toString('base64')}`; }
  catch (e) {
    console.warn(`[LOGO] ${e.message}`);
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }
}

// ─────────────────────────────────────────────
// R2 THUMBNAIL UPLOAD
// ─────────────────────────────────────────────
async function uploadThumbnailToR2(localPngPath, quizId) {
  if (!R2_CONFIGURED) { console.log('[R2] Not configured, skipping thumbnail upload.'); return null; }
  try {
    const buf = await fs.readFile(localPngPath);
    const key = `thumbnails/${quizId}.png`;
    await withTimeout(
      s3Client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buf, ContentType: 'image/png', CacheControl: 'public, max-age=31536000' })),
      30_000, 'R2 thumbnail upload'
    );
    const publicUrl = `${R2_PUBLIC_URL.replace(/\/$/,'')}/${key}`;
    console.log(`[R2] Thumbnail uploaded: ${publicUrl}`);
    return publicUrl;
  } catch (e) {
    console.warn(`[R2] Thumbnail upload failed: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// JOB PROCESSING
// ─────────────────────────────────────────────
async function processJobs() {
  console.log('[WORKER] Checking...');
  const stuckCutoff = new Date(Date.now()-30*60*1000).toISOString();
  const stuckRows = await fetchSupabase(`quiz?video_status=eq.processing&is_active=eq.true&updated_at=lt.${stuckCutoff}&select=id&limit=5`).catch(()=>null);
  if (stuckRows?.length) {
    console.log(`[WORKER] Resetting ${stuckRows.length} stuck rows`);
    for (const r of stuckRows) await fetchSupabase(`quiz?id=eq.${r.id}`,{method:'PATCH',body:JSON.stringify({video_status:'pending',updated_at:new Date().toISOString()})}).catch(()=>{});
  }

  const rows = await fetchSupabase('quiz?video_status=eq.pending&is_active=eq.true&quiz_enriched=eq.true&select=*&order=created_at.asc&limit=1');
  if (!rows?.length) { console.log('[WORKER] No pending quizzes.'); return; }

  const quiz = rows[0];
  console.log(`[WORKER] Processing: ${quiz.id} — ${quiz.topic}`);
  await fetchSupabase(`quiz?id=eq.${quiz.id}`,{method:'PATCH',body:JSON.stringify({video_status:'processing',updated_at:new Date().toISOString()})});

  const workDir = `/tmp/video_${uuidv4()}`;
  await ensureDir(workDir);

  try {
    const { videoPath, thumbnailUrl } = await withTimeout(buildVideo(quiz,workDir), TIMEOUT_JOB, `buildVideo ${quiz.id}`);
    const stats  = await fs.stat(videoPath);
    const sizeMb = parseFloat((stats.size/(1024*1024)).toFixed(2));
    const dur    = await videoDur(videoPath);
    console.log(`[WORKER] Done. ${dur.toFixed(1)}s, ${sizeMb}MB, thumbnail=${thumbnailUrl||'none'}`);

    const artifactPath = `/tmp/${quiz.id}_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);
    await fs.writeFile('/tmp/artifact_ready', artifactPath);

    const patchBody = { video_status:'rendered', render_duration_sec:Math.round(dur), file_size_mb:sizeMb, updated_at:new Date().toISOString() };
    if (thumbnailUrl) patchBody.thumbnail_url = thumbnailUrl;
    await fetchSupabase(`quiz?id=eq.${quiz.id}`,{method:'PATCH',body:JSON.stringify(patchBody)});

    await fs.rm(workDir,{recursive:true,force:true});
    console.log(`[WORKER] Artifact: ${artifactPath}`);
  } catch (err) {
    console.error('[WORKER] FAILED:', err.message);
    await fetchSupabase(`quiz?id=eq.${quiz.id}`,{method:'PATCH',body:JSON.stringify({
      video_status:'error', generation_error:String(err.message||err).slice(0,800), updated_at:new Date().toISOString()
    })});
    await fs.rm(workDir,{recursive:true,force:true}).catch(()=>{});
    throw err;
  }
}

// ─────────────────────────────────────────────
// MAIN VIDEO BUILDER
// ─────────────────────────────────────────────
async function buildVideo(quiz, workDir) {
  const lang  = quiz.lang_code || 'en';
  const voice = VOICE_MAP[lang] || VOICE_MAP.en;
  const niche = quiz.niche || 'general';

  const question    = quiz.question_1       || '';
  const options     = quiz.options_1        || [];
  const correct     = quiz.correct_answer_1 || '';
  const hint        = quiz.hint_1           || '';
  const keep5050    = quiz.keep_5050_1      || [];

  const miQuestion = quiz.mission_impossible_question || null;
  const miOptions  = quiz.mission_options_1           || [];
  const hasMI      = !!(miQuestion);

  const QTIME    = quiz.thinking_time_sec || DEFAULT_THINKING_TIME; // no artificial ceiling — DB controls this
  // FIX (checklist item 10): 50/50 fires at 2/3 of thinking time, not 1/2
  const HINT_AT  = QTIME / 4;
  const FIFTY_AT = QTIME * 2 / 3;

  const allIdx  = [0,1,2,3];
  const keepIdx = keep5050.map(v=>(typeof v==='string'?parseInt(v):v));
  const elimIdx = allIdx.filter(i=>!keepIdx.includes(i));
  const optClass= i=>elimIdx.includes(i)?'eliminate':'';
  const revClass= i=>options[i]===correct?'correct':'wrong';

  // FIX (checklist item 26 diagnosis): airtight non-empty check, treat whitespace as falsy
  const cta1Desc = (quiz.cta1_description_text || '').trim();
  const affUrl   = (quiz.affiliate_url || '').trim();
  const hasCta1  = !!(cta1Desc || affUrl);
  console.log(`[CTA] hasCta1=${hasCta1} (cta1_description_text="${cta1Desc.slice(0,30)}" affiliate_url="${affUrl.slice(0,30)}")`);

  console.log('[LOGO] Loading...');
  const logoDataUri = await getLogoDataUri();

  console.log('[AUDIO] Downloading...');
  const [
    hookFile, questionIntroFile, optionsIntroFile,
    timeupFile, cta1AudioFile, cta2AudioFile,
    missionIntroFile, cta3AudioFile,
    sfxFile, countdownFile, bgFile, correctSfxFile, sfxMissionFile
  ] = await Promise.all([
    downloadAudio(quiz.hook_audio_url,               `hook_${quiz.id}`),
    downloadAudio(quiz.question_intro_audio_url,     `qintro_${quiz.id}`),
    downloadAudio(quiz.options_intro_audio_url,      `ointro_${quiz.id}`),
    downloadAudio(quiz.timeup_audio_url,             `timeup_${quiz.id}`),
    downloadAudio(quiz.cta1_audio_url,               `cta1_${quiz.id}`),
    downloadAudio(quiz.cta2_audio_url,               `cta2_${quiz.id}`),
    downloadAudio(quiz.mission_intro_audio_url,      `missintro_${quiz.id}`),
    downloadAudio(quiz.cta3_audio_url,               `cta3_${quiz.id}`),
    downloadAudio(quiz.sfx_audio_url,                `sfx_${quiz.id}`,'question_appear'),
    downloadAudio(quiz.countdown_music,              `countdown_${quiz.id}`),
    downloadAudio(quiz.background_music||DEFAULT_BG_MUSIC,`bgmusic_${quiz.id}`),
    downloadAudio(quiz.correct_answer_sfx_audio_url, `correctsfx_${quiz.id}`),
    downloadAudio(quiz.sfx_mission_impossible,       `sfxmission_${quiz.id}`)
  ]);
  console.log(`[CTA] cta2AudioFile=${cta2AudioFile ? 'OK' : 'NULL (will use TTS fallback)'} cta1AudioFile=${cta1AudioFile ? 'OK' : 'NULL'}`);

  const { themeCss, decoHtml } = await resolveTheme(quiz);
  const confettiSet = pickConfettiSet(niche);
  const thumbCatch = pickThumbCatchphrase();
  const marqueeHtml = buildMarqueeHtml(quiz.topic);
  const floatIcons  = pickFloatIcons(niche);
  console.log(`[CONFETTI] niche=${niche} set=${confettiSet.join(' ')}`);
  console.log(`[MARQUEE] topic="${(quiz.topic||'').slice(0,50)}" floatIcons=${floatIcons.join(' ')}`);

  let html = await fs.readFile(path.join(__dirname,'quiz_template.html'),'utf8');
  const R = {
    '{{theme_css}}':themeCss, '{{theme_deco_html}}':decoHtml, '{{LOGO_DATA_URI}}':logoDataUri,
    '{{hook_phrase}}':quiz.hook_phrase||'Stop scrolling! Can you beat this?',
    '{{question}}':question,
    '{{options[0]}}':options[0]||'', '{{options[1]}}':options[1]||'',
    '{{options[2]}}':options[2]||'', '{{options[3]}}':options[3]||'',
    '{{opt0_class}}':optClass(0), '{{opt1_class}}':optClass(1),
    '{{opt2_class}}':optClass(2), '{{opt3_class}}':optClass(3),
    '{{rev0_class}}':revClass(0), '{{rev1_class}}':revClass(1),
    '{{rev2_class}}':revClass(2), '{{rev3_class}}':revClass(3),
    '{{hint}}':hint, '{{correct_answer}}':correct,
    '{{cta1_description_text}}':cta1Desc||quiz.affiliate_text||'',
    '{{cta2_text}}':quiz.cta2_text||'Play real quiz and earn ONS tokens!',
    '{{cta3_text}}':quiz.cta3_text||'Like, Share & Challenge a friend! Subscribe!',
    '{{niche}}':niche,
    '{{thumb_icon}}':thumbIconFor(niche),
    '{{thumb_badge_text}}':pickThumbBadgeText(),
    '{{thumb_catchphrase}}':thumbCatch.phrase,
    '{{thumb_catchphrase_size}}':thumbCatch.fontSize,
    '{{thumb_mission_text}}':miQuestion||question,
    '{{confetti_0}}':confettiSet[0], '{{confetti_1}}':confettiSet[1],
    '{{confetti_2}}':confettiSet[2], '{{confetti_3}}':confettiSet[3],
    '{{confetti_4}}':confettiSet[4], '{{confetti_5}}':confettiSet[5],
    '{{confetti_6}}':confettiSet[6], '{{confetti_7}}':confettiSet[7],
    '{{marquee_text}}':marqueeHtml,
    '{{float_icon_0}}':floatIcons[0], '{{float_icon_1}}':floatIcons[1], '{{float_icon_2}}':floatIcons[2],
    '{{platform_url}}': `${PLATFORM_URL_BASE}/${niche}`,
    '{{mission_intro_text}}':quiz.mission_intro_text||'Are you smart enough?',
    '{{mission_question}}':miQuestion||'',
    '{{mi_option_0}}':miOptions[0]||'', '{{mi_option_1}}':miOptions[1]||'',
    '{{mi_option_2}}':miOptions[2]||'', '{{mi_option_3}}':miOptions[3]||'',
    '{{qtime}}':QTIME, '{{hint_time}}':HINT_AT, '{{fiftyfifty_time}}':FIFTY_AT
  };
  for (const [k,v] of Object.entries(R)) html=html.split(k).join(String(v??''));
  const htmlPath = path.join(workDir,'index.html');
  await fs.writeFile(htmlPath,html);

  const browser = await puppeteer.launch({
    headless:'new',
    args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
          '--disable-gpu','--disable-web-security','--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  await page.setViewport({width:1080,height:1920});
  await page.goto(`file://${htmlPath}`,{waitUntil:'domcontentloaded'});
  await new Promise(r=>setTimeout(r,600));

  const showOnly = async sel => {
    await page.evaluate(s=>{
      document.querySelectorAll('.screen').forEach(e=>e.classList.remove('active'));
      const el=document.querySelector(s); if(el) el.classList.add('active');
    },sel);
    await new Promise(r=>setTimeout(r,150));
  };
  const shot = async name => { const p=path.join(workDir,`${name}.png`); await page.screenshot({path:p}); return p; };

  const clips=[], voiceRanges=[];
  let cursor=0;
  function pushClip(clip, isVoice=true) {
    if(isVoice) voiceRanges.push({start:cursor,end:cursor+clip.dur});
    cursor+=clip.dur; clips.push(clip);
  }

  // ══ DEDICATED THUMBNAIL — captured first (static is fine, it's a still image by design) ══
  await showOnly('.thumb-screen');
  const thumbVariant = pickThumbVariant(hasMI);
  await page.evaluate((variant)=>{
    document.querySelectorAll('.thumb-variant').forEach(el=>el.classList.remove('active'));
    const el = document.querySelector(`.thumb-variant-${variant}`);
    if (el) el.classList.add('active');
  }, thumbVariant);
  console.log(`[THUMBNAIL] variant=${thumbVariant}`);
  await new Promise(r=>setTimeout(r,500));
  const thumbImg = await shot('thumbnail_master');
  let thumbnailUrl = null;
  if (R2_CONFIGURED) thumbnailUrl = await uploadThumbnailToR2(thumbImg, quiz.id);

  // ══ STEP 1: HOOK — screen-recorded (logoPop + hook-text animations + glow) ══
  await page.goto(`file://${htmlPath}`,{waitUntil:'domcontentloaded'});
  await new Promise(r=>setTimeout(r,300));
  await showOnly('.hook-slide');
  await page.evaluate(()=>{
    const lw = document.querySelector('.hook-slide .logo-wrap');
    const ht = document.querySelector('.hook-slide .hook-text');
    [lw,ht].forEach(el=>{ if(el){ el.style.animation='none'; el.offsetHeight; el.style.animation=''; }});
  });
  const hookAudio = await buildAudio({
    prerecorded:hookFile, fallbackText:quiz.hook_phrase||'Stop scrolling!',
    fallbackSec:2.5, voice, leadGap:0.1, workDir, name:'hook'
  });
  // No cap — record for the full actual hook audio length
  pushClip(await recordedClip(page, hookAudio.path, Math.max(hookAudio.dur, 1.5), workDir, 'clip_hook'));

  // ══ STEP 2 (white intro-flash removed per feedback — straight to question_intro) ══

  // ══ STEP 3a: question_intro_audio_url plays, question HIDDEN ══
  await showOnly('.question-waiting-slide');
  await new Promise(r=>setTimeout(r,100));
  const qIntroAudio = await buildAudio({
    prerecorded: questionIntroFile, fallbackText: '', fallbackSec: 0.8,
    voice, leadGap: 0.15, workDir, name: 'qintro'
  });
  pushClip(await recordedClip(page, qIntroAudio.path, qIntroAudio.dur, workDir, 'clip_qwait'), false);

  // ══ STEP 3b: question_1 REVEALED + sfx + TTS — recorded for FULL audio, no truncation ══
  await showOnly('.question-appear-slide');
  await new Promise(r=>setTimeout(r,100));
  const step3bParts=[];
  if(sfxFile){ const g=path.join(workDir,'sfx_gap.mp3'); await silence(0.1,g); step3bParts.push(sfxFile,g); }
  const qTts=path.join(workDir,'q_tts.mp3'); await tts(question,voice,qTts,3); step3bParts.push(qTts);
  const step3bCombined=path.join(workDir,'step3b.mp3');
  await concatAudio(step3bParts,step3bCombined,workDir);
  const qRevealDur = Math.max(await audioDur(step3bCombined), 1.5);
  pushClip(await recordedClip(page, step3bCombined, qRevealDur, workDir, 'clip_q_reveal'));

  // ══ STEP 4a: options_intro_audio_url plays, options HIDDEN ══
  await showOnly('.options-waiting-slide');
  await new Promise(r=>setTimeout(r,100));
  const oIntroAudio = await buildAudio({
    prerecorded: optionsIntroFile, fallbackText: 'And your options are', fallbackSec: 1.5,
    voice, leadGap: GAP_OPTIONS, workDir, name: 'ointro'
  });
  pushClip(await recordedClip(page, oIntroAudio.path, oIntroAudio.dur, workDir, 'clip_owait'), false);

  // ══ STEP 4b: options_1 REVEALED — NO TTS per option (was unintelligible at 2x,
  // and unacceptably long at 1x). Options are shown silently on screen for 4s
  // (readable on their own), then ONE TTS line: "You have only Ns... time starts now". ══
  await showOnly('.question-static');
  await new Promise(r=>setTimeout(r,100));
  const s4bp=[];
  if(sfxFile){ const sg=path.join(workDir,'sfxgap2.mp3'); await silence(0.1,sg); s4bp.push(sfxFile,sg); }
  const optionsSilence=path.join(workDir,'options_silence.mp3'); await silence(2.0,optionsSilence); s4bp.push(optionsSilence);
  const snt=path.join(workDir,'start_now.mp3');
  await tts(`You have only ${QTIME} seconds to crack the challenge — and your time starts now!`,voice,snt,3);
  s4bp.push(snt);
  const step4bCombined=path.join(workDir,'step4b.mp3');
  await concatAudio(s4bp,step4bCombined,workDir);
  const oRevealDur = Math.max(await audioDur(step4bCombined), 2);
  pushClip(await recordedClip(page, step4bCombined, oRevealDur, workDir, 'clip_options_reveal'));

  // ══ STEP 6-8: COUNTDOWN — screen-recorded, 50/50 at 2/3 of QTIME.
  // QTIME comes straight from the DB (thinking_time_sec), no ceiling applied. ══
  await showOnly('.question-phase');
  await page.evaluate(()=>{ document.querySelector('.question-phase')?.offsetHeight; });
  await new Promise(r=>setTimeout(r,100));

  const cdBase=path.join(workDir,'cd_base.mp3');
  if(countdownFile){ await ffmpeg(`-y -stream_loop -1 -i "${countdownFile}" -t ${QTIME} -af "volume=0.75" -ar 44100 -acodec libmp3lame "${cdBase}"`, 'cdLoop'); }
  else { await silence(QTIME,cdBase); }
  let cdFinal=cdBase;
  if(sfxFile){
    const stingMixed=path.join(workDir,'cd_mixed.mp3');
    const hMs=Math.round(HINT_AT*1000), fMs=Math.round(FIFTY_AT*1000);
    await ffmpeg(`-y -i "${cdBase}" -i "${sfxFile}" -i "${sfxFile}" -filter_complex "[1:a]adelay=${hMs}|${hMs}[s0];[2:a]adelay=${fMs}|${fMs}[s1];[0:a][s0][s1]amix=inputs=3:duration=first[a]" -map "[a]" -t ${QTIME} -ar 44100 -acodec libmp3lame "${stingMixed}"`, 'cdStings');
    cdFinal=stingMixed;
  }
  pushClip(await recordedClip(page, cdFinal, QTIME, workDir, 'clip_countdown'));

  // ══ STEP 9: Timeup — audio only, no text changes ══
  await showOnly('.pre-reveal-slide');
  await new Promise(r=>setTimeout(r,100));
  const timeupAudio = await buildAudio({
    prerecorded:timeupFile, fallbackText:quiz.timeup_text||"Time's up!",
    fallbackSec:2, voice, leadGap:GAP_DEFAULT, workDir, name:'timeup'
  });
  pushClip(await recordedClip(page, timeupAudio.path, timeupAudio.dur, workDir, 'clip_timeup'));

  // ══ STEP 10: Answer reveal ══
  await showOnly('.answer-slide');
  await new Promise(r=>setTimeout(r,100));
  const s10p=[];
  const silRev=path.join(workDir,'sil_reveal.mp3'); await silence(GAP_ANSWER,silRev); s10p.push(silRev);
  if(correctSfxFile){ s10p.push(correctSfxFile); const sg3=path.join(workDir,'sfxgap3.mp3'); await silence(0.15,sg3); s10p.push(sg3); }
  const correctTts=path.join(workDir,'correct_tts.mp3'); await tts(correct,voice,correctTts,1.5); s10p.push(correctTts);
  const step10Combined=path.join(workDir,'step10.mp3');
  await concatAudio(s10p,step10Combined,workDir);
  const answerDur = Math.max(await audioDur(step10Combined), 1.5);
  pushClip(await recordedClip(page, step10Combined, answerDur, workDir, 'clip_answer'));

  // ══ MISSION IMPOSSIBLE — comes BEFORE the final CTA. Skip if mission_impossible_question
  // is null. ONE combined screen: title+tagline+question+4 options appear TOGETHER. ══
  if (hasMI) {
    await showOnly('.mission-final-slide');
    await page.evaluate(()=>{
      const c=document.getElementById('mi-cta3');
      if(c) c.classList.remove('show-cta3');
    });
    await new Promise(r=>setTimeout(r,150));

    const miParts=[];
    if(sfxMissionFile){ miParts.push(sfxMissionFile); const g=path.join(workDir,'sfx_mi_gap.mp3'); await silence(0.25,g); miParts.push(g); }
    if(missionIntroFile){ miParts.push(missionIntroFile); }
    else { const mt=path.join(workDir,'mi_tts.mp3'); await tts(quiz.mission_intro_text||'Mission impossible! Are you smart enough?',voice,mt,2); miParts.push(mt); }
    const miAudioRaw=path.join(workDir,'mi_audio_raw.mp3');
    await concatAudio(miParts,miAudioRaw,workDir);
    let miAudioDur = await audioDur(miAudioRaw);
    let miAudio = miAudioRaw;
    if (miAudioDur < 2.5) {
      const pad=path.join(workDir,'mi_pad.mp3'); await silence(2.5 - miAudioDur, pad);
      miAudio=path.join(workDir,'mi_audio.mp3');
      await concatAudio([miAudioRaw,pad],miAudio,workDir);
      miAudioDur = 2.5;
    }
    pushClip(await recordedClip(page, miAudio, miAudioDur, workDir, 'clip_mi'));

    // cta3 fades in + cta3 audio
    await page.evaluate(()=>{
      const c=document.getElementById('mi-cta3');
      if(c) c.classList.add('show-cta3');
    });
    await new Promise(r=>setTimeout(r,150));
    console.log(`[CTA3-DIAG] cta3AudioFile=${cta3AudioFile||'NULL'} cta3_text="${(quiz.cta3_text||'').slice(0,50)}"`);
    const cta3Audio = await buildAudio({
      prerecorded:cta3AudioFile, fallbackText:quiz.cta3_text||'Like, share and challenge a friend! Subscribe!',
      fallbackSec:4, voice, leadGap:0.15, workDir, name:'cta3'
    });
    console.log(`[CTA3-DIAG] built audio path=${cta3Audio.path} dur=${cta3Audio.dur.toFixed(2)}s`);
    pushClip(await recordedClip(page, cta3Audio.path, cta3Audio.dur, workDir, 'clip_cta3'));
  }

  // ══ FINAL CTA — comes LAST, after MI. ONE cta only: CTA1 if affiliate/
  // cta1_description_text exists, else CTA2. ══
  await showOnly(hasCta1?'.cta1-slide':'.cta2-slide');
  await new Promise(r=>setTimeout(r,150));
  console.log(`[FINALCTA-DIAG] hasCta1=${hasCta1} cta1AudioFile=${cta1AudioFile||'NULL'} cta2AudioFile=${cta2AudioFile||'NULL'} cta2_text="${(quiz.cta2_text||'').slice(0,50)}"`);
  const ctaAudio = await buildAudio({
    prerecorded:hasCta1?cta1AudioFile:cta2AudioFile,
    fallbackText:hasCta1
      ?(cta1Desc||quiz.affiliate_text||'Check the exclusive link in the description below!')
      :(quiz.cta2_text||'Play the real quiz and earn O.N.S tokens! Tap the link now!'),
    fallbackSec:3, voice, leadGap:GAP_DEFAULT, workDir, name:hasCta1?'cta1':'cta2'
  });
  console.log(`[FINALCTA-DIAG] built audio path=${ctaAudio.path} dur=${ctaAudio.dur.toFixed(2)}s`);
  pushClip(await recordedClip(page, ctaAudio.path, ctaAudio.dur, workDir, 'clip_cta'));

  await browser.close();

  // ══ FINAL ASSEMBLY ══
  console.log(`[VIDEO] Assembling ${clips.length} clips. Per-clip durations:`);
  let runningTotal = 0;
  for (const c of clips) { runningTotal += c.dur; console.log(`  ${path.basename(c.path)}: ${c.dur.toFixed(2)}s (cumulative ${runningTotal.toFixed(2)}s)`); }

  const concatTxt=path.join(workDir,'concat.txt');
  await fs.writeFile(concatTxt,clips.map(c=>`file '${c.path.replace(/'/g,"'\\''")}' `).join('\n'));
  const concatenated=path.join(workDir,'concatenated.mp4');
  await ffmpeg(`-y -f concat -safe 0 -i "${concatTxt}" -c:v libx264 -crf 18 -preset medium -pix_fmt yuv420p -r 30 -c:a aac -b:a 128k -ar 44100 -movflags +faststart "${concatenated}"`, 'finalConcat');
  const measuredTotal=await videoDur(concatenated);
  console.log(`[VIDEO] Concatenated: measured=${measuredTotal.toFixed(2)}s vs sum-of-clips=${runningTotal.toFixed(2)}s`);
  if (measuredTotal < runningTotal - 0.1) {
    console.warn(`[VIDEO] WARNING: measured duration is ${(runningTotal-measuredTotal).toFixed(2)}s SHORTER than the sum of clip durations — using runningTotal to avoid truncating the tail (this is what was cutting off CTA2/CTA3 audio).`);
  }
  // Use the authoritative sum of actual clip durations (runningTotal), not the
  // re-measured concatenated duration, which can under-report slightly due to
  // ffmpeg concat/keyframe rounding. Using a too-short duration here silently
  // truncated the LAST 1-2 clips in the video (CTA2/CTA3) in the final remux
  // clamp below — this was the real cause of "CTA2/CTA3 audio not playing"
  // even though the source audio files were confirmed valid.
  const total = Math.max(measuredTotal, runningTotal) + 0.4; // small safety margin
  const finalVideoPath = await applyBgMusic(concatenated,total,voiceRanges,bgFile,workDir);
  return { videoPath: finalVideoPath, thumbnailUrl };
}

processJobs()
  .then(()=>{ console.log('[WORKER] Done.'); process.exit(0); })
  .catch(err=>{ console.error('[WORKER] Fatal:',err); process.exit(1); });
