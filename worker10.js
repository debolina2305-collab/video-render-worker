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
const CACHE_DIR         = '/tmp/audio_cache';  // persistent within one GH Actions run, avoids repo dir issues
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

function pickConfettiSet(niche, topic) {
  const t = (topic || '').toLowerCase();
  let basePool = null;
  for (const entry of TOPIC_KEYWORD_ICONS) {
    if (entry.kw.some(k => t.includes(k))) { basePool = entry.icons; break; }
  }
  const pool = basePool || CONFETTI_POOL[(niche||'general').toLowerCase()] || CONFETTI_POOL.general;
  // Mix topic/niche-specific pieces with a couple of universal celebratory ones for variety
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
// Topic-keyword overrides — when the quiz topic mentions a specific
// recognizable sub-theme, use a MORE SPECIFIC icon set than the broad niche
// pool (e.g. a "cryptocurrency" finance quiz gets crypto icons, not generic
// money icons; a "space" science quiz gets rockets, not generic science).
// Checked in order; first match wins. Falls back to FLOAT_ICON_POOL[niche]
// if nothing matches.
const TOPIC_KEYWORD_ICONS = [
  { kw: ['crypto','bitcoin','ethereum','blockchain','nft','token'],          icons: ['₿','🪙','💎','⛓️','📊','🔐'] },
  { kw: ['stock market','stocks','shares','nasdaq','wall street','ipo'],     icons: ['📈','📊','💹','🏦','💼','📉'] },
  { kw: ['real estate','housing','mortgage','property'],                    icons: ['🏠','🏘️','🔑','📐','💰','🏗️'] },
  { kw: ['inflation','interest rate','federal reserve','economy'],          icons: ['💵','📉','🏦','⚖️','📊','💸'] },
  { kw: ['ai','artificial intelligence','machine learning','chatgpt','llm'],icons: ['🤖','🧠','⚡','💡','🔮','🛰️'] },
  { kw: ['space','nasa','rocket','astronaut','planet','mars'],              icons: ['🚀','🪐','🛸','⭐','🌌','👨‍🚀'] },
  { kw: ['cybersecurity','hacking','data breach','privacy'],                icons: ['🔒','🛡️','💻','🔓','⚠️','🕵️'] },
  { kw: ['heart','cardiac','cardiovascular'],                               icons: ['❤️','🫀','💓','🩺','💊','📈'] },
  { kw: ['brain','mental health','neuroscience','memory'],                  icons: ['🧠','💭','✨','🔬','💡','🧬'] },
  { kw: ['vaccine','disease','virus','pandemic','outbreak'],                icons: ['💉','🦠','🩺','🧪','😷','⚕️'] },
  { kw: ['olympics','world cup','championship','tournament'],               icons: ['🏆','🥇','⚽','🏅','🎯','🔥'] },
  { kw: ['movie','film','box office','hollywood','oscar'],                  icons: ['🎬','🍿','🎭','⭐','📽️','🏆'] },
  { kw: ['music','album','concert','grammy','song'],                        icons: ['🎵','🎤','🎸','🎧','⭐','🔥'] },
  { kw: ['climate','global warming','carbon','emissions'],                  icons: ['🌍','🌡️','♻️','🌊','🔥','🌳'] },
];

function pickFloatIcons(niche, topic) {
  const t = (topic || '').toLowerCase();
  for (const entry of TOPIC_KEYWORD_ICONS) {
    if (entry.kw.some(k => t.includes(k))) {
      const shuffled = [...entry.icons].sort(()=>Math.random()-0.5);
      return shuffled.slice(0, 5);
    }
  }
  const pool = FLOAT_ICON_POOL[(niche||'general').toLowerCase()] || FLOAT_ICON_POOL.general;
  const shuffled = [...pool].sort(()=>Math.random()-0.5);
  return shuffled.slice(0, 5);
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
// youtube_title replaces generic catchphrases as the thumbnail headline.
// Font auto-scales so longer titles fit the 1080px thumbnail frame.
function thumbTitleStyle(title) {
  const t = (title || '').trim();
  let fontSize;
  if (t.length <= 30)      fontSize = 52;
  else if (t.length <= 45) fontSize = 42;
  else if (t.length <= 60) fontSize = 34;
  else                     fontSize = 28;
  return { phrase: t, fontSize };
}
// Fallback for legacy rows without youtube_title
const THUMB_CATCHPHRASES = [
  'CAN YOU ANSWER?', 'LEVEL UP QUIZ', 'CHALLENGE YOURSELF',
  'ARE YOU SMART?', 'PROVE IT', 'TEST YOURSELF'
];
function pickThumbCatchphrase() {
  const phrase = THUMB_CATCHPHRASES[Math.floor(Math.random() * THUMB_CATCHPHRASES.length)];
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

// Background music levels. Tuned so music is clearly audible but never
// drowns out narration. base = volume when no voice; duck = volume during voice.
// Previous 0.10/0.035 were far too quiet (≈-20/-29dB) → music was inaudible.
const BG_VOL_BASE = 0.28;   // ≈ -11dB — clearly present during non-voice moments
const BG_VOL_DUCK = 0.12;   // ≈ -18dB — soft bed under narration, still audible
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
    if (await fileExists(local)) {
      console.log(`[DOWNLOAD] ${safe}: OK (${(await audioDur(local)).toFixed(2)}s)`);
      await checkAndBoostVolume(local, `download:${safe}`);
      return local;
    }
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

// Volume sanity check + auto-boost: a file can have nonzero duration but be
// silent or near-silent (corrupt/truncated render, quiet source recording,
// odd encoding) — duration alone wouldn't catch that. mean_volume below
// -50dB is effectively inaudible. Used for BOTH TTS-generated audio AND
// downloaded prerecorded audio (cta2/cta3 audio reports were traced to
// this exact class of bug — files that exist and have correct duration but
// play near-silently).
async function checkAndBoostVolume(filePath, label) {
  try {
    const { stderr } = await withTimeout(
      execPromise(`ffmpeg -i "${filePath}" -af volumedetect -f null -`), 10_000, 'volumeCheck'
    ).catch(e => ({ stderr: e.stderr || e.message || '' }));
    const m = String(stderr).match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
    const meanDb = m ? parseFloat(m[1]) : null;
    console.log(`[VOLUME] ${label}: mean_volume=${meanDb !== null ? meanDb+'dB' : 'unknown'}`);
    if (meanDb !== null && meanDb < -50) {
      console.warn(`[VOLUME WARN] ${label}: near-silent output detected (mean_volume=${meanDb}dB) — boosting`);
      const boosted = filePath + '.boosted.mp3';
      await ffmpeg(`-y -i "${filePath}" -af "volume=10dB" -ar 44100 -acodec libmp3lame "${boosted}"`, 'volumeBoost');
      await fs.rename(boosted, filePath).catch(()=>{});
    }
  } catch (volErr) { console.warn(`[VOLUME WARN] ${label}: volume check failed (non-fatal): ${volErr.message}`); }
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
      await checkAndBoostVolume(out, `tts:"${t.slice(0,40)}"`);
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
    `-y -loop 1 -i "${img}" -i "${audioP}" -c:v libx264 -crf 28 -preset faster -t ${safeDur} -pix_fmt yuv420p -r 30 ` +
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
async function recordedClip(page, audioP, dur, workDir, name, triggerSelector = null) {
  const safeDur = Math.max(0.3, dur);
  const rawVideo = path.join(workDir, `${name}_raw.mp4`);
  // DIAGNOSTIC: confirm exactly what page/URL/title is about to be recorded.
  try {
    const diagUrl = page.url();
    const diagTitle = await page.title().catch(()=>'(title fetch failed)');
    const diagPagesCount = (await page.browser().pages()).length;
    console.log(`[RECORD-DIAG] ${name}: url=${diagUrl} title="${diagTitle}" openPages=${diagPagesCount}`);
  } catch (e) {
    console.warn(`[RECORD-DIAG] ${name}: diagnostic check failed: ${e.message}`);
  }
  // Defensive: close stray extra pages so recorder has zero ambiguity about target.
  try {
    const allPages = await page.browser().pages();
    for (const p of allPages) {
      if (p !== page && !p.isClosed()) { console.warn(`[RECORD-DIAG] ${name}: closing stray page`); await p.close().catch(()=>{}); }
    }
  } catch (e) { console.warn(`[RECORD-DIAG] ${name}: stray page cleanup failed: ${e.message}`); }

  const recorder = new PuppeteerScreenRecorder(page, { fps:30, videoFrame:{width:1080,height:1920}, aspectRatio:'9:16', followNewTab:false });
  await recorder.start(rawVideo);

  // TRANSITION FIX: if a triggerSelector is provided, re-trigger the CSS
  // animation NOW — inside the recording window — so it plays in the video.
  // showOnly() already set .active before this call (which is correct for
  // screens that need to be visible before recording starts), but for
  // transition animations we need to restart them by briefly removing then
  // re-adding .active while the recorder is running. This makes slide_up,
  // zoom_in, flip, blur_in, and bounce visible in the recorded clip.
  if (triggerSelector) {
    await page.evaluate(sel => {
      const el = document.querySelector(sel);
      if (!el) return;
      // Force reflow: remove and re-add .active so the @keyframes animation
      // restarts from frame 0 with the recorder already capturing.
      el.classList.remove('active');
      void el.offsetHeight; // reflow trigger
      el.classList.add('active');
    }, triggerSelector);
    // Let animation play: wait for the longest animation (bounce, 550ms)
    await new Promise(r=>setTimeout(r,600));
  }

  await new Promise(r=>setTimeout(r, safeDur*1000));
  await withTimeout(recorder.stop(), TIMEOUT_RECORDER, `${name} recorder.stop()`);
  try {
    const rawStat = await fs.stat(rawVideo);
    console.log(`[RECORD-DIAG] ${name}: raw recording size=${(rawStat.size/1024).toFixed(1)}KB`);
  } catch (e) {
    console.warn(`[RECORD-DIAG] ${name}: raw recording stat failed: ${e.message}`);
  }

  const h264 = path.join(workDir, `${name}_h264.mp4`);
  // CRF 28 + preset faster: YouTube Shorts target quality at 4-8MB.
  // Previous CRF 18 + preset medium was broadcast quality at 20-25MB and
  // took 2-3× longer to encode. CRF 28 is indistinguishable on mobile screens.
  await ffmpeg(`-y -i "${rawVideo}" -c:v libx264 -crf 28 -preset faster -pix_fmt yuv420p -r 30 -vf "scale=1080:1920" "${h264}"`, `${name} reencode`);

  const out = path.join(workDir, `${name}.mp4`);
  await ffmpeg(
    `-y -i "${h264}" -i "${audioP}" ` +
    `-c:v libx264 -crf 28 -preset faster -pix_fmt yuv420p -r 30 ` +
    `-c:a aac -b:a 128k -ar 44100 -map 0:v:0 -map 1:a:0 -shortest -t ${safeDur} "${out}"`,
    `${name} mux`
  );
  const actualDur = await videoDur(out);
  console.log(`[CLIP] ${name}: requested=${safeDur.toFixed(2)}s actual=${actualDur.toFixed(2)}s (recorded)`);
  return { path: out, dur: actualDur };
}

// ─────────────────────────────────────────────
// BG MUSIC DUCKING
// ─────────────────────────────────────────────
async function applyBgMusic(concatMp4, totalDur, voiceRanges, bgFile, workDir) {
  if (!bgFile || !(await fileExists(bgFile))) { console.log('[BGMUSIC] skip — no bgFile'); return concatMp4; }
  const bgLooped=path.join(workDir,'bg_looped.mp3'), bgDucked=path.join(workDir,'bg_ducked.mp3');
  const fgAudio=path.join(workDir,'fg_audio.mp3'), mixedAudio=path.join(workDir,'mixed_audio.mp3');
  const finalMp4=path.join(workDir,'final_with_music.mp4');

  // Loop bg music to full video length at BASE volume.
  await ffmpeg(`-y -stream_loop -1 -i "${bgFile}" -t ${totalDur} -af "volume=${BG_VOL_BASE}" -ar 44100 -acodec libmp3lame "${bgLooped}"`, 'bgLoop');

  // Duck the bg music DOWN during voice ranges so narration is clear.
  if (voiceRanges.length > 0) {
    const ratio = (BG_VOL_DUCK/BG_VOL_BASE).toFixed(4);
    const filters = voiceRanges.map(r => {
      const s=Math.max(0,r.start-DUCK_RAMP).toFixed(3), e=(r.end+DUCK_RAMP).toFixed(3);
      return `volume=${ratio}:enable='between(t,${s},${e})'`;
    }).join(',');
    try {
      await ffmpeg(`-y -i "${bgLooped}" -af "${filters}" -ar 44100 -acodec libmp3lame "${bgDucked}"`, 'bgDuck');
    } catch (e) {
      console.warn(`[BGMUSIC] ducking failed (${e.message}) — using undocked bg music`);
      await fs.copyFile(bgLooped, bgDucked);
    }
  } else { await fs.copyFile(bgLooped, bgDucked); }

  // Extract foreground (voice + sfx + cta audio) from the concatenated video.
  await ffmpeg(`-y -i "${concatMp4}" -vn -ar 44100 -acodec libmp3lame "${fgAudio}"`, 'extractFg');

  // Mix foreground + bg. CRITICAL: amix normalizes by dividing by input count
  // (halving both signals). We counter this with normalize=0 so foreground
  // stays at full volume, and bg is already attenuated via BG_VOL_BASE.
  await ffmpeg(
    `-y -i "${fgAudio}" -i "${bgDucked}" ` +
    `-filter_complex "[0:a]volume=1.0[fg];[1:a]volume=1.0[bg];` +
    `[fg][bg]amix=inputs=2:duration=first:normalize=0[a]" ` +
    `-map "[a]" -ar 44100 -acodec libmp3lame "${mixedAudio}"`,
    'mixAudio'
  );

  // Remux mixed audio onto the video.
  await ffmpeg(`-y -i "${concatMp4}" -i "${mixedAudio}" -c:v copy -map 0:v:0 -map 1:a:0 -c:a aac -b:a 192k -t ${totalDur} -movflags +faststart "${finalMp4}"`, 'remux');
  const finalDur = await videoDur(finalMp4);
  console.log(`[BGMUSIC] Mixed bg music (base=${BG_VOL_BASE}, duck=${BG_VOL_DUCK}) + foreground. Final: ${finalDur.toFixed(2)}s`);
  return finalMp4;
}

// ─────────────────────────────────────────────
// THEME + quiz_background_css + design engine
// ─────────────────────────────────────────────
const DESIGN_ENGINE_CSS_PATH = path.join(__dirname,'themes','design_engine.css');

async function resolveTheme(quiz) {
  const base    = await fs.readFile(path.join(THEMES_DIR,'_base.css'),'utf8');
  const themeId = quiz.visual_theme_id || DEFAULT_THEME;
  let themeFile = path.join(THEMES_DIR,`${themeId}.css`);
  if (!(await fileExists(themeFile))) { console.warn(`[THEME] '${themeId}' not found — using ${DEFAULT_THEME}`); themeFile = path.join(THEMES_DIR,`${DEFAULT_THEME}.css`); }
  let css = base + '\n' + (await fs.readFile(themeFile,'utf8'));
  const a1=quiz.theme_accent_primary||'#00e0ff', a2=quiz.theme_accent_secondary||'#7b2ff7', a3=quiz.theme_accent_tertiary||'#ff2ec4';
  css = css.split('{{accent_primary}}').join(a1).split('{{accent_secondary}}').join(a2).split('{{accent_tertiary}}').join(a3);
  if (quiz.quiz_background_css?.trim() && themeId === DEFAULT_THEME) {
    // Only apply per-quiz dynamic background for the default particle_field theme.
    // All other themes define their own complete background — overriding it would
    // destroy the theme's visual identity (e.g. turning minimal white to dark blue).
    console.log('[THEME] Applying quiz_background_css (particle_field theme only)');
    css += '\n/* === QUIZ-SPECIFIC BACKGROUND === */\n' + quiz.quiz_background_css;
  } else if (quiz.quiz_background_css?.trim()) {
    console.log(`[THEME] Skipping quiz_background_css — theme=${themeId} controls its own background`);
  } else {
    console.log('[THEME] No quiz_background_css set — using theme default');
  }
  // Load design engine CSS (layout variants, countdown styles, transitions)
  let designEngineCss = '';
  try {
    designEngineCss = await fs.readFile(DESIGN_ENGINE_CSS_PATH,'utf8');
    console.log(`[DESIGN] theme=${themeId} layout=${quiz.layout_variant||'standard'} countdown=${quiz.countdown_style||'ring'} transition=${quiz.transition_style||'fade'}`);
  } catch(e) {
    console.warn(`[DESIGN] design_engine.css not found — skipping (${e.message})`);
  }
  return { themeCss: css, decoHtml: buildDecoHtml(themeId), designEngineCss };
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
// R2 HERO IMAGE UPLOAD (16:9)
// ─────────────────────────────────────────────
async function uploadHeroImageToR2(localPngPath, quizId) {
  if (!R2_CONFIGURED) { console.log('[R2] Not configured, skipping hero image upload.'); return null; }
  try {
    const buf = await fs.readFile(localPngPath);
    const key = `hero_images/${quizId}.jpg`;
    await withTimeout(
      s3Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET, Key: key, Body: buf,
        ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000'
      })),
      30_000, 'R2 hero image upload'
    );
    const publicUrl = `${R2_PUBLIC_URL.replace(/\/$/,'')}/${key}`;
    console.log(`[R2] Hero image uploaded: ${publicUrl}`);
    return publicUrl;
  } catch (e) {
    console.warn(`[R2] Hero image upload failed: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// IMAGE DIMENSION READER
// Reads width/height from raw image bytes without any external library.
// Supports JPEG, PNG, WebP — the three formats Tavily returns.
// Returns { width, height } or null if format unrecognised.
// ─────────────────────────────────────────────
function readImageDimensions(buf) {
  try {
    const b = Buffer.from(buf);
    // PNG: bytes 0-3 = signature, IHDR at offset 8
    if (b[0]===0x89&&b[1]===0x50&&b[2]===0x4E&&b[3]===0x47) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    // JPEG: scan for SOF markers
    if (b[0]===0xFF&&b[1]===0xD8) {
      let i=2;
      while (i<b.length-8) {
        if (b[i]!==0xFF){i++;continue;}
        const m=b[i+1];
        if (m===0xC0||m===0xC1||m===0xC2||m===0xC3||m===0xC5||m===0xC6||m===0xC7)
          return { width: b.readUInt16BE(i+7), height: b.readUInt16BE(i+5) };
        const segLen=b.readUInt16BE(i+2); i+=2+segLen;
      }
      return null;
    }
    // WebP: RIFF header
    if (b[0]===0x52&&b[1]===0x49&&b[2]===0x46&&b[3]===0x46&&
        b[8]===0x57&&b[9]===0x45&&b[10]===0x42&&b[11]===0x50) {
      const ct=b.slice(12,16).toString('ascii');
      if (ct==='VP8 ') return { width:(b.readUInt16LE(26)&0x3FFF)+1, height:(b.readUInt16LE(28)&0x3FFF)+1 };
      if (ct==='VP8L') { const bits=b.readUInt32LE(21); return { width:(bits&0x3FFF)+1, height:((bits>>14)&0x3FFF)+1 }; }
      if (ct==='VP8X') return { width:b.readUIntLE(24,3)+1, height:b.readUIntLE(27,3)+1 };
    }
    return null;
  } catch(e){ return null; }
}

// ─────────────────────────────────────────────
// ASPECT RATIO CLASSIFIER
// vertical : ratio < 0.85  → best for 9:16 thumbnail
// wide     : ratio > 1.25  → best for 16:9 hero image
// square   : 0.85–1.25     → best for inline blog image
// ─────────────────────────────────────────────
function classifyAspect(width, height) {
  if (!width||!height) return 'unknown';
  const r = width/height;
  if (r < 0.85) return 'vertical';
  if (r > 1.25) return 'wide';
  return 'square';
}

// ─────────────────────────────────────────────
// TAVILY IMAGE FETCH — dimension-aware
// Downloads ALL available Tavily images (up to 5), reads their dimensions,
// classifies each as vertical/wide/square, then returns the best match:
//   thumbnail → vertical  (portrait  — 9:16)
//   hero      → wide      (landscape — 16:9)
//   inline    → square    (1:1 — blog body)
// Falls back to first usable image for any unmatched slot.
// Returns { thumbnail, hero, inline } — each slot is
//   { dataUri, mimeType, rawUrl, width, height, aspect } or null
// ─────────────────────────────────────────────
async function fetchTavilyImagesForQuiz(quiz) {
  const result = { thumbnail: null, hero: null, inline: null };
  try {
    const queueRows = await fetchSupabase(
      `quiz_queue?trnding_topic=ilike.${encodeURIComponent(quiz.topic)}&select=payload&limit=1`
    ).catch(()=>null);
    const tavilyImages = queueRows?.[0]?.payload?.tavily_images || [];
    if (!tavilyImages.length) {
      console.log('[TAVILY-IMG] No Tavily images in quiz_queue payload');
      return result;
    }
    console.log(`[TAVILY-IMG] Downloading ${Math.min(tavilyImages.length,5)} images to detect dimensions...`);

    // Download all in parallel
    const downloaded = await Promise.all(
      tavilyImages.slice(0,5).map(async (img,idx) => {
        const rawUrl = typeof img==='string' ? img : img?.url;
        if (!rawUrl) return null;
        try {
          const res = await withTimeout(
            fetch(rawUrl,{headers:{'User-Agent':'Mozilla/5.0 AutoQuiz/1.0'}}),
            10000, `Tavily img[${idx}]`
          );
          if (!res.ok) return null;
          const buf    = await res.arrayBuffer();
          const mime   = (res.headers.get('content-type')||'image/jpeg').split(';')[0].trim();
          const dims   = readImageDimensions(buf);
          const aspect = dims ? classifyAspect(dims.width,dims.height) : 'unknown';
          const b64    = Buffer.from(buf).toString('base64');
          const dataUri = `data:${mime};base64,${b64}`;
          console.log(`[TAVILY-IMG] [${idx}] ${aspect.padEnd(8)} ${dims?`${dims.width}x${dims.height}`:`dims?`} ${(buf.byteLength/1024).toFixed(0)}KB — ${rawUrl.slice(0,70)}`);
          return { dataUri, mimeType:mime, rawUrl, width:dims?.width, height:dims?.height, aspect };
        } catch(e) {
          console.log(`[TAVILY-IMG] [${idx}] FAILED: ${e.message.slice(0,60)}`);
          return null;
        }
      })
    );

    // Filter out failed downloads AND images with 0 bytes (corrupt/empty R2 files)
    // A 0KB image produces a broken data URI that renders as blank background.
    const usable = downloaded.filter(img => img && img.dataUri && img.dataUri.length > 500);
    const zeroKb = downloaded.filter(img => img && (!img.dataUri || img.dataUri.length <= 500));
    if (zeroKb.length > 0) {
      console.log(`[TAVILY-IMG] Skipping ${zeroKb.length} empty/corrupt image(s) (0KB)`);
    }
    if (!usable.length) { console.log('[TAVILY-IMG] All downloads failed or returned empty'); return result; }

    // Assign best match per slot
    result.thumbnail = usable.find(i=>i.aspect==='vertical')
                    || usable.find(i=>i.aspect==='square')
                    || usable[0];
    result.hero      = usable.find(i=>i.aspect==='wide')
                    || usable.find(i=>i.aspect==='square')
                    || usable[0];
    result.inline    = usable.find(i=>i.aspect==='square')
                    || usable.find(i=>i.aspect==='wide')
                    || usable[0];

    // Avoid identical thumbnail + hero if alternatives exist
    if (result.thumbnail===result.hero && usable.length>1) {
      const alt = usable.find(i=>i!==result.thumbnail);
      if (alt) result.hero = alt;
    }
    // Avoid identical hero + inline if alternatives exist
    if (result.hero===result.inline && usable.length>2) {
      const alt = usable.find(i=>i!==result.hero && i!==result.thumbnail);
      if (alt) result.inline = alt;
    }

    console.log(`[TAVILY-IMG] Assigned: thumbnail=${result.thumbnail?.aspect}(${result.thumbnail?.width}x${result.thumbnail?.height}) hero=${result.hero?.aspect}(${result.hero?.width}x${result.hero?.height}) inline=${result.inline?.aspect}(${result.inline?.width}x${result.inline?.height})`);
    return result;
  } catch(e) {
    console.warn(`[TAVILY-IMG] Fetch error (non-fatal): ${e.message}`);
    return result;
  }
}
// ─────────────────────────────────────────────
// NICHE COLOR MAP — for image card accents
// ─────────────────────────────────────────────
const NICHE_COLORS = {
  sports:        '#f5c842',
  finance:       '#00d4aa',
  tech:          '#6c63ff',
  health:        '#ff6b6b',
  entertainment: '#ff4fc8',
  politics:      '#4fc3f7',
  general:       '#00cfff',
};
const NICHE_COLORS_DARK = {
  sports:        '#7a6000',
  finance:       '#004d3d',
  tech:          '#1a1040',
  health:        '#4d0000',
  entertainment: '#4d0030',
  politics:      '#00304d',
  general:       '#003040',
};
const NICHE_HOOKS = {
  sports:        { emoji: '🏆', text: 'Only 1% Know This!' },
  finance:       { emoji: '💰', text: 'Can You Beat This?' },
  tech:          { emoji: '⚡', text: '99% Get This Wrong!' },
  health:        { emoji: '🧠', text: 'Test Your Knowledge!' },
  entertainment: { emoji: '🎬', text: 'Most Fans Fail This!' },
  politics:      { emoji: '🌍', text: 'Do You Know This?' },
  general:       { emoji: '🔥', text: 'Only Genius Pass!' },
};

// ─────────────────────────────────────────────
// BUILD IMAGE CARD via Puppeteer
// mode: '9:16' (1080×1920 thumbnail) or '16:9' (1280×720 hero)
// bgImageDataUri: base64 data URI of Tavily photo, or null for gradient fallback
// Returns local file path of rendered PNG/JPG
// ─────────────────────────────────────────────
async function buildImageCard(quiz, mode, bgImageDataUri, logoDataUri, workDir, browser) {
  const is916  = mode === '9:16';
  const WIDTH  = is916 ? 1080 : 1280;
  const HEIGHT = is916 ? 1920 : 720;

  const niche      = (quiz.niche || 'general').toLowerCase();
  const nicheColor = NICHE_COLORS[niche]     || NICHE_COLORS.general;
  const nicheDark  = NICHE_COLORS_DARK[niche] || NICHE_COLORS_DARK.general;
  const nicheIcon  = NICHE_ICON[niche]        || '❓';
  const nicheLabel = niche.charAt(0).toUpperCase() + niche.slice(1);
  const hook       = NICHE_HOOKS[niche]       || NICHE_HOOKS.general;

  // Headline: youtube_title preferred (SEO-optimised), fallback to topic
  const headlineRaw = (quiz.youtube_title || quiz.topic || '').trim();
  // Clamp to ~80 chars for readability
  const headline = headlineRaw.length > 80 ? headlineRaw.slice(0, 77) + '...' : headlineRaw;

  const challengeLabel = quiz.niche_challenge_no
    ? `${nicheLabel} Challenge #${quiz.niche_challenge_no}`
    : `${nicheLabel} Quiz`;

  // Scale factors so sizes look right at both resolutions
  const S = is916 ? 1.0 : 0.52;

  // Background layer HTML
  const bgLayer = bgImageDataUri
    ? `<div class="bg-photo"></div>`
    : `<div class="bg-fallback"></div>`;

  const sideAccent  = is916 ? `<div class="side-accent"></div>` : '';
  const watermark   = !is916
    ? `<div class="watermark">jaasblog.online</div>`
    : '';

  // Play button — 9:16 thumbnail only (signals video/quiz content to viewers)
  const playBtnHtml = is916 ? `<div class="play-btn"></div>` : '';

  // Attribution — very subtle credit line, reduces copyright risk for news photos
  // Position: bottom-right corner, above the hook stripe area
  const attributionHtml = bgImageDataUri
    ? `<div class="attribution">Image: via news sources</div>`
    : '';

  // Build CSS variable substitutions
  const vars = {
    '{{WIDTH}}':         WIDTH,
    '{{HEIGHT}}':        HEIGHT,
    '{{NICHE_COLOR}}':   nicheColor,
    '{{NICHE_COLOR_DARK}}': nicheDark,
    // badge
    '{{BADGE_TOP}}':     Math.round(36 * S),
    '{{BADGE_LEFT}}':    Math.round(32 * S),
    '{{BADGE_GAP}}':     Math.round(8 * S),
    '{{BADGE_PAD_V}}':   Math.round(10 * S),
    '{{BADGE_PAD_H}}':   Math.round(18 * S),
    '{{BADGE_RADIUS}}':  Math.round(8 * S),
    '{{BADGE_FONT}}':    Math.round(28 * S),
    '{{BADGE_ICON}}':    Math.round(26 * S),
    // logo
    '{{LOGO_TOP}}':      Math.round(28 * S),
    '{{LOGO_RIGHT}}':    Math.round(28 * S),
    '{{LOGO_W}}':        Math.round(120 * S),
    // bottom block
    '{{BLOCK_PAD}}':     Math.round(48 * S),
    '{{LABEL_FONT}}':    Math.round(26 * S),
    '{{LABEL_MB}}':      Math.round(12 * S),
    '{{HEADLINE_FONT}}': Math.round((is916 ? 72 : 56) * S),
    '{{HEADLINE_MB}}':   Math.round(24 * S),
    // hook stripe
    '{{STRIPE_GAP}}':    Math.round(10 * S),
    '{{STRIPE_PAD_V}}':  Math.round(12 * S),
    '{{STRIPE_PAD_H}}':  Math.round(24 * S),
    '{{STRIPE_RADIUS}}': Math.round(8 * S),
    '{{STRIPE_FONT}}':   Math.round(28 * S),
    // side accent (9:16 only)
    '{{ACCENT_W}}':      Math.round(8 * S),
    // watermark (16:9 only)
    '{{WM_TOP}}':        Math.round(40 * S),
    '{{WM_RIGHT}}':      Math.round(180 * S),
    '{{WM_FONT}}':       Math.round(18 * S),
    // content
    '{{BG_IMAGE_DATA_URI}}': bgImageDataUri || '',
    '{{BG_LAYER}}':      bgLayer,
    '{{SIDE_ACCENT}}':   sideAccent,
    '{{WATERMARK}}':     watermark,
    '{{PLAY_BTN}}':      playBtnHtml,
    '{{ATTRIBUTION}}':   attributionHtml,
    // play button sizing
    '{{PLAY_W}}':        Math.round(120 * S),
    '{{PLAY_ARROW_T}}':  Math.round(28 * S),
    '{{PLAY_ARROW_L}}':  Math.round(48 * S),
    '{{PLAY_ARROW_OFFSET}}': Math.round(6 * S),
    // attribution sizing
    '{{ATTR_BOTTOM}}':   Math.round(10 * S),
    '{{ATTR_RIGHT}}':    Math.round(12 * S),
    '{{ATTR_FONT}}':     Math.round(16 * S),
    '{{NICHE_ICON}}':    nicheIcon,
    '{{NICHE_LABEL}}':   nicheLabel,
    '{{LOGO_DATA_URI}}': logoDataUri,
    '{{CHALLENGE_LABEL}}': challengeLabel,
    '{{HEADLINE_TEXT}}': headline,
    '{{HOOK_EMOJI}}':    hook.emoji,
    '{{HOOK_TEXT}}':     hook.text,
  };

  // Read template and substitute
  let tmplPath = path.join(__dirname, 'thumbnail_template.html');
  let html = await fs.readFile(tmplPath, 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    html = html.split(k).join(String(v ?? ''));
  }

  const htmlPath = path.join(workDir, `imgcard_${mode.replace(':','x')}.html`);
  await fs.writeFile(htmlPath, html);

  // Render with Puppeteer
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
  await new Promise(r => setTimeout(r, 400)); // let fonts/images settle

  const outPath = path.join(workDir, `imgcard_${mode.replace(':','x')}.png`);
  await page.screenshot({ path: outPath, type: 'png', clip: { x:0, y:0, width: WIDTH, height: HEIGHT } });
  await page.close();

  console.log(`[IMG-CARD] Rendered ${mode} card → ${outPath}`);
  return outPath;
}

// ─────────────────────────────────────────────
// JOB PROCESSING
// ─────────────────────────────────────────────
async function processJobs() {
  console.log('[WORKER] Checking...');

  // ── Reset stuck rows (processing for >30 min) ─────────────────────────
  const stuckCutoff = new Date(Date.now()-30*60*1000).toISOString();
  const stuckRows = await fetchSupabase(`quiz?video_status=eq.processing&is_active=eq.true&updated_at=lt.${stuckCutoff}&select=id&limit=5`).catch(()=>null);
  if (stuckRows?.length) {
    console.log(`[WORKER] Resetting ${stuckRows.length} stuck rows`);
    for (const r of stuckRows) await fetchSupabase(`quiz?id=eq.${r.id}`,{method:'PATCH',body:JSON.stringify({video_status:'pending',updated_at:new Date().toISOString()})}).catch(()=>{});
  }

  // ── TOPIC-FIRST SELECTION (3-rule logic) ──────────────────────────────
  //
  // Worker 8 creates 4 quiz rows per topic (q1, q2, q3, q4) with slugs like
  // "argentina-vs-brazil-q1", "argentina-vs-brazil-q2" etc.
  // These share the same raw `topic` string but have different topic_slugs.
  //
  // RULE 1: Always pick the NEWEST topic first (most recently enriched).
  //         Fresh trending topics must be rendered before old ones.
  //
  // RULE 2: For each topic, render ONLY ONE video per run (the most recently
  //         created quiz row for that topic). Skip all other rows for the
  //         same topic — they will be considered in future runs only if no
  //         fresher topic exists.
  //
  // RULE 3: Only render a second quiz row for the same topic if there are
  //         NO other fresh topics with zero renders waiting. This prevents
  //         Worker 10 from exhausting its run time on 4 rows of one topic
  //         while newer topics pile up unrendered.
  //
  // Implementation:
  //   Step A — fetch all pending rows, group by raw `topic` string.
  //   Step B — for each unique topic, identify how many rows already have
  //             a rendered video (video_status != pending/error).
  //   Step C — sort topics: topics with 0 renders come first (newest first
  //             within that group), then topics with 1 render, etc.
  //   Step D — pick the single best row to render now:
  //             → newest row for the highest-priority topic.
  //   Step E — mark all OTHER pending rows for the SAME topic as 'skipped'
  //             so they don't clog the pending queue, but keep them
  //             recoverable (video_status='skipped' → re-queued next run
  //             only if no fresh topics exist).

  // Fetch pending rows — newest first so we naturally find the freshest topic.
  // Dual query: rows assigned to long format use long_status=pending_long;
  // legacy rows (pre-migration, assigned_format null) fall back to video_status=pending.
  // OR filter covers both so worker10 handles whichever it finds.
  // CRITICAL: exclude rows explicitly assigned to short or medium format —
  // those belong to worker10_short / worker10_medium only. Without this exclusion
  // a short-assigned row whose video_status='pending' would be picked up by both
  // the short worker (via short_status=pending_short) AND by the long worker's
  // legacy fallback (assigned_format is not null so the IS NULL check should
  // exclude it — but a race where the short worker hasn't claimed it yet means
  // the long worker can grab it first). Belt-and-suspenders: filter it out here.
  const pendingRows = await fetchSupabase(
    'quiz?or=(long_status.eq.pending_long,and(assigned_format.is.null,video_status.eq.pending))' +
    '&assigned_format.neq.short&assigned_format.neq.medium' +
    '&is_active=eq.true&quiz_enriched=eq.true' +
    '&select=id,topic,topic_slug,created_at,assigned_format,long_status&order=created_at.desc&limit=500'
  );
  if (!pendingRows?.length) {
    // No fresh pending — check if any skipped rows can be revived
    const skippedRows = await fetchSupabase(
      'quiz?video_status=eq.skipped&is_active=eq.true&quiz_enriched=eq.true' +
      '&select=id,topic,topic_slug,created_at&order=created_at.desc&limit=100'
    ).catch(()=>null);
    if (skippedRows?.length) {
      // Revive the most recently skipped row — it's the next in line
      const revive = skippedRows[0];
      console.log(`[WORKER] No fresh topics — reviving skipped row: "${revive.topic}" (${revive.id})`);
      await fetchSupabase(`quiz?id=eq.${revive.id}`,{method:'PATCH',body:JSON.stringify({video_status:'pending',updated_at:new Date().toISOString()})});
      // Re-query so normal flow continues below
      const revivedRows = await fetchSupabase(`quiz?id=eq.${revive.id}&select=id,topic,topic_slug,created_at`);
      if (revivedRows?.length) pendingRows.push(revivedRows[0]);
    }
    if (!pendingRows?.length) { console.log('[WORKER] No pending quizzes.'); return; }
  }

  // Group by raw topic string (NOT topic_slug — slugs differ per question)
  const topicMap = new Map(); // topic -> [rows sorted newest first]
  for (const r of pendingRows) {
    const key = (r.topic || '').trim().toLowerCase();
    if (!key) continue;
    if (!topicMap.has(key)) topicMap.set(key, []);
    topicMap.get(key).push(r);
  }
  console.log(`[WORKER] ${topicMap.size} distinct topics with pending rows (${pendingRows.length} total pending rows)`);

  // For each topic, count how many rows already have a rendered video
  const renderCounts = {};
  for (const [topicKey, rows] of topicMap) {
    const sample = rows[0]; // use first row's topic string for the query
    const rendered = await fetchSupabase(
      `quiz?topic=eq.${encodeURIComponent(sample.topic)}&video_status=eq.rendered&select=id&limit=50`
    ).catch(()=>null);
    renderCounts[topicKey] = rendered?.length || 0;
  }

  // Sort topics: 0 renders first (fresh), then 1, 2, etc.
  // Within same render count, newest topic wins (rows are already desc by created_at,
  // so topicMap insertion order = newest topic first — Map preserves insertion order).
  const sortedTopics = [...topicMap.entries()].sort((a, b) => {
    const countDiff = (renderCounts[a[0]] ?? 0) - (renderCounts[b[0]] ?? 0);
    if (countDiff !== 0) return countDiff;
    // Same render count — prefer newer topic (first row = newest due to desc sort)
    return new Date(b[1][0].created_at) - new Date(a[1][0].created_at);
  });

  // Pick the single best row: newest row for the top-priority topic
  const [chosenTopicKey, chosenRows] = sortedTopics[0];
  const chosenRow = chosenRows[0]; // newest row for this topic (desc sort)
  const renderedSoFar = renderCounts[chosenTopicKey] ?? 0;

  console.log(`[WORKER] Selected topic: "${chosenRow.topic}" (${renderedSoFar} already rendered, ${chosenRows.length} pending rows for this topic)`);
  console.log(`[WORKER] Rendering: ${chosenRow.id} (slug=${chosenRow.topic_slug})`);

  // RULE 2 + 3: Mark all OTHER pending rows for this same topic as 'skipped'
  // so they don't get picked up in this run or the next fresh-topics run.
  // They'll be revived (status → pending) only when no fresh topics remain.
  const otherRows = chosenRows.slice(1); // everything except the chosen row
  if (otherRows.length > 0) {
    console.log(`[WORKER] Skipping ${otherRows.length} other pending row(s) for same topic (will revive when no fresh topics remain)`);
    for (const r of otherRows) {
      await fetchSupabase(`quiz?id=eq.${r.id}`,{
        method:'PATCH',
        body:JSON.stringify({video_status:'skipped', updated_at:new Date().toISOString()})
      }).catch(()=>{});
    }
  }

  const rows = await fetchSupabase(`quiz?id=eq.${chosenRow.id}&select=*`);
  if (!rows?.length) { console.log('[WORKER] Chosen row vanished — will retry next run.'); return; }

  const quiz = rows[0];
  console.log(`[WORKER] Processing: ${quiz.id} — ${quiz.topic}`);
  // Claim: set both video_status (legacy compat) and long_status (new system)
  const claimPatch = { video_status: 'processing', updated_at: new Date().toISOString() };
  if (quiz.long_status === 'pending_long') claimPatch.long_status = 'rendering_long';
  await fetchSupabase(`quiz?id=eq.${quiz.id}`,{method:'PATCH',body:JSON.stringify(claimPatch)});

  const workDir = `/tmp/video_${uuidv4()}`;
  await ensureDir(workDir);

  try {
    const { videoPath, thumbnailUrl, heroImageUrl } = await withTimeout(buildVideo(quiz,workDir), TIMEOUT_JOB, `buildVideo ${quiz.id}`);
    const stats  = await fs.stat(videoPath);
    const sizeMb = parseFloat((stats.size/(1024*1024)).toFixed(2));
    const dur    = await videoDur(videoPath);
    console.log(`[WORKER] Done. ${dur.toFixed(1)}s, ${sizeMb}MB, thumbnail=${thumbnailUrl||'none'}`);

    const artifactPath = `/tmp/${quiz.id}_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);
    await fs.writeFile('/tmp/artifact_ready', artifactPath);

    // Upload video to R2 so it's permanently accessible via URL
    let videoUrl = null;
    if (R2_CONFIGURED) {
      try {
        const videoBuf = await fs.readFile(artifactPath);
        const videoKey = `videos/${quiz.id}.mp4`;
        await withTimeout(
          s3Client.send(new PutObjectCommand({
            Bucket: R2_BUCKET,
            Key: videoKey,
            Body: videoBuf,
            ContentType: 'video/mp4',
          })),
          60000, 'R2 video upload'
        );
        videoUrl = `${R2_PUBLIC_URL.replace(/\/$/,'')}/${videoKey}`;
        console.log(`[R2] Video uploaded: ${videoUrl}`);
      } catch (e) {
        console.warn(`[R2] Video upload failed (non-fatal): ${e.message}`);
      }
    }

    const patchBody = {
      video_status:'rendered',
      // Also mark long_status done if this row was assigned via round-robin
      ...(quiz.long_status === 'rendering_long' ? { long_status: 'done_long' } : {}),
      render_duration_sec:Math.round(dur),
      file_size_mb:sizeMb,
      updated_at:new Date().toISOString()
    };
    if (thumbnailUrl)        patchBody.thumbnail_url         = thumbnailUrl;
    if (heroImageUrl)        patchBody.hero_image_url        = heroImageUrl;
    if (videoUrl)            patchBody.video_url             = videoUrl;
    if (quiz._inlineImageUrl) patchBody.inline_image_url     = quiz._inlineImageUrl;
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
    missionIntroFile, cta3AudioFile, cta4AudioFile,
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
    downloadAudio(quiz.cta4_audio_url,               `cta4_${quiz.id}`),
    downloadAudio(quiz.sfx_audio_url,                `sfx_${quiz.id}`,'question_appear'),
    downloadAudio(quiz.countdown_music,              `countdown_${quiz.id}`),
    downloadAudio(quiz.background_music||DEFAULT_BG_MUSIC,`bgmusic_${quiz.id}`),
    downloadAudio(quiz.correct_answer_sfx_audio_url, `correctsfx_${quiz.id}`),
    downloadAudio(quiz.sfx_mission_impossible,       `sfxmission_${quiz.id}`)
  ]);
  console.log(`[CTA] cta2AudioFile=${cta2AudioFile ? 'OK' : 'NULL (will use TTS fallback)'} cta1AudioFile=${cta1AudioFile ? 'OK' : 'NULL'}`);
  // If bg music download failed, retry with default track
  let resolvedBgFile = bgFile;
  if (!resolvedBgFile) {
    console.log('[BGMUSIC] Primary download failed — retrying with DEFAULT_BG_MUSIC');
    resolvedBgFile = await downloadAudio(DEFAULT_BG_MUSIC, `bgmusic_default`);
  }
  console.log(`[BGMUSIC] resolved bgFile=${resolvedBgFile || 'NULL (music will be skipped)'}`);

  const { themeCss, decoHtml, designEngineCss } = await resolveTheme(quiz);
  const confettiSet = pickConfettiSet(niche, quiz.topic);
  const thumbTitle  = (quiz.youtube_title && quiz.youtube_title.trim())
                      ? thumbTitleStyle(quiz.youtube_title.trim())
                      : pickThumbCatchphrase();
  // ── REQ1: Per-niche challenge number (from DB column set by Worker 8) ───
  // niche_challenge_no is populated by Worker 8 at quiz creation time.
  // Fallback: count rendered quizzes in this niche if column is missing.
  let nicheNo = quiz.niche_challenge_no || null;
  if (!nicheNo) {
    try {
      const nicheCount = await fetchSupabase(
        `quiz?niche=eq.${encodeURIComponent(niche)}&video_status=eq.rendered&id=neq.${quiz.id}&select=id`
      );
      nicheNo = (nicheCount ? nicheCount.length : 0) + 1;
      console.log(`[NICHE-NO] niche_challenge_no missing — counted ${nicheCount?.length||0} rendered → using ${nicheNo}`);
    } catch(e) {
      nicheNo = 1;
      console.warn(`[NICHE-NO] Failed to count niche (non-fatal): ${e.message}`);
    }
  } else {
    console.log(`[NICHE-NO] niche=${niche} niche_challenge_no=${nicheNo} (from DB)`);
  }
  const nicheLabel = niche ? niche.charAt(0).toUpperCase() + niche.slice(1) : 'General';
  // Marquee: "Sports Challenge No #18"
  const marqueeHtml = buildMarqueeHtml(`${nicheLabel} Challenge No #${nicheNo}`);
  // Below-logo label: "Challenge ID 2606280011"
  const challengeIdLabel = quiz.quiz_no ? `Challenge ID ${quiz.quiz_no}` : '';
  const floatIcons  = pickFloatIcons(niche, quiz.topic);

  // ── TAVILY IMAGE FETCH ───────────────────────────────────────────────────
  // Fetch ALL Tavily images for this topic, classify by aspect ratio,
  // then assign best-fit image to each slot: thumbnail/hero/inline.
  // Falls back to gradient if no images available.
  console.log('[TAVILY-IMG] Fetching and classifying news photos from quiz_queue...');
  const tavilyImgs = await fetchTavilyImagesForQuiz(quiz);
  const thumbImgData  = tavilyImgs.thumbnail;
  const heroImgData   = tavilyImgs.hero;
  const inlineImgData = tavilyImgs.inline;
  if (thumbImgData || heroImgData) {
    console.log('[TAVILY-IMG] ✓ Images ready for card generation');
  } else {
    console.log('[TAVILY-IMG] No photos available — gradient fallback will be used');
  }

  // Wikipedia thumbnail image — downloaded and base64-encoded, then injected
  // as a <style> block into the HTML. We cannot use file:// URLs for sub-resources
  // from a file:// page in headless Chrome (blocked even with --allow-file-access).
  // We also cannot embed the data URI inline in the HTML body (bloats HTML → Chrome
  // renders as plain text). The safe approach: a dedicated <style> block appended
  // to <head> sets the background via CSS class, keeping the body HTML small.
  // NOTE: Wikipedia image is still used for the quiz video background (blurred bg).
  // Tavily image is used for the thumbnail/hero image cards only.
  // ── THUMBNAIL SCREEN background (Wikipedia/topic image) ──────────────
  // Used ONLY on the thumbnail screen (.thumb-photo-bg) at the end of the video.
  // This is separate from the new video photo overlay below.
  let thumbBgStyleBlock = '';
  const videoBgImageUrl = quiz.topic_image_url || null;
  if (videoBgImageUrl) {
    try {
      const imgRes = await fetch(videoBgImageUrl, {
        headers: { 'User-Agent': 'AutoQuiz/1.0 thumbnail renderer' }
      });
      if (imgRes.ok) {
        const imgBuf  = await imgRes.arrayBuffer();
        const imgB64  = Buffer.from(imgBuf).toString('base64');
        const mime    = imgRes.headers.get('content-type') || 'image/jpeg';
        const dataUri = `data:${mime};base64,${imgB64}`;
        thumbBgStyleBlock = `<style>.thumb-photo-bg-img{background-image:url("${dataUri}") !important;}</style>`;
        console.log(`[THUMB-IMG] Wikipedia image encoded (${(imgBuf.byteLength/1024).toFixed(0)}KB): ${videoBgImageUrl.slice(0,70)}`);
      } else {
        console.log(`[THUMB-IMG] Fetch failed: HTTP ${imgRes.status}`);
      }
    } catch (e) {
      console.log(`[THUMB-IMG] Image fetch failed (non-fatal): ${e.message}`);
    }
  }

  // ── VIDEO PHOTO OVERLAY — Tavily image at 30% opacity behind all screens ──
  // This is the NEW feature: the Tavily news photo (best available image,
  // already downloaded above by fetchTavilyImagesForQuiz) is injected as a
  // fixed-position layer behind ALL quiz screens.
  // Priority: thumbnail slot image → hero slot image → Wikipedia image → none
  // The overlay sits above the theme animated bg but below all UI content.
  // 30% opacity + slight blur = visible context without distracting from quiz.
  let videoPhotoStyleBlock = '';
  let videoPhotoClass = 'no-photo'; // CSS class on the overlay div

  // Only use data URIs that are actually valid (>500 chars = real image data)
  // 0KB images produce tiny broken data URIs that render as blank
  const validDataUri = (d) => d && d.length > 500;
  const videoPhotoDataUri = (validDataUri(thumbImgData?.dataUri) ? thumbImgData.dataUri : null)
                         || (validDataUri(heroImgData?.dataUri)  ? heroImgData.dataUri  : null)
                         || (validDataUri(inlineImgData?.dataUri)? inlineImgData.dataUri: null)
                         || null;

  if (videoPhotoDataUri) {
    // IMPORTANT: Chrome cannot use large data URIs (>32KB) as CSS custom properties.
    // The CSS var(--topic-photo-url) silently fails for large images.
    // Fix: write the image to a temp file and use a file:// URL instead.
    // This is safe because Puppeteer already has --allow-file-access-from-files.
    try {
      const overlayImgPath = path.join(workDir, 'overlay_photo.jpg');
      // Extract base64 data from the data URI and write as binary file
      const b64 = videoPhotoDataUri.split(',')[1];
      if (b64) {
        await fs.writeFile(overlayImgPath, Buffer.from(b64, 'base64'));
        const overlayFileUrl = `file://${overlayImgPath}`;
        videoPhotoStyleBlock = `<style>
:root { --topic-photo-url: url("${overlayFileUrl}"); }
</style>`;
        videoPhotoClass = ''; // no "no-photo" class → overlay is visible
        console.log(`[VIDEO-OVERLAY] Photo written to temp file and injected as overlay (${(Buffer.from(b64,'base64').length/1024).toFixed(0)}KB)`);
      } else {
        console.log('[VIDEO-OVERLAY] Could not extract base64 from data URI');
      }
    } catch (e) {
      console.warn(`[VIDEO-OVERLAY] Failed to write overlay file (non-fatal): ${e.message}`);
    }
  } else if (videoBgImageUrl && thumbBgStyleBlock) {
    // Fallback: use Wikipedia image for the overlay
    // Wikipedia image is already downloaded — extract its data URI from the style block
    const wikiDataUri = thumbBgStyleBlock.match(/url\("([^"]+)"\)/)?.[1] || null;
    if (wikiDataUri) {
      try {
        const overlayImgPath = path.join(workDir, 'overlay_photo_wiki.jpg');
        const b64 = wikiDataUri.split(',')[1];
        if (b64) {
          await fs.writeFile(overlayImgPath, Buffer.from(b64, 'base64'));
          const overlayFileUrl = `file://${overlayImgPath}`;
          videoPhotoStyleBlock = `<style>
:root { --topic-photo-url: url("${overlayFileUrl}"); }
</style>`;
          videoPhotoClass = '';
          console.log('[VIDEO-OVERLAY] Wikipedia image used as fallback overlay (file://)');
        }
      } catch (e) {
        console.warn(`[VIDEO-OVERLAY] Wikipedia fallback failed (non-fatal): ${e.message}`);
      }
    }
  } else {
    console.log('[VIDEO-OVERLAY] No photo available — overlay hidden');
  }

  console.log(`[CONFETTI] niche=${niche} set=${confettiSet.join(' ')}`);
  console.log(`[THUMBNAIL TITLE] "${thumbTitle.phrase.slice(0,70)}" fontSize=${thumbTitle.fontSize}px`);
  console.log(`[MARQUEE] topic="${(quiz.topic||'').slice(0,50)}" floatIcons=${floatIcons.join(' ')}`);

  let html = await fs.readFile(path.join(__dirname,'quiz_template.html'),'utf8');
  const R = {
    '{{theme_css}}':themeCss, '{{theme_deco_html}}':decoHtml, '{{LOGO_DATA_URI}}':logoDataUri,
    '{{design_engine_css}}': designEngineCss || '',
    '{{transition_style}}': quiz.transition_style || 'fade',
    '{{countdown_style}}':  quiz.countdown_style  || 'ring',
    '{{layout_variant}}':   quiz.layout_variant   || 'standard',
    '{{hook_phrase}}':quiz.hook_phrase||'Stop scrolling! Can you beat this?',
    '{{quiz_no}}': challengeIdLabel,
    '{{question}}':question,
    '{{options[0]}}':options[0]||'', '{{options[1]}}':options[1]||'',
    '{{options[2]}}':options[2]||'', '{{options[3]}}':options[3]||'',
    '{{opt0_class}}':optClass(0), '{{opt1_class}}':optClass(1),
    '{{opt2_class}}':optClass(2), '{{opt3_class}}':optClass(3),
    '{{rev0_class}}':revClass(0), '{{rev1_class}}':revClass(1),
    '{{rev2_class}}':revClass(2), '{{rev3_class}}':revClass(3),
    '{{hint}}':hint, '{{correct_answer}}':correct,
    '{{explanation_1}}': quiz.explanation_1 || '',
    '{{cta1_description_text}}':cta1Desc||quiz.affiliate_text||'',
    '{{cta2_text}}':quiz.cta2_text||'Play real quiz and earn ONS tokens!',
    '{{cta3_text}}':quiz.cta3_text||'Like, Share & Challenge a friend! Subscribe!',
    '{{cta4_text}}':quiz.cta4_text||'Write your answer in the comments below!',
    '{{niche}}':niche,
    '{{thumb_icon}}':thumbIconFor(niche),
    '{{thumb_badge_text}}':pickThumbBadgeText(),
    '{{thumb_catchphrase}}':thumbTitle.phrase,
    '{{thumb_catchphrase_size}}':thumbTitle.fontSize,
    '{{thumb_mission_text}}':miQuestion||question,
    '{{niche_challenge_no}}': String(nicheNo),
    '{{niche_label}}': nicheLabel,
    '{{niche_challenge_label}}': `${nicheLabel} Challenge No #${nicheNo}`,
    '{{thumb_bg_style_block}}': thumbBgStyleBlock,
    '{{thumb_bg_image_class}}': thumbBgStyleBlock ? ' thumb-photo-bg-img' : ' thumb-photo-bg-hidden',
    '{{VIDEO_PHOTO_STYLE_BLOCK}}': videoPhotoStyleBlock,
    '{{VIDEO_PHOTO_CLASS}}':       videoPhotoClass,
    '{{confetti_0}}':confettiSet[0], '{{confetti_1}}':confettiSet[1],
    '{{confetti_2}}':confettiSet[2], '{{confetti_3}}':confettiSet[3],
    '{{confetti_4}}':confettiSet[4], '{{confetti_5}}':confettiSet[5],
    '{{confetti_6}}':confettiSet[6], '{{confetti_7}}':confettiSet[7],
    '{{marquee_text}}':marqueeHtml,
    '{{float_icon_0}}':floatIcons[0], '{{float_icon_1}}':floatIcons[1], '{{float_icon_2}}':floatIcons[2],
    '{{float_icon_3}}':floatIcons[3]||floatIcons[0], '{{float_icon_4}}':floatIcons[4]||floatIcons[1],
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
  // Load the page then wait for images separately.
  // networkidle0 times out with large file:// images (142KB+).
  // domcontentloaded is instant but images aren't loaded yet.
  // Solution: domcontentloaded + explicit image wait via JS.
  await page.goto(`file://${htmlPath}`,{waitUntil:'domcontentloaded', timeout:30000});
  // Wait for all <img> tags AND CSS background-image file:// resources to load
  await page.evaluate(() => new Promise(resolve => {
    // Check all img elements
    const imgs = [...document.querySelectorAll('img')];
    if (imgs.length === 0) { resolve(); return; }
    let loaded = 0;
    const done = () => { if (++loaded >= imgs.length) resolve(); };
    imgs.forEach(img => {
      if (img.complete) done();
      else { img.onload = done; img.onerror = done; }
    });
  })).catch(() => {});
  // Additional fixed wait for CSS background-image rendering (file:// URLs)
  // Chrome needs time to fetch and paint background-image after DOM is ready
  await new Promise(r=>setTimeout(r,1000));
  // Force repaint of overlay divs so background-image is applied
  if (videoPhotoClass !== 'no-photo') {
    await page.evaluate(() => {
      document.querySelectorAll('.topic-photo-overlay').forEach(el => {
        el.style.opacity = '0';
        el.offsetHeight; // force reflow
        el.style.opacity = '0.30';
      });
    }).catch(() => {});
    await new Promise(r=>setTimeout(r,300));
  }

  const showOnly = async (sel, { skipWait = false } = {}) => {
    await page.evaluate(s=>{
      document.querySelectorAll('.screen').forEach(e=>e.classList.remove('active'));
      const el=document.querySelector(s); if(el) el.classList.add('active');
    },sel);
    // 50ms — just enough for a DOM repaint/paint flush before screenshot.
    // CSS transition animations play DURING recordedClip() screen recording,
    // not during this wait, so this does not need to equal animation duration.
    if (!skipWait) await new Promise(r=>setTimeout(r,50));
  };
  const shot = async name => { const p=path.join(workDir,`${name}.png`); await page.screenshot({path:p}); return p; };

  const clips=[], voiceRanges=[];
  let cursor=0;
  function pushClip(clip, isVoice=true) {
    if(isVoice) voiceRanges.push({start:cursor,end:cursor+clip.dur});
    cursor+=clip.dur; clips.push(clip);
  }

  // ══ DEDICATED THUMBNAIL (9:16) — news-style image card ══════════════════
  // Uses Tavily news photo as full background + text overlay + JaasX logo.
  // Falls back to gradient if no Tavily image available.
  // Also generates a 16:9 hero image for the blog post.
  let thumbnailUrl  = null;
  let heroImageUrl  = null;
  try {
    console.log('[IMG-CARD] Generating news-style image cards...');

    // Generate 9:16 thumbnail (1080×1920) — vertical photo preferred (portrait fills frame best)
    // Each card has its own try/catch so a failure on one doesn't block the other.
    try {
      const thumb916Path = await buildImageCard(quiz, '9:16', thumbImgData?.dataUri||null, logoDataUri, workDir, browser);
      if (R2_CONFIGURED) thumbnailUrl = await uploadThumbnailToR2(thumb916Path, quiz.id);
      console.log(`[IMG-CARD] ✓ 9:16 thumbnail=${thumbnailUrl||'generated but not uploaded'}`);
    } catch (e9) {
      console.error(`[IMG-CARD] 9:16 thumbnail FAILED: ${e9.message}`);
      console.error(`[IMG-CARD] 9:16 stack: ${e9.stack?.slice(0,400)||'no stack'}`);
    }

    // Generate 16:9 hero image (1280×720) — wide photo preferred (fills landscape frame best)
    try {
      const hero169Path = await buildImageCard(quiz, '16:9', heroImgData?.dataUri||null, logoDataUri, workDir, browser);
      if (R2_CONFIGURED) heroImageUrl = await uploadHeroImageToR2(hero169Path, quiz.id);
      console.log(`[IMG-CARD] ✓ 16:9 hero=${heroImageUrl||'generated but not uploaded'}`);
    } catch (e16) {
      console.error(`[IMG-CARD] 16:9 hero FAILED: ${e16.message}`);
      console.error(`[IMG-CARD] 16:9 stack: ${e16.stack?.slice(0,400)||'no stack'}`);
    }

    // Save inline image URL to Supabase for Worker 12 to use in blog body
    // inline uses square photo — fits naturally between paragraphs
    if (inlineImgData?.rawUrl) {
      quiz._inlineImageUrl = inlineImgData.rawUrl;
      console.log(`[IMG-CARD] inline image URL saved: ${inlineImgData.rawUrl.slice(0,80)}`);
    }

    console.log(`[IMG-CARD] Summary: thumbnail=${thumbnailUrl||'FAILED'} hero=${heroImageUrl||'FAILED'}`);
  } catch (e) {
    // Log the FULL error including stack so we can diagnose exactly why it failed
    console.error(`[IMG-CARD] Image card generation FAILED: ${e.message}`);
    console.error(`[IMG-CARD] Stack: ${e.stack?.slice(0,500) || 'no stack'}`);
    // Fall back to old quiz_template thumb-screen screenshot
    try {
      await showOnly('.thumb-screen');
      const thumbVariant = pickThumbVariant(hasMI);
      await page.evaluate((variant)=>{
        document.querySelectorAll('.thumb-variant').forEach(el=>el.classList.remove('active'));
        const el = document.querySelector(`.thumb-variant-${variant}`);
        if (el) el.classList.add('active');
      }, thumbVariant);
      await new Promise(r=>setTimeout(r,500));
      const thumbImg = await shot('thumbnail_master');
      if (R2_CONFIGURED) thumbnailUrl = await uploadThumbnailToR2(thumbImg, quiz.id);
      console.log('[IMG-CARD] Fell back to old quiz_template thumbnail');
    } catch (e2) {
      console.warn(`[IMG-CARD] Fallback thumbnail also failed: ${e2.message}`);
    }
  }

  // ══ STEP 1: HOOK — screen-recorded (logoPop + hook-text animations + glow) ══
  await page.goto(`file://${htmlPath}`,{waitUntil:'domcontentloaded', timeout:30000});
  await new Promise(r=>setTimeout(r,600));
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
  pushClip(await recordedClip(page, hookAudio.path, Math.max(hookAudio.dur, 1.5), workDir, 'clip_hook', '.hook-slide'));

  // ══ STEP 2 (white intro-flash removed per feedback — straight to question_intro) ══

  // ══ STEP 3a: question_intro_audio_url plays, question HIDDEN ══
  await showOnly('.question-waiting-slide');
  await new Promise(r=>setTimeout(r,100));
  const qIntroAudio = await buildAudio({
    prerecorded: questionIntroFile, fallbackText: '', fallbackSec: 0.8,
    voice, leadGap: 0.15, workDir, name: 'qintro'
  });
  pushClip(await recordedClip(page, qIntroAudio.path, qIntroAudio.dur, workDir, 'clip_qwait', null), false);

  // ══ STEP 3b: question_1 REVEALED + sfx + TTS — recorded for FULL audio, no truncation ══
  await showOnly('.question-appear-slide');
  await new Promise(r=>setTimeout(r,100));
  const step3bParts=[];
  if(sfxFile){ const g=path.join(workDir,'sfx_gap.mp3'); await silence(0.1,g); step3bParts.push(sfxFile,g); }
  const qTts=path.join(workDir,'q_tts.mp3'); await tts(question,voice,qTts,3); step3bParts.push(qTts);
  const step3bCombined=path.join(workDir,'step3b.mp3');
  await concatAudio(step3bParts,step3bCombined,workDir);
  const qRevealDur = Math.max(await audioDur(step3bCombined), 1.5);
  pushClip(await recordedClip(page, step3bCombined, qRevealDur, workDir, 'clip_q_reveal', '.question-appear-slide'));

  // ══ STEP 4a: options_intro_audio_url plays, options HIDDEN ══
  await showOnly('.options-waiting-slide');
  await new Promise(r=>setTimeout(r,100));
  const oIntroAudio = await buildAudio({
    prerecorded: optionsIntroFile, fallbackText: 'And your options are', fallbackSec: 1.5,
    voice, leadGap: GAP_OPTIONS, workDir, name: 'ointro'
  });
  pushClip(await recordedClip(page, oIntroAudio.path, oIntroAudio.dur, workDir, 'clip_owait', null), false);

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
  pushClip(await recordedClip(page, step4bCombined, oRevealDur, workDir, 'clip_options_reveal', '.question-static'));

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
  pushClip(await recordedClip(page, cdFinal, QTIME, workDir, 'clip_countdown', '.question-phase'));

  // ══ STEP 9: Timeup — audio only, no text changes ══
  await showOnly('.pre-reveal-slide');
  await new Promise(r=>setTimeout(r,100));
  const timeupAudio = await buildAudio({
    prerecorded:timeupFile, fallbackText:quiz.timeup_text||"Time's up!",
    fallbackSec:2, voice, leadGap:GAP_DEFAULT, workDir, name:'timeup'
  });
  pushClip(await recordedClip(page, timeupAudio.path, timeupAudio.dur, workDir, 'clip_timeup', '.pre-reveal-slide'));

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
  pushClip(await recordedClip(page, step10Combined, answerDur, workDir, 'clip_answer', '.answer-slide'));

  // ══ FINAL CTA — now comes BEFORE Mission Impossible. ONE cta only: CTA1 if affiliate/
  // cta1_description_text exists, else CTA2. Moved here so MI is the last dramatic beat. ══
  await showOnly(hasCta1?'.cta1-slide':'.cta2-slide');
  await new Promise(r=>setTimeout(r,150));
  console.log(`[FINALCTA-DIAG] hasCta1=${hasCta1} cta1AudioFile=${cta1AudioFile||'NULL'} cta2AudioFile=${cta2AudioFile||'NULL'} cta2_text="${(quiz.cta2_text||'').slice(0,50)}"`);
  const ctaAudio = await buildAudio({
    prerecorded:hasCta1?cta1AudioFile:cta2AudioFile,
    fallbackText:hasCta1
      ?(cta1Desc||quiz.affiliate_text||'Check the exclusive link in the description below!')
      :(quiz.cta2_text||'Want to play the real challenge? Click the link in the description now!'),
    fallbackSec:3, voice, leadGap:GAP_DEFAULT, workDir, name:hasCta1?'cta1':'cta2'
  });
  console.log(`[FINALCTA-DIAG] built audio path=${ctaAudio.path} dur=${ctaAudio.dur.toFixed(2)}s`);
  pushClip(await recordedClip(page, ctaAudio.path, ctaAudio.dur, workDir, 'clip_cta', hasCta1?'.cta1-slide':'.cta2-slide'));

  // ══ MISSION IMPOSSIBLE — LAST screen, after CTA. Skip if mission_impossible_question
  // is null. ONE combined screen: title flies in, then question+options fade in. ══
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
    // MI minimum screen time = 5.5s (audio duration + 2s extra so viewer
    // can read the question and options before the screen moves on)
    const MI_MIN_SEC = 5.5;
    if (miAudioDur < MI_MIN_SEC) {
      const pad=path.join(workDir,'mi_pad.mp3'); await silence(MI_MIN_SEC - miAudioDur, pad);
      miAudio=path.join(workDir,'mi_audio.mp3');
      await concatAudio([miAudioRaw,pad],miAudio,workDir);
      miAudioDur = MI_MIN_SEC;
    }
    pushClip(await recordedClip(page, miAudio, miAudioDur, workDir, 'clip_mi', '.mission-final-slide'));

    // ══ COMBINED CTA SCREEN (like→share→subscribe + cta4) ══
    await showOnly('.comment-cta-screen');
    await new Promise(r=>setTimeout(r,200));

    console.log(`[CTA-COMBINED] cta4AudioFile=${cta4AudioFile||'NULL'}`);

    // ── REQ: Hardcoded SFX for like/share/subscribe (no DB fetch) ──
    const PILL_SFX_URL = 'https://pub-3578d297d3904e1d8ffedfc9dd4102f2.r2.dev/audio/hint_reveal/sound10_sharp.wav';
    const pillSfx = await downloadAudio(PILL_SFX_URL, `pillsfx_${quiz.id}`);
    console.log(`[CTA-COMBINED] pillSfx (hardcoded URL) = ${pillSfx || 'DOWNLOAD FAILED'}`);

    // ── REQ: cta4 audio MUST come from quiz table and MUST play ──
    let cta4Mp3 = cta4AudioFile;
    if (!cta4Mp3) {
      console.warn(`[CTA-COMBINED] cta4AudioFile is NULL — quiz.cta4_audio_url=${quiz.cta4_audio_url||'(empty)'} — using TTS fallback`);
      const cta4Tts = path.join(workDir,'cta4_tts.mp3');
      await tts(quiz.cta4_text||'Write your answer in the comments right now!', voice, cta4Tts, 3);
      cta4Mp3 = cta4Tts;
    }
    await checkAndBoostVolume(cta4Mp3, 'cta4_source');
    const cta4SourceDur = await audioDur(cta4Mp3);
    console.log(`[CTA-COMBINED] cta4 source dur=${cta4SourceDur.toFixed(2)}s`);

    // Timeline — SFX fires at animation-delay + 0.25s (midpoint of 0.5s pop animation)
    // so the sound hits exactly when the pill feels "arrived" not when it starts scaling in.
    // CSS animation-delay: LIKE=0.1s, SHARE=0.8s, SUB=1.5s → add 0.25s offset each
    // CTA4 card: animation-delay=2.3s + 0.25s offset
    const LIKE_T  = 0.35;   // 0.10 + 0.25
    const SHARE_T = 1.05;   // 0.80 + 0.25
    const SUB_T   = 1.75;   // 1.50 + 0.25
    const CTA4_T  = 2.55;   // 2.30 + 0.25
    const CTA_TAIL = 0.5;
    const totalCtaDur = CTA4_T + cta4SourceDur + CTA_TAIL;
    console.log(`[CTA-COMBINED] total screen dur=${totalCtaDur.toFixed(2)}s`);

    // Build CTA audio track. CRITICAL: force MONO (-ac 1) output to match all
    // other clips' audio (which are mono from TTS). A stereo CTA clip mixed with
    // mono body clips caused channel-count mismatch → audio dropped in concat.
    const ctaFinalAudio = path.join(workDir,'cta_final_audio.mp3');
    const ctaSilBase = path.join(workDir,'cta_sil_base.mp3');
    await silence(totalCtaDur, ctaSilBase);

    const cta4Ms = Math.round(CTA4_T * 1000);

    if (pillSfx && await fileExists(pillSfx)) {
      const likeMs = Math.round(LIKE_T*1000), shareMs = Math.round(SHARE_T*1000), subMs = Math.round(SUB_T*1000);
      try {
        // Mix base silence + 3 SFX (at pill times) + cta4 audio (at 2.3s).
        // -ac 1 forces mono. normalize=0 keeps full volume.
        await ffmpeg(
          `-y -i "${ctaSilBase}" -i "${pillSfx}" -i "${pillSfx}" -i "${pillSfx}" -i "${cta4Mp3}" ` +
          `-filter_complex ` +
          `"[1:a]adelay=${likeMs}|${likeMs}[like];` +
          `[2:a]adelay=${shareMs}|${shareMs}[share];` +
          `[3:a]adelay=${subMs}|${subMs}[sub];` +
          `[4:a]adelay=${cta4Ms}|${cta4Ms}[cta4];` +
          `[0:a][like][share][sub][cta4]amix=inputs=5:duration=first:normalize=0[a]" ` +
          `-map "[a]" -t ${totalCtaDur} -ar 44100 -ac 1 -acodec libmp3lame "${ctaFinalAudio}"`,
          'cta_mix_with_sfx'
        );
        console.log(`[CTA-COMBINED] Mixed sfx@${LIKE_T}/${SHARE_T}/${SUB_T}s + cta4@${CTA4_T}s (mono)`);
      } catch(e) {
        console.warn(`[CTA-COMBINED] SFX mix failed (${e.message}) — cta4-only fallback`);
        const lead=path.join(workDir,'cta_lead.mp3'), tail=path.join(workDir,'cta_tail.mp3');
        await silence(CTA4_T, lead); await silence(CTA_TAIL, tail);
        await concatAudio([lead, cta4Mp3, tail], ctaFinalAudio, workDir);
      }
    } else {
      // SFX download failed — still must play cta4 audio
      console.warn(`[CTA-COMBINED] pillSfx unavailable — cta4-only at ${CTA4_T}s`);
      const lead=path.join(workDir,'cta_lead.mp3'), tail=path.join(workDir,'cta_tail.mp3');
      await silence(CTA4_T, lead); await silence(CTA_TAIL, tail);
      await concatAudio([lead, cta4Mp3, tail], ctaFinalAudio, workDir);
    }

    await checkAndBoostVolume(ctaFinalAudio, 'cta_final_audio');
    console.log(`[CTA-COMBINED] final audio dur=${(await audioDur(ctaFinalAudio)).toFixed(2)}s`);

    // Record visual
    const ctaRawVideo = path.join(workDir,'clip_cta_combined_raw.mp4');
    const recCta = new PuppeteerScreenRecorder(page, { fps:30, videoFrame:{width:1080,height:1920}, aspectRatio:'9:16', followNewTab:false });
    await recCta.start(ctaRawVideo);
    await new Promise(r=>setTimeout(r, totalCtaDur * 1000));
    await withTimeout(recCta.stop(), TIMEOUT_RECORDER, 'clip_cta_combined recorder.stop()');

    // Re-encode video-only (no audio)
    const ctaH264 = path.join(workDir,'clip_cta_combined_h264.mp4');
    await ffmpeg(`-y -i "${ctaRawVideo}" -an -c:v libx264 -crf 28 -preset faster -pix_fmt yuv420p -r 30 -vf "scale=1080:1920" "${ctaH264}"`, 'cta_combined reencode');

    // Mux: -ac 1 (MONO) + 128k to EXACTLY match other clips → concat won't drop audio.
    const ctaOut = path.join(workDir,'clip_cta_combined.mp4');
    await ffmpeg(
      `-y -stream_loop -1 -i "${ctaH264}" -i "${ctaFinalAudio}" ` +
      `-map 0:v:0 -map 1:a:0 ` +
      `-c:v libx264 -crf 28 -preset faster -pix_fmt yuv420p -r 30 ` +
      `-c:a aac -b:a 128k -ar 44100 -ac 1 ` +
      `-t ${totalCtaDur} "${ctaOut}"`,
      'cta_combined mux'
    );
    const ctaActualDur = await videoDur(ctaOut);
    await checkAndBoostVolume(ctaOut, 'clip_cta_combined_out');
    console.log(`[CTA-COMBINED] final clip: ${ctaActualDur.toFixed(2)}s (mono 128k)`);
    pushClip({ path: ctaOut, dur: ctaActualDur });
  }

  await browser.close();

  // ══ FINAL ASSEMBLY ══
  console.log(`[VIDEO] Assembling ${clips.length} clips. Per-clip durations:`);
  let runningTotal = 0;
  for (const c of clips) { runningTotal += c.dur; console.log(`  ${path.basename(c.path)}: ${c.dur.toFixed(2)}s (cumulative ${runningTotal.toFixed(2)}s)`); }

  const concatTxt=path.join(workDir,'concat.txt');
  await fs.writeFile(concatTxt,clips.map(c=>`file '${c.path.replace(/'/g,"'\\''")}' `).join('\n'));
  const concatenated=path.join(workDir,'concatenated.mp4');
  await ffmpeg(`-y -f concat -safe 0 -i "${concatTxt}" -c:v libx264 -crf 28 -preset faster -pix_fmt yuv420p -r 30 -c:a aac -b:a 128k -ar 44100 -movflags +faststart "${concatenated}"`, 'finalConcat');
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
  console.log(`[BGMUSIC] About to apply: resolvedBgFile=${resolvedBgFile} total=${total.toFixed(2)}s voiceRanges=${voiceRanges.length}`);
  let finalVideoPath;
  try {
    finalVideoPath = await applyBgMusic(concatenated, total, voiceRanges, resolvedBgFile, workDir);
  } catch (e) {
    console.error(`[BGMUSIC] applyBgMusic FAILED: ${e.message} — using video without bg music`);
    finalVideoPath = concatenated;
  }
  return { videoPath: finalVideoPath, thumbnailUrl, heroImageUrl };
}

processJobs()
  .then(()=>{ console.log('[WORKER] Done.'); process.exit(0); })
  .catch(err=>{ console.error('[WORKER] Fatal:',err); process.exit(1); });
