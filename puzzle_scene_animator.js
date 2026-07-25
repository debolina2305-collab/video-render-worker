'use strict';
// ═══════════════════════════════════════════════════════════════════════
// PUZZLE SCENE ANIMATOR v2 — CONTINUOUS-MOTION EDITION
//
// v1 had entrance animations that landed and then held a static pose —
// reads as an animated slide, not a video. This version keeps something
// moving on screen for the ENTIRE duration of every phase:
//
//   • Ken Burns camera drift on every phase (slow, continuous zoom/pan —
//     duration is set PER PHASE from the real narration timeline, so a
//     10s phase drifts slowly and a 3s phase drifts fast enough to read).
//   • A magnifying glass that physically TRAVELS to each clue the instant
//     it's narrated (real getBoundingClientRect tracking, not a guess).
//   • A "detective board" thread on the left of the clue list that grows
//     taller as each clue is confirmed — classic investigation-board beat.
//   • Suspect cards breathe (idle float) and a scanner bar sweeps the
//     lineup continuously, THEN eliminates suspects one by one before the
//     reveal — instead of just sitting still.
//   • A soft color-graded tint + film-grain overlay + drifting dust motes
//     for atmosphere, persistent across phase cuts (not reset each time).
//   • Phase cuts are a zoom+wipe (scale + clip-path) instead of a flat
//     opacity crossfade.
//   • A one-frame camera "impact punch" timed to the GUILTY stamp landing.
//
// INTEGRATION IS UNCHANGED — same public API as v1:
//   isSceneEligible(quiz), recordScene(page, quiz, ctx), SCENE_BUILDERS
// puzzle_render_long.js does not need to change; drop this file in place.
// ═══════════════════════════════════════════════════════════════════════

const path = require('path');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');

const VIDEO_W = 1080;
const VIDEO_H = 1920;

// ── ELIGIBILITY ─────────────────────────────────────────────────────────
function isSceneEligible(quiz) {
  if (!quiz || quiz.puzzle_type !== 'detective') return false;
  const s = quiz.puzzle_spec;
  return !!(s && s.case_title && Array.isArray(s.clues) && s.clues.length >= 2 &&
            Array.isArray(s.suspects) && s.suspects.length === 4 && quiz.correct_answer_1);
}

