'use strict';
// ════════════════════════════════════════════════════════════════════════════
// puzzleRenderers.js — VISUAL ENGINE for the JaasX "Brain Challenge" pipeline
//
// PURE, DEPENDENCY-FREE module (works in a Cloudflare Worker AND in Node/GitHub
// Actions). Given a puzzle_type + puzzle_spec (the structured JSON the LLM
// produces) it returns ONE self-contained <svg> fragment string.
//
// WHY ALWAYS SVG (never emoji, never foreignObject):
//   • Deterministic — the same spec always renders pixel-identically.
//   • Font-independent — no reliance on emoji fonts being present on the runner.
//   • One injection path — the video renderer, the blog, and the thumbnail all
//     just drop this <svg> into a slot. No per-surface special-casing.
//   • Testable offline — rasterises cleanly with cairosvg / rsvg / ImageMagick.
//
// Every renderer draws its own rounded "panel" card so the puzzle reads clearly
// on ANY theme background (the video themes are mostly dark; the blog is light).
//
// Public API:
//   renderPuzzle(type, spec, opts) -> { svg, ok, warnings }
//     type : one of PUZZLE_TYPES
//     spec : the structured object from the LLM (validated upstream)
//     opts : { accent, accent2, accent3, width } — theme colours (all optional)
// ════════════════════════════════════════════════════════════════════════════

const PUZZLE_TYPES = [
  'matchstick',
  'geometry_triangle',
  'geometry_right_triangle',
  'geometry_straight_line',
  'number_sequence',
  'number_grid',
  'visual_math',
  'odd_one_out',
  'rebus',
  'detective',
];

// ── Base palette (overridden per-render by theme accents) ──────────────────
const C = {
  panel:   '#0e1626',   // card background
  panel2:  '#152238',   // card gradient stop
  stroke:  '#2b3d5c',   // card border
  ink:     '#f4f8ff',   // primary text
  inkDim:  '#9fb3d1',   // secondary text
  wood:    '#E7B24C',   // matchstick body
  wood2:   '#c8912f',   // matchstick shade
  flame:   '#E8433F',   // matchstick head
  good:    '#22c55e',
  slotBg:  '#1b2a45',   // number cell bg
  slotHi:  '#20304e',   // highlighted cell bg
};

// ────────────────────────────────────────────────────────────────────────────
// SMALL HELPERS
// ────────────────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function clampNum(n, lo, hi) { n = Number(n); if (isNaN(n)) return lo; return Math.max(lo, Math.min(hi, n)); }

// Greedy word-wrap → array of lines that each fit `maxChars`.
function wrapText(text, maxChars) {
  const words = String(text || '').trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if ((line + ' ' + w).length <= maxChars) line += ' ' + w;
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  return lines;
}

