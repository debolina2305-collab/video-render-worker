'use strict';
// ═══════════════════════════════════════════════════════════════════════
// PUZZLE SCENE ANIMATOR — GOLD / REVEAL-ONLY EDITION
// Used exclusively by puzzle_render_long_animated.js (NOT the original
// puzzle_render_long.js — that file is untouched).
//
// SCOPE (per spec):
//   • Intro (hook, question, options, 10s countdown + pause_audio at 3s)
//     is handled by the calling script exactly as in the original long
//     renderer — this module is ONLY the post-countdown replacement:
//     a clue-by-clue deduction walkthrough → culprit reveal.
//   • Ends on the correct-answer reveal. NO explanation is narrated or
//     displayed — TTS says only "The culprit is <name>."
//   • Color scheme is black background with GOLD / AMBER / WARM WHITE
//     accents only — no blue, no purple, no deep/cool tones anywhere.
//   • Every element (clue text, numbers, magnifier, reveal avatar/name,
//     stamp) is sized up ("big and bold") relative to the earlier
//     purple prototype — this is the ONLY visual content for a long
//     stretch of screen time, so it needs to read clearly at a glance.
//   • Same continuous-motion approach as before: Ken Burns camera drift
//     sized to each phase's REAL narration duration, a magnifying glass
//     that physically travels to each clue via getBoundingClientRect,
//     and a detective-board thread that grows as clues are confirmed.
//
// PUBLIC API (same shape as the earlier module, so the calling script's
// integration code doesn't need to special-case anything):
//   isSceneEligible(quiz), recordScene(page, quiz, ctx)
// ═══════════════════════════════════════════════════════════════════════

const path = require('path');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');

const VIDEO_W = 1080;
const VIDEO_H = 1920;

function isSceneEligible(quiz) {
  if (!quiz || quiz.puzzle_type !== 'detective') return false;
  const s = quiz.puzzle_spec;
  return !!(s && Array.isArray(s.clues) && s.clues.length >= 2 &&
            Array.isArray(s.suspects) && s.suspects.length === 4 && quiz.correct_answer_1);
}

