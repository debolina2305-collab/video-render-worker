'use strict';
// ════════════════════════════════════════════════════════════════════════════
// puzzle_render_micro.js — "MICRO" ultra-short puzzle format (~10 seconds)
//
// COMPLETELY NEW, SELF-CONTAINED worker. Does not modify, require, or share
// any state/columns with worker8.js / worker10*.js / puzzle_render_short.js /
// puzzlerenderswithoutintro.js / puzzleAssigner.js / formatAssigner.js. The
// ONLY existing file it reuses is puzzleRenderers.js (the pure SVG drawing
// engine) — reusing that is intentional, since it's the thing that turns
// puzzle_spec into the visual and re-implementing it would just re-introduce
// the same rendering bugs it already fixed.
//
// SCREEN / SCRIPT (updated):
//   Screen 1 (whole video): the puzzle SVG, EXTREMELY large, with the 4
//   options below it, PLUS a hint line shown from the very start. No logo,
//   no host/avatar clip, no marquee, no CTA card. A small countdown badge
//   appears in the corner once the countdown starts, a "pause" caption
//   appears partway through the countdown, a 50/50 eliminates two wrong
//   options 2 seconds into the countdown, then the correct option is
//   highlighted at the end. The puzzle card animates in and gently pulses
//   throughout instead of sitting static.
//
//   t=0.00                puzzle + options + hint appear (fade/scale-in), silent
//   t=0.00                TTS: "Can you solve it within 5 seconds?"
//   (tts ends) +0.25s     5-second countdown starts (corner badge, 5→1)
//   +1.50s into countdown TTS: "Pause the video if you need more time!"
//   +2.00s into countdown 50/50 — two wrong options fade + get crossed out
//   +5.00s into countdown countdown ends → correct option highlighted
//   +0.15s after reveal   TTS: "Did you find the answer within 5 seconds?
//                                Write it in the comments!"
//   (tts ends) +0.40s     video ends
//
//   Every timestamp above is driven by the REAL length of the generated TTS
//   audio (edge-tts), the same "durations are 100% dynamic" philosophy the
//   rest of this pipeline uses — nothing here is a hardcoded video length.
//   With the four lines above at a natural speaking pace the total lands
//   close to ~10 seconds; tune RATE / TAIL_BUFFER / GAP_* below to taste.
//
// DATA SOURCE: reads ONE row from the EXISTING `puzzle` table (question_1,
// options_1, correct_answer_1, puzzle_type, puzzle_spec, theme_accent_*).
// It does NOT read puzzle_queue, and it does NOT touch short_status /
// medium_status / long_status / assigned_format — a puzzle can get a MICRO
// video independently of (and in addition to) its short/medium/long video.
//
// REQUIRED ONE-TIME SUPABASE MIGRATION (new columns, additive only):
//   alter table public.puzzle add column if not exists micro_status text null;
//   alter table public.puzzle add column if not exists micro_video_url text null;
//   create index if not exists idx_puzzle_micro_status
//     on public.puzzle (micro_status, is_active, created_at)
//     where (micro_status is null or micro_status = 'pending_micro');
//
// micro_status lifecycle (mirrors the existing short/medium/long convention,
// but is entirely local to this file — nothing else reads/writes it):
//   NULL | 'pending_micro'  → eligible to render (NULL = not yet touched)
//   'rendering_micro'       → claimed by a worker (auto-reset if stuck >20m)
//   'done_micro'            → finished, micro_video_url is set
//   'error_micro'           → failed (retried automatically after 15 min)
//
// ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY,
//      [R2_ACCESS_KEY, R2_SECRET_KEY, R2_ENDPOINT, R2_BUCKET, R2_PUBLIC_URL]
//      (R2 optional — without it the mp4 is still produced locally and
//      picked up by the GitHub Actions artifact upload step)
//
// DEPLOY: `node puzzle_render_micro.js` — single-shot, run by
//         render_puzzle_micro.yml (also completely new).
// ════════════════════════════════════════════════════════════════════════════

const { exec }       = require('child_process');
const util            = require('util');
const execPromise      = util.promisify(exec);
const fs               = require('fs').promises;
const path             = require('path');
const puppeteer         = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const { v4: uuidv4 }    = require('uuid');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { renderPuzzle }  = require('./puzzleRenderers');

// ─── ENV ────────────────────────────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const cleanUrl     = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;
if (!cleanUrl || !supabaseKey) { console.error('[MICRO] Missing Supabase credentials'); process.exit(1); }

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

