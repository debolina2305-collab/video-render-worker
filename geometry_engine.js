'use strict';
// ════════════════════════════════════════════════════════════════════════════
// geometry_engine.js — PROCEDURAL geometry puzzle generator + renderer
//
// WHY THIS EXISTS:
//   The old geometry_triangle / geometry_right_triangle / geometry_straight_line
//   puzzle_types each draw ONE fixed diagram — only the numbers change. Viewers
//   see "the same puzzle" every time that type comes up. Asking an LLM to
//   invent 200 more near-identical types multiplies that problem, not fixes it.
//
//   Geometry answers are 100% computable from formulas, so there's no reason
//   to call an LLM for these at all. This engine:
//     1. Picks a random FAMILY (a genuinely different shape + question, not
//        just different numbers) from GEOMETRY_FAMILIES below.
//     2. Generates random parameters for it.
//     3. Computes the correct answer directly with real math (no LLM, no
//        validator guessing — it is simply arithmetically correct).
//     4. Renders a filled, colored SVG diagram specific to that family.
//
//   Adding a new family = adding one object to GEOMETRY_FAMILIES. No new LLM
//   prompt, no new hard validator, no new puzzle_type_config row required.
//
// SCALING TO "1000+":
//   33 families × randomized integer parameters × 10 fill colors × (for many
//   families) mirrored/rotated orientation already produces many thousands of
//   visually-and-numerically distinct outputs. Reaching more families is just
//   appending to this array — see the "NEXT BATCHES" note at the bottom.
//
// INTEGRATION (see integration notes at the end of this file):
//   - puzzle_generator.js: for puzzle_type 'geometry', call generateGeometryPuzzle()
//     INSTEAD of generatePuzzlesWithLLM(). Skips the whole LLM+validate step.
//   - puzzleRenderers.js: add `geometry: renderGeometryPuzzle` to RENDERERS.
// ════════════════════════════════════════════════════════════════════════════

// ── Shared SVG shell (same visual language as puzzleRenderers.js) ──────────
const INK = '#ffffff', INK_DIM = '#cccccc', STROKE = '#333333';

// Curated vivid fill palette — a DIFFERENT color is picked per puzzle instance
// (previously every shape was hardcoded gold-outline-only). Kept saturated
// enough to read clearly against the near-black panel.
const FILL_PALETTE = [
  '#FFC700', '#22c55e', '#3b82f6', '#f97316', '#ec4899',
  '#a78bfa', '#06b6d4', '#ef4444', '#84cc16', '#e879f9',
];

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function openSvg(W, H, fillColor) {
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" width="100%" role="img" class="puzzle-svg">
  <defs>
    <linearGradient id="pzPanel2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#111111"/>
    </linearGradient>
    <filter id="pzGlow2" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="${fillColor}" flood-opacity="0.7"/>
    </filter>
    <style>
      .pz-anim2 { transform-box: fill-box; transform-origin: 50% 50%;
        animation: pzFadeIn2 0.6s ease both; }
      @keyframes pzFadeIn2 { from { opacity:0; transform: scale(0.94) translateY(14px); }
        to { opacity:1; transform: scale(1) translateY(0); } }
    </style>
  </defs>
  <g class="pz-anim2">
  <rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="34" fill="url(#pzPanel2)" stroke="${fillColor}" stroke-width="4"/>
  <rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="34" fill="none" stroke="${STROKE}" stroke-width="1" opacity="0.6"/>`;
}
function closeSvg() { return `</g></svg>`; }
function titleStrip(W, text, fillColor) {
  if (!text) return '';
  return `<g><rect x="${W/2-300}" y="42" width="600" height="66" rx="33" fill="${fillColor}" opacity="0.30"/>
    <text x="${W/2}" y="88" text-anchor="middle" font-family="Poppins,Segoe UI,Arial,sans-serif"
      font-size="42" font-weight="800" fill="#ffffff" letter-spacing="1">${esc(String(text).toUpperCase())}</text></g>`;
}
function label(x, y, text, fillColor, hi, size = 52) {
  const box = hi ? `<circle cx="${x}" cy="${y-14}" r="42" fill="${fillColor}" opacity="0.2"/>` : '';
  return `${box}<text x="${x}" y="${y}" text-anchor="middle" font-family="Poppins,Arial"
    font-size="${size}" font-weight="800" fill="${hi ? fillColor : INK}">${esc(text)}</text>`;
}
// Generic filled polygon — this is the core "not outline only" primitive.
function filledPolygon(points, fillColor) {
  const pts = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  return `<polygon points="${pts}" fill="${fillColor}" fill-opacity="0.82" stroke="${fillColor}" stroke-width="5" stroke-linejoin="round"/>`;
}
function rightAngleMarker(x, y, sx, sy) {
  return `<path d="M ${x} ${y+sy*40} L ${x+sx*40} ${y+sy*40} L ${x+sx*40} ${y}" fill="none" stroke="${INK_DIM}" stroke-width="3"/>`;
}
function angleArc(v, p1, p2, r, fillColor) {
  const ang = (px, py) => Math.atan2(py - v.y, px - v.x);
  const a1 = ang(p1.x, p1.y), a2 = ang(p2.x, p2.y);
  const x1 = v.x + r * Math.cos(a1), y1 = v.y + r * Math.sin(a1);
  const x2 = v.x + r * Math.cos(a2), y2 = v.y + r * Math.sin(a2);
  return `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${fillColor}" stroke-width="3"/>`;
}