// ── CSS — black background, gold/amber/warm-white ONLY, big & bold ─────
const SCENE_CSS = `
#scene-root { position: fixed; inset: 0; width: ${VIDEO_W}px; height: ${VIDEO_H}px;
  background: #060606; font-family: 'Poppins', Arial, sans-serif; overflow: hidden; z-index: 9999; }

#scene-root .sc-vignette { position:absolute; inset:0; pointer-events:none; z-index:50;
  background: radial-gradient(ellipse 75% 65% at 50% 42%, transparent 0%, transparent 52%, rgba(0,0,0,0.65) 100%); }
#scene-root .sc-grain { position:absolute; inset:-4px; pointer-events:none; z-index:51; opacity:0.045; mix-blend-mode:overlay; }
@keyframes sceneDustDrift { 0%{ transform:translateY(0); opacity:0;} 10%{opacity:.55;} 90%{opacity:.4;} 100%{ transform:translateY(-620px); opacity:0;} }
.sc-dust { position:absolute; bottom:-20px; width:5px; height:5px; border-radius:50%; background:#ffd700; pointer-events:none; z-index:40; animation: sceneDustDrift linear infinite; }

#scene-root .sp { position: absolute; inset: 0; opacity: 0; z-index: 10;
  clip-path: inset(0 0 0 100%); transition: opacity .55s ease, clip-path .65s cubic-bezier(.65,0,.35,1); }
#scene-root .sp.active { opacity: 1; clip-path: inset(0 0 0 0%); z-index: 20; }
#scene-root .sp-camera { position:absolute; inset:-40px; transform-origin:50% 50%; animation-timing-function: ease-in-out; animation-iteration-count: 1; animation-fill-mode: both; }
.sp.active .sp-camera.kb-a { animation-name: kenBurnsA; animation-duration: var(--phase-dur, 6s); }
.sp.active .sp-camera.kb-d { animation-name: kenBurnsD; animation-duration: var(--phase-dur, 6s); }
@keyframes kenBurnsA { 0%{ transform:scale(1.0) translate(-1%,0.6%);} 100%{ transform:scale(1.1) translate(1.4%,-1%);} }
@keyframes kenBurnsD { 0%{ transform:scale(1.1);} 55%{ transform:scale(1.18);} 100%{ transform:scale(1.12);} }

/* warm gold grade wash — no blue/purple anywhere */
.sp-grade { position:absolute; inset:0; pointer-events:none; mix-blend-mode:overlay; opacity:.28; z-index:30; }
.sp-deduction .sp-grade { background:linear-gradient(160deg,#3a2a00 0%, transparent 55%, #1a1400 100%); }
.sp-reveal .sp-grade { background:radial-gradient(ellipse at 50% 40%, #7a5a00 0%, transparent 60%); }

#scene-root .sp-title { position: absolute; top: 58px; left: 0; right: 0; text-align: center;
  color: #ffd700; font-size: 36px; letter-spacing: 5px; font-weight: 900; text-transform: uppercase; z-index: 35;
  text-shadow: 0 0 26px #ffd70099; }

/* ── deduction ── */
.sc-clue-list { position:absolute; top:420px; left:130px; right:80px; bottom:130px; }
.sc-thread-track { position:absolute; left:-56px; top:6px; bottom:6px; width:6px; background:#2a2210; border-radius:3px; }
.sc-thread-fill { position:absolute; left:0; top:0; width:100%; height:0%; background:linear-gradient(180deg,#ffd700,#d4941e); border-radius:3px; transition: height .6s cubic-bezier(.4,0,.2,1); box-shadow:0 0 16px #ffd70099; }
.sc-clue-row { position:relative; display:flex; align-items:flex-start; gap:28px; margin-bottom:42px; opacity:.25; filter:saturate(.35); transition:opacity .45s, filter .45s; }
.sc-clue-row.show { opacity:1; filter:saturate(1); }
.sc-thread-node { position:absolute; left:-64px; top:16px; width:22px; height:22px; border-radius:50%; background:#2a2210; border:4px solid #4a3a10; transition: background .4s, border-color .4s, box-shadow .4s; }
.sc-clue-row.show .sc-thread-node { background:#ffd700; border-color:#fff2b0; box-shadow:0 0 18px #ffd700cc; }
.sc-clue-num { width:72px; height:72px; border-radius:50%; background:#ffd700; color:#100c00; font-size:38px; font-weight:900; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition: transform .4s cubic-bezier(.34,1.56,.64,1), box-shadow .4s; }
.sc-clue-row.show .sc-clue-num { transform: scale(1.14); box-shadow:0 0 28px #ffd700cc; }
.sc-clue-text { color:#fff8e7; font-size:36px; font-weight:600; line-height:1.45; padding-top:12px; text-shadow: 0 2px 10px #0009; }
@keyframes sceneMagPulse { 0%,100%{ box-shadow:0 0 0 0 #ffd70066, inset 0 0 30px #ffd70044;} 50%{ box-shadow:0 0 0 18px #ffd70000, inset 0 0 40px #ffd70077;} }
.sc-magnifier { position:absolute; width:130px; height:130px; border-radius:50%; border:9px solid #fff2b0; background:radial-gradient(circle at 40% 35%, #ffffff33, transparent 60%); top:0; left:0; transform: translate(-9999px,-9999px); transition: transform .6s cubic-bezier(.4,0,.2,1); animation: sceneMagPulse 1.6s ease-in-out infinite; pointer-events:none; z-index:25; }
.sc-magnifier::after { content:''; position:absolute; width:12px; height:74px; background:#fff2b0; bottom:-60px; right:8px; border-radius:6px; transform: rotate(45deg); transform-origin:top; }

/* ── reveal ── */
.sc-reveal-wrap { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:0 70px; }
@keyframes sceneRing { 0%{ transform:scale(.3); opacity:0;} 60%{ transform:scale(1.1);} 100%{ transform:scale(1); opacity:1;} }
@keyframes sceneRevealPulse { 0%,100%{ box-shadow:0 0 40px 6px #ffd70066;} 50%{ box-shadow:0 0 78px 18px #ffd700aa;} }
@keyframes sceneGlowSpin { 0%{ transform:rotate(0deg);} 100%{ transform:rotate(360deg);} }
.sc-reveal-glow { position:absolute; width:400px; height:400px; border-radius:50%; background:conic-gradient(from 0deg,#ffd700,#fff2b0,#d4941e,#ffd700); filter:blur(36px); opacity:.6; animation: sceneGlowSpin 6s linear infinite; z-index:0; }
.sc-reveal-avatar { position:relative; z-index:1; width:280px; height:280px; border-radius:50%; border:8px solid #ffd700; background:#141000; display:flex; align-items:center; justify-content:center; font-size:128px; opacity:0; animation: sceneRing .7s cubic-bezier(.34,1.56,.64,1) forwards, sceneRevealPulse 2.4s ease-in-out infinite 0.9s; }
.sc-reveal-name { color:#fff8e7; font-size:72px; font-weight:900; margin-top:34px; opacity:0; animation: scenePop .5s ease forwards .8s; text-shadow: 0 0 30px #ffd70088; }
@keyframes scenePop { 0%{ opacity:0; transform:scale(.7) translateY(14px);} 100%{ opacity:1; transform:scale(1) translateY(0);} }
@keyframes sceneStamp { 0%{ transform:scale(2.6) rotate(-15deg); opacity:0;} 55%{ transform:scale(.85) rotate(4deg);} 72%{ transform:scale(1.06) rotate(-8deg);} 100%{ transform:scale(1) rotate(-6deg); opacity:1;} }
.sc-guilty-stamp { font-size:80px; font-weight:900; color:#ffd700; border:10px solid #ffd700; border-radius:10px; padding:14px 42px; letter-spacing:10px; opacity:0; margin-top:44px; animation: sceneStamp .45s cubic-bezier(.34,1.56,.64,1) forwards 1.5s; background: #100c0088; }
@keyframes sceneImpactFlash { 0%{ opacity:0;} 12%{ opacity:.9;} 100%{ opacity:0;} }
@keyframes sceneImpactShake { 0%,100%{ transform:translate(0,0);} 20%{ transform:translate(-10px,4px);} 40%{ transform:translate(8px,-6px);} 60%{ transform:translate(-6px,-3px);} 80%{ transform:translate(5px,5px);} }
.sc-impact-flash { position:absolute; inset:0; background:#fff8e0; opacity:0; pointer-events:none; z-index:60; }
.sc-impact-flash.fire { animation: sceneImpactFlash .3s ease-out; }
#scene-root.impact .sp.active .sp-camera { animation: sceneImpactShake .3s ease-out; }
`;