// Rounded panel card + soft shadow. Returns the opening <svg> ... you append
// content, then call closeSvg(). W/H are the viewBox dimensions.
function openSvg(W, H, o) {
  const a = o.accent;
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" width="100%" role="img" class="puzzle-svg">
  <defs>
    <linearGradient id="pzPanel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.panel}"/><stop offset="1" stop-color="${C.panel2}"/>
    </linearGradient>
    <linearGradient id="pzWood" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.wood}"/><stop offset="1" stop-color="${C.wood2}"/>
    </linearGradient>
    <filter id="pzShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#000" flood-opacity="0.45"/>
    </filter>
    <filter id="pzGlow" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="0" stdDeviation="8" flood-color="${a}" flood-opacity="0.8"/>
    </filter>
  </defs>
  <rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="34"
        fill="url(#pzPanel)" stroke="${a}" stroke-width="4" filter="url(#pzShadow)"/>
  <rect x="14" y="14" width="${W - 28}" height="${H - 28}" rx="34"
        fill="none" stroke="${C.stroke}" stroke-width="1" opacity="0.6"/>`;
}
function closeSvg() { return `</svg>`; }

// Title strip at top of the panel (e.g. "MOVE 1 MATCHSTICK").
function titleStrip(W, text, o) {
  if (!text) return '';
  const t = esc(String(text).toUpperCase());
  return `
  <g>
    <rect x="${W/2 - 300}" y="42" width="600" height="66" rx="33" fill="${o.accent}" opacity="0.16"/>
    <text x="${W/2}" y="88" text-anchor="middle" font-family="Poppins,Segoe UI,Arial,sans-serif"
          font-size="40" font-weight="800" fill="${o.accent}" letter-spacing="1.5">${t}</text>
  </g>`;
}

// ────────────────────────────────────────────────────────────────────────────
// MATCHSTICK ENGINE (seven-segment sticks + operators)
// ────────────────────────────────────────────────────────────────────────────
// A "matchstick" = a wood body (rounded rect) + a red head at one end.
function matchstick(x, y, len, horizontal, o) {
  const T = o.thick ? 38 : 24;        // stick thickness (thick mode = more visible)
  const headR = T * 0.62;
  if (horizontal) {
    const body = `<rect x="${x}" y="${y}" width="${len}" height="${T}" rx="${T/2}" fill="url(#pzWood)" stroke="${C.wood2}" stroke-width="1.5"/>`;
    const head = `<circle cx="${x + len - headR*0.2}" cy="${y + T/2}" r="${headR}" fill="${C.flame}"/>`;
    return body + head;
  } else {
    const body = `<rect x="${x}" y="${y}" width="${T}" height="${len}" rx="${T/2}" fill="url(#pzWood)" stroke="${C.wood2}" stroke-width="1.5"/>`;
    const head = `<circle cx="${x + T/2}" cy="${y + headR*0.2}" r="${headR}" fill="${C.flame}"/>`;
    return body + head;
  }
}
const SEG = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};
// Draw one seven-segment digit at cell origin (ox,oy). Cell = DW x DH.
function matchDigit(ox, oy, ch, o) {
  const DW = o.thick ? 160 : 120, DH = o.thick ? 310 : 230, T = o.thick ? 38 : 24, p = o.thick ? 8 : 6;
  const segs = SEG[ch] || '';
  const vLen = (DH / 2) - 1.6 * p;
  const hLen = DW - 2 * p;
  const parts = [];
  const has = s => segs.includes(s);
  if (has('a')) parts.push(matchstick(ox + p, oy, hLen, true, o));
  if (has('g')) parts.push(matchstick(ox + p, oy + DH/2 - T/2, hLen, true, o));
  if (has('d')) parts.push(matchstick(ox + p, oy + DH - T, hLen, true, o));
  if (has('f')) parts.push(matchstick(ox, oy + p, vLen, false, o));
  if (has('b')) parts.push(matchstick(ox + DW - T, oy + p, vLen, false, o));
  if (has('e')) parts.push(matchstick(ox, oy + DH/2 + 0.6*p, vLen, false, o));
  if (has('c')) parts.push(matchstick(ox + DW - T, oy + DH/2 + 0.6*p, vLen, false, o));
  return { svg: parts.join(''), w: DW };
}
// Operators rendered in matchsticks.
function matchOp(ox, oy, ch, o) {
  const DH = o.thick ? 310 : 230, T = o.thick ? 38 : 24;
  const midY = oy + DH/2 - T/2;
  if (ch === '+') {
    const W = 100, hLen = 84;
    const h = matchstick(ox + (W - hLen)/2, midY, hLen, true, o);
    const vLen = 84;
    const v = matchstick(ox + W/2 - T/2, oy + DH/2 - vLen/2, vLen, false, o);
    return { svg: h + v, w: W };
  }
  if (ch === '-') {
    const W = 100, hLen = 84;
    return { svg: matchstick(ox + (W - hLen)/2, midY, hLen, true, o), w: W };
  }
  if (ch === '=') {
    const W = 100, hLen = 84, gap = 34;
    const top = matchstick(ox + (W - hLen)/2, midY - gap/2 - T, hLen, true, o);
    const bot = matchstick(ox + (W - hLen)/2, midY + gap/2, hLen, true, o);
    return { svg: top + bot, w: W };
  }
  // fallback: draw as plain text
  return { svg: `<text x="${ox+40}" y="${oy+DH/2+18}" font-size="90" fill="${C.ink}" font-family="Arial">${esc(ch)}</text>`, w: 80 };
}

function renderMatchstick(spec, o) {
  const warnings = [];
  const eq = String(spec.equation || spec.display || '6+4=4').replace(/\s+/g, '');
  const instruction = spec.instruction || 'Move 1 matchstick to make it correct';
  // thick mode: bigger sticks, wider canvas, taller layout
  const W      = o.thick ? 1080 : 960;
  const H      = o.thick ? 820  : 600;
  const rowY   = o.thick ? 350  : 250;
  const GAP    = o.thick ? 36   : 26;
  const DW_dig = o.thick ? 160  : 120;
  const DW_op  = o.thick ? 120  : 100;
  const instrY = o.thick ? 196  : 170;
  const instrFS= o.thick ? 46   : 34;
  const cells  = eq.split('');
  const widths = cells.map(ch => (SEG[ch] ? DW_dig : DW_op));
  const totalW = widths.reduce((s, w) => s + w, 0) + GAP * (cells.length - 1);
  const startX = (W - totalW) / 2;
  let cx = startX;
  const body = [];
  cells.forEach((ch, i) => {
    const r = SEG[ch] ? matchDigit(cx, rowY, ch, o) : matchOp(cx, rowY, ch, o);
    body.push(r.svg);
    cx += widths[i] + GAP;
  });
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Matchstick Puzzle', o);
  svg += `<text x="${W/2}" y="${instrY}" text-anchor="middle" font-family="Poppins,Segoe UI,Arial"
            font-size="${instrFS}" font-weight="700" fill="${C.inkDim}">${esc(instruction)}</text>`;
  svg += body.join('');
  svg += closeSvg();
  return { svg, ok: true, warnings };
}

// ────────────────────────────────────────────────────────────────────────────
// GEOMETRY — TRIANGLE (find the missing angle)
// ────────────────────────────────────────────────────────────────────────────
function angleLabel(x, y, text, o, hi) {
  const fill = hi ? o.accent : C.ink;
  const box  = hi ? `<circle cx="${x}" cy="${y-14}" r="42" fill="${o.accent}" opacity="0.18"/>` : '';
  return `${box}<text x="${x}" y="${y}" text-anchor="middle" font-family="Poppins,Arial"
    font-size="52" font-weight="800" fill="${fill}">${esc(text)}</text>`;
}
function renderGeometryTriangle(spec, o) {
  const W = 960, H = 720;
  // Vertices: A top, B bottom-left, C bottom-right
  const A = { x: 480, y: 210 }, B = { x: 230, y: 560 }, Cc = { x: 730, y: 560 };
  const labels = Array.isArray(spec.labels) ? spec.labels : [
    { at: 'A', text: '?', highlight: true }, { at: 'B', text: '60°' }, { at: 'C', text: '70°' },
  ];
  const pos = { A: { x: A.x, y: A.y - 46 }, B: { x: B.x - 8, y: B.y + 66 }, C: { x: Cc.x + 8, y: Cc.y + 66 } };
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Find the Angle', o);
  // triangle fill + edges
  svg += `<polygon points="${A.x},${A.y} ${B.x},${B.y} ${Cc.x},${Cc.y}"
    fill="${o.accent}" fill-opacity="0.10" stroke="${o.accent}" stroke-width="6" stroke-linejoin="round"/>`;
  // small angle arcs at each vertex
  const arc = (v, p1, p2) => {
    const ang = (px, py) => Math.atan2(py - v.y, px - v.x);
    const a1 = ang(p1.x, p1.y), a2 = ang(p2.x, p2.y);
    const r = 46;
    const x1 = v.x + r * Math.cos(a1), y1 = v.y + r * Math.sin(a1);
    const x2 = v.x + r * Math.cos(a2), y2 = v.y + r * Math.sin(a2);
    return `<path d="M ${x1.toFixed(1)} ${y1.toFixed(1)} A ${r} ${r} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}"
      fill="none" stroke="${C.inkDim}" stroke-width="3"/>`;
  };
  svg += arc(A, B, Cc) + arc(B, A, Cc) + arc(Cc, A, B);
  // vertex dots
  [A, B, Cc].forEach(v => { svg += `<circle cx="${v.x}" cy="${v.y}" r="8" fill="${C.ink}"/>`; });
  // labels
  for (const L of labels) {
    const P = pos[(L.at || 'A').toUpperCase()] || pos.A;
    svg += angleLabel(P.x, P.y, L.text, o, !!L.highlight);
  }
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ── GEOMETRY — RIGHT TRIANGLE (find hypotenuse / a side) ──────────────────
function renderGeometryRightTriangle(spec, o) {
  const W = 960, H = 720;
  // right angle at B (bottom-left). A top-left, C bottom-right.
  const B = { x: 250, y: 560 }, A = { x: 250, y: 210 }, Cc = { x: 740, y: 560 };
  const legA = spec.leg_a != null ? String(spec.leg_a) : '3';   // vertical AB
  const legB = spec.leg_b != null ? String(spec.leg_b) : '4';   // horizontal BC
  const hyp  = spec.hypotenuse != null ? String(spec.hypotenuse) : '?';
  const unk  = (spec.unknown || 'hypotenuse'); // which is the ?
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Find the Missing Side', o);
  svg += `<polygon points="${A.x},${A.y} ${B.x},${B.y} ${Cc.x},${Cc.y}"
    fill="${o.accent}" fill-opacity="0.10" stroke="${o.accent}" stroke-width="6" stroke-linejoin="round"/>`;
  // right-angle square marker at B
  svg += `<path d="M ${B.x} ${B.y-40} L ${B.x+40} ${B.y-40} L ${B.x+40} ${B.y}"
    fill="none" stroke="${C.inkDim}" stroke-width="3"/>`;
  const sideLabel = (x, y, text, hi) => angleLabel(x, y, text, o, hi);
  svg += sideLabel(B.x - 60, (A.y + B.y)/2 + 16, legA, unk === 'leg_a');
  svg += sideLabel((B.x + Cc.x)/2, B.y + 66, legB, unk === 'leg_b');
  svg += sideLabel((A.x + Cc.x)/2 + 60, (A.y + Cc.y)/2 - 30, hyp, unk === 'hypotenuse');
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ── GEOMETRY — STRAIGHT LINE (angles on a line sum to 180) ────────────────
function renderGeometryStraightLine(spec, o) {
  const W = 960, H = 560;
  const known = spec.known_angle != null ? String(spec.known_angle) : '120°';
  const unk   = spec.unknown_glyph || 'x';
  const O = { x: 480, y: 380 }, L = { x: 120, y: 380 }, R = { x: 840, y: 380 };
  // a ray going up-left splitting the straight angle
  const rayAng = -140 * Math.PI / 180;
  const ray = { x: O.x + 300 * Math.cos(rayAng), y: O.y + 300 * Math.sin(rayAng) };
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Find x', o);
  svg += `<line x1="${L.x}" y1="${L.y}" x2="${R.x}" y2="${R.y}" stroke="${o.accent}" stroke-width="7" stroke-linecap="round"/>`;
  svg += `<line x1="${O.x}" y1="${O.y}" x2="${ray.x.toFixed(0)}" y2="${ray.y.toFixed(0)}" stroke="${o.accent}" stroke-width="7" stroke-linecap="round"/>`;
  svg += `<circle cx="${O.x}" cy="${O.y}" r="9" fill="${C.ink}"/>`;
  // left angle (known) and right angle (unknown x)
  svg += `<path d="M ${O.x-70} ${O.y} A 70 70 0 0 1 ${(O.x+70*Math.cos(rayAng)).toFixed(1)} ${(O.y+70*Math.sin(rayAng)).toFixed(1)}" fill="none" stroke="${C.inkDim}" stroke-width="3"/>`;
  svg += angleLabel(O.x - 150, O.y - 40, known, o, false);
  svg += angleLabel(O.x + 130, O.y - 40, unk, o, true);
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// NUMBER SEQUENCE (cells in a row, one is "?")
// ────────────────────────────────────────────────────────────────────────────
function renderNumberSequence(spec, o) {
  const cells = (Array.isArray(spec.cells) && spec.cells.length ? spec.cells : ['2', '6', '12', '20', '?']).slice(0, 7).map(String);
  const W = 960;
  const n = cells.length;
  const gap = 26;
  const cw = Math.min(150, (W - 120 - gap * (n - 1)) / n);
  const ch = cw;
  const totalW = cw * n + gap * (n - 1);
  const startX = (W - totalW) / 2;
  const y = 250;
  const H = 560;
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'What comes next?', o);
  cells.forEach((val, i) => {
    const x = startX + i * (cw + gap);
    const isQ = /^\?+$/.test(val.trim());
    const bg = isQ ? o.accent : C.slotBg;
    const op = isQ ? '0.18' : '1';
    svg += `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="22"
      fill="${bg}" fill-opacity="${op}" stroke="${isQ ? o.accent : C.stroke}" stroke-width="${isQ ? 5 : 2}"/>`;
    svg += `<text x="${x + cw/2}" y="${y + ch/2 + 26}" text-anchor="middle"
      font-family="Poppins,Arial" font-size="${isQ ? 78 : 64}" font-weight="800"
      fill="${isQ ? o.accent : C.ink}">${esc(val)}</text>`;
    if (i < n - 1) {
      svg += `<text x="${x + cw + gap/2}" y="${y + ch/2 + 20}" text-anchor="middle"
        font-size="46" fill="${C.inkDim}">›</text>`;
    }
  });
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ── NUMBER GRID (rows x cols, one is "?") ─────────────────────────────────
function renderNumberGrid(spec, o) {
  const rows = Array.isArray(spec.rows) && spec.rows.length ? spec.rows
             : [['8', '3', '5'], ['4', '2', '6'], ['?', '5', '1']];
  const nR = rows.length, nC = Math.max(...rows.map(r => r.length));
  const W = 960;
  const gap = 22;
  const cw = Math.min(180, (620 - gap * (nC - 1)) / nC);
  const ch = cw;
  const gridW = cw * nC + gap * (nC - 1);
  const gridH = ch * nR + gap * (nR - 1);
  const startX = (W - gridW) / 2, startY = 180;
  const H = startY + gridH + 60;
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Find the Missing Number', o);
  rows.forEach((row, ri) => {
    row.forEach((val, ci) => {
      const x = startX + ci * (cw + gap), y = startY + ri * (ch + gap);
      const isQ = /^\?+$/.test(String(val).trim());
      svg += `<rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="20"
        fill="${isQ ? o.accent : C.slotBg}" fill-opacity="${isQ ? '0.18' : '1'}"
        stroke="${isQ ? o.accent : C.stroke}" stroke-width="${isQ ? 5 : 2}"/>`;
      svg += `<text x="${x + cw/2}" y="${y + ch/2 + 22}" text-anchor="middle"
        font-family="Poppins,Arial" font-size="${isQ ? 66 : 56}" font-weight="800"
        fill="${isQ ? o.accent : C.ink}">${esc(val)}</text>`;
    });
  });
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// VISUAL MATH  (fruit/icon algebra — "🍎+🍎=10" style, but as SVG icons)
// ────────────────────────────────────────────────────────────────────────────
function drawIcon(kind, cx, cy, r, o) {
  const k = String(kind || 'apple').toLowerCase();
  const map = {
    apple:  '#e23b4a', banana: '#f4c430', cherry: '#c0263d', grape: '#7b4bc9',
    star:   o.accent,  circle: o.accent,  heart:  '#ff5c8a', square: o.accent2 || '#22c55e',
    triangle: o.accent3 || '#f4c430', pentagon: '#38bdf8', lemon: '#f6e05e', orange: '#fb923c',
  };
  const col = map[k] || o.accent;
  if (k === 'star') {
    let pts = '';
    for (let i = 0; i < 10; i++) {
      const ang = -Math.PI/2 + i * Math.PI/5;
      const rad = i % 2 === 0 ? r : r * 0.45;
      pts += `${(cx + rad*Math.cos(ang)).toFixed(1)},${(cy + rad*Math.sin(ang)).toFixed(1)} `;
    }
    return `<polygon points="${pts}" fill="${col}"/>`;
  }
  if (k === 'square') return `<rect x="${cx-r}" y="${cy-r}" width="${2*r}" height="${2*r}" rx="${r*0.2}" fill="${col}"/>`;
  if (k === 'triangle') return `<polygon points="${cx},${cy-r} ${cx-r},${cy+r} ${cx+r},${cy+r}" fill="${col}"/>`;
  if (k === 'heart') {
    return `<path d="M ${cx} ${cy+r*0.75} C ${cx-r*1.4} ${cy-r*0.4} ${cx-r*0.5} ${cy-r*1.1} ${cx} ${cy-r*0.25}
      C ${cx+r*0.5} ${cy-r*1.1} ${cx+r*1.4} ${cy-r*0.4} ${cx} ${cy+r*0.75} Z" fill="${col}"/>`;
  }
  if (k === 'banana') {
    return `<path d="M ${cx-r} ${cy-r*0.6} Q ${cx} ${cy+r*1.2} ${cx+r} ${cy-r*0.6}
      Q ${cx} ${cy+r*0.4} ${cx-r} ${cy-r*0.6} Z" fill="${col}"/>`;
  }
  // default: fruit/circle with a small leaf/stem
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}"/>
    <rect x="${cx-3}" y="${cy-r-16}" width="6" height="18" rx="3" fill="#4b7f2f"/>
    <ellipse cx="${cx+12}" cy="${cy-r-8}" rx="12" ry="6" fill="#5ea03a" transform="rotate(-30 ${cx+12} ${cy-r-8})"/>`;
}
function renderVisualMath(spec, o) {
  // spec.equations: [ { items:[{icon,count}], result:"10" }, ... , last has result:"?" ]
  const eqs = Array.isArray(spec.equations) && spec.equations.length ? spec.equations : [
    { items: [{ icon: 'apple', count: 2 }], result: '10' },
    { items: [{ icon: 'apple', count: 1 }, { icon: 'banana', count: 2 }], result: '13' },
    { items: [{ icon: 'banana', count: 1 }, { icon: 'apple', count: 1 }], result: '?' },
  ].slice(0, 4);
  const W = 960;
  const rowH = 130, top = 170;
  const H = top + eqs.length * rowH + 50;
  const R = 40;
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Solve the Puzzle', o);
  eqs.forEach((eq, ri) => {
    const y = top + ri * rowH + rowH / 2;
    let x = 120;
    const parts = eq.items || [];
    parts.forEach((it, pi) => {
      const count = clampNum(it.count, 1, 3);
      for (let c = 0; c < count; c++) { svg += drawIcon(it.icon, x, y, R, o); x += R * 2 + 10; }
      if (pi < parts.length - 1) { svg += `<text x="${x + 6}" y="${y + 20}" font-size="60" font-weight="800" fill="${C.inkDim}">+</text>`; x += 70; }
    });
    svg += `<text x="${x + 10}" y="${y + 20}" font-size="60" font-weight="800" fill="${C.inkDim}">=</text>`;
    x += 80;
    const isQ = /^\?+$/.test(String(eq.result).trim());
    svg += `<text x="${x}" y="${y + 24}" font-size="72" font-weight="900"
      fill="${isQ ? o.accent : C.ink}">${esc(eq.result)}</text>`;
  });
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// ODD ONE OUT (grid of shapes, cells numbered; one differs)
// ────────────────────────────────────────────────────────────────────────────
function renderOddOneOut(spec, o) {
  const cols = clampNum(spec.cols || 4, 3, 5);
  const items = Array.isArray(spec.items) && spec.items.length ? spec.items : (() => {
    const arr = []; const total = cols * cols;
    const odd = Math.floor(total / 2) + 1;
    for (let i = 0; i < total; i++) arr.push({ shape: i === odd ? 'triangle' : 'circle' });
    return arr;
  })();
  const rows = Math.ceil(items.length / cols);
  const W = 960;
  const cell = Math.min(170, (W - 120) / cols);
  const R = cell * 0.32;
  const gridW = cell * cols;
  const startX = (W - gridW) / 2, startY = 170;
  const H = startY + rows * cell + 50;
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Spot the Odd One', o);
  items.forEach((it, i) => {
    const r = Math.floor(i / cols), c = i % cols;
    const cx = startX + c * cell + cell / 2, cy = startY + r * cell + cell / 2;
    svg += `<circle cx="${cx}" cy="${cy}" r="${cell*0.44}" fill="#ffffff" fill-opacity="0.03" stroke="${C.stroke}" stroke-width="1.5"/>`;
    svg += drawIcon(it.shape || 'circle', cx, cy - 4, R, { accent: it.color || o.accent, accent2: o.accent2, accent3: o.accent3 });
    svg += `<text x="${cx}" y="${cy + cell*0.34}" text-anchor="middle" font-size="22" fill="${C.inkDim}" font-family="Arial">${i + 1}</text>`;
  });
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ── REBUS (token pills → guess the phrase) ────────────────────────────────
function renderRebus(spec, o) {
  const tokens = Array.isArray(spec.tokens) && spec.tokens.length ? spec.tokens : ['RAIN', '+', 'BOW'];
  const W = 960, H = 520;
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Guess the Phrase', o);
  // measure pill widths (approx)
  const pad = 34, fs = 62;
  const widths = tokens.map(t => (String(t) === '+' || String(t) === '=' ? 60 : Math.max(120, String(t).length * fs * 0.62 + pad * 2)));
  const gap = 24;
  const totalW = widths.reduce((s, w) => s + w, 0) + gap * (tokens.length - 1);
  let x = (W - totalW) / 2;
  const y = 260;
  tokens.forEach((t, i) => {
    const w = widths[i];
    if (String(t) === '+' || String(t) === '=') {
      svg += `<text x="${x + w/2}" y="${y + 24}" text-anchor="middle" font-size="${fs}" font-weight="800" fill="${C.inkDim}">${esc(t)}</text>`;
    } else {
      svg += `<rect x="${x}" y="${y - 58}" width="${w}" height="110" rx="24" fill="${o.accent}" fill-opacity="0.14" stroke="${o.accent}" stroke-width="3"/>`;
      svg += `<text x="${x + w/2}" y="${y + 18}" text-anchor="middle" font-family="Poppins,Arial" font-size="${fs}" font-weight="800" fill="${C.ink}">${esc(t)}</text>`;
    }
    x += w + gap;
  });
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// DETECTIVE (styled "case file" — title, scenario, clue list, suspects)
// ────────────────────────────────────────────────────────────────────────────
function renderDetective(spec, o) {
  const title    = spec.case_title || 'The Locked Room';
  const scenario = spec.scenario || 'A valuable ring vanished from a room locked from the inside.';
  const clues    = (Array.isArray(spec.clues) && spec.clues.length ? spec.clues : ['The window was sealed shut', 'Only one person had a key']).slice(0, 4);
  const suspects = (Array.isArray(spec.suspects) && spec.suspects.length ? spec.suspects : ['The Butler', 'The Maid', 'The Guest', 'The Cook']).slice(0, 4);
  const W = 960;
  const scenarioLines = wrapText(scenario, 46);
  let y = 150;
  // dynamic height
  const H = 190 + scenarioLines.length * 42 + 70 + clues.length * 58 + 90 + 120;
  let svg = openSvg(W, H, o);
  // "CASE FILE" header ribbon
  svg += `<rect x="60" y="46" width="${W-120}" height="72" rx="16" fill="${o.accent}" opacity="0.16"/>`;
  svg += `<text x="90" y="94" font-family="Poppins,Arial" font-size="30" font-weight="800" fill="${o.accent}" letter-spacing="3">🔍 CASE FILE</text>`.replace('🔍 ', ''); // keep font-safe
  svg += `<text x="${W-90}" y="94" text-anchor="end" font-family="Poppins,Arial" font-size="30" font-weight="800" fill="${C.ink}">${esc(title.toUpperCase())}</text>`;
  y = 175;
  // scenario
  scenarioLines.forEach(ln => {
    svg += `<text x="90" y="${y}" font-family="Georgia,serif" font-size="34" fill="${C.ink}">${esc(ln)}</text>`;
    y += 42;
  });
  y += 24;
  // clues
  svg += `<text x="90" y="${y}" font-family="Poppins,Arial" font-size="28" font-weight="800" fill="${o.accent}" letter-spacing="2">CLUES</text>`;
  y += 46;
  clues.forEach(cl => {
    svg += `<rect x="90" y="${y-30}" width="28" height="28" rx="6" fill="none" stroke="${C.inkDim}" stroke-width="2.5"/>`;
    svg += `<text x="134" y="${y-6}" font-family="Georgia,serif" font-size="30" fill="${C.ink}">${esc(cl)}</text>`;
    y += 54;
  });
  y += 30;
  // suspects row
  svg += `<text x="90" y="${y}" font-family="Poppins,Arial" font-size="28" font-weight="800" fill="${o.accent}" letter-spacing="2">SUSPECTS</text>`;
  y += 40;
  const sw = (W - 180 - 3 * 20) / 4;
  suspects.forEach((s, i) => {
    const x = 90 + i * (sw + 20);
    svg += `<rect x="${x}" y="${y}" width="${sw}" height="90" rx="16" fill="${C.slotBg}" stroke="${C.stroke}" stroke-width="2"/>`;
    // avatar circle
    svg += `<circle cx="${x + 34}" cy="${y + 45}" r="22" fill="${o.accent}" opacity="0.35"/>`;
    const nameLines = wrapText(s, 12);
    nameLines.slice(0, 2).forEach((nl, li) => {
      svg += `<text x="${x + 66}" y="${y + 40 + li*26}" font-family="Poppins,Arial" font-size="22" font-weight="700" fill="${C.ink}">${esc(nl)}</text>`;
    });
  });
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// DISPATCHER
// ────────────────────────────────────────────────────────────────────────────
const RENDERERS = {
  matchstick: renderMatchstick,
  geometry_triangle: renderGeometryTriangle,
  geometry_right_triangle: renderGeometryRightTriangle,
  geometry_straight_line: renderGeometryStraightLine,
  number_sequence: renderNumberSequence,
  number_grid: renderNumberGrid,
  visual_math: renderVisualMath,
  odd_one_out: renderOddOneOut,
  rebus: renderRebus,
  detective: renderDetective,
};

function renderPuzzle(type, spec, opts = {}) {
  const o = {
    accent:  opts.accent  || '#00cfff',
    accent2: opts.accent2 || '#22c55e',
    accent3: opts.accent3 || '#f4c430',
    width:   opts.width   || 960,
    thick:   opts.thick   || false,  // makes matchstick sticks thicker and taller
  };
  const fn = RENDERERS[type];
  if (!fn) {
    return {
      ok: false,
      warnings: [`Unknown puzzle_type "${type}"`],
      svg: openSvg(960, 400, o) +
        `<text x="480" y="220" text-anchor="middle" font-size="40" fill="${C.inkDim}" font-family="Arial">Unsupported puzzle type: ${esc(type)}</text>` +
        closeSvg(),
    };
  }
  try {
    return fn(spec || {}, o);
  } catch (e) {
    return {
      ok: false,
      warnings: [`Renderer threw: ${e.message}`],
      svg: openSvg(960, 400, o) +
        `<text x="480" y="220" text-anchor="middle" font-size="34" fill="${C.flame}" font-family="Arial">Render error</text>` +
        closeSvg(),
    };
  }
}

module.exports = { renderPuzzle, PUZZLE_TYPES, RENDERERS };