// ─── CONSTANTS ──────────────────────────────────────────────────────────────
const VOICE_MAP = {
  en: 'en-US-JennyNeural', hi: 'hi-IN-SwaraNeural',
  es: 'es-ES-ElviraNeural', pt: 'pt-BR-FranciscaNeural'
};
const TTS_RATE          = '+8%';   // slightly snappier than default, keeps total near ~10s
const CACHE_DIR         = '/tmp/puzzle_micro_cache';
const TIMEOUT_JOB        = 10 * 60 * 1000;
const TIMEOUT_RECORDER   = 60 * 1000;
const VIDEO_W            = 1080;
const VIDEO_H            = 1920;

const COUNTDOWN_SECONDS  = 5;     // fixed — "can you solve it within 5 sec"
const GAP_AFTER_ASK_TTS  = 0.25;  // silence between "Can you solve it...?" and countdown start
const PAUSE_CAPTION_AT   = 1.5;   // seconds INTO the countdown when the pause line fires
const FIFTY_FIFTY_AT     = 2.0;   // seconds INTO the countdown when two wrong options fade out
const GAP_BEFORE_REVEAL_TTS = 0.15;
const TAIL_BUFFER        = 0.40;  // silence after the final line before the clip ends

const LINE_ASK    = 'Can you solve it within 5 seconds?';
const LINE_PAUSE  = 'Pause the video if you need more time!';
const LINE_REVEAL = 'Did you find the answer within 5 seconds? Write it in the comments!';

const STUCK_RESET_MIN = 20;  // reclaim rows stuck in 'rendering_micro' after this many minutes
const ERROR_RETRY_MIN = 15;  // retry rows stuck in 'error_micro' after this many minutes