// ── HTML BUILDER ─────────────────────────────────────────────────────────
function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

function buildDustHTML(n) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const left = Math.round(5 + Math.random() * 90);
    const dur = (10 + Math.random() * 8).toFixed(1);
    const delay = (Math.random() * 10).toFixed(1);
    const size = (4 + Math.random() * 5).toFixed(1);
    out += `<div class="sc-dust" style="left:${left}%; width:${size}px; height:${size}px; animation-duration:${dur}s; animation-delay:${delay}s;"></div>`;
  }
  return out;
}

function buildRevealOnlySceneHTML(quiz) {
  const spec = quiz.puzzle_spec;
  const clues = spec.clues;
  const culprit = quiz.correct_answer_1;

  const clueDeduction = clues.map((c, i) => `
    <div class="sc-clue-row" data-clue-idx="${i}">
      <div class="sc-thread-node"></div>
      <div class="sc-clue-num">${i + 1}</div>
      <div class="sc-clue-text">${esc(c)}</div>
    </div>`).join('');

  return `
  <div id="scene-root">
    <div class="sc-vignette"></div>
    <svg class="sc-grain" width="100%" height="100%"><filter id="scGrainF2"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#scGrainF2)"/></svg>
    ${buildDustHTML(12)}
    <div class="sc-impact-flash"></div>

    <div class="sp sp-deduction active" data-phase="deduction">
      <div class="sp-camera kb-a">
        <div class="sc-clue-list">
          <div class="sc-thread-track"></div>
          <div class="sc-thread-fill" id="sc-thread-fill"></div>
          ${clueDeduction}
        </div>
        <div class="sc-magnifier" id="sc-magnifier"></div>
      </div>
      <div class="sp-grade"></div>
      <div class="sp-title">Following the Clues</div>
    </div>

    <div class="sp sp-reveal" data-phase="reveal">
      <div class="sp-camera kb-d">
        <div class="sc-reveal-wrap">
          <div class="sc-reveal-glow"></div>
          <div class="sc-reveal-avatar">🕵️</div>
          <div class="sc-reveal-name">${esc(culprit)}</div>
          <div class="sc-guilty-stamp">GUILTY</div>
        </div>
      </div>
      <div class="sp-grade"></div>
    </div>
  </div>`;
}