// ── CSS ──────────────────────────────────────────────────────────────────
const SCENE_CSS = `
#scene-root { position: fixed; inset: 0; width: ${VIDEO_W}px; height: ${VIDEO_H}px;
  background: #0a0414; font-family: 'Poppins', Arial, sans-serif; overflow: hidden; z-index: 9999; }

/* ── persistent atmosphere: grain + vignette + dust, survive phase cuts ── */
#scene-root .sc-vignette { position:absolute; inset:0; pointer-events:none; z-index:50;
  background: radial-gradient(ellipse 75% 65% at 50% 42%, transparent 0%, transparent 55%, rgba(4,1,12,0.55) 100%); }
#scene-root .sc-grain { position:absolute; inset:-4px; pointer-events:none; z-index:51; opacity:0.05; mix-blend-mode:overlay; }
@keyframes sceneDustDrift { 0%{ transform:translateY(0) translateX(0); opacity:0;} 10%{opacity:.5;} 90%{opacity:.4;} 100%{ transform:translateY(-620px) translateX(30px); opacity:0;} }
.sc-dust { position:absolute; bottom:-20px; width:5px; height:5px; border-radius:50%; background:#c9baf0; pointer-events:none; z-index:40; animation: sceneDustDrift linear infinite; }

/* ── phase container + camera (Ken Burns lives on .sp-camera, duration set per-phase from JS) ── */
#scene-root .sp { position: absolute; inset: 0; opacity: 0; z-index: 10;
  clip-path: inset(0 0 0 100%); transition: opacity .55s ease, clip-path .65s cubic-bezier(.65,0,.35,1); }
#scene-root .sp.active { opacity: 1; clip-path: inset(0 0 0 0%); z-index: 20; }
#scene-root .sp-camera { position:absolute; inset:-40px; transform-origin:50% 50%; animation-timing-function: ease-in-out; animation-iteration-count: 1; animation-fill-mode: both; }
.sp.active .sp-camera.kb-a { animation-name: kenBurnsA; animation-duration: var(--phase-dur, 6s); }
.sp.active .sp-camera.kb-b { animation-name: kenBurnsB; animation-duration: var(--phase-dur, 6s); }
.sp.active .sp-camera.kb-c { animation-name: kenBurnsC; animation-duration: var(--phase-dur, 6s); }
.sp.active .sp-camera.kb-d { animation-name: kenBurnsD; animation-duration: var(--phase-dur, 6s); }
@keyframes kenBurnsA { 0%{ transform:scale(1.0) translate(0,0);} 100%{ transform:scale(1.11) translate(-2.2%,-1.4%);} }
@keyframes kenBurnsB { 0%{ transform:scale(1.06) translate(1.6%,0.6%);} 100%{ transform:scale(1.16) translate(-1.2%,-0.8%);} }
@keyframes kenBurnsC { 0%{ transform:scale(1.0) translate(-1.4%,0.4%);} 100%{ transform:scale(1.1) translate(1.6%,-1%);} }
@keyframes kenBurnsD { 0%{ transform:scale(1.08);} 55%{ transform:scale(1.16);} 100%{ transform:scale(1.1);} }

/* ── per-phase color grade wash, mixed over the whole frame ── */
.sp-grade { position:absolute; inset:0; pointer-events:none; mix-blend-mode:overlay; opacity:.35; z-index:30; }
.sp-crime .sp-grade { background:linear-gradient(160deg,#2a1a5a 0%, transparent 55%, #0c1a3a 100%); }
.sp-suspects .sp-grade { background:linear-gradient(160deg,#3a1a4a 0%, transparent 55%, #4a2a1a 100%); }
.sp-deduction .sp-grade { background:linear-gradient(160deg,#3a1050 0%, transparent 55%, #150a30 100%); }
.sp-reveal .sp-grade { background:radial-gradient(ellipse at 50% 40%, #6a3ab0 0%, transparent 60%); }

#scene-root .sp-title { position: absolute; top: 64px; left: 0; right: 0; text-align: center;
  color: #c8b6ff; font-size: 30px; letter-spacing: 4px; font-weight: 800; text-transform: uppercase; z-index: 35;
  text-shadow: 0 0 22px #a78bfa88; }

/* ── crime scene ── */
@keyframes sceneCurtain { 0%,100%{ transform: skewX(-2deg);} 50%{ transform: skewX(3deg);} }
.sc-curtain-l { position:absolute; top:140px; left:120px; width:70px; height:420px; background:#3a2060; transform-origin:top; animation: sceneCurtain 3s ease-in-out infinite; }
.sc-curtain-r { position:absolute; top:140px; right:120px; width:70px; height:420px; background:#3a2060; transform-origin:top; animation: sceneCurtain 3s ease-in-out infinite .5s; }
.sc-window { position:absolute; top:100px; right:220px; width:220px; height:280px; border:8px solid #4a3a6a; background:#071020; border-radius:4px; }
.sc-window::before { content:''; position:absolute; top:50%; left:0; right:0; height:6px; background:#4a3a6a; }
.sc-window::after  { content:''; position:absolute; left:50%; top:0; bottom:0; width:6px; background:#4a3a6a; }
@keyframes sceneMoonGlow { 0%,100%{ box-shadow:0 0 32px #ddd8b0aa;} 50%{ box-shadow:0 0 52px #ddd8b0dd;} }
.sc-moon { position:absolute; top:30px; right:30px; width:46px; height:46px; background:#ddd8b0; border-radius:50%; animation: sceneMoonGlow 4s ease-in-out infinite; }
@keyframes sceneRayPulse { 0%,100%{ opacity:.08;} 50%{ opacity:.22;} }
.sc-lightray { position:absolute; top:0; width:180px; height:1400px; background:linear-gradient(180deg,#e8dfffcc,transparent); transform-origin:top; pointer-events:none; z-index:5; animation: sceneRayPulse 5s ease-in-out infinite; }
.sc-ray1 { right:180px; transform:rotate(18deg); animation-delay:0s; }
.sc-ray2 { right:320px; transform:rotate(12deg); animation-delay:1.5s; }
.sc-floor { position:absolute; bottom:0; left:0; right:0; height:320px; background:linear-gradient(180deg,#1a0d2e,#120820); border-top:5px solid #2a1a4a; }
.sc-desk { position:absolute; bottom:260px; left:50%; transform:translateX(-50%); width:420px; height:50px; background:#3d2010; border-radius:8px 8px 0 0; }
.sc-desk::after { content:''; position:absolute; top:50px; left:-24px; right:-24px; height:26px; background:#2a1508; border-radius:0 0 8px 8px; }
.sc-diamond-box { position:absolute; bottom:308px; left:50%; transform:translateX(-50%); width:80px; height:56px; background:#1a3a5a; border:2px solid #3a6a9a; border-radius:6px; display:flex; align-items:center; justify-content:center; }
@keyframes sceneSparkle { 0%,100%{ filter:brightness(1) drop-shadow(0 0 0 transparent);} 50%{ filter:brightness(2.1) drop-shadow(0 0 20px #aaddff);} }
.sc-diamond { font-size:36px; animation: sceneSparkle 1.8s ease-in-out infinite; }
.sc-french-window { position:absolute; bottom:290px; right:150px; width:130px; height:230px; background:#071020; border:5px solid #3a5070; border-radius:4px 4px 0 0; }
@keyframes sceneFpWalk { 0%{ opacity:0; transform:translateY(14px) scale(.6) rotate(var(--fr,0deg));} 25%{ opacity:.7; transform:translateY(0) scale(1) rotate(var(--fr,0deg));} 85%{ opacity:.55;} 100%{ opacity:.35; transform:translateY(-4px) scale(1) rotate(var(--fr,0deg));} }
.sc-fp { position:absolute; font-size:28px; opacity:0; color:#8a7a6a; animation: sceneFpWalk 1.1s ease-out forwards; }
.sc-clue-badge { position:absolute; background:#1a0d2ecc; backdrop-filter:blur(2px); border:3px solid #a78bfa; border-radius:14px; padding:14px 22px; font-size:24px; color:#c4b5fd; opacity:0; animation: scenePop .5s cubic-bezier(.34,1.56,.64,1) forwards; max-width:420px; }
@keyframes scenePop { 0%{ opacity:0; transform:scale(.7) translateY(14px);} 100%{ opacity:1; transform:scale(1) translateY(0);} }
@keyframes sceneBadgeFloat { 0%,100%{ transform:translateY(0);} 50%{ transform:translateY(-8px);} }
.sc-clue-badge.floaty { animation: scenePop .5s cubic-bezier(.34,1.56,.64,1) forwards, sceneBadgeFloat 3.4s ease-in-out infinite 0.5s; }

/* ── suspects ── */
.sc-suspects-row { position:absolute; top:420px; left:0; right:0; display:flex; justify-content:center; gap:36px; flex-wrap:wrap; padding:0 60px; }
@keyframes sceneSlide { 0%{ opacity:0; transform:translateY(50px);} 100%{ opacity:1; transform:translateY(0);} }
@keyframes sceneBreathe { 0%,100%{ transform:translateY(0) scale(1);} 50%{ transform:translateY(-10px) scale(1.015);} }
.sc-suspect-card { width:230px; border-radius:20px; border:3px solid #2a1a4a; background:#120820; padding:26px 18px; text-align:center; display:flex; flex-direction:column; align-items:center; gap:16px; opacity:0; transition: border-color .5s, background .5s, opacity .6s, filter .6s; }
.sc-suspect-card .sc-breathe-wrap { animation: sceneBreathe 3.2s ease-in-out infinite; animation-delay: var(--bdelay,0s); }
.sc-suspect-card.eliminated { opacity:.3; filter:grayscale(.85); border-color:#2a1a2a; }
.sc-suspect-card.eliminated .sc-breathe-wrap { animation-play-state: paused; }
.sc-suspect-card.guilty { border-color:#a78bfa; background:#1a0d2e; box-shadow:0 0 46px #a78bf077; }
.sc-suspect-card.guilty .sc-breathe-wrap { animation-duration: 1.6s; }
.sc-suspect-avatar { width:96px; height:96px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:46px; border:4px solid #3a2a5a; background:#1e1436; }
.sc-suspect-name { color:#e8e0ff; font-size:24px; font-weight:600; }
.sc-suspect-role { color:#7060a0; font-size:18px; }
@keyframes sceneScan { 0%{ left:-8%;} 100%{ left:104%;} }
.sc-scanner { position:absolute; top:400px; bottom:120px; width:6px; background:linear-gradient(180deg,transparent,#a78bfaee,transparent); filter: blur(1px); animation: sceneScan 2.6s linear infinite; z-index:15; }
.sc-elim-mark { position:absolute; top:8px; right:8px; width:34px; height:34px; border-radius:50%; background:#3a1616cc; color:#ff9a9a; display:flex; align-items:center; justify-content:center; font-size:20px; font-weight:800; opacity:0; transform:scale(.4); transition: opacity .35s, transform .35s cubic-bezier(.34,1.56,.64,1); }
.sc-suspect-card.eliminated .sc-elim-mark { opacity:1; transform:scale(1); }

/* ── deduction ── */
.sc-clue-list { position:absolute; top:400px; left:110px; right:70px; bottom:120px; }
.sc-thread-track { position:absolute; left:-46px; top:6px; bottom:6px; width:4px; background:#2a1a4a; border-radius:2px; }
.sc-thread-fill { position:absolute; left:0; top:0; width:100%; height:0%; background:linear-gradient(180deg,#a78bfa,#e85d9e); border-radius:2px; transition: height .6s cubic-bezier(.4,0,.2,1); box-shadow:0 0 12px #a78bfa88; }
.sc-clue-row { position:relative; display:flex; align-items:flex-start; gap:22px; margin-bottom:30px; opacity:.28; filter:saturate(.4); transition:opacity .45s, filter .45s; }
.sc-clue-row.show { opacity:1; filter:saturate(1); }
.sc-thread-node { position:absolute; left:-52px; top:14px; width:16px; height:16px; border-radius:50%; background:#2a1a4a; border:3px solid #4a3a6a; transition: background .4s, border-color .4s, box-shadow .4s; }
.sc-clue-row.show .sc-thread-node { background:#a78bfa; border-color:#e85d9e; box-shadow:0 0 14px #a78bfaaa; }
.sc-clue-num { width:52px; height:52px; border-radius:50%; background:#a78bfa; color:#0a0414; font-size:26px; font-weight:800; display:flex; align-items:center; justify-content:center; flex-shrink:0; transition: transform .4s cubic-bezier(.34,1.56,.64,1), box-shadow .4s; }
.sc-clue-row.show .sc-clue-num { transform: scale(1.12); box-shadow:0 0 22px #a78bfa99; }
.sc-clue-text { color:#d8cff0; font-size:26px; line-height:1.5; padding-top:8px; }
@keyframes sceneMagPulse { 0%,100%{ box-shadow:0 0 0 0 #a78bfa66, inset 0 0 24px #a78bfa33;} 50%{ box-shadow:0 0 0 14px #a78bfa00, inset 0 0 32px #a78bfa55;} }
.sc-magnifier { position:absolute; width:96px; height:96px; border-radius:50%; border:6px solid #d8c9ff; background:radial-gradient(circle at 40% 35%, #ffffff22, transparent 60%); top:0; left:0; transform: translate(-9999px,-9999px); transition: transform .6s cubic-bezier(.4,0,.2,1); animation: sceneMagPulse 1.6s ease-in-out infinite; pointer-events:none; z-index:25; }
.sc-magnifier::after { content:''; position:absolute; width:8px; height:56px; background:#d8c9ff; bottom:-46px; right:6px; border-radius:4px; transform: rotate(45deg); transform-origin:top; }

/* ── reveal ── */
.sc-reveal-wrap { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:0 80px; }
@keyframes sceneRing { 0%{ transform:scale(.3); opacity:0;} 60%{ transform:scale(1.08);} 100%{ transform:scale(1); opacity:1;} }
@keyframes sceneRevealPulse { 0%,100%{ box-shadow:0 0 30px 4px #a78bfa55;} 50%{ box-shadow:0 0 60px 14px #a78bfa88;} }
@keyframes sceneGlowSpin { 0%{ transform:rotate(0deg);} 100%{ transform:rotate(360deg);} }
.sc-reveal-glow { position:absolute; width:320px; height:320px; border-radius:50%; background:conic-gradient(from 0deg,#a78bfa,#e85d9e,#a78bfa,#4a2a8a,#a78bfa); filter:blur(30px); opacity:.55; animation: sceneGlowSpin 6s linear infinite; z-index:0; }
.sc-reveal-avatar { position:relative; z-index:1; width:220px; height:220px; border-radius:50%; border:6px solid #a78bfa; background:#1a0d2e; display:flex; align-items:center; justify-content:center; font-size:100px; opacity:0; animation: sceneRing .7s cubic-bezier(.34,1.56,.64,1) forwards, sceneRevealPulse 2.4s ease-in-out infinite 0.9s; }
.sc-reveal-name { color:#e8e0ff; font-size:56px; font-weight:700; margin-top:28px; opacity:0; animation: scenePop .5s ease forwards .8s; }
.sc-reveal-explain { max-width:820px; color:#9080b8; font-size:26px; line-height:1.6; margin-top:26px; opacity:0; animation: scenePop .5s ease forwards 1.2s; }
@keyframes sceneStamp { 0%{ transform:scale(2.5) rotate(-15deg); opacity:0;} 55%{ transform:scale(.85) rotate(4deg);} 72%{ transform:scale(1.05) rotate(-8deg);} 100%{ transform:scale(1) rotate(-6deg); opacity:1;} }
.sc-guilty-stamp { font-size:64px; font-weight:900; color:#a78bfa; border:8px solid #a78bfa; border-radius:8px; padding:10px 34px; letter-spacing:8px; opacity:0; margin-top:36px; animation: sceneStamp .45s cubic-bezier(.34,1.56,.64,1) forwards 1.7s; }
@keyframes sceneImpactFlash { 0%{ opacity:0;} 12%{ opacity:.9;} 100%{ opacity:0;} }
@keyframes sceneImpactShake { 0%,100%{ transform:translate(0,0);} 20%{ transform:translate(-10px,4px);} 40%{ transform:translate(8px,-6px);} 60%{ transform:translate(-6px,-3px);} 80%{ transform:translate(5px,5px);} }
.sc-impact-flash { position:absolute; inset:0; background:#fff; opacity:0; pointer-events:none; z-index:60; }
.sc-impact-flash.fire { animation: sceneImpactFlash .3s ease-out; }
#scene-root.impact .sp.active .sp-camera { animation: sceneImpactShake .3s ease-out; }
`;