// ─── SUPABASE ───────────────────────────────────────────────────────────────
function sbHeaders() {
  return { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };
}
async function fetchSupabase(pathStr) {
  const res = await fetch(`${cleanUrl}/rest/v1/${pathStr}`, { headers: sbHeaders() });
  const txt = await res.text();
  if (!res.ok) throw new Error(`GET ${pathStr} → ${res.status}: ${txt.slice(0, 300)}`);
  return txt.trim() ? JSON.parse(txt) : [];
}
async function patchSupabase(pathStr, body) {
  const res = await fetch(`${cleanUrl}/rest/v1/${pathStr}`, {
    method: 'PATCH',
    headers: { ...sbHeaders(), Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${pathStr} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// ─── FS / PROCESS HELPERS ────────────────────────────────────────────────────
async function ensureDir(d)  { await fs.mkdir(d, { recursive: true }); }
async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }
function withTimeout(promise, ms, label = '') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout: ${label} (${ms}ms)`)), ms)),
  ]);
}
async function ffmpeg(args, label = '') {
  const cmd = `ffmpeg ${args}`;
  console.log(`[FF:${label}] ${cmd.slice(0, 160)}`);
  return execPromise(cmd, { maxBuffer: 100 * 1024 * 1024 });
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
async function silence(sec, outPath) {
  await ffmpeg(`-y -f lavfi -i anullsrc=r=44100:cl=mono -t ${sec} -ar 44100 -ac 1 -acodec libmp3lame "${outPath}"`, 'sil');
}

// ─── TTS ────────────────────────────────────────────────────────────────────
const TTS_VOLUME_GAIN = 2.6;
async function boostTtsVolume(filePath) {
  const tmp = `${filePath}.boost.mp3`;
  try {
    await ffmpeg(
      `-y -i "${filePath}" -af "volume=${TTS_VOLUME_GAIN},alimiter=limit=0.95" -ar 44100 -ac 1 -acodec libmp3lame "${tmp}"`,
      'ttsVol'
    );
    await fs.rename(tmp, filePath);
  } catch (e) { console.warn(`[TTS-VOL] boost failed (non-fatal): ${e.message.slice(0, 100)}`); }
}
async function tts(text, voice, outPath, retries = 3) {
  if (!text?.trim()) { await silence(0.5, outPath); return; }
  const safe = text.replace(/"/g, "'").replace(/[^\x00-\x7F]/g, ' ').slice(0, 300);
  for (let i = 0; i < retries; i++) {
    try {
      await execPromise(`edge-tts --voice "${voice}" --rate="${TTS_RATE}" --text "${safe}" --write-media "${outPath}"`);
      if (await fileExists(outPath)) { await boostTtsVolume(outPath); return; }
    } catch (e) {
      console.warn(`[TTS] attempt ${i + 1}: ${e.message.slice(0, 90)}`);
      if (i < retries - 1) await new Promise(r => setTimeout(r, 1000));
    }
  }
  await silence(1, outPath);
}

// ─── DOWNLOAD (optional sfx reused from the puzzle row — best-effort) ───────
async function download(url, name) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) return null;
  await ensureDir(CACHE_DIR);
  const ext  = url.split('?')[0].split('.').pop().toLowerCase() || 'mp3';
  const safe = name.replace(/[^a-z0-9_]/gi, '_').slice(0, 40);
  const dest = path.join(CACHE_DIR, `${safe}.${ext}`);
  if (await fileExists(dest)) return dest;
  try {
    const res = await withTimeout(fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 JaasX-Micro/1.0' } }), 20000, `dl:${name}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    await fs.writeFile(dest, buf);
    return dest;
  } catch (e) {
    console.warn(`[DL] FAILED ${name}: ${e.message.slice(0, 80)}`);
    return null;
  }
}

// ─── JOB CLAIMING (micro_status is entirely local to this file) ────────────
async function claimMicroRow() {
  // Reclaim rows stuck mid-render
  try {
    const stuckCutoff = new Date(Date.now() - STUCK_RESET_MIN * 60000).toISOString();
    const stuck = await fetchSupabase(
      `puzzle?micro_status=eq.rendering_micro&is_active=eq.true&updated_at=lt.${stuckCutoff}&select=id&limit=5`
    ).catch(() => null);
    for (const r of stuck || []) {
      await patchSupabase(`puzzle?id=eq.${r.id}`, { micro_status: 'pending_micro', updated_at: new Date().toISOString() }).catch(() => {});
    }
  } catch {}

  // Retry old errors after a cooldown
  try {
    const errCutoff = new Date(Date.now() - ERROR_RETRY_MIN * 60000).toISOString();
    const errored = await fetchSupabase(
      `puzzle?micro_status=eq.error_micro&is_active=eq.true&updated_at=lt.${errCutoff}&select=id&limit=3`
    ).catch(() => null);
    for (const r of errored || []) {
      await patchSupabase(`puzzle?id=eq.${r.id}`, { micro_status: 'pending_micro', updated_at: new Date().toISOString() }).catch(() => {});
    }
  } catch {}

  // Fresh/pending rows first (NULL == never touched by the micro pipeline)
  let candidates;
  try {
    candidates = await fetchSupabase(
      `puzzle?or=(micro_status.is.null,micro_status.eq.pending_micro)` +
      `&is_active=eq.true&puzzle_enriched=eq.true&order=created_at.desc&limit=1&select=*`
    );
  } catch (e) {
    // Previously this was `.catch(() => null)`, which made a genuine query
    // failure (e.g. the micro_status column not existing yet — see the
    // REQUIRED ONE-TIME SUPABASE MIGRATION comment at the top of this file)
    // print the exact same "No pending puzzle rows." as a real empty result.
    // That's a silent failure mode — log it loudly so it's diagnosable.
    console.error(`[MICRO] Query for pending rows FAILED (not just empty): ${e.message}`);
    console.error('[MICRO] If this mentions micro_status/micro_video_url, the one-time migration in the file header has not been run yet.');
    return null;
  }

  if (!candidates?.length) { console.log('[MICRO] No pending puzzle rows.'); return null; }

  const row = candidates[0];
  await patchSupabase(`puzzle?id=eq.${row.id}`, { micro_status: 'rendering_micro', updated_at: new Date().toISOString() }).catch(() => {});
  console.log(`[MICRO] Claimed puzzle id=${row.id} type=${row.puzzle_type}`);
  return row;
}
async function markMicroDone(id, videoUrl) {
  await patchSupabase(`puzzle?id=eq.${id}`, {
    micro_status: 'done_micro',
    micro_video_url: videoUrl || null,
    updated_at: new Date().toISOString(),
  }).catch(() => {});
}
async function markMicroError(id, msg) {
  await patchSupabase(`puzzle?id=eq.${id}`, {
    micro_status: 'error_micro',
    generation_error: `[puzzle-micro] ${String(msg).slice(0, 700)}`,
    updated_at: new Date().toISOString(),
  }).catch(() => {});
}

// ─── HTML BUILD (fully self-contained — no template file, no logo/host) ────
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function buildHtml(quiz, svgHtml) {
  const accent  = quiz.theme_accent_primary   || '#00e0ff';
  const accent2 = quiz.theme_accent_secondary || '#22c55e';
  const question = quiz.question_1 || '';
  const hint     = quiz.hint_1 || '';
  const options  = (quiz.options_1 || []).slice(0, 4);
  const labels   = ['A', 'B', 'C', 'D'];

  const optionsHtml = options.map((opt, i) => `
    <div class="opt" id="opt-${i}" data-idx="${i}">
      <span class="opt-badge">${labels[i]}</span>
      <span class="opt-text">${esc(opt)}</span>
      <span class="opt-mark" id="opt-mark-${i}"></span>
    </div>`).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${VIDEO_W}px; height:${VIDEO_H}px; overflow:hidden; background:#05070d; }
  body {
    font-family: 'Arial Black', Arial, Helvetica, sans-serif;
    display:flex; flex-direction:column; align-items:center; justify-content:center;
    background:
      radial-gradient(circle at 50% 12%, color-mix(in srgb, ${accent} 22%, transparent), transparent 55%),
      linear-gradient(180deg, #0a0d16 0%, #05070d 60%, #050608 100%);
    height:100%; width:100%; position:relative;
  }

  /* ── Question line — compact, above the puzzle ── */
  .question-line {
    max-width: 92vw;
    text-align:center;
    color:#ffffff;
    font-size:34px;
    font-weight:900;
    line-height:1.2;
    padding: 10px 22px;
    margin-bottom: 14px;
    background: rgba(0,0,0,0.5);
    border: 2px solid color-mix(in srgb, ${accent} 55%, rgba(255,255,255,0.12));
    border-radius: 20px;
    text-shadow: 0 2px 8px rgba(0,0,0,0.8);
  }

  /* ── Puzzle visual — EXTREMELY large, the dominant element ── */
  .puzzle-visual-wrap {
    width: 94vw;
    max-width: 94vw;
    margin: 4px auto 18px;
    border-radius: 30px;
    border: 3px solid color-mix(in srgb, ${accent} 55%, rgba(255,255,255,0.14));
    box-shadow: 0 10px 46px rgba(0,0,0,0.55),
                0 0 60px color-mix(in srgb, ${accent} 34%, transparent);
    overflow: visible;
  }
  .puzzle-visual-wrap svg, .puzzle-visual-wrap .puzzle-svg { width:100%; height:auto; display:block; }

  /* ── Options — big, bold, 2x2 grid ── */
  .options-grid {
    width: 92vw;
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .opt {
    position: relative;
    display:flex; align-items:center; gap:12px;
    background: rgba(0,0,0,0.55);
    border: 3px solid rgba(255,255,255,0.22);
    border-radius: 18px;
    padding: 20px 18px;
    color:#ffffff;
    font-size: 42px;
    font-weight: 800;
    line-height: 1.15;
    overflow-wrap: anywhere;
    transition: opacity 0.35s ease, border-color 0.35s ease, background 0.35s ease, transform 0.35s ease;
  }
  .opt-badge {
    flex-shrink:0;
    width:46px; height:46px; border-radius:50%;
    display:flex; align-items:center; justify-content:center;
    background: color-mix(in srgb, ${accent} 55%, #111);
    color:#fff; font-size:24px; font-weight:900;
  }
  .opt-mark { font-size:34px; margin-left:auto; }

  .opt.opt-correct {
    background: color-mix(in srgb, ${accent2} 28%, rgba(0,0,0,0.55));
    border-color: ${accent2};
    box-shadow: 0 0 34px color-mix(in srgb, ${accent2} 55%, transparent);
    transform: scale(1.03);
  }
  .opt.opt-fade { opacity: 0.32; }

  /* ── Countdown badge — small corner element, never covers the puzzle ── */
  .countdown-badge {
    position: fixed;
    top: 46px; right: 40px;
    width: 168px; height: 168px;
    border-radius: 50%;
    display:flex; align-items:center; justify-content:center;
    background: radial-gradient(circle at 50% 40%, rgba(0,0,0,0.75), rgba(0,0,0,0.55));
    border: 6px solid rgba(255,255,255,0.16);
    opacity: 0;
    transform: scale(0.8);
    transition: opacity 0.25s ease, transform 0.25s ease;
    z-index: 20;
  }
  .countdown-badge.show { opacity: 1; transform: scale(1); }
  .countdown-ring {
    position:absolute; inset:0; border-radius:50%;
    background: conic-gradient(${accent} calc(var(--pct,100) * 1%), rgba(255,255,255,0.12) 0);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 12px), #000 calc(100% - 11px));
            mask: radial-gradient(farthest-side, transparent calc(100% - 12px), #000 calc(100% - 11px));
  }
  .countdown-num {
    position:relative; z-index:2;
    color:#fff; font-size:78px; font-weight:900;
    text-shadow: 0 2px 10px rgba(0,0,0,0.9);
  }

  /* ── Entrance + continuous "alive" motion (recorded frame-by-frame, so
         this shows up in the final video, not just in a live browser) ── */
  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateY(26px) scale(0.96); }
    to   { opacity: 1; transform: translateY(0) scale(1); }
  }
  @keyframes puzzlePulse {
    0%, 100% { box-shadow: 0 10px 46px rgba(0,0,0,0.55), 0 0 60px color-mix(in srgb, ${accent} 34%, transparent); transform: scale(1); }
    50%      { box-shadow: 0 10px 54px rgba(0,0,0,0.6), 0 0 88px color-mix(in srgb, ${accent} 50%, transparent); transform: scale(1.012); }
  }
  .question-line     { animation: fadeSlideIn 0.5s ease both; }
  .hint-line          { animation: fadeSlideIn 0.5s ease 0.08s both; }
  .puzzle-visual-wrap { animation: fadeSlideIn 0.55s ease 0.16s both, puzzlePulse 2.6s ease-in-out 0.75s infinite; }
  .options-grid .opt  { animation: fadeSlideIn 0.45s ease both; }
  .options-grid .opt:nth-child(1) { animation-delay: 0.28s; }
  .options-grid .opt:nth-child(2) { animation-delay: 0.34s; }
  .options-grid .opt:nth-child(3) { animation-delay: 0.40s; }
  .options-grid .opt:nth-child(4) { animation-delay: 0.46s; }

  /* ── Hint line — shown from t=0, sits between question and puzzle ── */
  .hint-line {
    max-width: 90vw;
    text-align:center;
    color:#ffd24a;
    font-size:26px;
    font-weight:800;
    line-height:1.25;
    padding: 8px 20px;
    margin-bottom: 12px;
    background: rgba(0,0,0,0.45);
    border: 2px dashed rgba(255,210,74,0.55);
    border-radius: 16px;
    text-shadow: 0 2px 6px rgba(0,0,0,0.8);
  }

  /* ── 50/50 — two wrong options fade + get crossed out, 2s into countdown ── */
  .opt.opt-eliminated {
    opacity: 0.28;
    filter: grayscale(0.6);
    transform: scale(0.97);
  }
  .opt.opt-eliminated .opt-text { text-decoration: line-through; }
  .opt.opt-eliminated .opt-mark::after { content: '✖'; font-size: 30px; color: #ff5c5c; }


  .pause-caption {
    position: fixed;
    left: 5vw; right: 5vw; bottom: 54px;
    text-align:center;
    color:#ffd24a;
    font-size: 32px;
    font-weight: 900;
    letter-spacing: 0.5px;
    padding: 16px 20px;
    background: rgba(0,0,0,0.62);
    border: 2px solid rgba(255,210,74,0.55);
    border-radius: 18px;
    text-shadow: 0 2px 8px rgba(0,0,0,0.85);
    opacity: 0;
    transform: translateY(10px);
    transition: opacity 0.3s ease, transform 0.3s ease;
    z-index: 20;
  }
  .pause-caption.show { opacity: 1; transform: translateY(0); }
</style>
</head>
<body>
  <div class="question-line">${esc(question)}</div>
  ${hint ? `<div class="hint-line">💡 HINT: ${esc(hint)}</div>` : ''}
  <div class="puzzle-visual-wrap">${svgHtml}</div>
  <div class="options-grid">${optionsHtml}</div>

  <div class="countdown-badge" id="cdBadge">
    <div class="countdown-ring" id="cdRing"></div>
    <div class="countdown-num" id="cdNum">5</div>
  </div>

  <div class="pause-caption" id="pauseCaption">⏸ Pause the video if you need more time!</div>
</body>
</html>`;
}

// ─── SILENT VIDEO RECORDING (events fired in wall-clock time) ──────────────
async function recordSilentVideo(page, totalDur, workDir, events = []) {
  const rawPath   = path.join(workDir, 'micro_raw.mp4');
  const h264Path  = path.join(workDir, 'micro_h264.mp4');

  const rec = new PuppeteerScreenRecorder(page, {
    fps: 30,
    videoFrame: { width: VIDEO_W, height: VIDEO_H },
    aspectRatio: '9:16',
    followNewTab: false,
  });
  await rec.start(rawPath);

  const t0 = Date.now();
  const queue = [...events].sort((a, b) => a.at - b.at);
  for (const ev of queue) {
    const waitMs = ev.at * 1000 - (Date.now() - t0);
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    try {
      await ev.fn(page);
      console.log(`[MICRO-REC] event fired at t=${((Date.now() - t0) / 1000).toFixed(2)}s`);
    } catch (e) {
      console.warn(`[MICRO-REC] event failed: ${e.message.slice(0, 90)}`);
    }
  }
  const remainMs = totalDur * 1000 - (Date.now() - t0);
  if (remainMs > 0) await new Promise(r => setTimeout(r, remainMs));

  await withTimeout(rec.stop(), TIMEOUT_RECORDER, 'micro.stop');

  await ffmpeg(
    `-y -i "${rawPath}" -an -c:v libx264 -crf 26 -preset faster -pix_fmt yuv420p -r 30 ` +
    `-vf "scale=${VIDEO_W}:${VIDEO_H}" "${h264Path}"`,
    'micro_enc'
  );
  return h264Path;
}

// ─── AUDIO COMPOSITE (adelay + amix, same pattern used elsewhere in repo) ──
async function buildAudioTrack(workDir, parts, totalDur) {
  const outPath = path.join(workDir, 'micro_audio.mp3');
  // parts: [{ file, atSec, volume }]
  const usable = parts.filter(p => p.file);
  if (!usable.length) { await silence(totalDur, outPath); return outPath; }

  const inputs = usable.map(p => `-i "${p.file}"`).join(' ');
  const labels = usable.map((p, i) => {
    const ms  = Math.max(0, Math.round(p.atSec * 1000));
    const vol = p.volume != null ? p.volume : 1.0;
    return `[${i}:a]volume=${vol},adelay=${ms}|${ms}[s${i}]`;
  }).join(';');
  const mixIns = usable.map((_, i) => `[s${i}]`).join('');
  const filter = `${labels};${mixIns}amix=inputs=${usable.length}:duration=longest:normalize=0[a]`;

  await ffmpeg(
    `-y ${inputs} -filter_complex "${filter}" -map "[a]" -t ${totalDur} -ar 44100 -ac 1 -acodec libmp3lame "${outPath}"`,
    'micro_mix'
  );
  return outPath;
}

// ─── MAIN BUILD ──────────────────────────────────────────────────────────────
async function buildMicroVideo(quiz, workDir) {
  const lang  = quiz.lang_code || 'en';
  const voice = VOICE_MAP[lang] || VOICE_MAP.en;

  // ── 1. Generate the three TTS lines first — every timestamp below is
  //        derived from their REAL rendered durations. ──────────────────
  console.log('[MICRO] Generating TTS...');
  const askPath    = path.join(workDir, 'tts_ask.mp3');
  const pausePath  = path.join(workDir, 'tts_pause.mp3');
  const revealPath = path.join(workDir, 'tts_reveal.mp3');
  await tts(LINE_ASK, voice, askPath);
  await tts(LINE_PAUSE, voice, pausePath);
  await tts(LINE_REVEAL, voice, revealPath);

  const askDur    = await probeNum(askPath)    || 1.2;
  const pauseDur  = await probeNum(pausePath)  || 1.6;
  const revealDur = await probeNum(revealPath) || 3.2;
  console.log(`[MICRO] TTS durations — ask=${askDur.toFixed(2)}s pause=${pauseDur.toFixed(2)}s reveal=${revealDur.toFixed(2)}s`);

  // ── 2. Timeline (all absolute offsets, seconds from t=0) ───────────────
  const countdownStart = askDur + GAP_AFTER_ASK_TTS;
  const pauseAt         = countdownStart + PAUSE_CAPTION_AT;
  const fiftyFiftyAt      = countdownStart + FIFTY_FIFTY_AT;
  const revealAt         = countdownStart + COUNTDOWN_SECONDS;
  const revealTtsAt       = revealAt + GAP_BEFORE_REVEAL_TTS;
  const totalDur           = revealTtsAt + revealDur + TAIL_BUFFER;
  console.log(`[MICRO] Timeline — countdownStart=${countdownStart.toFixed(2)} pauseAt=${pauseAt.toFixed(2)} fiftyFiftyAt=${fiftyFiftyAt.toFixed(2)} revealAt=${revealAt.toFixed(2)} total=${totalDur.toFixed(2)}s`);

  // ── 3. Optional reused sfx from the puzzle row (best-effort, never blocks) ──
  const [tickFile, stingFile] = await Promise.all([
    download(quiz.countdown_music, `mi_cd_${quiz.id}`),
    download(quiz.correct_answer_sfx_audio_url, `mi_sting_${quiz.id}`),
  ]);

  // ── 4. Puzzle visual ─────────────────────────────────────────────────
  console.log('[MICRO] Rendering puzzle SVG...');
  let svgHtml = '';
  try {
    const spec = typeof quiz.puzzle_spec === 'string' ? JSON.parse(quiz.puzzle_spec) : (quiz.puzzle_spec || {});
    const result = renderPuzzle(quiz.puzzle_type, spec, {
      accent:  quiz.theme_accent_primary   || '#00cfff',
      accent2: quiz.theme_accent_secondary || '#22c55e',
      accent3: quiz.theme_accent_tertiary  || '#f4c430',
      thick: true,
    });
    svgHtml = result.svg;
    if (!result.ok) console.warn('[MICRO] SVG warnings:', result.warnings);
  } catch (e) {
    throw new Error(`puzzleRenderers failed: ${e.message}`);
  }

  const html = buildHtml(quiz, svgHtml);
  const htmlPath = path.join(workDir, 'micro_index.html');
  await fs.writeFile(htmlPath, html);

  // ── 5. Puppeteer ─────────────────────────────────────────────────────
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-web-security', '--allow-file-access-from-files',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: VIDEO_W, height: VIDEO_H });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (u.startsWith('file://') || u.startsWith('data:') || u.startsWith('about:')) req.continue().catch(() => {});
    else req.abort().catch(() => {});
  });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 500));

  // correct option index (needed for the reveal event)
  const options = quiz.options_1 || [];
  const correctIdx = options.findIndex(o => (o || '').trim().toLowerCase() === (quiz.correct_answer_1 || '').trim().toLowerCase());

  // 50/50 — indices to KEEP come from keep_5050_1 (set by the generator; always
  // includes the correct index + one plausible wrong one). Whatever's left of
  // the 4 options gets eliminated at fiftyFiftyAt. Falls back to keeping one
  // random wrong option if keep_5050_1 is missing/malformed, so exactly one
  // wrong option always survives alongside the correct one.
  let keepIdx = (Array.isArray(quiz.keep_5050_1) ? quiz.keep_5050_1 : [])
    .map(v => parseInt(v, 10)).filter(n => !isNaN(n) && n >= 0 && n <= 3);
  if (correctIdx >= 0 && !keepIdx.includes(correctIdx)) keepIdx = [correctIdx];
  keepIdx = [...new Set(keepIdx)];
  if (keepIdx.length < 2) {
    const wrongPool = [0, 1, 2, 3].filter(i => i !== correctIdx && !keepIdx.includes(i));
    if (wrongPool.length) keepIdx.push(wrongPool[Math.floor(Math.random() * wrongPool.length)]);
  }
  const eliminatedIdx = [0, 1, 2, 3].filter(i => !keepIdx.includes(i));

  const events = [
    {
      at: countdownStart,
      fn: (p) => p.evaluate(() => {
        const badge = document.getElementById('cdBadge');
        const ring  = document.getElementById('cdRing');
        const num   = document.getElementById('cdNum');
        if (badge) badge.classList.add('show');
        if (ring)  ring.style.setProperty('--pct', '100');
        if (num)   num.textContent = '5';
      }),
    },
    { at: countdownStart + 1, fn: (p) => p.evaluate(() => {
      document.getElementById('cdRing')?.style.setProperty('--pct', '80');
      const n = document.getElementById('cdNum'); if (n) n.textContent = '4';
    }) },
    { at: pauseAt, fn: (p) => p.evaluate(() => { document.getElementById('pauseCaption')?.classList.add('show'); }) },
    { at: fiftyFiftyAt, fn: (p) => p.evaluate((idxs) => {
      idxs.forEach(i => document.getElementById(`opt-${i}`)?.classList.add('opt-eliminated'));
    }, eliminatedIdx) },
    { at: countdownStart + 2, fn: (p) => p.evaluate(() => {
      document.getElementById('cdRing')?.style.setProperty('--pct', '60');
      const n = document.getElementById('cdNum'); if (n) n.textContent = '3';
    }) },
    { at: countdownStart + 3, fn: (p) => p.evaluate(() => {
      document.getElementById('cdRing')?.style.setProperty('--pct', '40');
      const n = document.getElementById('cdNum'); if (n) n.textContent = '2';
    }) },
    { at: countdownStart + 4, fn: (p) => p.evaluate(() => {
      document.getElementById('cdRing')?.style.setProperty('--pct', '20');
      const n = document.getElementById('cdNum'); if (n) n.textContent = '1';
    }) },
    {
      at: revealAt,
      fn: (p) => p.evaluate((idx) => {
        document.getElementById('cdBadge')?.classList.remove('show');
        document.getElementById('pauseCaption')?.classList.remove('show');
        document.querySelectorAll('.opt').forEach((el, i) => {
          if (i === idx) { el.classList.add('opt-correct'); const m = el.querySelector('.opt-mark'); if (m) m.textContent = '✅'; }
          else            { el.classList.add('opt-fade'); }
        });
      }, correctIdx >= 0 ? correctIdx : 0),
    },
  ];

  console.log('[MICRO] Recording...');
  const videoNoAudio = await recordSilentVideo(page, totalDur, workDir, events);
  await browser.close();

  // ── 6. Composite audio track ────────────────────────────────────────
  console.log('[MICRO] Mixing audio...');
  const audioParts = [
    { file: askPath,    atSec: 0,               volume: 1.0 },
    { file: tickFile,   atSec: countdownStart,  volume: 0.22 },
    { file: pausePath,  atSec: pauseAt,          volume: 1.0 },
    { file: stingFile,  atSec: revealAt,          volume: 0.7 },
    { file: revealPath, atSec: revealTtsAt,        volume: 1.0 },
  ];
  const audioPath = await buildAudioTrack(workDir, audioParts, totalDur);

  // ── 7. Mux ───────────────────────────────────────────────────────────
  const finalPath = path.join(workDir, 'micro_final.mp4');
  await ffmpeg(
    `-y -i "${videoNoAudio}" -i "${audioPath}" -map 0:v:0 -map 1:a:0 ` +
    `-c:v libx264 -crf 26 -preset faster -pix_fmt yuv420p -r 30 ` +
    `-c:a aac -b:a 128k -ar 44100 -ac 1 -t ${totalDur} -movflags +faststart "${finalPath}"`,
    'micro_final'
  );

  return { videoPath: finalPath, durationSec: totalDur };
}

// ─── JOB RUNNER ──────────────────────────────────────────────────────────────
async function processJob() {
  console.log('[MICRO] Starting — puzzle micro format (~10s)');
  const quiz = await claimMicroRow();
  if (!quiz) return;

  const workDir = `/tmp/pz_micro_${uuidv4()}`;
  await ensureDir(workDir);

  try {
    const { videoPath, durationSec } = await withTimeout(
      buildMicroVideo(quiz, workDir), TIMEOUT_JOB, `buildMicroVideo ${quiz.id}`
    );
    const stats  = await fs.stat(videoPath);
    const sizeMb = parseFloat((stats.size / (1024 * 1024)).toFixed(2));
    console.log(`[MICRO] ✓ ${durationSec.toFixed(1)}s ${sizeMb}MB`);

    const artifactPath = `/tmp/${quiz.id}_puzzle_micro_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);

    let microVideoUrl = null;
    if (R2_CONFIGURED) {
      try {
        const buf = await fs.readFile(artifactPath);
        const key = `puzzles/${quiz.id}_micro.mp4`;
        await withTimeout(
          s3Client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: buf, ContentType: 'video/mp4' })),
          60000, 'R2 micro upload'
        );
        microVideoUrl = `${R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`;
        console.log(`[R2] ${microVideoUrl}`);
      } catch (e) { console.warn(`[R2] Upload failed: ${e.message}`); }
    }

    await markMicroDone(quiz.id, microVideoUrl);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    console.log(`[MICRO] Artifact: ${artifactPath}`);
  } catch (err) {
    console.error('[MICRO] FAILED:', err.message);
    console.error(err.stack?.slice(0, 600) || '');
    await markMicroError(quiz.id, err.message);
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

processJob()
  .then(() => { console.log('[MICRO] Done.'); process.exit(0); })
  .catch(err => { console.error('[MICRO] Fatal:', err.message); process.exit(1); });
