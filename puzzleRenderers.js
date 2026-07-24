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
  // Original 10 (matchstick, visual_math, geometry = your channel exclusives)
  'matchstick','geometry_triangle','geometry_right_triangle','geometry_straight_line',
  'number_sequence','number_grid','visual_math','odd_one_out','rebus','detective',
  // New 10 — buyer pipeline (10,000+ unique each)
  'word_ladder','pattern_matrix','visual_pattern_sequence','balance_scale',
  'cipher_decode','flag_puzzle','area_perimeter','dominoes','clock_angle','truth_or_lie',
];

// ── Base palette (overridden per-render by theme accents) ──────────────────
const C = {
  panel:   '#000000',   // card background — pure black
  panel2:  '#0d0d0d',   // card gradient stop
  stroke:  '#333333',   // card border
  ink:     '#ffffff',   // primary text — pure white
  inkDim:  '#cccccc',   // secondary text
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
      <stop offset="0" stop-color="#000000"/><stop offset="1" stop-color="#111111"/>
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
        fill="url(#pzPanel)" stroke="${a}" stroke-width="4" filter="url(#pzShadow)">
    <animate attributeName="stroke-width" values="4;6.5;4" dur="2.2s" repeatCount="indefinite"/>
  </rect>
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
    <rect x="${W/2 - 300}" y="42" width="600" height="66" rx="33" fill="${o.accent}" opacity="0.30"/>
    <text x="${W/2}" y="88" text-anchor="middle" font-family="Poppins,Segoe UI,Arial,sans-serif"
          font-size="40" font-weight="800" fill="#ffffff" letter-spacing="1.5">${t}</text>
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
    const delay = (i * 0.03).toFixed(2);
    // Staggered fade+rise entrance: each digit/operator "lands" in sequence
    // instead of the whole equation appearing as one static frame. Chromium
    // plays this out live, so puppeteer-screen-recorder captures real motion.
    // Timing is deliberately tight (finishes well under 0.4s even for a
    // 7-char equation) so it fully completes before the existing long-format
    // thumbnail screenshot (400ms settle wait) fires — avoids a partially
    // faded-in thumbnail.
    body.push(`<g opacity="0" transform="translate(0,14)">
      <animate attributeName="opacity" from="0" to="1" begin="${delay}s" dur="0.18s" fill="freeze"/>
      <animateTransform attributeName="transform" type="translate" from="0,14" to="0,0"
        begin="${delay}s" dur="0.18s" fill="freeze"/>
      ${r.svg}
    </g>`);
    cx += widths[i] + GAP;
  });
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Matchstick Puzzle', o);
  svg += `<text x="${W/2}" y="${instrY}" text-anchor="middle" font-family="Poppins,Segoe UI,Arial"
            font-size="${instrFS}" font-weight="700" fill="#ffffff">${esc(instruction)}</text>`;
  svg += body.join('');
  svg += closeSvg();
  return { svg, ok: true, warnings };
}

// ────────────────────────────────────────────────────────────────────────────
// GEOMETRY — TRIANGLE (find the missing angle)
// ────────────────────────────────────────────────────────────────────────────
function angleLabel(x, y, text, o, hi) {
  const fill = hi ? o.accent : "#ffffff";
  const box  = hi ? `<circle cx="${x}" cy="${y-14}" r="42" fill="${o.accent}" opacity="0.18"/>` : '';
  return `${box}<text x="${x}" y="${y}" text-anchor="middle" font-family="Poppins,Arial"
    font-size="52" font-weight="800" fill="${fill}">${esc(text)}</text>`;
}
function renderGeometryTriangle(spec, o) {
  const W = 960, H = 480;
  // Vertices: A top, B bottom-left, C bottom-right
  const A = { x: 480, y: 140 }, B = { x: 230, y: 380 }, Cc = { x: 730, y: 380 };
  const labels = Array.isArray(spec.labels) ? spec.labels : [
    { at: 'A', text: '?', highlight: true }, { at: 'B', text: '60°' }, { at: 'C', text: '70°' },
  ];
  const pos = { A: { x: A.x, y: A.y - 36 }, B: { x: B.x - 8, y: B.y + 50 }, C: { x: Cc.x + 8, y: Cc.y + 50 } };
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
  const W = 960, H = 480;
  // right angle at B (bottom-left). A top-left, C bottom-right.
  const B = { x: 250, y: 380 }, A = { x: 250, y: 140 }, Cc = { x: 740, y: 380 };
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
  const W = 960, H = 380;
  const known = spec.known_angle != null ? String(spec.known_angle) : '120°';
  const unk   = spec.unknown_glyph || 'x';
  const O = { x: 480, y: 250 }, L = { x: 120, y: 250 }, R = { x: 840, y: 250 };
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
  const cw = Math.min(130, (W - 120 - gap * (n - 1)) / n);
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
    const delay = (i * 0.03).toFixed(2);
    const cellCx = x + cw/2, cellCy = y + ch/2;
    // Same sub-400ms completion budget as the matchstick entrance (see note
    // there) — keeps the long-format thumbnail screenshot safe.
    svg += `<g opacity="0" transform="translate(${cellCx} ${cellCy}) scale(0.6) translate(${-cellCx} ${-cellCy})">
      <animate attributeName="opacity" from="0" to="1" begin="${delay}s" dur="0.18s" fill="freeze"/>
      <animateTransform attributeName="transform" type="scale" additive="sum"
        from="0.6" to="1" begin="${delay}s" dur="0.18s" fill="freeze"/>
      <rect x="${x}" y="${y}" width="${cw}" height="${ch}" rx="22"
        fill="${bg}" fill-opacity="${op}" stroke="${isQ ? o.accent : C.stroke}" stroke-width="${isQ ? 5 : 2}">
        ${isQ ? `<animate attributeName="stroke-width" values="5;8;5" dur="1.1s" begin="${(n*0.03+0.25).toFixed(2)}s" repeatCount="indefinite"/>` : ''}
      </rect>
      <text x="${x + cw/2}" y="${y + ch/2 + 26}" text-anchor="middle"
        font-family="Poppins,Arial" font-size="${isQ ? 78 : 64}" font-weight="800"
        fill="${isQ ? o.accent : "#ffffff"}">${esc(val)}</text>
    </g>`;
    if (i < n - 1) {
      svg += `<text x="${x + cw + gap/2}" y="${y + ch/2 + 20}" text-anchor="middle"
        font-size="46" fill="${C.inkDim}" opacity="0">
        <animate attributeName="opacity" from="0" to="1" begin="${(Number(delay)+0.1).toFixed(2)}s" dur="0.15s" fill="freeze"/>
        ›</text>`;
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
        fill="${isQ ? o.accent : "#ffffff"}">${esc(val)}</text>`;
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
      fill="${isQ ? o.accent : "#ffffff"}">${esc(eq.result)}</text>`;
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
    svg += `<text x="${cx}" y="${cy + cell*0.34}" text-anchor="middle" font-size="22" fill="#ffffff" font-family="Arial" font-weight="700">${i + 1}</text>`;
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
      svg += `<text x="${x + w/2}" y="${y + 18}" text-anchor="middle" font-family="Poppins,Arial" font-size="${fs}" font-weight="800" fill="#ffffff">${esc(t)}</text>`;
    }
    x += w + gap;
  });
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// DETECTIVE — topic icon picker + drawer
// Picks a simple, self-contained SVG motif based on keywords in the case
// title/scenario/clues so the case-file card doesn't look identical for
// every mystery. No external image fetching (works offline, deterministic,
// renders identically in the video / thumbnail / blog).
// ────────────────────────────────────────────────────────────────────────────
function pickDetectiveIcon(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(manuscript|book|library|novel|page|author|diary|journal)\b/.test(t)) return 'book';
  if (/\b(ring|diamond|jewel|necklace|gem|tiara|crown|treasure)\b/.test(t))     return 'gem';
  if (/\b(cash|money|bank|vault|safe)\b/.test(t))                              return 'vault';
  if (/\b(door|window|lock|locked|key)\b/.test(t))                             return 'key';
  if (/\b(paint|painting|portrait|museum|artwork|statue|sculpture)\b/.test(t)) return 'art';
  return 'magnifier';
}