// ── HTML BUILDER (detective) ────────────────────────────────────────────
function esc(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }

const SUSPECT_ICONS = ['🎩', '🧹', '🎭', '👨‍🍳', '🕵️', '👤'];

function buildDustHTML(n) {
  let out = '';
  for (let i = 0; i < n; i++) {
    const left = Math.round(5 + Math.random() * 90);
    const dur = (10 + Math.random() * 8).toFixed(1);
    const delay = (Math.random() * 10).toFixed(1);
    const size = (3 + Math.random() * 4).toFixed(1);
    out += `<div class="sc-dust" style="left:${left}%; width:${size}px; height:${size}px; animation-duration:${dur}s; animation-delay:${delay}s;"></div>`;
  }
  return out;
}

function buildDetectiveSceneHTML(quiz) {
  const spec = quiz.puzzle_spec;
  const clues = spec.clues;
  const suspects = spec.suspects;
  const culprit = quiz.correct_answer_1;
  const culpritIdx = suspects.findIndex(s => s.trim().toLowerCase() === culprit.trim().toLowerCase());

  const footprintCoords = [
    { style: 'bottom:270px;left:56%;', rot: '-8deg', delay: '0.4s' },
    { style: 'bottom:312px;left:58.6%;', rot: '10deg', delay: '0.9s' },
    { style: 'bottom:354px;left:61%;', rot: '-6deg', delay: '1.4s' },
    { style: 'bottom:396px;left:63.6%;', rot: '9deg', delay: '1.9s' },
    { style: 'bottom:438px;left:66%;', rot: '-5deg', delay: '2.4s' },
    { style: 'bottom:480px;left:68.6%;', rot: '8deg', delay: '2.9s' },
  ];
  const footprints = footprintCoords.map(f =>
    `<div class="sc-fp" style="${f.style} --fr:${f.rot}; animation-delay:${f.delay};">👣</div>`
  ).join('');

  const cluePositions = [
    'top:220px;left:60px;', 'top:220px;right:60px;',
    'bottom:80px;left:60px;', 'bottom:80px;right:60px;',
  ];
  const clueBadges = clues.slice(0, 4).map((c, i) =>
    `<div class="sc-clue-badge floaty" style="${cluePositions[i] || cluePositions[i % 4]} animation-delay:${0.3 + i * 0.5}s;">${esc(c.length > 60 ? c.slice(0, 57) + '...' : c)}</div>`
  ).join('');

  const suspectCards = suspects.map((s, i) => `
    <div class="sc-suspect-card" data-suspect-idx="${i}" style="animation: sceneSlide .5s ease forwards ${0.3 + i * 0.25}s;">
      <div class="sc-elim-mark">✕</div>
      <div class="sc-breathe-wrap" style="--bdelay:${(i * 0.3).toFixed(1)}s; display:flex; flex-direction:column; align-items:center; gap:16px;">
        <div class="sc-suspect-avatar">${SUSPECT_ICONS[i % SUSPECT_ICONS.length]}</div>
        <div class="sc-suspect-name">${esc(s)}</div>
        <div class="sc-suspect-role">Suspect</div>
      </div>
    </div>`).join('');

  const clueDeduction = clues.map((c, i) => `
    <div class="sc-clue-row" data-clue-idx="${i}">
      <div class="sc-thread-node"></div>
      <div class="sc-clue-num">${i + 1}</div>
      <div class="sc-clue-text">${esc(c)}</div>
    </div>`).join('');

  return `
  <div id="scene-root">
    <div class="sc-vignette"></div>
    <svg class="sc-grain" width="100%" height="100%"><filter id="scGrainF"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#scGrainF)"/></svg>
    ${buildDustHTML(14)}
    <div class="sc-impact-flash"></div>

    <div class="sp sp-crime active" data-phase="crime">
      <div class="sp-camera kb-a">
        <div class="sc-curtain-l"></div><div class="sc-curtain-r"></div>
        <div class="sc-window"><div class="sc-moon"></div></div>
        <div class="sc-lightray sc-ray1"></div><div class="sc-lightray sc-ray2"></div>
        <div class="sc-french-window"></div>
        <div class="sc-floor"></div>
        <div class="sc-desk"></div>
        <div class="sc-diamond-box"><span class="sc-diamond">💎</span></div>
        ${footprints}
        ${clueBadges}
      </div>
      <div class="sp-grade"></div>
      <div class="sp-title">${esc(spec.case_title)}</div>
    </div>

    <div class="sp sp-suspects" data-phase="suspects">
      <div class="sp-camera kb-b">
        <div class="sc-scanner"></div>
        <div class="sc-suspects-row">${suspectCards}</div>
      </div>
      <div class="sp-grade"></div>
      <div class="sp-title">The Suspects</div>
    </div>

    <div class="sp sp-deduction" data-phase="deduction">
      <div class="sp-camera kb-c">
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
          <div class="sc-reveal-avatar">${SUSPECT_ICONS[culpritIdx >= 0 ? culpritIdx % SUSPECT_ICONS.length : 0]}</div>
          <div class="sc-reveal-name">${esc(culprit)}</div>
          <div class="sc-reveal-explain">${esc(quiz.explanation_1 || '')}</div>
          <div class="sc-guilty-stamp">GUILTY</div>
        </div>
      </div>
      <div class="sp-grade"></div>
    </div>
  </div>`;
}

