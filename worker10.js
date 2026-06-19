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

// Niche-specific centerpiece icon for the thumbnail
const NICHE_ICON = {
  finance: '💰', tech: '🤖', health: '🧠', general: '🧠',
  science: '🔬', history: '🏛️', sports: '🏆', geography: '🌍',
  entertainment: '🎬', food: '🍔', nature: '🌿', space: '🚀'
};
function thumbIconFor(niche) {
  return NICHE_ICON[(niche||'general').toLowerCase()] || '❓';
}

const BG_VOL_BASE = 0.10;
const BG_VOL_DUCK = 0.035;
const DUCK_RAMP   = 0.12;

const GAP_DEFAULT     = 0.25;
const GAP_OPTIONS     = 0.30;
const GAP_ANSWER      = 0.35;
const DEFAULT_THINKING_TIME = 10;
const MAX_TTS_FALLBACK_SEC = 6;

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

async function tts(text, voice, out, fallbackSec = 1.5) {
  const t = (text || '').trim();
  if (!t) { await silence(fallbackSec, out); return; }
  const tmp = out + '.txt';
  await fs.writeFile(tmp, t, 'utf8');
  try {
    await withTimeout(execPromise(`edge-tts --voice "${voice}" --file "${tmp}" --write-media "${out}"`), TIMEOUT_TTS, 'tts');
    if (!(await fileExists(out)) || (await audioDur(out)) === 0) { console.warn('[TTS WARN] empty output'); await silence(fallbackSec, out); }
    else {
      const d = await audioDur(out);
      if (d > MAX_TTS_FALLBACK_SEC + 10) {
        console.warn(`[TTS WARN] unexpectedly long TTS (${d.toFixed(1)}s) for text: "${t.slice(0,60)}..."`);
      }
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

async function imgClip(img, audioP, dur, workDir, name) {
  const out = path.join(workDir, `${name}.mp4`);
  const safeDur = Math.max(0.3, dur);
  await ffmpeg(
    `-y -loop 1 -i "${img}" -i "${audioP}" -c:v libx264 -t ${safeDur} -pix_fmt yuv420p -r 30 ` +
    `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" ` +
    `-c:a aac -b:a 128k -ar 44100 -shortest "${out}"`, `imgClip ${name}`
  );
  const actualDur = await videoDur(out);
  console.log(`[CLIP] ${name}: requested=${safeDur.toFixed(2)}s actual=${actualDur.toFixed(2)}s`);
  return { path: out, dur: actualDur };
}

// ─────────────────────────────────────────────
// BACKGROUND MUSIC DUCKING
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
  await ffmpeg(`-y -i "${concatMp4}" -i "${mixedAudio}" -c:v copy -map 0:v:0 -map 1:a:0 -c:a aac -b:a 192k -t ${totalDur} -movflags +faststart "${finalMp4}"`, 'remux');
  const finalDur = await videoDur(finalMp4);
  console.log(`[BGMUSIC] Final video duration after remux: ${finalDur.toFixed(2)}s (target was ${totalDur.toFixed(2)}s)`);
  return finalMp4;
}

// ─────────────────────────────────────────────
// THEME + NICHE BACKGROUND
// ─────────────────────────────────────────────
async function resolveTheme(quiz) {
  const base    = await fs.readFile(path.join(THEMES_DIR,'_base.css'),'utf8');
  const themeId = quiz.visual_theme_id || DEFAULT_THEME;
  let themeFile = path.join(THEMES_DIR,`${themeId}.css`);
  if (!(await fileExists(themeFile))) { console.warn(`[THEME] '${themeId}' not found`); themeFile = path.join(THEMES_DIR,`${DEFAULT_THEME}.css`); }
  let css = base + '\n' + (await fs.readFile(themeFile,'utf8'));
  const a1=quiz.theme_accent_primary||'#00e0ff', a2=quiz.theme_accent_secondary||'#7b2ff7', a3=quiz.theme_accent_tertiary||'#ff2ec4';
  css = css.split('{{accent_primary}}').join(a1).split('{{accent_secondary}}').join(a2).split('{{accent_tertiary}}').join(a3);
  // Custom background is now handled separately via nicheBgCss; no need to embed quiz_background_css here.
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

// --- NEW: Niche & Topic specific animated background ---
function getNicheBackground(quiz) {
  // If a custom background is provided, use it directly
  if (quiz.quiz_background_css && quiz.quiz_background_css.trim()) {
    return `<style>/* custom background */\n${quiz.quiz_background_css}\n</style>`;
  }

  const niche = (quiz.niche || 'general').toLowerCase();
  const bgConfigs = {
    finance: {
      gradient: 'radial-gradient(circle at 20% 20%, rgba(255,215,0,0.4), transparent 45%), radial-gradient(circle at 80% 70%, rgba(0,200,100,0.4), transparent 45%), linear-gradient(160deg, #0a1a10, #0d2e1a 60%, #050f08)',
      colors: ['#ffd700', '#00e676', '#1a8a4a'],
      animation: 'bgShift 14s ease-in-out infinite alternate',
      extra: '.bg-anim { background-size: 200% 200%; } .bg-anim::after { content: ""; position: absolute; inset: 0; background-image: radial-gradient(circle at 30% 40%, rgba(255,215,0,0.1) 2px, transparent 2px); background-size: 60px 60px; animation: floatDots 20s linear infinite; }'
    },
    tech: {
      gradient: 'radial-gradient(circle at 30% 30%, rgba(0,200,255,0.4), transparent 45%), radial-gradient(circle at 70% 70%, rgba(100,0,255,0.3), transparent 45%), linear-gradient(160deg, #050a20, #0a1a3d 60%, #020510)',
      colors: ['#00e0ff', '#7b2ff7', '#ff2ec4'],
      animation: 'bgShift 12s ease-in-out infinite alternate',
      extra: '.bg-anim { background-size: 200% 200%; } .bg-grid { opacity: 0.3; background-image: linear-gradient(rgba(0,224,255,0.3) 1px, transparent 1px), linear-gradient(90deg, rgba(0,224,255,0.3) 1px, transparent 1px); background-size: 40px 40px; animation: gridMove 6s linear infinite; }'
    },
    health: {
      gradient: 'radial-gradient(circle at 40% 30%, rgba(0,255,150,0.35), transparent 45%), radial-gradient(circle at 60% 80%, rgba(0,200,255,0.3), transparent 45%), linear-gradient(160deg, #0a1a10, #0d2e1a 60%, #050f08)',
      colors: ['#00ff8c', '#00ccff', '#7b2ff7'],
      animation: 'bgShift 16s ease-in-out infinite alternate',
      extra: '.bg-anim { background-size: 200% 200%; } .bg-anim::before { content: ""; position: absolute; inset: 0; background: repeating-linear-gradient(45deg, transparent, transparent 30px, rgba(0,255,150,0.05) 30px, rgba(0,255,150,0.05) 32px); animation: gridMove 8s linear infinite; }'
    },
    general: {
      gradient: 'radial-gradient(circle at 20% 20%, rgba(100,100,255,0.3), transparent 45%), radial-gradient(circle at 80% 80%, rgba(200,100,255,0.25), transparent 45%), linear-gradient(160deg, #0a0820, #1a0a3d 60%, #05030f)',
      colors: ['#a78bfa', '#34d399', '#f472b6'],
      animation: 'bgShift 15s ease-in-out infinite alternate',
      extra: '.bg-anim { background-size: 200% 200%; }'
    }
  };
  const cfg = bgConfigs[niche] || bgConfigs.general;

  const bgCSS = `
  <style>
    .bg-anim {
      background: ${cfg.gradient};
      background-size: 200% 200%;
      animation: ${cfg.animation};
    }
    ${cfg.extra || ''}
    .orb1 { background: ${cfg.colors[0]}; }
    .orb2 { background: ${cfg.colors[1]}; }
    .orb3 { background: ${cfg.colors[2]}; }
    .bg-anim::after {
      content: "${quiz.topic ? quiz.topic.slice(0, 20) : ''}";
      position: absolute; bottom: 20px; right: 20px;
      font-size: 14px; color: rgba(255,255,255,0.04);
      font-weight: 900; letter-spacing: 4px;
      text-transform: uppercase;
      pointer-events: none;
    }
  </style>
  `;
  return bgCSS;
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
// MAIN VIDEO BUILDER (with intro-flash removed, niche background added)
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
  const introSpeech = quiz.quiz_intro_speech|| ''; // kept for reference but not used

  const miQuestion = quiz.mission_impossible_question || null;
  const miOptions  = quiz.mission_options_1           || [];
  const hasMI      = !!(miQuestion);

  const QTIME    = Math.min(quiz.thinking_time_sec || DEFAULT_THINKING_TIME, 14);
  const HINT_AT  = QTIME / 4;
  const FIFTY_AT = QTIME * 2 / 3;

  const allIdx  = [0,1,2,3];
  const keepIdx = keep5050.map(v=>(typeof v==='string'?parseInt(v):v));
  const elimIdx = allIdx.filter(i=>!keepIdx.includes(i));
  const optClass= i=>elimIdx.includes(i)?'eliminate':'';
  const revClass= i=>options[i]===correct?'correct':'wrong';

  const cta1Desc = (quiz.cta1_description_text || '').trim();
  const affUrl   = (quiz.affiliate_url || '').trim();
  const hasCta1  = !!(cta1Desc || affUrl);

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

  // Resolve theme
  const { themeCss, decoHtml } = await resolveTheme(quiz);

  // Get niche-specific animated background CSS
  const nicheBgCss = getNicheBackground(quiz);

  // Build HTML
  let html = await fs.readFile(path.join(__dirname,'quiz_template.html'),'utf8');
  const R = {
    '{{theme_css}}':themeCss,
    '{{niche_bg_css}}': nicheBgCss,
    '{{theme_deco_html}}':decoHtml,
    '{{LOGO_DATA_URI}}':logoDataUri,
    '{{hook_phrase}}':quiz.hook_phrase||'Stop scrolling! Can you beat this?',
    '{{quiz_intro_speech}}':introSpeech, // kept for template but no slide uses it
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

  // ─── THUMBNAIL ───
  await showOnly('.thumb-screen');
  await new Promise(r=>setTimeout(r,500));
  const thumbImg = await shot('thumbnail_master');
  let thumbnailUrl = null;
  if (R2_CONFIGURED) thumbnailUrl = await uploadThumbnailToR2(thumbImg, quiz.id);

  // ─── STEP 1: HOOK (screen-recorded) ───
  await page.goto(`file://${htmlPath}`,{waitUntil:'domcontentloaded'});
  await new Promise(r=>setTimeout(r,300));
  await showOnly('.hook-slide');
  await page.evaluate(()=>{
    const lw = document.querySelector('.hook-slide .logo-wrap');
    const ht = document.querySelector('.hook-slide .hook-text');
    [lw,ht].forEach(el=>{ if(el){ el.style.animation='none'; el.offsetHeight; el.style.animation=''; }});
  });
  const HOOK_RECORD_SEC = 2.6;
  const hookRawVideo = path.join(workDir,'hook_raw.mp4');
  const hookRecorder = new PuppeteerScreenRecorder(page,{fps:30,videoFrame:{width:1080,height:1920},aspectRatio:'9:16'});
  await hookRecorder.start(hookRawVideo);
  await new Promise(r=>setTimeout(r,HOOK_RECORD_SEC*1000));
  await withTimeout(hookRecorder.stop(),TIMEOUT_RECORDER,'hookRecorder.stop()');

  const hookAudio = await buildAudio({
    prerecorded:hookFile, fallbackText:quiz.hook_phrase||'Stop scrolling!',
    fallbackSec:2.5, voice, leadGap:0.1, workDir, name:'hook'
  });
  const hookClipDur = Math.min(Math.max(hookAudio.dur, HOOK_RECORD_SEC), 4.0);
  const hookH264 = path.join(workDir,'hook_h264.mp4');
  await ffmpeg(`-y -i "${hookRawVideo}" -c:v libx264 -pix_fmt yuv420p -r 30 -vf "scale=1080:1920" "${hookH264}"`, 'hookReencode');
  const hookClipPath = path.join(workDir,'clip_hook.mp4');
  await ffmpeg(
    `-y -stream_loop -1 -i "${hookH264}" -i "${hookAudio.path}" -c:v libx264 -t ${hookClipDur} -pix_fmt yuv420p -r 30 -c:a aac -b:a 128k -ar 44100 -map 0:v:0 -map 1:a:0 "${hookClipPath}"`,
    'hookFinalClip'
  );
  pushClip({ path: hookClipPath, dur: await videoDur(hookClipPath) });

  // ─── STEP 2: question_intro_audio_url plays, question HIDDEN ───
  // (intro-flash removed, now we go directly to the waiting slide)
  await showOnly('.question-waiting-slide');
  await new Promise(r=>setTimeout(r,200));
  const qWaitImg = await shot('question_waiting');
  const qIntroAudio = await buildAudio({
    prerecorded: questionIntroFile, fallbackText: '', fallbackSec: 0.8,
    voice, leadGap: 0.15, workDir, name: 'qintro'
  });
  pushClip(await imgClip(qWaitImg, qIntroAudio.path, qIntroAudio.dur, workDir, 'clip_qwait'), false);

  // ─── STEP 3: question_1 REVEALED + sfx + TTS ───
  await showOnly('.question-appear-slide');
  await new Promise(r=>setTimeout(r,500));
  const qAppearImg = await shot('question_appear');
  const step3bParts=[];
  if(sfxFile){ const g=path.join(workDir,'sfx_gap.mp3'); await silence(0.1,g); step3bParts.push(sfxFile,g); }
  const qTts=path.join(workDir,'q_tts.mp3'); await tts(question,voice,qTts,3); step3bParts.push(qTts);
  const step3bCombined=path.join(workDir,'step3b.mp3');
  await concatAudio(step3bParts,step3bCombined,workDir);
  pushClip(await imgClip(qAppearImg,step3bCombined,Math.max(await audioDur(step3bCombined),2),workDir,'clip_q_reveal'));

  // ─── STEP 4a: options_intro_audio_url plays, options HIDDEN ───
  await showOnly('.options-waiting-slide');
  await new Promise(r=>setTimeout(r,200));
  const oWaitImg = await shot('options_waiting');
  const oIntroAudio = await buildAudio({
    prerecorded: optionsIntroFile, fallbackText: 'And your options are', fallbackSec: 1.5,
    voice, leadGap: GAP_OPTIONS, workDir, name: 'ointro'
  });
  pushClip(await imgClip(oWaitImg, oIntroAudio.path, oIntroAudio.dur, workDir, 'clip_owait'), false);

  // ─── STEP 4b: options_1 REVEALED + TTS each + "time starts now" ───
  await showOnly('.question-static');
  await new Promise(r=>setTimeout(r,500));
  const optionsImg = await shot('options_static');
  const s4bp=[];
  if(sfxFile){ const sg=path.join(workDir,'sfxgap2.mp3'); await silence(0.1,sg); s4bp.push(sfxFile,sg); }
  for(let i=0;i<options.length;i++){
    if(!options[i]) continue;
    const os=path.join(workDir,`o_sil_${i}.mp3`); await silence(0.2,os);
    const ot=path.join(workDir,`o_tts_${i}.mp3`); await tts(`${String.fromCharCode(65+i)}. ${options[i]}`,voice,ot,1);
    s4bp.push(os,ot);
  }
  const sng=path.join(workDir,'start_now_gap.mp3'); await silence(0.3,sng);
  const snt=path.join(workDir,'start_now.mp3');
  await tts(`You have only ${QTIME} seconds to crack the challenge — and your time starts now!`,voice,snt,3);
  s4bp.push(sng,snt);
  const step4bCombined=path.join(workDir,'step4b.mp3');
  await concatAudio(s4bp,step4bCombined,workDir);
  pushClip(await imgClip(optionsImg,step4bCombined,Math.max(await audioDur(step4bCombined),3),workDir,'clip_options_reveal'));

  // ─── COUNTDOWN (recorded) ───
  await page.goto(`file://${htmlPath}`,{waitUntil:'domcontentloaded'});
  await new Promise(r=>setTimeout(r,400));
  await showOnly('.question-phase');
  await page.evaluate(()=>{ document.querySelector('.question-phase')?.offsetHeight; });
  await new Promise(r=>setTimeout(r,100));

  const rawVideo=path.join(workDir,'phase_raw.mp4');
  const recorder=new PuppeteerScreenRecorder(page,{fps:30,videoFrame:{width:1080,height:1920},aspectRatio:'9:16'});
  await recorder.start(rawVideo);
  await new Promise(r=>setTimeout(r,QTIME*1000));
  await withTimeout(recorder.stop(),TIMEOUT_RECORDER,'recorder.stop()');

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
  const qClipRaw=path.join(workDir,'phase_h264.mp4'), qClipPath=path.join(workDir,'clip_countdown.mp4');
  await ffmpeg(`-y -i "${rawVideo}" -c:v libx264 -pix_fmt yuv420p -r 30 -vf "scale=1080:1920" "${qClipRaw}"`, 'reencodeRecording');
  await ffmpeg(`-y -i "${qClipRaw}" -i "${cdFinal}" -c:v libx264 -c:a aac -b:a 128k -ar 44100 -map 0:v:0 -map 1:a:0 -shortest -t ${QTIME} "${qClipPath}"`, 'countdownClip');
  pushClip({path:qClipPath,dur:await videoDur(qClipPath)});

  // ─── TIMEUP ───
  await page.goto(`file://${htmlPath}`,{waitUntil:'domcontentloaded'});
  await new Promise(r=>setTimeout(r,300));
  await showOnly('.pre-reveal-slide');
  const preRevealImg = await shot('pre_reveal');
  const timeupAudio = await buildAudio({
    prerecorded:timeupFile, fallbackText:quiz.timeup_text||"Time's up!",
    fallbackSec:2, voice, leadGap:GAP_DEFAULT, workDir, name:'timeup'
  });
  pushClip(await imgClip(preRevealImg,timeupAudio.path,timeupAudio.dur,workDir,'clip_timeup'));

  // ─── ANSWER REVEAL ───
  await showOnly('.answer-slide');
  await new Promise(r=>setTimeout(r,300));
  const answerImg = await shot('answer');
  const s10p=[];
  const silRev=path.join(workDir,'sil_reveal.mp3'); await silence(GAP_ANSWER,silRev); s10p.push(silRev);
  if(correctSfxFile){ s10p.push(correctSfxFile); const sg3=path.join(workDir,'sfxgap3.mp3'); await silence(0.15,sg3); s10p.push(sg3); }
  const correctTts=path.join(workDir,'correct_tts.mp3'); await tts(correct,voice,correctTts,1.5); s10p.push(correctTts);
  const step10Combined=path.join(workDir,'step10.mp3');
  await concatAudio(s10p,step10Combined,workDir);
  pushClip(await imgClip(answerImg,step10Combined,Math.max(await audioDur(step10Combined),2),workDir,'clip_answer'));

  // ─── MISSION IMPOSSIBLE (if present) ───
  if (hasMI) {
    await showOnly('.mission-final-slide');
    await page.evaluate(()=>{
      const c=document.getElementById('mi-cta3');
      if(c) c.classList.remove('show-cta3');
    });
    await new Promise(r=>setTimeout(r,400));
    const miImg = await shot('mi_combined');
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
    pushClip(await imgClip(miImg,miAudio,Math.max(miAudioDur,2.5),workDir,'clip_mi'));

    // cta3 fade in
    await page.evaluate(()=>{
      const c=document.getElementById('mi-cta3');
      if(c) c.classList.add('show-cta3');
    });
    await new Promise(r=>setTimeout(r,400));
    const cta3Img = await shot('mi_with_cta3');
    const cta3Audio = await buildAudio({
      prerecorded:cta3AudioFile, fallbackText:quiz.cta3_text||'Like, share and challenge a friend! Subscribe!',
      fallbackSec:4, voice, leadGap:0.15, workDir, name:'cta3'
    });
    pushClip(await imgClip(cta3Img,cta3Audio.path,cta3Audio.dur,workDir,'clip_cta3'));
  }

  // ─── FINAL CTA ───
  await showOnly(hasCta1?'.cta1-slide':'.cta2-slide');
  await new Promise(r=>setTimeout(r,400));
  const ctaImg = await shot('cta');
  const ctaAudio = await buildAudio({
    prerecorded:hasCta1?cta1AudioFile:cta2AudioFile,
    fallbackText:hasCta1
      ?(cta1Desc||quiz.affiliate_text||'Check the exclusive link in the description below!')
      :(quiz.cta2_text||'Play the real quiz and earn O.N.S tokens! Tap the link now!'),
    fallbackSec:3, voice, leadGap:GAP_DEFAULT, workDir, name:hasCta1?'cta1':'cta2'
  });
  pushClip(await imgClip(ctaImg,ctaAudio.path,ctaAudio.dur,workDir,'clip_cta'));

  await browser.close();

  // ─── FINAL ASSEMBLY ───
  console.log(`[VIDEO] Assembling ${clips.length} clips.`);
  const concatTxt=path.join(workDir,'concat.txt');
  await fs.writeFile(concatTxt,clips.map(c=>`file '${c.path.replace(/'/g,"'\\''")}' `).join('\n'));
  const concatenated=path.join(workDir,'concatenated.mp4');
  await ffmpeg(`-y -f concat -safe 0 -i "${concatTxt}" -c:v libx264 -pix_fmt yuv420p -r 30 -c:a aac -b:a 128k -ar 44100 -movflags +faststart "${concatenated}"`, 'finalConcat');
  const total=await videoDur(concatenated);
  console.log(`[VIDEO] Concatenated: ${total.toFixed(1)}s`);
  const finalVideoPath = await applyBgMusic(concatenated,total,voiceRanges,bgFile,workDir);
  return { videoPath: finalVideoPath, thumbnailUrl };
}

// ─────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────
processJobs()
  .then(()=>{ console.log('[WORKER] Done.'); process.exit(0); })
  .catch(err=>{ console.error('[WORKER] Fatal:',err); process.exit(1); });