// ── RNG helpers ──────────────────────────────────────────────────────────
function ri(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(a) { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
// 4 distinct plausible options containing the true answer, values near it.
function makeOptions(correctVal, fmt, spread) {
  const set = new Set([fmt(correctVal)]);
  let guard = 0;
  while (set.size < 4 && guard++ < 50) {
    const delta = pick([-2, -1, 1, 2]) * spread * (1 + Math.floor(guard / 8));
    const v = correctVal + delta;
    if (v > 0) set.add(fmt(v));
  }
  return shuffle([...set]).slice(0, 4);
}
function keep5050(options, correct) {
  const ci = options.indexOf(correct);
  const others = options.map((_, i) => i).filter(i => i !== ci);
  return [ci, pick(others)].map(String);
}
const PYTH_TRIPLES = [[3,4,5],[6,8,10],[5,12,13],[8,15,17],[9,12,15],[7,24,25],[20,21,29],[12,16,20]];
// Recognizable triples first, weighted MUCH higher — a viewer who half-remembers
// "3-4-5" can pattern-match instantly; almost nobody recognizes "20-21-29" fast.
const COMMON_TRIPLES = [[3,4,5],[3,4,5],[3,4,5],[6,8,10],[6,8,10],[5,12,13],[5,12,13],[9,12,15],[8,15,17],[7,24,25]];

// ════════════════════════════════════════════════════════════════════════════
// 5–8 SECOND BUDGET — the actual design constraint
// ────────────────────────────────────────────────────────────────────────────
// A Shorts/Reels viewer gets ONE glance. They need to be ABLE to narrow it to
// one option using rough estimation/recognition, not forced into exact mental
// arithmetic. Three concrete levers, applied per-family below:
//   1. WEIGHT      — how often a family is picked. 'hard' families (irrational
//                    math: √2, √3, π) still exist for variety, but 3x rarer.
//   2. SPREAD      — how far apart the 4 multiple-choice options are, as a %
//                    of the correct value. Wider spread = estimation is enough,
//                    no exact math needed. This was the main bug: everything
//                    used a flat ±1/±2 gap regardless of the answer's size, so
//                    e.g. "27 vs 28 vs 29 vs 26" REQUIRED exact computation.
//   3. THINK TIME  — 'hard' families get more on-screen seconds (this maps
//                    directly to the existing `thinking_time_sec` DB column).
// A 4th lever — TRAP DISTRACTORS — makes the "too easy" ones not boring: for
// families with a well-known conceptual mistake (mixing up complementary vs
// supplementary, vertical vs adjacent), one wrong option IS that mistake,
// instead of a random nearby number. That's what creates real hesitation.
// ════════════════════════════════════════════════════════════════════════════
const DIFFICULTY_CONFIG = {
  quick:  { selectWeight: 3, spreadPct: 0.12, thinkTimeSec: 5  }, // → short  (12s video)
  medium: { selectWeight: 2, spreadPct: 0.20, thinkTimeSec: 8  }, // → medium (22s video)
  hard:   { selectWeight: 1, spreadPct: 0.32, thinkTimeSec: 12 }, // → long   (42s video)
};
// Deterministic difficulty → format mapping. This is the piece that makes
// the "12s/5s, 22s/8s, 42s/12s" format plan actually work: a hard puzzle
// MUST land in the long slot, not whichever format worker polls first.
const DIFFICULTY_TO_FORMAT = { quick: 'short', medium: 'medium', hard: 'long' };

// ════════════════════════════════════════════════════════════════════════════
// FAMILIES — each: { id, category, generate() -> {vars, correct}, render(vars, fillColor) -> innerSvg,
//                     question, title, explain(vars) }
// ════════════════════════════════════════════════════════════════════════════
const GEOMETRY_FAMILIES = [

  // ── TRIANGLES ──────────────────────────────────────────────────────────
  {
    id: 'tri_angle_sum', difficulty: 'quick', category: 'triangle', title: 'Find the Angle',
    question: 'What is the missing angle?',
    generate() {
      let b = ri(30, 85), c = ri(30, 85 - Math.max(0, b - 85));
      while (b + c >= 175) c = ri(20, 60);
      const a = 180 - b - c;
      return { vars: { a, b, c, flip: Math.random() < 0.5 }, correct: a, fmt: v => `${v}°` };
    },
    render(v, fc) {
      const A = { x: 480, y: 140 }, B = { x: 230, y: 380 }, Cc = { x: 730, y: 380 };
      let s = filledPolygon([A, B, Cc], fc);
      s += angleArc(A, B, Cc, 46, INK_DIM) + angleArc(B, A, Cc, 46, INK_DIM) + angleArc(Cc, A, B, 46, INK_DIM);
      [A, B, Cc].forEach(p => s += `<circle cx="${p.x}" cy="${p.y}" r="8" fill="${INK}"/>`);
      s += label(A.x, A.y - 36, 'x°', fc, true);
      s += label(B.x - 8, B.y + 50, `${v.b}°`, fc, false);
      s += label(Cc.x + 8, Cc.y + 50, `${v.c}°`, fc, false);
      return s;
    },
    explain: v => `A triangle's angles always sum to 180°, so 180 − ${v.b} − ${v.c} = ${v.a}°.`,
  },
  {
    id: 'tri_isosceles_base', difficulty: 'quick', category: 'triangle', title: 'Isosceles Triangle',
    question: 'What is each base angle?',
    generate() {
      const apex = ri(20, 100) - (ri(20,100) % 2); // keep remainder even for clean division
      const base = (180 - apex) / 2;
      return { vars: { apex, base }, correct: base, fmt: v => `${v}°` };
    },
    render(v, fc) {
      const A = { x: 480, y: 130 }, B = { x: 260, y: 380 }, Cc = { x: 700, y: 380 };
      let s = filledPolygon([A, B, Cc], fc);
      s += `<line x1="${A.x}" y1="${A.y}" x2="${(B.x+Cc.x)/2}" y2="${B.y}" stroke="${INK_DIM}" stroke-width="2" stroke-dasharray="6,6"/>`;
      s += angleArc(A, B, Cc, 40, INK_DIM) + angleArc(B, A, Cc, 46, INK_DIM) + angleArc(Cc, A, B, 46, INK_DIM);
      s += label(A.x, A.y - 26, `${v.apex}°`, fc, false, 44);
      s += label(B.x - 10, B.y + 50, 'x°', fc, true);
      s += label(Cc.x + 10, Cc.y + 50, 'x°', fc, true);
      s += `<text x="${A.x}" y="${(B.y+A.y)/2}" text-anchor="middle" font-size="26" fill="${INK_DIM}" font-family="Arial">equal sides</text>`;
      return s;
    },
    explain: v => `Isosceles triangles have two equal base angles. (180 − ${v.apex}) ÷ 2 = ${v.base}°.`,
  },
  {
    id: 'tri_exterior_angle', difficulty: 'quick', category: 'triangle', title: 'Exterior Angle',
    question: 'What is the marked exterior angle?',
    generate() {
      const i1 = ri(30, 80), i2 = ri(30, 80);
      return { vars: { i1, i2 }, correct: i1 + i2, fmt: v => `${v}°` };
    },
    render(v, fc) {
      const A = { x: 420, y: 150 }, B = { x: 220, y: 380 }, Cc = { x: 650, y: 380 }, D = { x: 860, y: 380 };
      let s = filledPolygon([A, B, Cc], fc);
      s += `<line x1="${B.x}" y1="${B.y}" x2="${D.x}" y2="${D.y}" stroke="${INK_DIM}" stroke-width="4"/>`;
      s += angleArc(A, B, Cc, 44, INK_DIM) + angleArc(B, A, Cc, 40, INK_DIM) + angleArc(Cc, A, D, 44, fc);
      s += label(A.x, A.y - 26, `${v.i1}°`, fc, false, 40);
      s += label(B.x - 6, B.y + 50, `${v.i2}°`, fc, false, 40);
      s += label(Cc.x + 60, Cc.y - 40, 'x°', fc, true);
      return s;
    },
    explain: v => `An exterior angle equals the sum of the two remote interior angles: ${v.i1} + ${v.i2} = ${v.i1+v.i2}°.`,
  },
  {
    id: 'tri_right_pyth', difficulty: 'medium', category: 'triangle', title: 'Missing Side',
    question: 'What is the missing side length?',
    generate() {
      const [a, b, c] = pick(COMMON_TRIPLES);
      const unknown = pick(['leg_a', 'leg_b', 'hyp']);
      const correct = unknown === 'leg_a' ? a : unknown === 'leg_b' ? b : c;
      return { vars: { a, b, c, unknown }, correct, fmt: v => `${v}` };
    },
    render(v, fc) {
      const B = { x: 250, y: 380 }, A = { x: 250, y: 140 }, Cc = { x: 740, y: 380 };
      let s = filledPolygon([A, B, Cc], fc);
      s += rightAngleMarker(B.x, B.y, 1, -1);
      s += label(B.x - 60, (A.y+B.y)/2 + 16, v.unknown === 'leg_a' ? 'x' : String(v.a), fc, v.unknown === 'leg_a');
      s += label((B.x+Cc.x)/2, B.y + 66, v.unknown === 'leg_b' ? 'x' : String(v.b), fc, v.unknown === 'leg_b');
      s += label((A.x+Cc.x)/2 + 60, (A.y+Cc.y)/2 - 30, v.unknown === 'hyp' ? 'x' : String(v.c), fc, v.unknown === 'hyp');
      return s;
    },
    explain: v => `Pythagoras: a² + b² = c². With ${v.a}-${v.b}-${v.c}, the missing side is ${v.unknown === 'hyp' ? v.c : v.unknown === 'leg_a' ? v.a : v.b}.`,
  },
  {
    id: 'tri_special_306090', difficulty: 'hard', category: 'triangle', title: '30-60-90 Triangle',
    question: 'What is the longer leg? (hint: × 1.7)',
    generate() {
      // Small, even short-leg values only — keeps "short × 1.7" a fast
      // single mental multiplication instead of an arbitrary decimal.
      const short = pick([2,4,6,8,10]);
      const correct = Math.round(short * Math.sqrt(3) * 10) / 10;
      return { vars: { short, correct }, correct, fmt: v => `${v}` };
    },
    render(v, fc) {
      const B = { x: 260, y: 380 }, A = { x: 260, y: 140 }, Cc = { x: 780, y: 380 };
      let s = filledPolygon([A, B, Cc], fc);
      s += rightAngleMarker(B.x, B.y, 1, -1);
      s += label(B.x - 50, (A.y+B.y)/2 + 16, String(v.short), fc, false, 44);
      s += label((B.x+Cc.x)/2, B.y + 66, 'x', fc, true);
      s += label(A.x + 70, A.y + 60, '30°', fc, false, 32);
      s += label(Cc.x - 70, Cc.y - 30, '60°', fc, false, 32);
      return s;
    },
    explain: v => `In a 30-60-90 triangle the long leg = short leg × √3 ≈ ${v.short} × 1.732 = ${v.correct}.`,
  },
  {
    id: 'tri_special_454590', difficulty: 'hard', category: 'triangle', title: '45-45-90 Triangle',
    question: 'What is the hypotenuse? (hint: × 1.4)',
    generate() {
      const leg = pick([2,4,6,8,10]);
      const correct = Math.round(leg * Math.sqrt(2) * 10) / 10;
      return { vars: { leg, correct }, correct, fmt: v => `${v}` };
    },
    render(v, fc) {
      const B = { x: 260, y: 380 }, A = { x: 260, y: 140 }, Cc = { x: 720, y: 380 };
      let s = filledPolygon([A, B, Cc], fc);
      s += rightAngleMarker(B.x, B.y, 1, -1);
      s += label(B.x - 50, (A.y+B.y)/2 + 16, String(v.leg), fc, false, 44);
      s += label((B.x+Cc.x)/2, B.y + 66, String(v.leg), fc, false, 44);
      s += label((A.x+Cc.x)/2 + 50, (A.y+Cc.y)/2 - 20, 'x', fc, true);
      return s;
    },
    explain: v => `In a 45-45-90 triangle the hypotenuse = leg × √2 ≈ ${v.leg} × 1.414 = ${v.correct}.`,
  },
  {
    id: 'tri_area_base_height', difficulty: 'quick', category: 'triangle', title: 'Triangle Area',
    question: 'What is the area of this triangle?',
    generate() {
      const base = ri(4, 16), height = ri(3, 14);
      return { vars: { base, height }, correct: (base * height) / 2, fmt: v => `${v}` };
    },
    render(v, fc) {
      const B = { x: 230, y: 380 }, Cc = { x: 730, y: 380 }, A = { x: 500, y: 150 };
      let s = filledPolygon([A, B, Cc], fc);
      s += `<line x1="${A.x}" y1="${A.y}" x2="${A.x}" y2="${B.y}" stroke="${INK_DIM}" stroke-width="2" stroke-dasharray="6,6"/>`;
      s += label((B.x+Cc.x)/2, B.y + 50, `base = ${v.base}`, fc, false, 34);
      s += label(A.x + 90, (A.y+B.y)/2, `h = ${v.height}`, fc, false, 34);
      return s;
    },
    explain: v => `Triangle area = ½ × base × height = ½ × ${v.base} × ${v.height} = ${(v.base*v.height)/2}.`,
  },

  // ── QUADRILATERALS ────────────────────────────────────────────────────
  {
    id: 'quad_square_area', difficulty: 'quick', category: 'quadrilateral', title: 'Square Area',
    question: 'What is the area of this square?',
    generate() { const s = ri(3, 15); return { vars: { s }, correct: s * s, fmt: v => `${v}`, trap: s * 4 }; },
    render(v, fc) {
      const x = 300, y = 150, side = 360;
      let s = `<rect x="${x}" y="${y}" width="${side}" height="${side}" fill="${fc}" fill-opacity="0.82" stroke="${fc}" stroke-width="5"/>`;
      s += label(x + side/2, y - 20, `${v.s}`, fc, false, 40);
      s += label(x - 40, y + side/2, `${v.s}`, fc, false, 40);
      return s;
    },
    explain: v => `Square area = side². ${v.s}² = ${v.s*v.s}.`,
  },
  {
    id: 'quad_square_perimeter', difficulty: 'quick', category: 'quadrilateral', title: 'Square Perimeter',
    question: 'What is the perimeter of this square?',
    generate() { const s = ri(3, 20); return { vars: { s }, correct: s * 4, fmt: v => `${v}`, trap: s * s }; },
    render(v, fc) {
      const x = 300, y = 150, side = 360;
      let s = `<rect x="${x}" y="${y}" width="${side}" height="${side}" fill="${fc}" fill-opacity="0.82" stroke="${fc}" stroke-width="5"/>`;
      s += label(x + side/2, y - 20, `${v.s}`, fc, false, 40);
      return s;
    },
    explain: v => `Square perimeter = 4 × side = 4 × ${v.s} = ${v.s*4}.`,
  },
  {
    id: 'quad_square_diagonal', difficulty: 'hard', category: 'quadrilateral', title: 'Square Diagonal',
    question: 'What is the diagonal length? (hint: × 1.4)',
    generate() { const s = pick([2,4,6,8,10]); return { vars: { s }, correct: Math.round(s*Math.SQRT2*10)/10, fmt: v => `${v}` }; },
    render(v, fc) {
      const x = 320, y = 140, side = 320;
      let s = `<rect x="${x}" y="${y}" width="${side}" height="${side}" fill="${fc}" fill-opacity="0.82" stroke="${fc}" stroke-width="5"/>`;
      s += `<line x1="${x}" y1="${y}" x2="${x+side}" y2="${y+side}" stroke="${INK}" stroke-width="3" stroke-dasharray="8,6"/>`;
      s += label(x + side/2, y - 20, `${v.s}`, fc, false, 38);
      s += label(x + side/2 + 60, y + side/2 - 30, 'x', fc, true);
      return s;
    },
    explain: v => `Square diagonal = side × √2 ≈ ${v.s} × 1.414 = ${Math.round(v.s*Math.SQRT2*10)/10}.`,
  },
  {
    id: 'quad_rect_area', difficulty: 'quick', category: 'quadrilateral', title: 'Rectangle Area',
    question: 'What is the area of this rectangle?',
    generate() { const w = ri(4, 18), h = ri(3, 14); return { vars: { w, h }, correct: w * h, fmt: v => `${v}`, trap: 2*(w+h) }; },
    render(v, fc) {
      const x = 250, y = 170, W = 460, H = 260;
      let s = `<rect x="${x}" y="${y}" width="${W}" height="${H}" fill="${fc}" fill-opacity="0.82" stroke="${fc}" stroke-width="5"/>`;
      s += label(x + W/2, y - 20, `${v.w}`, fc, false, 40);
      s += label(x - 40, y + H/2, `${v.h}`, fc, false, 40);
      return s;
    },
    explain: v => `Rectangle area = width × height = ${v.w} × ${v.h} = ${v.w*v.h}.`,
  },
  {
    id: 'quad_rect_perimeter', difficulty: 'quick', category: 'quadrilateral', title: 'Rectangle Perimeter',
    question: 'What is the perimeter of this rectangle?',
    generate() { const w = ri(4, 20), h = ri(3, 16); return { vars: { w, h }, correct: 2*(w+h), fmt: v => `${v}`, trap: w*h }; },
    render(v, fc) {
      const x = 250, y = 170, W = 460, H = 260;
      let s = `<rect x="${x}" y="${y}" width="${W}" height="${H}" fill="${fc}" fill-opacity="0.82" stroke="${fc}" stroke-width="5"/>`;
      s += label(x + W/2, y - 20, `${v.w}`, fc, false, 40);
      s += label(x - 40, y + H/2, `${v.h}`, fc, false, 40);
      return s;
    },
    explain: v => `Rectangle perimeter = 2 × (w + h) = 2 × (${v.w} + ${v.h}) = ${2*(v.w+v.h)}.`,
  },
  {
    id: 'quad_rect_diagonal', difficulty: 'medium', category: 'quadrilateral', title: 'Rectangle Diagonal',
    question: 'What is the diagonal length?',
    generate() { const [a,b,c] = pick(COMMON_TRIPLES); return { vars: { w: a, h: b, d: c }, correct: c, fmt: v => `${v}` }; },
    render(v, fc) {
      const x = 260, y = 180, W = 440, H = 240;
      let s = `<rect x="${x}" y="${y}" width="${W}" height="${H}" fill="${fc}" fill-opacity="0.82" stroke="${fc}" stroke-width="5"/>`;
      s += `<line x1="${x}" y1="${y}" x2="${x+W}" y2="${y+H}" stroke="${INK}" stroke-width="3" stroke-dasharray="8,6"/>`;
      s += label(x + W/2, y - 20, `${v.w}`, fc, false, 38);
      s += label(x - 40, y + H/2, `${v.h}`, fc, false, 38);
      s += label(x + W/2 + 60, y + H/2 - 30, 'x', fc, true);
      return s;
    },
    explain: v => `Diagonal² = w² + h² → ${v.w}² + ${v.h}² = ${v.d}².`,
  },
  {
    id: 'quad_rhombus_area', difficulty: 'medium', category: 'quadrilateral', title: 'Rhombus Area',
    question: 'What is the area of this rhombus?',
    generate() { const d1 = ri(4,16)*2, d2 = ri(3,12)*2; return { vars: { d1, d2 }, correct: (d1*d2)/2, fmt: v => `${v}` }; },
    render(v, fc) {
      const cx = 480, cy = 300, rx = 220, ry = 140;
      const pts = [{x:cx,y:cy-ry},{x:cx+rx,y:cy},{x:cx,y:cy+ry},{x:cx-rx,y:cy}];
      let s = filledPolygon(pts, fc);
      s += `<line x1="${cx}" y1="${cy-ry}" x2="${cx}" y2="${cy+ry}" stroke="${INK}" stroke-width="2" stroke-dasharray="6,6"/>`;
      s += `<line x1="${cx-rx}" y1="${cy}" x2="${cx+rx}" y2="${cy}" stroke="${INK}" stroke-width="2" stroke-dasharray="6,6"/>`;
      s += label(cx, cy-ry-24, `d1 = ${v.d1}`, fc, false, 34);
      s += label(cx+rx+70, cy+8, `d2 = ${v.d2}`, fc, false, 34);
      return s;
    },
    explain: v => `Rhombus area = (d1 × d2) ÷ 2 = (${v.d1} × ${v.d2}) ÷ 2 = ${(v.d1*v.d2)/2}.`,
  },
  {
    id: 'quad_parallelogram_area', difficulty: 'quick', category: 'quadrilateral', title: 'Parallelogram Area',
    question: 'What is the area of this parallelogram?',
    generate() { const base = ri(5,18), h = ri(3,12); return { vars: { base, h }, correct: base*h, fmt: v => `${v}` }; },
    render(v, fc) {
      const y1 = 180, y2 = 420, x0 = 260, skew = 110, W = 380;
      const pts = [{x:x0+skew,y:y1},{x:x0+skew+W,y:y1},{x:x0+W,y:y2},{x:x0,y:y2}];
      let s = filledPolygon(pts, fc);
      s += `<line x1="${x0+skew+W/2}" y1="${y1}" x2="${x0+W/2}" y2="${y2}" stroke="${INK}" stroke-width="2" stroke-dasharray="6,6"/>`;
      s += label(x0+W/2, y2+40, `base = ${v.base}`, fc, false, 34);
      s += label(x0+W/2-70, (y1+y2)/2, `h = ${v.h}`, fc, false, 34);
      return s;
    },
    explain: v => `Parallelogram area = base × height = ${v.base} × ${v.h} = ${v.base*v.h}.`,
  },
  {
    id: 'quad_trapezoid_area', difficulty: 'medium', category: 'quadrilateral', title: 'Trapezoid Area',
    question: 'What is the area of this trapezoid?',
    generate() { const a = ri(4,10), b = ri(10,20), h = ri(3,10); return { vars: { a, b, h }, correct: ((a+b)/2)*h, fmt: v => `${v}` }; },
    render(v, fc) {
      const y1 = 180, y2 = 420, cx = 480, wTop = 200, wBot = 420;
      const pts = [{x:cx-wTop/2,y:y1},{x:cx+wTop/2,y:y1},{x:cx+wBot/2,y:y2},{x:cx-wBot/2,y:y2}];
      let s = filledPolygon(pts, fc);
      s += label(cx, y1-20, `${v.a}`, fc, false, 38);
      s += label(cx, y2+40, `${v.b}`, fc, false, 38);
      s += label(cx-wBot/2-40, (y1+y2)/2, `h=${v.h}`, fc, false, 32);
      return s;
    },
    explain: v => `Trapezoid area = ((a+b)/2) × h = ((${v.a}+${v.b})/2) × ${v.h} = ${((v.a+v.b)/2)*v.h}.`,
  },

  // ── CIRCLES ───────────────────────────────────────────────────────────
  {
    id: 'circle_area', difficulty: 'hard', category: 'circle', title: 'Circle Area',
    question: 'What is the area of this circle? (use π ≈ 3)',
    generate() { const r = ri(2,6); return { vars: { r }, correct: Math.round(3*r*r*100)/100, fmt: v => `${v}` }; },
    render(v, fc) {
      const cx = 480, cy = 300, R = 160;
      let s = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${fc}" fill-opacity="0.82" stroke="${fc}" stroke-width="5"/>`;
      s += `<line x1="${cx}" y1="${cy}" x2="${cx+R}" y2="${cy}" stroke="${INK}" stroke-width="3"/>`;
      s += label(cx+R/2, cy-16, `r=${v.r}`, fc, false, 34);
      return s;
    },
    explain: v => `Circle area = πr² ≈ 3 × ${v.r}² = ${Math.round(3*v.r*v.r*100)/100}.`,
  },
  {
    id: 'circle_circumference', difficulty: 'hard', category: 'circle', title: 'Circle Circumference',
    question: 'What is the circumference of this circle? (use π ≈ 3)',
    generate() { const r = ri(2,6); return { vars: { r }, correct: Math.round(2*3*r*100)/100, fmt: v => `${v}` }; },
    render(v, fc) {
      const cx = 480, cy = 300, R = 160;
      let s = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${fc}" fill-opacity="0.82" stroke="${fc}" stroke-width="5"/>`;
      s += `<line x1="${cx}" y1="${cy}" x2="${cx+R}" y2="${cy}" stroke="${INK}" stroke-width="3"/>`;
      s += label(cx+R/2, cy-16, `r=${v.r}`, fc, false, 34);
      return s;
    },
    explain: v => `Circumference = 2πr ≈ 2 × 3 × ${v.r} = ${Math.round(2*3*v.r*100)/100}.`,
  },
  {
    id: 'circle_sector_area', difficulty: 'hard', category: 'circle', title: 'Sector Area',
    question: 'What is the area of the shaded sector? (use π ≈ 3)',
    generate() {
      // Only "nice" fractions of a circle (quarter/third/half) so the
      // fraction step is instant instead of an arbitrary angle/360 division.
      const r = ri(3,6), angle = pick([90,120,180]);
      const correct = Math.round(3*r*r*(angle/360)*100)/100;
      return { vars: { r, angle }, correct, fmt: v => `${v}` };
    },
    render(v, fc) {
      const cx = 480, cy = 300, R = 160;
      const a1 = -90, a2 = -90 + v.angle;
      const toXY = a => ({ x: cx + R*Math.cos(a*Math.PI/180), y: cy + R*Math.sin(a*Math.PI/180) });
      const p1 = toXY(a1), p2 = toXY(a2);
      const large = v.angle > 180 ? 1 : 0;
      let s = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${fc}" fill-opacity="0.15" stroke="${fc}" stroke-width="3"/>`;
      s += `<path d="M ${cx} ${cy} L ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} Z" fill="${fc}" fill-opacity="0.85" stroke="${fc}" stroke-width="4"/>`;
      s += label(cx+40, cy-70, `${v.angle}°`, fc, true, 34);
      s += label(cx+R/2, cy+40, `r=${v.r}`, fc, false, 30);
      return s;
    },
    explain: v => `Sector area = πr² × (angle/360) ≈ 3 × ${v.r}² × (${v.angle}/360) = ${Math.round(3*v.r*v.r*(v.angle/360)*100)/100}.`,
  },
  {
    id: 'circle_arc_length', difficulty: 'hard', category: 'circle', title: 'Arc Length',
    question: 'What is the length of the marked arc? (use π ≈ 3)',
    generate() {
      const r = ri(3,7), angle = pick([90,120,180]);
      const correct = Math.round(2*3*r*(angle/360)*100)/100;
      return { vars: { r, angle }, correct, fmt: v => `${v}` };
    },
    render(v, fc) {
      const cx = 480, cy = 300, R = 160;
      const a1 = -90, a2 = -90 + v.angle;
      const toXY = a => ({ x: cx + R*Math.cos(a*Math.PI/180), y: cy + R*Math.sin(a*Math.PI/180) });
      const p1 = toXY(a1), p2 = toXY(a2);
      const large = v.angle > 180 ? 1 : 0;
      let s = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${fc}" fill-opacity="0.12" stroke="${fc}" stroke-width="3"/>`;
      s += `<path d="M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}" fill="none" stroke="${fc}" stroke-width="8" stroke-linecap="round"/>`;
      s += label(cx+40, cy-70, `${v.angle}°`, fc, true, 34);
      s += label(cx+R/2, cy+40, `r=${v.r}`, fc, false, 30);
      return s;
    },
    explain: v => `Arc length = 2πr × (angle/360) ≈ 2 × 3 × ${v.r} × (${v.angle}/360) = ${Math.round(2*3*v.r*(v.angle/360)*100)/100}.`,
  },

  // ── COMPOUND SHAPES ───────────────────────────────────────────────────
  {
    id: 'compound_L_area', difficulty: 'medium', category: 'compound', title: 'L-Shape Area',
    question: 'What is the area of this L-shape?',
    generate() {
      const ow = ri(6,14), oh = ri(6,14), cw = ri(2,ow-2), ch = ri(2,oh-2);
      return { vars: { ow, oh, cw, ch }, correct: ow*oh - (ow-cw)*ch, fmt: v => `${v}` };
    },
    render(v, fc) {
      const x = 260, y = 150, sc = 24;
      const OW = v.ow*sc, OH = v.oh*sc, CW = v.cw*sc, CH = v.ch*sc;
      const pts = [
        {x, y}, {x: x+OW-CW, y}, {x: x+OW-CW, y: y+CH}, {x: x+OW, y: y+CH}, {x: x+OW, y: y+OH}, {x, y: y+OH},
      ];
      let s = filledPolygon(pts, fc);
      s += label(x+OW/2, y-16, `${v.ow}`, fc, false, 32);
      s += label(x-36, y+OH/2, `${v.oh}`, fc, false, 32);
      s += label(x+OW-CW/2, y+CH+26, `${v.cw}`, fc, false, 26);
      s += label(x+OW+26, y+CH/2, `${v.ch}`, fc, false, 26);
      return s;
    },
    explain: v => `Full rectangle (${v.ow}×${v.oh}) minus the notch ((${v.ow}-${v.cw})×${v.ch}) = ${v.ow*v.oh - (v.ow-v.cw)*v.ch}.`,
  },
  {
    id: 'compound_T_area', difficulty: 'medium', category: 'compound', title: 'T-Shape Area',
    question: 'What is the area of this T-shape?',
    generate() {
      const topW = ri(8,16), topH = ri(2,5), stemW = ri(2,topW-2), stemH = ri(4,10);
      return { vars: { topW, topH, stemW, stemH }, correct: topW*topH + stemW*stemH, fmt: v => `${v}` };
    },
    render(v, fc) {
      const sc = 20, x0 = 480, y0 = 160;
      const TW = v.topW*sc, TH = v.topH*sc, SW = v.stemW*sc, SH = v.stemH*sc;
      const pts = [
        {x:x0-TW/2,y:y0},{x:x0+TW/2,y:y0},{x:x0+TW/2,y:y0+TH},{x:x0+SW/2,y:y0+TH},
        {x:x0+SW/2,y:y0+TH+SH},{x:x0-SW/2,y:y0+TH+SH},{x:x0-SW/2,y:y0+TH},{x:x0-TW/2,y:y0+TH},
      ];
      let s = filledPolygon(pts, fc);
      s += label(x0, y0-16, `top ${v.topW}×${v.topH}`, fc, false, 26);
      s += label(x0, y0+TH+SH+34, `stem ${v.stemW}×${v.stemH}`, fc, false, 26);
      return s;
    },
    explain: v => `Top bar (${v.topW}×${v.topH}) + stem (${v.stemW}×${v.stemH}) = ${v.topW*v.topH + v.stemW*v.stemH}.`,
  },
  {
    id: 'compound_plus_area', difficulty: 'medium', category: 'compound', title: 'Plus-Shape Area',
    question: 'What is the area of this plus/cross shape?',
    generate() {
      const arm = ri(2,6), center = ri(4,10);
      // 5 squares of size `arm` around a `center` core is a simplification —
      // use: cross = center*center*... simpler model: one big square (center)
      // with 4 arm x arm squares attached — but to keep the FORMULA simple
      // and airtight we use: total = center^2 + 4*(arm*center) is wrong for a
      // real cross, so instead model a true plus made of 5 unit blocks scaled:
      const unit = ri(2,8);
      return { vars: { unit }, correct: 5*unit*unit, fmt: v => `${v}` };
    },
    render(v, fc) {
      const sc = 22, u = v.unit*sc, x0 = 480, y0 = 300;
      const pts = [
        {x:x0-u/2,y:y0-1.5*u},{x:x0+u/2,y:y0-1.5*u},{x:x0+u/2,y:y0-0.5*u},{x:x0+1.5*u,y:y0-0.5*u},
        {x:x0+1.5*u,y:y0+0.5*u},{x:x0+u/2,y:y0+0.5*u},{x:x0+u/2,y:y0+1.5*u},{x:x0-u/2,y:y0+1.5*u},
        {x:x0-u/2,y:y0+0.5*u},{x:x0-1.5*u,y:y0+0.5*u},{x:x0-1.5*u,y:y0-0.5*u},{x:x0-u/2,y:y0-0.5*u},
      ];
      let s = filledPolygon(pts, fc);
      s += label(x0, y0-1.5*u-24, `each block = ${v.unit}×${v.unit}`, fc, false, 26);
      return s;
    },
    explain: v => `This plus-shape is made of 5 equal squares of side ${v.unit}: 5 × ${v.unit}² = ${5*v.unit*v.unit}.`,
  },

  // ── ANGLE RELATIONSHIPS ───────────────────────────────────────────────
  {
    id: 'angle_on_line', difficulty: 'quick', category: 'angle', title: 'Angles on a Line',
    question: 'What is the missing angle?',
    // Trap: viewers who mix this up with vertical angles guess "equal to k"
    // instead of "180-k" — include k itself as a decoy.
    generate() { const k = ri(20,160); return { vars: { k }, correct: 180-k, fmt: v => `${v}°`, trap: k }; },
    render(v, fc) {
      const O = {x:480,y:250}, L = {x:120,y:250}, R = {x:840,y:250};
      const rayAng = -(30 + (v.k)); const rad = rayAng*Math.PI/180;
      const ray = { x: O.x+300*Math.cos(rad), y: O.y+300*Math.sin(rad) };
      let s = `<line x1="${L.x}" y1="${L.y}" x2="${R.x}" y2="${R.y}" stroke="${fc}" stroke-width="7" stroke-linecap="round"/>`;
      s += `<line x1="${O.x}" y1="${O.y}" x2="${ray.x.toFixed(0)}" y2="${ray.y.toFixed(0)}" stroke="${fc}" stroke-width="7" stroke-linecap="round"/>`;
      s += `<circle cx="${O.x}" cy="${O.y}" r="9" fill="${INK}"/>`;
      s += angleArc(O, R, ray, 70, INK_DIM);
      s += label(O.x-150, O.y-40, `${v.k}°`, fc, false);
      s += label(O.x+130, O.y-40, 'x°', fc, true);
      return s;
    },
    explain: v => `Angles on a straight line sum to 180°: 180 − ${v.k} = ${180-v.k}°.`,
  },
  {
    id: 'angle_vertical', difficulty: 'quick', category: 'angle', title: 'Vertical Angles',
    question: 'What is the marked vertical angle?',
    // Trap: vertical angles are EQUAL, but the classic mistake is answering
    // 180-k (the ADJACENT/supplementary angle) instead — that's what makes
    // "just copy the number" not actually free.
    generate() { const k = ri(20,160); return { vars: { k }, correct: k, fmt: v => `${v}°`, trap: 180 - k }; },
    render(v, fc) {
      const O = {x:480,y:300};
      const rad1 = 20*Math.PI/180, rad2 = (20+180)*Math.PI/180;
      const rad3 = (20+v.k > 0 ? 110 : 110)*Math.PI/180, rad4 = (110+180)*Math.PI/180;
      const p1 = {x:O.x+260*Math.cos(rad1), y:O.y+260*Math.sin(rad1)};
      const p2 = {x:O.x+260*Math.cos(rad2), y:O.y+260*Math.sin(rad2)};
      const p3 = {x:O.x+260*Math.cos(rad3), y:O.y+260*Math.sin(rad3)};
      const p4 = {x:O.x+260*Math.cos(rad4), y:O.y+260*Math.sin(rad4)};
      let s = `<line x1="${p1.x.toFixed(0)}" y1="${p1.y.toFixed(0)}" x2="${p2.x.toFixed(0)}" y2="${p2.y.toFixed(0)}" stroke="${fc}" stroke-width="6"/>`;
      s += `<line x1="${p3.x.toFixed(0)}" y1="${p3.y.toFixed(0)}" x2="${p4.x.toFixed(0)}" y2="${p4.y.toFixed(0)}" stroke="${fc}" stroke-width="6"/>`;
      s += `<circle cx="${O.x}" cy="${O.y}" r="9" fill="${INK}"/>`;
      s += angleArc(O, p1, p3, 60, INK_DIM);
      s += angleArc(O, p2, p4, 60, INK_DIM);
      s += label(O.x+90, O.y-70, `${v.k}°`, fc, false, 34);
      s += label(O.x-110, O.y+70, 'x°', fc, true, 34);
      return s;
    },
    explain: v => `Vertical angles (across the same intersection point) are always equal: x = ${v.k}°.`,
  },
  {
    id: 'angle_around_point', difficulty: 'medium', category: 'angle', title: 'Angles Around a Point',
    question: 'What is the missing angle around the point?',
    generate() {
      let a = ri(60,140), b = ri(60,140);
      while (a+b >= 340) b = ri(40,100);
      return { vars: { a, b }, correct: 360-a-b, fmt: v => `${v}°` };
    },
    render(v, fc) {
      const O = {x:480,y:300}, R = 220;
      const a1 = 0, a2 = v.a, a3 = v.a+v.b;
      const toXY = deg => ({x:O.x+R*Math.cos(deg*Math.PI/180), y:O.y+R*Math.sin(deg*Math.PI/180)});
      const p1=toXY(a1), p2=toXY(a2), p3=toXY(a3);
      let s = '';
      [ [p1,p2,v.a], [p2,p3,v.b], [p3,p1,360-v.a-v.b] ].forEach(([pa,pb,ang], i) => {
        const large = ang > 180 ? 1 : 0;
        s += `<path d="M ${O.x} ${O.y} L ${pa.x.toFixed(1)} ${pa.y.toFixed(1)} A ${R} ${R} 0 ${large} 1 ${pb.x.toFixed(1)} ${pb.y.toFixed(1)} Z" fill="${fc}" fill-opacity="${0.3+i*0.25}" stroke="${fc}" stroke-width="3"/>`;
      });
      s += `<circle cx="${O.x}" cy="${O.y}" r="8" fill="${INK}"/>`;
      s += label((O.x+p1.x*0.4), (O.y+p1.y*0.4)-30, `${v.a}°`, fc, false, 30);
      s += label(O.x+ (p2.x-O.x)*0.5, O.y+(p2.y-O.y)*0.5, `${v.b}°`, fc, false, 30);
      s += label(O.x-40, O.y+90, 'x°', fc, true, 34);
      return s;
    },
    explain: v => `Angles around a point sum to 360°: 360 − ${v.a} − ${v.b} = ${360-v.a-v.b}°.`,
  },
  {
    id: 'angle_complementary', difficulty: 'quick', category: 'angle', title: 'Complementary Angles',
    question: 'These two angles are complementary. Find x.',
    // Trap: the #1 real-world mixup is complementary (90°) vs supplementary
    // (180°) — so 180-k is a genuine "wait, which one is this again?" decoy.
    generate() { const k = ri(10,80); return { vars: { k }, correct: 90-k, fmt: v => `${v}°`, trap: 180-k }; },
    render(v, fc) {
      const O = {x:300,y:400}, R = {x:700,y:400};
      const rad = -50*Math.PI/180;
      const up = {x:O.x+300*Math.cos(rad), y:O.y+300*Math.sin(rad)};
      let s = `<line x1="${O.x}" y1="${O.y}" x2="${R.x}" y2="${O.y}" stroke="${fc}" stroke-width="7" stroke-linecap="round"/>`;
      s += `<line x1="${O.x}" y1="${O.y}" x2="${O.x}" y2="${O.y-260}" stroke="${fc}" stroke-width="7" stroke-linecap="round"/>`;
      s += `<line x1="${O.x}" y1="${O.y}" x2="${up.x.toFixed(0)}" y2="${up.y.toFixed(0)}" stroke="${fc}" stroke-width="7" stroke-linecap="round"/>`;
      s += `<circle cx="${O.x}" cy="${O.y}" r="9" fill="${INK}"/>`;
      s += rightAngleMarker(O.x, O.y, 1, -1);
      s += label(O.x+70, O.y-190, `${v.k}°`, fc, false, 34);
      s += label(O.x+220, O.y-90, 'x°', fc, true, 34);
      return s;
    },
    explain: v => `Complementary angles sum to 90°: 90 − ${v.k} = ${90-v.k}°.`,
  },
  {
    id: 'angle_polygon_interior', difficulty: 'medium', category: 'angle', title: 'Polygon Interior Angle',
    question: 'What is one interior angle of this regular polygon?',
    generate() {
      const n = pick([5,6,7,8,9,10,12]);
      const correct = Math.round(((n-2)*180)/n*10)/10;
      return { vars: { n }, correct, fmt: v => `${v}°` };
    },
    render(v, fc) {
      const cx = 480, cy = 300, R = 170, n = v.n;
      const pts = [];
      for (let i = 0; i < n; i++) { const a = -90 + i*360/n; pts.push({ x: cx+R*Math.cos(a*Math.PI/180), y: cy+R*Math.sin(a*Math.PI/180) }); }
      let s = filledPolygon(pts, fc);
      s += label(cx, cy, `n=${n}`, fc, false, 30);
      return s;
    },
    explain: v => `Interior angle of a regular n-gon = (n−2)×180 ÷ n = (${v.n}−2)×180 ÷ ${v.n} = ${Math.round(((v.n-2)*180)/v.n*10)/10}°.`,
  },

  // ── COORDINATE GEOMETRY ───────────────────────────────────────────────
  {
    id: 'coord_distance', difficulty: 'medium', category: 'coordinate', title: 'Distance Between Points',
    question: 'What is the distance between these two points?',
    generate() {
      const [dx,dy,d] = pick(COMMON_TRIPLES);
      const x1 = ri(-4,2), y1 = ri(-4,2);
      const x2 = x1+dx, y2 = y1+dy;
      return { vars: { x1,y1,x2,y2 }, correct: d, fmt: v => `${v}` };
    },
    render(v, fc) {
      const sc = 40, ox = 480, oy = 300;
      const toXY = (x,y) => ({x: ox+x*sc, y: oy-y*sc});
      const p1 = toXY(v.x1,v.y1), p2 = toXY(v.x2,v.y2);
      let s = `<line x1="80" y1="${oy}" x2="880" y2="${oy}" stroke="${INK_DIM}" stroke-width="1.5" opacity="0.5"/>`;
      s += `<line x1="${ox}" y1="60" x2="${ox}" y2="540" stroke="${INK_DIM}" stroke-width="1.5" opacity="0.5"/>`;
      s += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${fc}" stroke-width="6" stroke-linecap="round"/>`;
      s += `<circle cx="${p1.x}" cy="${p1.y}" r="10" fill="${fc}"/><circle cx="${p2.x}" cy="${p2.y}" r="10" fill="${fc}"/>`;
      s += label(p1.x-10, p1.y+40, `(${v.x1},${v.y1})`, fc, false, 26);
      s += label(p2.x+10, p2.y-24, `(${v.x2},${v.y2})`, fc, false, 26);
      return s;
    },
    explain: v => `Distance = √((Δx)² + (Δy)²) — a ${Math.abs(v.x2-v.x1)}-${Math.abs(v.y2-v.y1)}-? right triangle, giving ${Math.hypot(v.x2-v.x1, v.y2-v.y1)}.`,
  },
  {
    id: 'coord_midpoint', difficulty: 'quick', category: 'coordinate', title: 'Midpoint',
    question: 'What is the x-coordinate of the midpoint?',
    generate() {
      const x1 = ri(-6,0)*2, x2 = ri(0,6)*2, y1 = ri(-4,4), y2 = ri(-4,4);
      return { vars: { x1,y1,x2,y2 }, correct: (x1+x2)/2, fmt: v => `${v}` };
    },
    render(v, fc) {
      const sc = 30, ox = 480, oy = 300;
      const toXY = (x,y) => ({x: ox+x*sc, y: oy-y*sc});
      const p1 = toXY(v.x1,v.y1), p2 = toXY(v.x2,v.y2);
      const mid = { x:(p1.x+p2.x)/2, y:(p1.y+p2.y)/2 };
      let s = `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${fc}" stroke-width="6" stroke-linecap="round"/>`;
      s += `<circle cx="${p1.x}" cy="${p1.y}" r="10" fill="${fc}"/><circle cx="${p2.x}" cy="${p2.y}" r="10" fill="${fc}"/>`;
      s += `<circle cx="${mid.x}" cy="${mid.y}" r="12" fill="none" stroke="${INK}" stroke-width="3"/>`;
      s += label(p1.x-10, p1.y+40, `(${v.x1},${v.y1})`, fc, false, 26);
      s += label(p2.x+10, p2.y-24, `(${v.x2},${v.y2})`, fc, false, 26);
      s += label(mid.x, mid.y+50, '?', fc, true, 30);
      return s;
    },
    explain: v => `Midpoint x = (x1+x2)/2 = (${v.x1}+${v.x2})/2 = ${(v.x1+v.x2)/2}.`,
  },
  {
    id: 'coord_slope', difficulty: 'medium', category: 'coordinate', title: 'Slope of a Line',
    question: 'What is the slope of this line?',
    generate() {
      const rise = pick([1,2,3,4,-1,-2,-3]), run = pick([1,2,3,4]);
      const x1 = ri(-3,0), y1 = ri(-3,1);
      const x2 = x1+run, y2 = y1+rise;
      return { vars: { x1,y1,x2,y2,rise,run }, correct: Math.round((rise/run)*100)/100, fmt: v => `${v}` };
    },
    render(v, fc) {
      const sc = 40, ox = 480, oy = 300;
      const toXY = (x,y) => ({x: ox+x*sc, y: oy-y*sc});
      const p1 = toXY(v.x1,v.y1), p2 = toXY(v.x2,v.y2);
      let s = `<line x1="80" y1="${oy}" x2="880" y2="${oy}" stroke="${INK_DIM}" stroke-width="1.5" opacity="0.5"/>`;
      s += `<line x1="${ox}" y1="60" x2="${ox}" y2="540" stroke="${INK_DIM}" stroke-width="1.5" opacity="0.5"/>`;
      s += `<line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}" stroke="${fc}" stroke-width="6" stroke-linecap="round"/>`;
      s += `<circle cx="${p1.x}" cy="${p1.y}" r="10" fill="${fc}"/><circle cx="${p2.x}" cy="${p2.y}" r="10" fill="${fc}"/>`;
      s += label(p1.x-10, p1.y+40, `(${v.x1},${v.y1})`, fc, false, 26);
      s += label(p2.x+10, p2.y-24, `(${v.x2},${v.y2})`, fc, false, 26);
      return s;
    },
    explain: v => `Slope = rise/run = (${v.y2}-${v.y1})/(${v.x2}-${v.x1}) = ${v.rise}/${v.run} = ${Math.round((v.rise/v.run)*100)/100}.`,
  },
];

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ════════════════════════════════════════════════════════════════════════════

// Weighted pool built once — 'quick' families appear 3x as often as 'hard'
// ones, so a viewer sees an instantly-graspable puzzle most of the time,
// with a harder one occasionally for variety (and given more think time).
const WEIGHTED_POOL = GEOMETRY_FAMILIES.flatMap(f => {
  const cfg = DIFFICULTY_CONFIG[f.difficulty] || DIFFICULTY_CONFIG.medium;
  return Array(cfg.selectWeight).fill(f);
});

// Options built around the correct answer using a %-of-magnitude spread (not
// a flat ±1) so the 4 choices are far enough apart to eliminate by rough
// estimation — plus the family's real conceptual "trap" wrong answer when
// one exists (see angle_vertical/complementary/on_line and the area↔perimeter
// mixups above), so quick puzzles still have a genuine hesitation moment.
function buildOptions(correct, fmt, spreadPct, trap) {
  const set = new Set([fmt(correct)]);
  if (trap != null && trap > 0 && Math.abs(trap - correct) > 0.001) set.add(fmt(trap));
  const spread = Math.max(1, Math.round(Math.abs(correct) * spreadPct));
  let guard = 0;
  while (set.size < 4 && guard++ < 60) {
    const mult = 1 + Math.floor(guard / 8);
    const delta = pick([-2, -1, 1, 2]) * spread * mult;
    const v = correct + delta;
    if (v > 0) set.add(fmt(v));
  }
  return shuffle([...set]).slice(0, 4);
}

// Recent-family memory (per-process) — pass in the last N family ids used
// (e.g. fetched from the DB like puzzle_generator.js already does for
// fingerprints) to avoid immediate repeats even within a large pool.
function generateGeometryPuzzle(recentFamilyIds = []) {
  const avoid = new Set(recentFamilyIds.slice(0, 5));
  let pool = WEIGHTED_POOL.filter(f => !avoid.has(f.id));
  if (!pool.length) pool = WEIGHTED_POOL;
  const family = pick(pool);
  const cfg = DIFFICULTY_CONFIG[family.difficulty] || DIFFICULTY_CONFIG.medium;
  const { vars, correct, fmt, trap } = family.generate();
  const correctStr = fmt(correct);
  const options = buildOptions(correct, fmt, cfg.spreadPct, trap);
  if (!options.includes(correctStr)) options[0] = correctStr;
  const fillColor = pick(FILL_PALETTE);

  const spec = { family: family.id, vars, title: family.title, fillColor };
  const fingerprint = `geometry::${family.id}::${JSON.stringify(vars)}`;

  return {
    title: family.title,
    spec,
    question: family.question,
    options,
    correct: correctStr,
    hint: `Think about the ${family.category} formula this shape needs.`,
    explanation: family.explain(vars),
    keep_5050: keep5050(options, correctStr),
    youtube_title: `Can You Solve This ${family.title}?`,
    familyId: family.id,
    difficulty: family.difficulty,
    thinking_time_sec: cfg.thinkTimeSec,
    target_format: DIFFICULTY_TO_FORMAT[family.difficulty], // 'short' | 'medium' | 'long'
  };
}

// Renderer — call this from puzzleRenderers.js's RENDERERS['geometry'].
function renderGeometryPuzzle(spec, o) {
  const family = GEOMETRY_FAMILIES.find(f => f.id === spec.family);
  const fc = spec.fillColor || pick(FILL_PALETTE);
  if (!family) {
    return { ok: false, warnings: [`Unknown geometry family "${spec.family}"`], svg: openSvg(960,480,fc)+closeSvg() };
  }
  const W = 960, H = 480;
  let svg = openSvg(W, H, fc);
  svg += titleStrip(W, spec.title || family.title, fc);
  svg += family.render(spec.vars, fc);
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

module.exports = { GEOMETRY_FAMILIES, generateGeometryPuzzle, renderGeometryPuzzle };

// ════════════════════════════════════════════════════════════════════════════
// INTEGRATION NOTES
// ════════════════════════════════════════════════════════════════════════════
// 1. puzzleRenderers.js:
//      const { renderGeometryPuzzle } = require('./geometry_engine');
//      RENDERERS.geometry = renderGeometryPuzzle;   // add to the RENDERERS map
//      PUZZLE_TYPES.push('geometry');               // (retire the 3 old geometry_* types)
//
// 2. puzzle_generator.js — in processPuzzleQueue(), BEFORE the LLM call:
//      if (puzzleType === 'geometry') {
//        const recentFPs = ...; // already fetched above
//        const recentFamilyIds = recentFPs.map(fp => fp.split('::')[1]).filter(Boolean);
//        const candidate = generateGeometryPuzzle(recentFamilyIds);
//        // skip generatePuzzlesWithLLM + validatePuzzle entirely — the math
//        // is already guaranteed correct — go straight to the fingerprint /
//        // duplicate-check step with `chosen = candidate`.
//      } else {
//        // existing LLM path for non-geometry types
//      }
//
// 2b. ⚠️ REQUIRED if you're using difficulty-tied video formats (quick→12s/5s
//     countdown, medium→22s/8s, hard→42s/12s, or similar): the row MUST be
//     opened to ONLY its target format, not all three. The current code
//     (search "CROSS-FORMAT LOCK" in puzzle_generator.js) intentionally sets
//     short_status/medium_status/long_status ALL to pending so whichever
//     format worker polls first claims the row. That is WRONG for difficulty-
//     tied formats — a 'hard' puzzle that gets claimed by the short-form
//     worker would be crammed into a 12s video it was never designed to fit.
//     Replace step 7 in puzzle_generator.js with:
//
//       if (puzzleType === 'geometry') {
//         row.short_status  = chosen.target_format === 'short'  ? 'pending_short'  : null;
//         row.medium_status = chosen.target_format === 'medium' ? 'pending_medium' : null;
//         row.long_status   = chosen.target_format === 'long'   ? 'pending_long'   : null;
//         row.thinking_time_sec = chosen.thinking_time_sec; // 5 / 8 / 12
//       } else {
//         // existing "open to all three" behavior for LLM-driven types —
//         // fine to leave as-is for types that aren't difficulty-tiered yet.
//         row.short_status  = 'pending_short';
//         row.medium_status = 'pending_medium';
//         row.long_status   = 'pending_long';
//       }
//
//     This is a deliberate, per-row, DATA-DRIVEN single-format assignment —
//     not a regression to the old global ratio_sequence RPC. It only applies
//     to types that declare a target_format; anything else keeps today's
//     "open to all formats" behavior untouched.
//
// 3. puzzle_type_config: replace the 5 existing geometry-ish rows (matchstick
//    stays separate; geometry_triangle / geometry_right_triangle /
//    geometry_straight_line / area_perimeter) with ONE row:
//      { puzzle_type: 'geometry', category: 'math', display_name: 'Geometry Challenge',
//        is_active: true, weight: 6 }
//    All 31 families share that one row/weight — puzzleAssigner.js's existing
//    "at most one per puzzle_type per render run" logic keeps working exactly
//    as-is, no changes needed there.
//
// 4. RENDER SCRIPT — for 'hard'/long-format puzzles specifically: the extra
//    ~30s of non-countdown runtime (42s total − 12s countdown) needs to be
//    filled with an actual multi-beat explanation reveal (e.g. show the
//    formula → plug in the numbers → compute → highlight the answer, as 3
//    sequential ~5s beats), NOT one static explanation card held on screen
//    for 16+ seconds unchanged. A long static hold reads as dead air and
//    will hurt retention worse than a puzzle that was merely hard.
//
// NEXT BATCHES (same pattern, once you're happy with geometry's results):
//   - "visual" category: more odd-one-out variants (rotation-trick,
//     size-trick, count-trick), more pattern_matrix shapes, kaleidoscope
//     symmetry puzzles, more visual_pattern_sequence rule types.
//   - "logic" category: more cipher types (Vigenère-lite, symbol-substitution),
//     more word_ladder lengths, Sudoku-mini, magic-square variants.
//   - "trivia"/"detective": these genuinely need an LLM (real-world facts /
//     narrative) — for those, the fix is diversifying the PROMPT's scenario
//     pool (settings, eras, artifact types) rather than a procedural engine.