const SCENE_BUILDERS = {
  detective: buildDetectiveSceneHTML,
};

// ── NARRATION SCRIPT ────────────────────────────────────────────────────
function buildDetectiveNarrationLines(quiz) {
  const spec = quiz.puzzle_spec;
  const lines = [];
  lines.push({ phase: 'crime', text: spec.scenario });
  lines.push({ phase: 'suspects', text: `Our suspects: ${spec.suspects.join(', ')}.` });
  spec.clues.forEach((c, i) => lines.push({ phase: 'deduction', clueIdx: i, text: c }));
  lines.push({ phase: 'reveal', text: `The culprit is ${quiz.correct_answer_1}.` });
  lines.push({ phase: 'reveal', text: quiz.explanation_1 || '' });
  return lines.filter(l => l.text && l.text.trim());
}

// ── RECORD ───────────────────────────────────────────────────────────────
// ctx = { workDir, voice, tts, silence, concatAudio, audioDur,
//         ffmpeg, fileExists, withTimeout, TIMEOUT_RECORDER }
async function recordScene(page, quiz, ctx) {
  const { workDir, voice, tts, silence, concatAudio, audioDur,
          ffmpeg, withTimeout, TIMEOUT_RECORDER } = ctx;

  const buildHTML = SCENE_BUILDERS[quiz.puzzle_type];
  if (!buildHTML) throw new Error(`[SCENE] No scene builder for puzzle_type=${quiz.puzzle_type}`);

  const narrationLines = buildDetectiveNarrationLines(quiz);

  // 1) One TTS clip per line + small gaps; remember each line's real start
  //    time so visual events fire exactly when the matching line begins.
  const GAP = 0.35;
  const parts = [];
  const timeline = []; // { atSec, phase, clueIdx }
  let cursor = 0;
  for (let i = 0; i < narrationLines.length; i++) {
    const line = narrationLines[i];
    const clipPath = path.join(workDir, `scene_line_${i}.mp3`);
    await tts(line.text, voice, clipPath, 3);
    const dur = await audioDur(clipPath);
    timeline.push({ atSec: cursor, phase: line.phase, clueIdx: line.clueIdx });
    parts.push(clipPath);
    cursor += dur;
    if (i < narrationLines.length - 1) {
      const gapPath = path.join(workDir, `scene_gap_${i}.mp3`);
      await silence(GAP, gapPath);
      parts.push(gapPath);
      cursor += GAP;
    }
  }
  const totalDur = Math.max(cursor + 0.4, 3);
  const narrationPath = path.join(workDir, 'scene_narration.mp3');
  await concatAudio(parts, narrationPath, workDir);

  // 1b) Derive PER-PHASE duration from the real timeline — this is what
  //     drives Ken Burns speed (slow drift on a long phase, snappier drift
  //     on a short one) instead of a fixed guessed animation length.
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

  // 2) Inject scene markup + CSS. Also stash the culprit's suspect index
  //    on <body> so the in-page elimination-scheduling code (below) can
  //    read it without re-deriving it inside page.evaluate's isolated
  //    scope every time.
  await page.evaluate((html, culpritIdx) => {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
    document.body.dataset.culpritIdx = String(culpritIdx);
  }, buildHTML(quiz), quiz.puzzle_spec.suspects.findIndex(
    s => s.trim().toLowerCase() === quiz.correct_answer_1.trim().toLowerCase()
  ));
  await page.addStyleTag({ content: SCENE_CSS });

  // Set the FIRST phase's camera duration before recording starts (it's
  // already .active from the injected markup, so no phase-switch event
  // will fire for it).
  await page.evaluate((dur) => {
    const cam = document.querySelector('#scene-root .sp.active .sp-camera');
    if (cam) cam.style.setProperty('--phase-dur', dur + 's');
  }, phaseDur.crime || 4);

  // 3) Record, firing phase-switch / clue-reveal / magnifier-tracking
  //    events at their real narration timestamps.
  const rawVideo = path.join(workDir, 'scene_raw.mp4');
  const h264Video = path.join(workDir, 'scene_h264.mp4');
  const outVideo = path.join(workDir, 'clip_explanation_scene.mp4');

  const recorder = new PuppeteerScreenRecorder(page, {
    fps: 30, videoFrame: { width: VIDEO_W, height: VIDEO_H }, aspectRatio: '9:16', followNewTab: false
  });
  await recorder.start(rawVideo);

  const t0 = Date.now();
  let currentPhase = 'crime';
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
          if (phase === 'deduction') {
            document.querySelectorAll('#scene-root .sc-clue-row').forEach(r => r.classList.remove('show'));
            const fill = document.getElementById('sc-thread-fill');
            if (fill) fill.style.height = '0%';
          }
          // Entering suspects: schedule progressive elimination timed to
          // fill most of this phase's real duration, landing on "guilty"
          // just before the phase ends.
          if (phase === 'suspects') {
            const cards = Array.from(document.querySelectorAll('#scene-root .sc-suspect-card'));
            const guiltyIdxStr = document.body.dataset.culpritIdx;
            const others = cards.map((c, i) => i).filter(i => String(i) !== guiltyIdxStr);
            const stepMs = Math.max(500, (dur * 1000 * 0.6) / Math.max(1, others.length));
            others.forEach((idx, k) => {
              setTimeout(() => { const c = cards[idx]; if (c) c.classList.add('eliminated'); }, 600 + k * stepMs);
            });
            const gIdx = Number(guiltyIdxStr);
            setTimeout(() => { const c = cards[gIdx]; if (c) c.classList.add('guilty'); }, 600 + others.length * stepMs + 300);
          }
          // Entering reveal: schedule the camera-shake / flash impact to
          // land exactly when the GUILTY stamp animation completes (the
          // stamp's own CSS delay is 1.7s, animation ~0.45s).
          if (phase === 'reveal') {
            setTimeout(() => {
              const root = document.getElementById('scene-root');
              const flash = document.querySelector('#scene-root .sc-impact-flash');
              if (root) { root.classList.add('impact'); setTimeout(() => root.classList.remove('impact'), 320); }
              if (flash) { flash.classList.add('fire'); setTimeout(() => flash.classList.remove('fire'), 320); }
            }, 2050);
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
              const x = rowRect.left - listRect.left - 60;
              const y = rowRect.top - listRect.top + rowRect.height / 2 - 48;
              mag.style.transform = `translate(${x}px, ${y}px)`;
            }
          }
          const fill = document.getElementById('sc-thread-fill');
          if (fill) fill.style.height = `${Math.round(((idx + 1) / total) * 100)}%`;
        }, ev.clueIdx, clueCount);
      }
    } catch (e) {
      console.warn(`[SCENE] event failed at t=${ev.atSec.toFixed(2)}s: ${e.message.slice(0, 90)}`);
    }
  }

  const remainMs = totalDur * 1000 - (Date.now() - t0);
  if (remainMs > 0) await new Promise(r => setTimeout(r, remainMs));

  await withTimeout(recorder.stop(), TIMEOUT_RECORDER, 'scene.stop');

  await ffmpeg(
    `-y -i "${rawVideo}" -an -c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
    `-vf "scale=${VIDEO_W}:${VIDEO_H}" "${h264Video}"`, 'scene_enc'
  );
  await ffmpeg(
    `-y -stream_loop -1 -i "${h264Video}" -i "${narrationPath}" ` +
    `-map 0:v:0 -map 1:a:0 -c:v libx264 -crf 27 -preset faster -pix_fmt yuv420p -r 30 ` +
    `-c:a aac -b:a 128k -ar 44100 -ac 1 -t ${totalDur} "${outVideo}"`, 'scene_mux'
  );

  await page.evaluate(() => {
    const el = document.getElementById('scene-root');
    if (el) el.remove();
  });

  console.log(`[SCENE] explanation scene recorded: ${totalDur.toFixed(2)}s, ${timeline.length} narration beat(s)`);
  return { path: outVideo, dur: totalDur };
}

module.exports = { isSceneEligible, recordScene, SCENE_BUILDERS };