function drawDetectiveIcon(kind, cx, cy, s, accent) {
  const ink = '#0a0f1c';
  switch (kind) {
    case 'book':
      return `<g>
        <path d="M ${cx-1.05*s} ${cy-0.8*s} Q ${cx-1.15*s} ${cy-0.95*s} ${cx-0.9*s} ${cy-0.9*s} L ${cx-0.04*s} ${cy-0.72*s} L ${cx-0.04*s} ${cy+0.78*s} L ${cx-0.9*s} ${cy+0.95*s} Q ${cx-1.15*s} ${cy+0.98*s} ${cx-1.05*s} ${cy+0.82*s} Z" fill="${ink}"/>
        <path d="M ${cx+1.05*s} ${cy-0.8*s} Q ${cx+1.15*s} ${cy-0.95*s} ${cx+0.9*s} ${cy-0.9*s} L ${cx+0.04*s} ${cy-0.72*s} L ${cx+0.04*s} ${cy+0.78*s} L ${cx+0.9*s} ${cy+0.95*s} Q ${cx+1.15*s} ${cy+0.98*s} ${cx+1.05*s} ${cy+0.82*s} Z" fill="${ink}" opacity="0.75"/>
      </g>`;
    case 'gem':
      return `<g fill="${ink}">
        <polygon points="${cx-0.95*s},${cy-0.15*s} ${cx-0.45*s},${cy-0.95*s} ${cx+0.45*s},${cy-0.95*s} ${cx+0.95*s},${cy-0.15*s} ${cx},${cy+0.95*s}"/>
        <polygon points="${cx-0.95*s},${cy-0.15*s} ${cx},${cy-0.15*s} ${cx},${cy+0.95*s}" opacity="0.55"/>
        <polygon points="${cx+0.95*s},${cy-0.15*s} ${cx},${cy-0.15*s} ${cx},${cy+0.95*s}" opacity="0.3"/>
      </g>`;
    case 'vault':
      return `<g>
        <rect x="${cx-s}" y="${cy-s}" width="${2*s}" height="${2*s}" rx="${0.22*s}" fill="${ink}"/>
        <circle cx="${cx}" cy="${cy}" r="${0.5*s}" fill="none" stroke="${accent}" stroke-width="${0.14*s}"/>
        <line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy-0.4*s}" stroke="${accent}" stroke-width="${0.12*s}" stroke-linecap="round"/>
        <line x1="${cx}" y1="${cy}" x2="${cx+0.3*s}" y2="${cy}" stroke="${accent}" stroke-width="${0.12*s}" stroke-linecap="round"/>
      </g>`;
    case 'key':
      return `<g fill="${ink}">
        <circle cx="${cx-0.55*s}" cy="${cy}" r="${0.5*s}" fill="none" stroke="${ink}" stroke-width="${0.22*s}"/>
        <rect x="${cx-0.05*s}" y="${cy-0.14*s}" width="${1.15*s}" height="${0.28*s}"/>
        <rect x="${cx+0.55*s}" y="${cy+0.14*s}" width="${0.2*s}" height="${0.3*s}"/>
        <rect x="${cx+0.85*s}" y="${cy+0.14*s}" width="${0.2*s}" height="${0.42*s}"/>
      </g>`;
    case 'art':
      return `<g>
        <rect x="${cx-s}" y="${cy-0.9*s}" width="${2*s}" height="${1.8*s}" rx="${0.08*s}" fill="none" stroke="${ink}" stroke-width="${0.16*s}"/>
        <circle cx="${cx-0.5*s}" cy="${cy-0.4*s}" r="${0.24*s}" fill="${ink}"/>
        <polyline points="${cx-0.85*s},${cy+0.6*s} ${cx-0.25*s},${cy-0.05*s} ${cx+0.2*s},${cy+0.3*s} ${cx+0.85*s},${cy-0.35*s}" fill="none" stroke="${ink}" stroke-width="${0.16*s}" stroke-linejoin="round" stroke-linecap="round"/>
      </g>`;
    default: // magnifier — the universal detective motif
      return `<g fill="none" stroke="${ink}" stroke-linecap="round">
        <circle cx="${cx-0.18*s}" cy="${cy-0.18*s}" r="${0.62*s}" stroke-width="${0.22*s}"/>
        <line x1="${cx+0.28*s}" y1="${cy+0.28*s}" x2="${cx+0.95*s}" y2="${cy+0.95*s}" stroke-width="${0.26*s}"/>
      </g>`;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// DETECTIVE (styled "case file" — big bold title, an icon badge matched to
// the case's theme, and a large, easy-to-read clue list). The suspects list
// is deliberately NOT drawn here: it is identical to the on-screen options
// (validated 1:1 upstream in puzzle_generator.js), so repeating it as its
// own row just ate vertical space and pushed everything else's font size
// down without adding any new information for the viewer.
// ────────────────────────────────────────────────────────────────────────────
function renderDetective(spec, o) {
  const title    = spec.case_title || 'The Locked Room';
  const scenario = spec.scenario || 'A valuable ring vanished from a room locked from the inside.';
  const clues    = (Array.isArray(spec.clues) && spec.clues.length ? spec.clues : ['The window was sealed shut', 'Only one person had a key']).slice(0, 4);
  const W = 1000;
  const titleLines    = wrapText(title.toUpperCase(), 20);
  const scenarioLines = wrapText(scenario, 34);
  const clueLineData  = clues.map(cl => wrapText(cl, 26));

  const iconKind = pickDetectiveIcon(`${title} ${scenario} ${clues.join(' ')}`);

  // ── dynamic height ──────────────────────────────────────────────────────
  const HEADER_H   = 120 + titleLines.length * 56;
  const SCENARIO_H = scenarioLines.length * 46 + 20;
  const CLUES_HEAD_H = 60;
  const clueRowH = clueLineData.map(lines => Math.max(1, lines.length) * 40 + 34);
  const CLUES_H  = clueRowH.reduce((s, h) => s + h + 18, 0);
  const H = HEADER_H + SCENARIO_H + CLUES_HEAD_H + CLUES_H + 70;

  let svg = openSvg(W, H, o);

  // ── Header: "CASE FILE" ribbon + icon badge + big case title ───────────
  svg += `<rect x="60" y="46" width="${W - 180}" height="52" rx="14" fill="${o.accent}" opacity="0.18"/>`;
  svg += `<text x="86" y="82" font-family="Poppins,Arial" font-size="26" font-weight="800" fill="${o.accent}" letter-spacing="3">CASE FILE</text>`;

  // Icon badge — top-right corner, colour-matched to the theme accent
  const badgeR = 52, badgeCx = W - 96, badgeCy = 98;
  svg += `<circle cx="${badgeCx}" cy="${badgeCy}" r="${badgeR}" fill="${o.accent}" filter="url(#pzGlow)"/>`;
  svg += `<circle cx="${badgeCx}" cy="${badgeCy}" r="${badgeR}" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="3"/>`;
  svg += drawDetectiveIcon(iconKind, badgeCx, badgeCy, badgeR * 0.55, o.accent);

  let y = 138;
  titleLines.forEach(ln => {
    y += 56;
    svg += `<text x="60" y="${y}" font-family="Poppins,Arial" font-size="46" font-weight="900" fill="#ffffff">${esc(ln)}</text>`;
  });

  // ── Scenario — bigger, serif for a "case file" feel ─────────────────────
  y += 46;
  scenarioLines.forEach(ln => {
    svg += `<text x="60" y="${y}" font-family="Georgia,serif" font-size="38" fill="#e8e8e8">${esc(ln)}</text>`;
    y += 46;
  });

  // ── CLUES header ─────────────────────────────────────────────────────────
  y += 26;
  svg += `<text x="60" y="${y}" font-family="Poppins,Arial" font-size="32" font-weight="800" fill="${o.accent}" letter-spacing="2">CLUES</text>`;
  y += 22;

  // ── Numbered clue cards — big text, generous spacing, easy to read ──────
  clueLineData.forEach((lines, i) => {
    const rowH = clueRowH[i];
    const cardY = y;
    svg += `<rect x="56" y="${cardY}" width="${W - 112}" height="${rowH}" rx="18" fill="${C.slotBg}" stroke="${C.stroke}" stroke-width="2"/>`;
    // number badge
    svg += `<circle cx="${56 + 42}" cy="${cardY + rowH / 2}" r="26" fill="${o.accent}" opacity="0.9"/>`;
    svg += `<text x="${56 + 42}" y="${cardY + rowH / 2 + 12}" text-anchor="middle" font-family="Poppins,Arial" font-size="30" font-weight="800" fill="#ffffff">${i + 1}</text>`;
    // clue text (vertically centred within the card)
    const textStartY = cardY + rowH / 2 - ((lines.length - 1) * 21) + 12;
    lines.forEach((ln, li) => {
      svg += `<text x="112" y="${textStartY + li * 42}" font-family="Georgia,serif" font-size="34" fill="#ffffff">${esc(ln)}</text>`;
    });
    y += rowH + 18;
  });

  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ────────────────────────────────────────────────────────────────────────────
// DISPATCHER
// ────────────────────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
// NEW PUZZLE TYPES — 10 additional types for the buyer pipeline
// ════════════════════════════════════════════════════════════════════════════

// ── 1. WORD LADDER ────────────────────────────────────────────────────────
function renderWordLadder(spec, o) {
  const words = Array.isArray(spec.words) && spec.words.length
    ? spec.words : ['COLD','CORD','WORD','WARD','?'];
  const W = 960, cellH = 110, cellW = 420, gap = 18;
  const startX = (W - cellW) / 2, startY = 160;
  const H = startY + words.length * (cellH + gap) + 60;
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Word Ladder', o);
  svg += `<text x="${W/2}" y="138" text-anchor="middle" font-family="Poppins,Arial" font-size="32" font-weight="600" fill="#ffffff">Change one letter each step</text>`;
  words.forEach((word, i) => {
    const y = startY + i * (cellH + gap);
    const isQ = /^\?+$/.test(String(word).trim());
    svg += `<rect x="${startX}" y="${y}" width="${cellW}" height="${cellH}" rx="22" fill="${isQ ? o.accent : '#ffffff'}" fill-opacity="${isQ ? '0.18' : '0.07'}" stroke="${isQ ? o.accent : 'rgba(255,255,255,0.25)'}" stroke-width="${isQ ? 5 : 2}"/>`;
    const letters = String(word).split('');
    const lw = 72, lGap = 12;
    const total = letters.length * lw + (letters.length - 1) * lGap;
    const lx = startX + (cellW - total) / 2;
    letters.forEach((ch, j) => {
      const cx = lx + j * (lw + lGap);
      svg += `<rect x="${cx}" y="${y + 16}" width="${lw}" height="${cellH - 32}" rx="12" fill="${isQ ? o.accent : 'rgba(255,255,255,0.10)'}" fill-opacity="${isQ ? '0.25' : '1'}" stroke="${isQ ? o.accent : 'rgba(255,255,255,0.30)'}" stroke-width="2"/>`;
      svg += `<text x="${cx + lw/2}" y="${y + cellH/2 + 20}" text-anchor="middle" font-family="Poppins,Arial" font-size="58" font-weight="900" fill="${isQ ? o.accent : '#ffffff'}">${esc(ch)}</text>`;
    });
    if (i < words.length - 1) {
      svg += `<text x="${W/2}" y="${y + cellH + gap/2 + 10}" text-anchor="middle" font-size="34" fill="rgba(255,255,255,0.4)">↓</text>`;
    }
  });
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ── 2. PATTERN MATRIX ─────────────────────────────────────────────────────
function renderPatternMatrix(spec, o) {
  const grid = Array.isArray(spec.grid) && spec.grid.length ? spec.grid
    : [['circle','square','triangle'],['square','triangle','circle'],['triangle','circle','?']];
  const W = 960, cell = 220, gap = 20;
  const startX = (W - 3*cell - 2*gap)/2, startY = 170;
  const H = startY + 3*cell + 2*gap + 60;
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'What comes next?', o);
  grid.forEach((row, ri) => {
    (Array.isArray(row) ? row : []).forEach((shape, ci) => {
      const x = startX + ci*(cell+gap), y = startY + ri*(cell+gap);
      const isQ = /^\?+$/.test(String(shape).trim());
      const cellColor = isQ ? o.accent : `hsl(${(ri*3+ci)*37},70%,60%)`;
      const fillOpts = { accent: cellColor, accent2: o.accent2, accent3: o.accent3 };
      svg += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="18" fill="${isQ ? o.accent : 'rgba(255,255,255,0.07)'}" fill-opacity="${isQ ? '0.15' : '1'}" stroke="${isQ ? o.accent : 'rgba(255,255,255,0.25)'}" stroke-width="${isQ ? 5 : 2}"/>`;
      if (isQ) {
        svg += `<text x="${x+cell/2}" y="${y+cell/2+28}" text-anchor="middle" font-size="110" font-weight="900" fill="${o.accent}" font-family="Arial">?</text>`;
      } else {
        svg += drawIcon(shape, x + cell/2, y + cell/2, Math.round(cell * 0.38), fillOpts);
      }
    });
  });
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ── 3. VISUAL PATTERN SEQUENCE ────────────────────────────────────────────
function renderVisualPatternSequence(spec, o) {
  const steps = Array.isArray(spec.steps) && spec.steps.length ? spec.steps
    : [{shape:'triangle'},{shape:'square'},{shape:'pentagon'},{shape:'hexagon'},{shape:'?'}];
  const W = 960, n = steps.length;
  const cell = Math.min(160, Math.floor((W - 120) / n));
  const gap = Math.floor((W - 120 - cell * n) / Math.max(n - 1, 1));
  const startX = 60, midY = 300, H = 500;
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'What comes next?', o);
  svg += `<text x="${W/2}" y="146" text-anchor="middle" font-family="Poppins,Arial" font-size="32" font-weight="600" fill="#ffffff">Find the pattern</text>`;
  steps.forEach((step, i) => {
    const cx = startX + i * (cell + gap) + cell / 2;
    const isQ = /^\?+$/.test(String(step.shape || '').trim());
    svg += `<rect x="${cx - cell/2}" y="${midY - cell/2}" width="${cell}" height="${cell}" rx="16" fill="${isQ ? o.accent : 'rgba(255,255,255,0.07)'}" fill-opacity="${isQ ? '0.18':'1'}" stroke="${isQ ? o.accent : 'rgba(255,255,255,0.25)'}" stroke-width="${isQ ? 5:2}"/>`;
    if (isQ) {
      svg += `<text x="${cx}" y="${midY+30}" text-anchor="middle" font-size="90" font-weight="900" fill="${o.accent}" font-family="Arial">?</text>`;
    } else {
      const fillOpts = { accent: step.color || o.accent, accent2: o.accent2, accent3: o.accent3 };
      svg += drawIcon(step.shape, cx, midY, Math.round(cell*0.35), fillOpts);
    }
    if (i < steps.length - 1) {
      svg += `<text x="${cx + cell/2 + gap/2}" y="${midY+14}" text-anchor="middle" font-size="38" fill="rgba(255,255,255,0.4)">›</text>`;
    }
  });
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ── 4. BALANCE SCALE ──────────────────────────────────────────────────────
function renderBalanceScale(spec, o) {
  const leftItems  = spec.left_items  || [{ icon:'apple', count:3 }];
  const rightItems = spec.right_items || [{ icon:'banana', count:1 },{ icon:'?', count:1 }];
  const leftVal    = String(spec.left_total  || '9');
  const W = 960, H = 680;
  const pivX = W/2, pivY = 340;
  const beamHalf = 260, panDrop = 110;
  const bLx = pivX - beamHalf, bRx = pivX + beamHalf;
  const bLy = pivY - 10,       bRy = pivY + 10;
  const panLy = bLy + panDrop, panRy = bRy + panDrop;
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Balance the Scale', o);
  // pole
  svg += `<rect x="${pivX-8}" y="${pivY}" width="16" height="180" rx="8" fill="${o.accent}" fill-opacity="0.6"/>`;
  // base
  svg += `<rect x="${pivX-80}" y="${pivY+168}" width="160" height="28" rx="10" fill="${o.accent}" fill-opacity="0.4"/>`;
  // beam
  svg += `<line x1="${bLx}" y1="${bLy}" x2="${bRx}" y2="${bRy}" stroke="${o.accent}" stroke-width="16" stroke-linecap="round"/>`;
  // strings
  svg += `<line x1="${bLx}" y1="${bLy}" x2="${bLx}" y2="${panLy}" stroke="${o.accent}" stroke-width="3" opacity="0.5"/>`;
  svg += `<line x1="${bRx}" y1="${bRy}" x2="${bRx}" y2="${panRy}" stroke="${o.accent}" stroke-width="3" opacity="0.5"/>`;
  // pans
  svg += `<rect x="${bLx-110}" y="${panLy}" width="220" height="14" rx="7" fill="${o.accent}" fill-opacity="0.5"/>`;
  svg += `<rect x="${bRx-110}" y="${panRy}" width="220" height="14" rx="7" fill="${o.accent}" fill-opacity="0.5"/>`;
  // pivot circle
  svg += `<circle cx="${pivX}" cy="${pivY}" r="18" fill="${o.accent}"/>`;
  // items on pans
  const drawItems = (items, panCX, panY) => {
    let out='', ix=panCX - 80;
    items.forEach(it => {
      const cnt = Number(it.count)||1;
      for(let k=0;k<cnt;k++){
        const isQ = it.icon==='?';
        if(isQ) {
          out += `<text x="${ix}" y="${panY-16}" text-anchor="middle" font-size="60" font-weight="900" fill="${o.accent}" font-family="Arial">?</text>`;
        } else {
          out += drawIcon(it.icon, ix, panY-36, 30, {accent:o.accent,accent2:o.accent2,accent3:o.accent3});
        }
        ix += 72;
      }
    });
    return out;
  };
  svg += drawItems(leftItems, bLx, panLy);
  svg += drawItems(rightItems, bRx, panRy);
  svg += `<text x="${bLx}" y="${panLy+60}" text-anchor="middle" font-family="Poppins,Arial" font-size="44" font-weight="800" fill="#ffffff">= ${esc(leftVal)}</text>`;
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ── 5. CIPHER DECODE ──────────────────────────────────────────────────────
function renderCipherDecode(spec, o) {
  const encoded    = spec.encoded    || [13,1,20,8];
  const keyType    = spec.key_type   || 'a1z26';
  const shiftN     = Number(spec.shift || 3);
  const hiddenIdx  = spec.hidden_index != null ? Number(spec.hidden_index) : encoded.length - 1;
  const W = 960, H = 560;
  const keyLabel = keyType === 'shift'
    ? `Each letter shifted ${shiftN} forward  (A→${String.fromCharCode(65+shiftN)})`
    : 'A=1, B=2, C=3 … Z=26';
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Crack the Code', o);
  svg += `<rect x="160" y="148" width="640" height="54" rx="18" fill="${o.accent}" fill-opacity="0.15"/>`;
  svg += `<text x="${W/2}" y="182" text-anchor="middle" font-family="Poppins,Arial" font-size="34" font-weight="700" fill="${o.accent}">${esc(keyLabel)}</text>`;
  const n = encoded.length, cellW = Math.min(130, Math.floor((W-80)/n) - 14), cellH = 130, gap = 14;
  const totalW = n*cellW + (n-1)*gap, sx = (W-totalW)/2, sy = 260;
  encoded.forEach((val, i) => {
    const x = sx + i*(cellW+gap);
    const isH = i === hiddenIdx;
    svg += `<rect x="${x}" y="${sy}" width="${cellW}" height="${cellH}" rx="20" fill="${isH ? o.accent : 'rgba(255,255,255,0.08)'}" fill-opacity="${isH?'0.20':'1'}" stroke="${isH ? o.accent : 'rgba(255,255,255,0.25)'}" stroke-width="${isH?5:2}"/>`;
    svg += `<text x="${x+cellW/2}" y="${sy+cellH/2+20}" text-anchor="middle" font-family="Poppins,Arial" font-size="${isH?80:64}" font-weight="900" fill="${isH ? o.accent : '#ffffff'}">${esc(isH ? '?' : val)}</text>`;
  });
  svg += `<text x="${W/2}" y="${sy+cellH+66}" text-anchor="middle" font-size="44" fill="rgba(255,255,255,0.4)">↓  decode  ↓</text>`;
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ── 6. FLAG PUZZLE ────────────────────────────────────────────────────────
function renderFlagPuzzle(spec, o) {
  const stripes   = spec.stripes   || ['#002868','#BF0A30','#ffffff'];
  const symbol    = spec.symbol    || null;
  const hiddenIdx = spec.hidden_stripe_index != null ? Number(spec.hidden_stripe_index) : 1;
  const W = 960, flagW = 680, flagH = 400, fx = (W-flagW)/2, fy = 150;
  const H = fy + flagH + 90;
  const sh = Math.floor(flagH / stripes.length);
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Which Country?', o);
  svg += `<text x="${W/2}" y="134" text-anchor="middle" font-family="Poppins,Arial" font-size="32" fill="#ffffff" font-weight="600">Identify this flag</text>`;
  svg += `<rect x="${fx-4}" y="${fy-4}" width="${flagW+8}" height="${flagH+8}" rx="14" fill="none" stroke="${o.accent}" stroke-width="4"/>`;
  stripes.forEach((col, i) => {
    const sy = fy + i * sh;
    const sh2 = i === stripes.length-1 ? flagH - i*sh : sh;
    const isH = i === hiddenIdx;
    svg += `<rect x="${fx}" y="${sy}" width="${flagW}" height="${sh2}" fill="${isH ? '#111122' : col}" stroke="${isH ? o.accent : 'none'}" stroke-width="${isH ? 4 : 0}"/>`;
    if (isH) {
      svg += `<text x="${fx+flagW/2}" y="${sy+sh2/2+26}" text-anchor="middle" font-size="90" font-weight="900" fill="${o.accent}" font-family="Arial">?</text>`;
    }
  });
  if (symbol) {
    svg += `<text x="${fx+flagW/2}" y="${fy+flagH/2+24}" text-anchor="middle" font-size="110" font-family="Arial">${esc(symbol)}</text>`;
  }
  svg += `<rect x="${fx}" y="${fy}" width="${flagW}" height="${flagH}" rx="10" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="2"/>`;
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ── 7. AREA / PERIMETER ───────────────────────────────────────────────────
function renderAreaPerimeter(spec, o) {
  const outerW  = Number(spec.outer_w  || 8);
  const outerH  = Number(spec.outer_h  || 6);
  const cutW    = Number(spec.cut_w    || 3);
  const cutH    = Number(spec.cut_h    || 3);
  const unknown = spec.unknown || 'area';
  const unit = 60, ox = 140, oy = 170;
  const sw = outerW*unit, sh = outerH*unit;
  const cw = cutW*unit, ch = cutH*unit;
  const W = 960, H = oy + sh + 130;
  const d = `M${ox} ${oy} L${ox+sw} ${oy} L${ox+sw} ${oy+ch} L${ox+cw} ${oy+ch} L${ox+cw} ${oy+sh} L${ox} ${oy+sh}Z`;
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || `Find the ${unknown==='area'?'Area':'Perimeter'}`, o);
  svg += `<path d="${d}" fill="${o.accent}" fill-opacity="0.12" stroke="${o.accent}" stroke-width="5" stroke-linejoin="round"/>`;
  const dl = (x1,y1,x2,y2,lbl) => {
    const mx=(x1+x2)/2, my=(y1+y2)/2, horiz=y1===y2;
    return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${o.accent}" stroke-width="2" stroke-dasharray="8 5" opacity="0.5"/>` +
      `<text x="${horiz?mx:mx-40}" y="${horiz?my-28:my+8}" text-anchor="middle" font-family="Poppins,Arial" font-size="34" font-weight="800" fill="#ffffff">${esc(lbl)}</text>`;
  };
  svg += dl(ox,oy-26,ox+sw,oy-26,`${outerW}`);
  svg += dl(ox+sw+30,oy,ox+sw+30,oy+sh,`${outerH}`);
  svg += dl(ox-34,oy,ox-34,oy+sh,`${outerH}`);
  svg += dl(ox,oy+sh+36,ox+cw,oy+sh+36,`${cutW}`);
  svg += dl(ox+sw+30,oy,ox+sw+30,oy+ch,`${cutH}`);
  // unknown label box on the right
  const rx = ox+sw+90, ry = oy+sh/2-90;
  svg += `<rect x="${rx}" y="${ry}" width="220" height="190" rx="22" fill="${o.accent}" fill-opacity="0.12" stroke="${o.accent}" stroke-width="3"/>`;
  svg += `<text x="${rx+110}" y="${ry+54}" text-anchor="middle" font-family="Poppins,Arial" font-size="34" font-weight="700" fill="${o.accent}">Find</text>`;
  svg += `<text x="${rx+110}" y="${ry+100}" text-anchor="middle" font-family="Poppins,Arial" font-size="36" font-weight="900" fill="${o.accent}">${esc(unknown.toUpperCase())}</text>`;
  svg += `<text x="${rx+110}" y="${ry+164}" text-anchor="middle" font-family="Poppins,Arial" font-size="96" font-weight="900" fill="${o.accent}">?</text>`;
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ── 8. DOMINOES ───────────────────────────────────────────────────────────
function _dot(cx,cy,r,col){return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}"/>`;}
function _pips(n,cx,cy){
  const pos={0:[],1:[[0,0]],2:[[-1,-1],[1,1]],3:[[-1,-1],[0,0],[1,1]],
    4:[[-1,-1],[1,-1],[-1,1],[1,1]],5:[[-1,-1],[1,-1],[0,0],[-1,1],[1,1]],
    6:[[-1,-1],[1,-1],[-1,0],[1,0],[-1,1],[1,1]]};
  return (pos[Math.min(Number(n)||0,6)]||[]).map(([dx,dy])=>_dot(cx+dx*20,cy+dy*20,8,'#ffffff')).join('');
}
function _dominoTile(x,y,t,b,isQ,o){
  const TW=110,TH=220,R=16;
  let out=`<rect x="${x}" y="${y}" width="${TW}" height="${TH}" rx="${R}" fill="${isQ?o.accent:'#1a2340'}" fill-opacity="${isQ?'0.20':'1'}" stroke="${isQ?o.accent:'rgba(255,255,255,0.35)'}" stroke-width="${isQ?5:3}"/>`;
  out+=`<line x1="${x+12}" y1="${y+TH/2}" x2="${x+TW-12}" y2="${y+TH/2}" stroke="rgba(255,255,255,0.25)" stroke-width="2"/>`;
  if(isQ){out+=`<text x="${x+TW/2}" y="${y+TH/2+16}" text-anchor="middle" font-size="80" font-weight="900" fill="${o.accent}" font-family="Arial">?</text>`;return out;}
  out+=_pips(t,x+TW/2,y+TH/4)+_pips(b,x+TW/2,y+3*TH/4);
  return out;
}
function renderDominoes(spec, o) {
  const chain = Array.isArray(spec.chain) && spec.chain.length ? spec.chain : [[3,5],[5,2],[2,4],[4,'?']];
  const W=960,TW=110,TH=220,gap=28;
  const totalW=chain.length*TW+(chain.length-1)*gap;
  const sx=(W-totalW)/2,sy=200,H=sy+TH+110;
  let svg=openSvg(W,H,o);
  svg+=titleStrip(W,spec.title||'Complete the Chain',o);
  svg+=`<text x="${W/2}" y="150" text-anchor="middle" font-family="Poppins,Arial" font-size="32" font-weight="600" fill="#ffffff">Touching halves must match</text>`;
  chain.forEach(([t,b],i)=>{
    const x=sx+i*(TW+gap);
    const isQ=String(t)==='?'||String(b)==='?';
    svg+=_dominoTile(x,sy,t,b,isQ,o);
    if(i<chain.length-1)svg+=`<text x="${x+TW+gap/2}" y="${sy+TH/2+14}" text-anchor="middle" font-size="38" fill="rgba(255,255,255,0.35)">—</text>`;
  });
  svg+=closeSvg();
  return {svg,ok:true,warnings:[]};
}

// ── 9. CLOCK ANGLE ────────────────────────────────────────────────────────
function renderClockAngle(spec, o) {
  const hour  = Number(spec.hour   != null ? spec.hour   : 3);
  const min   = Number(spec.minute != null ? spec.minute : 30);
  const qtype = spec.question_type || 'angle';
  const W = 960, R = 240, cx = W/2, cy = 330, H = cy + R + 110;
  const toRad = a => a * Math.PI / 180;
  const minAng  = (min/60)*360 - 90;
  const hourAng = ((hour%12)/12)*360 + (min/60)*30 - 90;
  const hx = cx + R*0.55*Math.cos(toRad(hourAng)), hy = cy + R*0.55*Math.sin(toRad(hourAng));
  const mx = cx + R*0.80*Math.cos(toRad(minAng)),  my = cy + R*0.80*Math.sin(toRad(minAng));
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Clock Puzzle', o);
  svg += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="rgba(255,255,255,0.06)" stroke="${o.accent}" stroke-width="8"/>`;
  for(let i=0;i<12;i++){
    const a=toRad(i*30-90),r1=R-10,r2=R-36;
    svg+=`<line x1="${(cx+r1*Math.cos(a)).toFixed(1)}" y1="${(cy+r1*Math.sin(a)).toFixed(1)}" x2="${(cx+r2*Math.cos(a)).toFixed(1)}" y2="${(cy+r2*Math.sin(a)).toFixed(1)}" stroke="rgba(255,255,255,0.4)" stroke-width="5" stroke-linecap="round"/>`;
    const n=i===0?12:i;
    svg+=`<text x="${(cx+(R-62)*Math.cos(a)).toFixed(1)}" y="${(cy+(R-62)*Math.sin(a)+12).toFixed(1)}" text-anchor="middle" font-family="Poppins,Arial" font-size="34" font-weight="700" fill="#ffffff">${n}</text>`;
  }
  svg+=`<line x1="${cx}" y1="${cy}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}" stroke="#ffffff" stroke-width="14" stroke-linecap="round"/>`;
  svg+=`<line x1="${cx}" y1="${cy}" x2="${mx.toFixed(1)}" y2="${my.toFixed(1)}" stroke="${o.accent}" stroke-width="9" stroke-linecap="round"/>`;
  svg+=`<circle cx="${cx}" cy="${cy}" r="14" fill="${o.accent}"/>`;
  const qlabel = qtype==='angle' ? 'Angle between hands = ?' : 'Time shown = ?';
  svg+=`<text x="${W/2}" y="${cy+R+76}" text-anchor="middle" font-family="Poppins,Arial" font-size="44" font-weight="900" fill="${o.accent}">${esc(qlabel)}</text>`;
  svg+=closeSvg();
  return {svg,ok:true,warnings:[]};
}

// ── 10. TRUTH OR LIE ──────────────────────────────────────────────────────
// Draw a simple SVG human silhouette centred at (cx, cy), total height ~h.
// gender: 'f' draws wider hips (skirt shape), 'm' draws straight legs.
// Colour driven by col. Pure SVG paths — no fonts, no emoji, renders everywhere.
function humanFigure(cx, cy, h, gender, col) {
  const r   = h * 0.18;           // head radius
  const sh  = h * 0.30;           // shoulder width half
  const tH  = h * 0.28;           // torso height
  const legH = h * 0.30;          // leg height
  const lw  = h * 0.07;           // limb stroke width
  const headCY = cy - h/2 + r;
  const neckY  = headCY + r;
  const torsoY = neckY + h*0.04;
  const hipY   = torsoY + tH;
  const footY  = hipY + legH;
  const armMidY = torsoY + tH * 0.45;

  let out = '';
  // head
  out += `<circle cx="${cx}" cy="${headCY.toFixed(1)}" r="${r.toFixed(1)}" fill="${col}"/>`;
  // neck
  out += `<line x1="${cx}" y1="${(headCY+r).toFixed(1)}" x2="${cx}" y2="${torsoY.toFixed(1)}" stroke="${col}" stroke-width="${(lw*0.8).toFixed(1)}" stroke-linecap="round"/>`;

  if (gender === 'f') {
    // body — trapezoid skirt shape
    const hipW = sh * 1.5;
    out += `<polygon points="${cx-sh*0.6},${torsoY.toFixed(1)} ${cx+sh*0.6},${torsoY.toFixed(1)} ${cx+hipW},${hipY.toFixed(1)} ${cx-hipW},${hipY.toFixed(1)}" fill="${col}"/>`;
    // legs — slightly angled out from wide hip
    out += `<line x1="${(cx-hipW*0.55).toFixed(1)}" y1="${hipY.toFixed(1)}" x2="${(cx-sh*0.5).toFixed(1)}" y2="${footY.toFixed(1)}" stroke="${col}" stroke-width="${lw.toFixed(1)}" stroke-linecap="round"/>`;
    out += `<line x1="${(cx+hipW*0.55).toFixed(1)}" y1="${hipY.toFixed(1)}" x2="${(cx+sh*0.5).toFixed(1)}" y2="${footY.toFixed(1)}" stroke="${col}" stroke-width="${lw.toFixed(1)}" stroke-linecap="round"/>`;
  } else {
    // body — straight rectangle
    out += `<rect x="${(cx-sh*0.55).toFixed(1)}" y="${torsoY.toFixed(1)}" width="${(sh*1.1).toFixed(1)}" height="${tH.toFixed(1)}" rx="${(sh*0.2).toFixed(1)}" fill="${col}"/>`;
    // legs
    out += `<line x1="${(cx-sh*0.3).toFixed(1)}" y1="${hipY.toFixed(1)}" x2="${(cx-sh*0.4).toFixed(1)}" y2="${footY.toFixed(1)}" stroke="${col}" stroke-width="${lw.toFixed(1)}" stroke-linecap="round"/>`;
    out += `<line x1="${(cx+sh*0.3).toFixed(1)}" y1="${hipY.toFixed(1)}" x2="${(cx+sh*0.4).toFixed(1)}" y2="${footY.toFixed(1)}" stroke="${col}" stroke-width="${lw.toFixed(1)}" stroke-linecap="round"/>`;
  }
  // arms (same for both)
  out += `<line x1="${(cx-sh*0.5).toFixed(1)}" y1="${torsoY.toFixed(1)}" x2="${(cx-sh*1.1).toFixed(1)}" y2="${armMidY.toFixed(1)}" stroke="${col}" stroke-width="${lw.toFixed(1)}" stroke-linecap="round"/>`;
  out += `<line x1="${(cx+sh*0.5).toFixed(1)}" y1="${torsoY.toFixed(1)}" x2="${(cx+sh*1.1).toFixed(1)}" y2="${armMidY.toFixed(1)}" stroke="${col}" stroke-width="${lw.toFixed(1)}" stroke-linecap="round"/>`;
  return out;
}

function renderTruthOrLie(spec, o) {
  const people = Array.isArray(spec.people) && spec.people.length ? spec.people : [
    { name:'Alice', statement:'Bob is lying.',            gender:'f' },
    { name:'Bob',   statement:'I always tell the truth.', gender:'m' },
    { name:'Carol', statement:'Alice tells the truth.',   gender:'f' },
  ];
  const W = 960, bubbleH = 148, bubbleGap = 24, topY = 172;
  const H = topY + people.length*(bubbleH+bubbleGap) + 70;
  // Accent colour variants per person so figures look distinct
  const colors = [o.accent, o.accent2 || '#22c55e', o.accent3 || '#f4c430', '#ff2d78', '#a78bfa', '#38bdf8'];
  const genders = ['f','m','f','m','f','m'];
  let svg = openSvg(W, H, o);
  svg += titleStrip(W, spec.title || 'Who Tells the Truth?', o);
  svg += `<text x="${W/2}" y="148" text-anchor="middle" font-family="Poppins,Arial" font-size="32" font-weight="600" fill="#ffffff">Only ONE person always tells the truth</text>`;
  people.forEach((p, i) => {
    const y   = topY + i*(bubbleH+bubbleGap);
    const col = colors[i % colors.length];
    const gen = p.gender || genders[i % genders.length];
    const figH = bubbleH * 0.76;
    const figCX = 82, figCY = y + bubbleH/2 - 4;
    // human figure (no background circle — figure stands freely)
    svg += humanFigure(figCX, figCY, figH, gen, col);
    // name label below
    svg += `<text x="${figCX}" y="${y+bubbleH-4}" text-anchor="middle" font-family="Poppins,Arial" font-size="24" font-weight="800" fill="${col}">${esc(p.name)}</text>`;
    // speech bubble
    const bx = 154, by = y, bw = W-bx-34, bh = bubbleH;
    svg += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="22" fill="rgba(255,255,255,0.07)" stroke="${col}" stroke-width="2.5" stroke-opacity="0.4"/>`;
    svg += `<polygon points="${bx},${by+bh/2-14} ${bx-26},${by+bh/2} ${bx},${by+bh/2+14}" fill="rgba(255,255,255,0.07)"/>`;
    const lines = wrapText(p.statement || '', 38);
    const lh = 42, ty = by + bh/2 - ((lines.length-1)*lh)/2;
    lines.forEach((ln, li) => {
      svg += `<text x="${bx+bw/2}" y="${ty+li*lh+14}" text-anchor="middle" font-family="Georgia,serif" font-size="36" font-weight="700" fill="#ffffff">${esc(ln)}</text>`;
    });
  });
  svg += closeSvg();
  return { svg, ok: true, warnings: [] };
}

// ════════════════════════════════════════════════════════════════════════════

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
  // New buyer pipeline types
  word_ladder: renderWordLadder,
  pattern_matrix: renderPatternMatrix,
  visual_pattern_sequence: renderVisualPatternSequence,
  balance_scale: renderBalanceScale,
  cipher_decode: renderCipherDecode,
  flag_puzzle: renderFlagPuzzle,
  area_perimeter: renderAreaPerimeter,
  dominoes: renderDominoes,
  clock_angle: renderClockAngle,
  truth_or_lie: renderTruthOrLie,
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

module.exports = {
  renderPuzzle, PUZZLE_TYPES, RENDERERS,
  // Export individual renderers for testing
  renderWordLadder, renderPatternMatrix, renderVisualPatternSequence,
  renderBalanceScale, renderCipherDecode, renderFlagPuzzle,
  renderAreaPerimeter, renderDominoes, renderClockAngle, renderTruthOrLie,
};