// ── NARRATION — clues, then a single short reveal line. NO explanation. ──
function buildNarrationLines(quiz) {
  const spec = quiz.puzzle_spec;
  const lines = [];
  spec.clues.forEach((c, i) => lines.push({ phase: 'deduction', clueIdx: i, text: c }));
  lines.push({ phase: 'reveal', text: `The culprit is ${quiz.correct_answer_1}.` });
  return lines.filter(l => l.text && l.text.trim());
}

// ── RECORD ───────────────────────────────────────────────────────────────
// ctx = { workDir, voice, tts, silence, concatAudio, audioDur,
//         ffmpeg, withTimeout, TIMEOUT_RECORDER }
async function recordScene(page, quiz, ctx) {
  const { workDir, voice, tts, silence, concatAudio, audioDur,
          ffmpeg, withTimeout, TIMEOUT_RECORDER } = ctx;

  const narrationLines = buildNarrationLines(quiz);

  const GAP = 0.35;
  const parts = [];
  const timeline = [];
  let cursor = 0;
  for (let i = 0; i < narrationLines.length; i++) {
    const line = narrationLines[i];
    const clipPath = path.join(workDir, `gscene_line_${i}.mp3`);
    await tts(line.text, voice, clipPath, 3);
    const dur = await audioDur(clipPath);
    timeline.push({ atSec: cursor, phase: line.phase, clueIdx: line.clueIdx });
    parts.push(clipPath);
    cursor += dur;
    if (i < narrationLines.length - 1) {
      const gapPath = path.join(workDir, `gscene_gap_${i}.mp3`);
      await silence(GAP, gapPath);
      parts.push(gapPath);
      cursor += GAP;
    }
  }
  const totalDur = Math.max(cursor + 0.5, 3);
  const narrationPath = path.join(workDir, 'gscene_narration.mp3');
  await concatAudio(parts, narrationPath, workDir);

  const phaseOrder = [];
  for (const ev of timeline) {
    if (!phaseOrder.length || phaseOrder[phaseOrder.length - 1].phase !== ev.phase) {
      phaseOrder.push({ phase: ev.phase, atSec: ev.atSec });
    }
  }
  const phaseDur = {};
  for (let i = 0; i < phaseOrder.length; i++) {
    const start = phaseOrder[i].atSec;
    const end = i + 1 < phaseOrder.length ? phaseOrder[i + 1].atSec : totalDur;
    phaseDur[phaseOrder[i].phase] = Math.max(1.2, end - start);
  }
  const clueCount = quiz.puzzle_spec.clues.length;

  await page.evaluate((html) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
  }, buildRevealOnlySceneHTML(quiz));
  await page.addStyleTag({ content: SCENE_CSS });

  await page.evaluate((dur) => {
    const cam = document.querySelector('#scene-root .sp.active .sp-camera');
    if (cam) cam.style.setProperty('--phase-dur', dur + 's');
  }, phaseDur.deduction || 4);

  const rawVideo = path.join(workDir, 'gscene_raw.mp4');
  const h264Video = path.join(workDir, 'gscene_h264.mp4');
  const outVideo = path.join(workDir, 'clip_explanation_scene_gold.mp4');

  const recorder = new PuppeteerScreenRecorder(page, {
    fps: 30, videoFrame: { width: VIDEO_W, height: VIDEO_H }, aspectRatio: '9:16', followNewTab: false
  });
  await recorder.start(rawVideo);

  const t0 = Date.now();
  let currentPhase = 'deduction';
  for (const ev of timeline) {
    const waitMs = ev.atSec * 1000 - (Date.now() - t0);
    if (waitMs > 0) await new Promise(r => setTimeout(r, waitMs));
    try {
      if (ev.phase !== currentPhase) {
        currentPhase = ev.phase;
        const dur = phaseDur[ev.phase] || 4;
        await page.evaluate((phase, dur) => {
          document.querySelectorAll('#scene-root .sp').forEach(el => el.classList.remove('active'));
          const target = document.querySelector(`#scene-root .sp-${phase}`);
          if (target) {
            target.classList.add('active');
            const cam = target.querySelector('.sp-camera');
            if (cam) cam.style.setProperty('--phase-dur', dur + 's');
          }
          if (phase === 'reveal') {
            setTimeout(() => {
              const root = document.getElementById('scene-root');
              const flash = document.querySelector('#scene-root .sc-impact-flash');
              if (root) { root.classList.add('impact'); setTimeout(() => root.classList.remove('impact'), 320); }
              if (flash) { flash.classList.add('fire'); setTimeout(() => flash.classList.remove('fire'), 320); }
            }, 1850); // matches sc-guilty-stamp's 1.5s delay + ~0.35s land
          }
        }, ev.phase, dur);
      }
      if (ev.phase === 'deduction' && ev.clueIdx != null) {
        await page.evaluate((idx, total) => {
          const row = document.querySelector(`#scene-root .sc-clue-row[data-clue-idx="${idx}"]`);
          const mag = document.getElementById('sc-magnifier');
          const list = document.querySelector('#scene-root .sc-clue-list');
          if (row) {
            row.classList.add('show');
            if (mag && list) {
              const rowRect = row.getBoundingClientRect();
              const listRect = list.getBoundingClientRect();
              const x = rowRect.left - listRect.left - 78;
              const y = rowRect.top - listRect.top + rowRect.height / 2 - 65;
              mag.style.transform = `translate(${x}px, ${y}px)`;
            }
          }
          const fill = document.getElementById('sc-thread-fill');
          if (fill) fill.style.height = `${Math.round(((idx + 1) / total) * 100)}%`;
        }, ev.clueIdx, clueCount);
      }
    } catch (e) {
      console.warn(`[SCENE-GOLD] event failed at t=${ev.atSec.toFixed(2)}s: ${e.message.slice(0, 90)}`);
    }
  }

  const remainMs = totalDur * 1000 - (Date.now() - t0);
  if (remainMs > 0) await new Promise(r => setTimeout(r, remainMs));

  await withTimeout(recorder.stop(), TIMEOUT_RECORDER, 'gscene.stop');

  await ffmpeg(
    `-y -i "${rawVideo}" -an -c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
    `-vf "scale=${VIDEO_W}:${VIDEO_H}" "${h264Video}"`, 'gscene_enc'
  );
  await ffmpeg(
    `-y -stream_loop -1 -i "${h264Video}" -i "${narrationPath}" ` +
    `-map 0:v:0 -map 1:a:0 -c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
    `-c:a aac -b:a 128k -ar 44100 -ac 1 -t ${totalDur} "${outVideo}"`, 'gscene_mux'
  );

  await page.evaluate(() => {
    const el = document.getElementById('scene-root');
    if (el) el.remove();
  });

  console.log(`[SCENE-GOLD] reveal scene recorded: ${totalDur.toFixed(2)}s, ${timeline.length} narration beat(s)`);
  return { path: outVideo, dur: totalDur };
}

module.exports = { isSceneEligible, recordScene };
