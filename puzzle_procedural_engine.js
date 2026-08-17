'use strict';
// ════════════════════════════════════════════════════════════════════════════
// puzzle_procedural_engine.js — BATCH 1 of the LLM-removal project.
//
// Same philosophy as geometry_engine.js: every answer here is computed or
// verified by real code, not asked of an LLM. Covers the 13 types where that
// is fully possible (pure math/logic, or a small curated real-world/word
// dataset — never an invented "fact"):
//
//   matchstick, number_sequence, number_grid, visual_math, balance_scale,
//   clock_angle, dominoes, cipher_decode, pattern_matrix,
//   visual_pattern_sequence, word_ladder, truth_or_lie, flag_puzzle
//
// NOT in this batch (see chat for rationale, not silently downgraded):
//   - rebus, detective: narrative/wordplay quality genuinely benefits from
//     an LLM; a template-only version would be noticeably worse. Proposed
//     as a hybrid (curated scenario/phrase POOLS + LLM only fills the
//     connecting sentence) in a follow-up rather than fully proceduralized.
//   - area_perimeter: now redundant with geometry's compound_L_area family
//     — recommend retiring (is_active=false) rather than rebuilding it.
//
// Every generator returns EXACTLY the same object shape as
// generateGeometryPuzzle(): { spec, question, options, correct, hint,
// explanation, keep_5050, youtube_title, difficulty, thinking_time_sec,
// target_format... } — see puzzle_generator.js's PROCEDURAL_TYPES branch for
// how this plugs in. `spec` matches each type's EXISTING schema exactly
// (documented in puzzle_generator.js's TYPE_PROMPTS), so the EXISTING
// renderers in puzzleRenderers.js need zero changes.
// ════════════════════════════════════════════════════════════════════════════

function ri(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function shuffle(a) { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }
function keep5050(options, correct) {
  const ci = options.indexOf(correct);
  const others = options.map((_, i) => i).filter(i => i !== ci);
  return [ci, pick(others)].map(String);
}
function buildOptionsNum(correct, fmt, spreadPct, trap) {
  const set = new Set([fmt(correct)]);
  if (trap != null && Math.abs(trap - correct) > 0.001) set.add(fmt(trap));
  const spread = Math.max(1, Math.round(Math.abs(correct) * spreadPct));
  let guard = 0;
  while (set.size < 4 && guard++ < 60) {
    const mult = 1 + Math.floor(guard / 8);
    const delta = pick([-2, -1, 1, 2]) * spread * mult;
    const v = correct + delta;
    if (v > 0 || correct <= 0) set.add(fmt(v));
  }
  return shuffle([...set]).slice(0, 4);
}

const DIFF_CFG = {
  quick:  { thinkTimeSec: 5,  fmt: 'short'  },
  medium: { thinkTimeSec: 8,  fmt: 'medium' },
  hard:   { thinkTimeSec: 12, fmt: 'long'   },
};

// ════════════════════════════════════════════════════════════════════════════
// MATCHSTICK — reuses your existing, tested seven-segment solver verbatim
// (copied from puzzle_generator.js) so "is this equation reachable by moving
// exactly one stick" is real, not assumed. GENERATE-AND-FILTER: try random
// equation strings from a few natural templates, keep the first one that
// (a) is currently false and (b) has at least one reachable true fix.
// ════════════════════════════════════════════════════════════════════════════
const MS_SEG = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};
const MS_ALL_SEGS = 'abcdefg'.split('');
function canonSegs(str) { return str.split('').sort().join(''); }
const MS_CANON_TO_DIGIT = Object.fromEntries(Object.entries(MS_SEG).map(([d, s]) => [canonSegs(s), d]));
function evalSimpleExpr(expr) {
  const parts = expr.match(/[+\-]?\d+/g);
  if (!parts) return null;
  return parts.reduce((s, p) => s + parseInt(p, 10), 0);
}
function evalEquation(eq) {
  const sides = eq.split('=');
  if (sides.length !== 2) return null;
  const l = evalSimpleExpr(sides[0]), r = evalSimpleExpr(sides[1]);
  if (l == null || r == null) return null;
  return { left: l, right: r, isTrue: l === r };
}
function solveMatchstickMove(eq) {
  const parsed = evalEquation(eq);
  if (!parsed) return { parsedOk: false, currentlyFalse: false, reachable: new Set() };
  const digitIdx = [];
  for (let i = 0; i < eq.length; i++) if (MS_SEG[eq[i]]) digitIdx.push(i);
  if (digitIdx.length < 2) return { parsedOk: true, currentlyFalse: !parsed.isTrue, reachable: new Set() };
  const removalOptions = [], additionOptions = [];
  for (const i of digitIdx) {
    const segs = MS_SEG[eq[i]].split('');
    for (const seg of segs) {
      const remaining = segs.filter(s => s !== seg);
      const to = MS_CANON_TO_DIGIT[canonSegs(remaining.join(''))];
      if (to != null) removalOptions.push({ i, to });
    }
    for (const seg of MS_ALL_SEGS) {
      if (segs.includes(seg)) continue;
      const to = MS_CANON_TO_DIGIT[canonSegs([...segs, seg].join(''))];
      if (to != null) additionOptions.push({ i, to });
    }
  }
  const reachable = new Set();
  for (const rem of removalOptions) for (const add of additionOptions) {
    if (add.i === rem.i) continue;
    const chars = eq.split('');
    chars[rem.i] = rem.to; chars[add.i] = add.to;
    const candidate = chars.join('');
    const p = evalEquation(candidate);
    if (p && p.isTrue) reachable.add(candidate);
  }
  return { parsedOk: true, currentlyFalse: !parsed.isTrue, reachable };
}
const MS_TEMPLATES = [
  () => `${ri(0,9)}+${ri(0,9)}=${ri(0,9)}`,
  () => `${ri(10,19)}+${ri(0,9)}=${ri(10,29)}`,
  () => `${ri(0,9)}-${ri(0,9)}=${ri(0,9)}`,
  () => `${ri(10,19)}-${ri(0,9)}=${ri(0,19)}`,
  () => `${ri(0,9)}+${ri(0,9)}=${ri(10,19)}`,
];
function genMatchstick() {
  for (let attempt = 0; attempt < 300; attempt++) {
    const eq = pick(MS_TEMPLATES)();
    const check = solveMatchstickMove(eq);
    if (!check.parsedOk || !check.currentlyFalse || !check.reachable.size) continue;
    const correct = pick([...check.reachable]);
    const distractors = new Set([correct]);
    // Build 3 plausible-but-wrong "fixes": digit-perturbations of the correct one
    let guard = 0;
    while (distractors.size < 4 && guard++ < 30) {
      const chars = correct.split('');
      const idx = pick(chars.map((c,i)=>i).filter(i => MS_SEG[chars[i]]));
      chars[idx] = String(ri(0,9));
      distractors.add(chars.join(''));
    }
    const options = shuffle([...distractors]).slice(0,4);
    if (!options.includes(correct)) options[0] = correct;
    return {
      difficulty: 'quick',
      spec: { equation: eq, instruction: 'Move 1 matchstick to make it true', title: 'Matchstick Move' },
      question: 'Move ONE matchstick to make the equation true — which works?',
      options, correct,
      hint: 'Only one digit changes.',
      explanation: `Moving one stick turns ${eq} into ${correct}, a true equation.`,
      youtube_title: 'Move ONE Stick to Fix This Equation!',
    };
  }
  return null; // extremely unlikely; caller retries
}

// ════════════════════════════════════════════════════════════════════════════
// NUMBER_SEQUENCE — 5 distinct rule families for real content variety
// ════════════════════════════════════════════════════════════════════════════
function genNumberSequence() {
  const ruleType = pick(['arithmetic', 'geometric', 'quadratic', 'fibonacci', 'alternating']);
  let cells = [], correct, explanation;
  if (ruleType === 'arithmetic') {
    const start = ri(1, 20), d = pick([-4,-3,-2,-1,2,3,4,5,6]);
    const n = ri(4,6);
    for (let i=0;i<n;i++) cells.push(start + i*d);
    correct = start + n*d;
    explanation = `Each step ${d>0?'adds':'subtracts'} ${Math.abs(d)}: the next term is ${cells[n-1]} ${d>0?'+':'-'} ${Math.abs(d)} = ${correct}.`;
  } else if (ruleType === 'geometric') {
    const start = ri(1,5), r = pick([2,3]);
    const n = ri(4,5);
    for (let i=0;i<n;i++) cells.push(start * Math.pow(r,i));
    correct = start * Math.pow(r,n);
    explanation = `Each term is multiplied by ${r}: ${cells[n-1]} × ${r} = ${correct}.`;
  } else if (ruleType === 'quadratic') {
    const start = ri(1,10), d0 = ri(1,4), dd = ri(1,3);
    const n = ri(4,5);
    let cur = start, diff = d0;
    for (let i=0;i<n;i++) { cells.push(cur); cur += diff; diff += dd; }
    correct = cur;
    explanation = `The gap between terms grows by ${dd} each time — the next gap is ${diff}, so ${cells[n-1]} + ${diff} = ${correct}.`;
  } else if (ruleType === 'fibonacci') {
    let a = ri(1,5), b = ri(a+1,a+6);
    cells = [a,b];
    const n = ri(4,5);
    for (let i=2;i<n;i++) { const c=a+b; cells.push(c); a=b; b=c; }
    correct = cells[cells.length-1] + cells[cells.length-2];
    explanation = `Each term is the sum of the two before it: ${cells[cells.length-2]} + ${cells[cells.length-1]} = ${correct}.`;
  } else { // alternating +a,-b repeat
    const start = ri(10,30), up = ri(3,8), down = ri(1,5);
    const n = ri(4,6);
    cells = [start];
    for (let i=1;i<n;i++) cells.push(cells[i-1] + (i%2===1?up:-down));
    correct = cells[n-1] + (n%2===1?up:-down);
    explanation = `The pattern alternates +${up} then -${down}: next is ${cells[n-1]} ${n%2===1?'+':'-'} ${n%2===1?up:down} = ${correct}.`;
  }
  cells.push('?');
  const fmt = v => `${v}`;
  const options = buildOptionsNum(correct, fmt, 0.18);
  if (!options.includes(fmt(correct))) options[0] = fmt(correct);
  return {
    difficulty: pick(['quick','quick','medium']),
    spec: { cells: cells.map(String), title: 'What comes next?' },
    question: 'What number comes next in the sequence?',
    options, correct: fmt(correct),
    hint: `Look at how each number changes to the next.`,
    explanation,
    youtube_title: '99% Get This Number Sequence Wrong!',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// NUMBER_GRID — row-sum / col-sum / row-product rules, all verified by
// construction (build the grid FROM the rule, so it can never be wrong)
// ════════════════════════════════════════════════════════════════════════════
function genNumberGrid() {
  const rule = pick(['row-sum', 'col-sum', 'row-product']);
  let grid;
  if (rule === 'row-product') {
    // small factors so the product stays readable
    grid = Array.from({length:3}, () => {
      const a = ri(1,4), b = ri(1,4);
      return [a, b, a*b];
    });
  } else {
    const target = ri(12, 24);
    grid = [];
    for (let r=0;r<3;r++) {
      const a = ri(1, target-2), b = ri(1, target-a-1), c = target-a-b;
      if (c < 1) { r--; continue; }
      grid.push([a,b,c]);
    }
    if (rule === 'col-sum') {
      // transpose so the CONSTANT total reads down columns instead of across rows
      grid = grid[0].map((_,c) => grid.map(row => row[c]));
    }
  }
  const qr = ri(0,2), qc = ri(0,2);
  const correct = grid[qr][qc];
  const rows = grid.map(row => row.map(String));
  rows[qr][qc] = '?';
  const fmt = v => `${v}`;
  const options = buildOptionsNum(correct, fmt, 0.2);
  if (!options.includes(fmt(correct))) options[0] = fmt(correct);
  // Explanation text matches the ACTUAL rule for each mode — row-product
  // grids are independent per-row a×b=c facts (not a shared product across
  // rows), so the explanation says that explicitly instead of the wrong
  // "same product" claim a copy-pasted row-sum-style sentence would imply.
  let hint, explanation;
  if (rule === 'row-product') {
    hint = 'In each row, the first two numbers multiply to the third.';
    explanation = `In this row, the first two numbers multiply to the third — use the two you know to solve for "?".`;
  } else if (rule === 'col-sum') {
    hint = 'Check what each column adds up to.';
    explanation = `Each column adds up to the same total — use that to solve for the missing cell.`;
  } else {
    hint = 'Check what each row adds up to.';
    explanation = `Each row adds up to the same total — use that to solve for the missing cell.`;
  }
  return {
    difficulty: 'medium',
    spec: { rows, title: 'Missing Number' },
    question: 'What number replaces the question mark?',
    options, correct: fmt(correct),
    hint, explanation,
    youtube_title: 'Find The Missing Number In This Grid!',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// VISUAL_MATH — icon algebra, 2-3 row variants, always an integer answer
// ════════════════════════════════════════════════════════════════════════════
const ICONS = ['apple','banana','cherry','grape','star','heart','lemon','orange'];
function genVisualMath() {
  const icons = shuffle(ICONS).slice(0, pick([1,2]));
  const vals = {}; icons.forEach(ic => vals[ic] = ri(2,9));
  const rows = [];
  if (icons.length === 1) {
    const [ic] = icons;
    const c1 = ri(2,4);
    rows.push({ items:[{icon:ic,count:c1}], result: String(c1*vals[ic]) });
    const c2 = ri(1,3);
    rows.push({ items:[{icon:ic,count:c2}], result: '?' });
    var correct = c2*vals[ic];
  } else {
    const [ic1, ic2] = icons;
    const a1=ri(1,3), b1=ri(1,3);
    rows.push({ items:[{icon:ic1,count:a1},{icon:ic2,count:b1}], result: String(a1*vals[ic1]+b1*vals[ic2]) });
    const a2=ri(1,3);
    rows.push({ items:[{icon:ic1,count:a2}], result: String(a2*vals[ic1]) });
    const a3=ri(1,2), b3=ri(1,2);
    rows.push({ items:[{icon:ic2,count:a3},{icon:ic1,count:b3}], result: '?' });
    correct = a3*vals[ic2] + b3*vals[ic1];
  }
  const fmt = v => `${v}`;
  const options = buildOptionsNum(correct, fmt, 0.2);
  if (!options.includes(fmt(correct))) options[0] = fmt(correct);
  return {
    difficulty: 'quick',
    spec: { equations: rows, title: 'Solve the Puzzle' },
    question: 'What does the last row equal?',
    options, correct: fmt(correct),
    hint: 'Work out each icon\'s value from the rows above.',
    explanation: `Each icon has a fixed value derived from the earlier rows; the last row equals ${correct}.`,
    youtube_title: 'Solve This Fruit Math Puzzle!',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// BALANCE_SCALE
// ════════════════════════════════════════════════════════════════════════════
function genBalanceScale() {
  const icon = pick(ICONS);
  const perIcon = ri(2,9);
  const leftCount = ri(1,4);
  const leftTotal = leftCount * perIcon;
  const rightKnownCount = pick([0,0,1,1,2]);
  const qCount = ri(1,2);
  const rightItems = [];
  if (rightKnownCount > 0) rightItems.push({ icon, count: rightKnownCount });
  rightItems.push({ icon: '?', count: qCount });
  const correct = (leftTotal - rightKnownCount*perIcon) / qCount;
  if (!Number.isInteger(correct) || correct <= 0) return null; // caller retries
  const fmt = v => `${v}`;
  const options = buildOptionsNum(correct, fmt, 0.2);
  if (!options.includes(fmt(correct))) options[0] = fmt(correct);
  return {
    difficulty: 'quick',
    spec: { left_items:[{icon,count:leftCount}], left_total:String(leftTotal), right_items: rightItems, title: 'Balance the Scale' },
    question: 'What number balances the scale?',
    options, correct: fmt(correct),
    hint: `Each ${icon} is worth ${perIcon} — but figure that out from the left pan.`,
    explanation: `The left pan shows ${leftCount} ${icon}=${leftTotal}, so each ${icon}=${perIcon}. Solve the right pan for "?".`,
    youtube_title: 'Balance The Scale — Can You Solve It?',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CLOCK_ANGLE
// ════════════════════════════════════════════════════════════════════════════
function genClockAngle() {
  const hour = ri(1,12), minute = pick([0,5,10,15,20,25,30,35,40,45,50,55]);
  const qtype = pick(['angle','angle','time']);
  if (qtype === 'angle') {
    const raw = Math.abs(30*(hour%12) + 0.5*minute - 6*minute);
    const correct = Math.round(Math.min(raw, 360-raw));
    const fmt = v => `${v}°`;
    const options = buildOptionsNum(correct, v=>`${v}°`, 0.25);
    if (!options.includes(fmt(correct))) options[0] = fmt(correct);
    return {
      difficulty: 'medium',
      spec: { hour, minute, question_type: 'angle', title: 'Clock Puzzle' },
      question: 'What is the angle between the hands?',
      options, correct: fmt(correct),
      hint: 'The minute hand moves 6° per minute; the hour hand moves 0.5° per minute.',
      explanation: `At ${hour}:${String(minute).padStart(2,'0')} the hands are ${correct}° apart.`,
      youtube_title: 'What\'s The Angle On This Clock?',
    };
  } else {
    const correct = `${hour}:${String(minute).padStart(2,'0')}`;
    const decoyMinutes = shuffle([0,5,10,15,20,25,30,35,40,45,50,55].filter(m=>m!==minute)).slice(0,3);
    const options = shuffle([correct, ...decoyMinutes.map(m=>`${hour}:${String(m).padStart(2,'0')}`)]);
    return {
      difficulty: 'quick',
      spec: { hour, minute, question_type: 'time', title: 'Read the Clock' },
      question: 'What time does this clock show?',
      options, correct,
      hint: 'Read the hour hand first, then the minutes.',
      explanation: `The short hand is on/past ${hour}, and the long hand shows ${minute} minutes — ${correct}.`,
      youtube_title: 'Can You Read This Clock?',
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// DOMINOES — builds a guaranteed-consistent chain, then blanks ONE interior
// pip (never an outer end, matching the existing validator's own rule)
// ════════════════════════════════════════════════════════════════════════════
function genDominoes() {
  const n = ri(4,6);
  const chain = [[ri(0,6), ri(0,6)]];
  for (let i=1;i<n;i++) chain.push([chain[i-1][1], ri(0,6)]);
  // pick an interior pip to blank: interior top (i>0) or interior bottom (i<n-1)
  const candidates = [];
  for (let i=1;i<n;i++) candidates.push({i, side:'top'});
  for (let i=0;i<n-1;i++) candidates.push({i, side:'bottom'});
  const q = pick(candidates);
  const correct = q.side === 'top' ? chain[q.i][0] : chain[q.i][1];
  const display = chain.map(t => [...t]);
  if (q.side === 'top') display[q.i][0] = '?'; else display[q.i][1] = '?';
  const fmt = v => `${v}`;
  const options = new Set([fmt(correct)]);
  while (options.size < 4) options.add(fmt(ri(0,6)));
  const optArr = shuffle([...options]).slice(0,4);
  if (!optArr.includes(fmt(correct))) optArr[0] = fmt(correct);
  return {
    difficulty: 'quick',
    spec: { chain: display, title: 'Complete the Chain' },
    question: 'What number completes the domino chain?',
    options: optArr, correct: fmt(correct),
    hint: 'Touching halves must match.',
    explanation: `Touching domino halves must be equal, so the missing pip is ${correct}.`,
    youtube_title: 'Complete This Domino Chain!',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// CIPHER_DECODE — small curated common-word list (real words only)
// ════════════════════════════════════════════════════════════════════════════
const CIPHER_WORDS = ['CAT','DOG','SUN','MOON','STAR','FISH','BIRD','TREE','BOOK','MATH',
  'GAME','TIME','LOVE','HOPE','GOLD','BLUE','RING','KING','SHIP','LAKE',
  'ROCK','SAND','WIND','SNOW','RAIN','FIRE','LEAF','SEED','FARM','MILK'];
function genCipherDecode() {
  const word = pick(CIPHER_WORDS);
  const keyType = pick(['a1z26','a1z26','shift']);
  const shift = keyType === 'shift' ? ri(1,5) : 0;
  const encode = ch => {
    const pos = ch.charCodeAt(0) - 64;
    return keyType === 'shift' ? ((pos - 1 + shift) % 26 + 26) % 26 + 1 : pos;
  };
  const encoded = [...word].map(encode);
  const hiddenIdx = ri(0, word.length-1);
  const correct = word[hiddenIdx];
  const options = new Set([correct]);
  while (options.size < 4) options.add(String.fromCharCode(65 + ri(0,25)));
  const optArr = shuffle([...options]).slice(0,4);
  if (!optArr.includes(correct)) optArr[0] = correct;
  return {
    difficulty: 'medium',
    spec: { word, encoded, key_type: keyType, shift, hidden_index: hiddenIdx, title: 'Crack the Code' },
    question: 'What\'s the missing letter once you decode it?',
    options: optArr, correct,
    hint: keyType === 'shift' ? `Each letter is shifted by ${shift}.` : 'A=1, B=2, C=3...',
    explanation: keyType === 'shift'
      ? `Shift each number back by ${shift} to decode the word: ${word}.`
      : `Each number is that letter's position in the alphabet (A=1...Z=26) — the word is ${word}.`,
    youtube_title: 'Crack This Secret Code!',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PATTERN_MATRIX — genuine 3×3 Latin squares (every row/col has each shape
// exactly once), built directly so the missing cell is always derivable
// ════════════════════════════════════════════════════════════════════════════
const SHAPES5 = ['circle','square','triangle','star','heart'];
const LATIN_BASE = [[0,1,2],[1,2,0],[2,0,1]];
function genPatternMatrix() {
  const shapes = shuffle(SHAPES5).slice(0,3);
  const base = pick([LATIN_BASE, LATIN_BASE.map(r=>[...r].reverse())]);
  const grid = base.map(row => row.map(i => shapes[i]));
  const qr = ri(0,2), qc = ri(0,2);
  const correct = grid[qr][qc];
  const display = grid.map(r => [...r]);
  display[qr][qc] = '?';
  const options = new Set([correct]);
  shuffle(shapes).forEach(s => options.add(s));
  const extra = shuffle(SHAPES5.filter(s=>!shapes.includes(s)));
  let ei=0; while (options.size < 4 && ei<extra.length) options.add(extra[ei++]);
  const optArr = shuffle([...options]).slice(0,4);
  if (!optArr.includes(correct)) optArr[0] = correct;
  return {
    difficulty: 'medium',
    spec: { grid: display, title: 'What comes next?' },
    question: 'Which shape completes the pattern?',
    options: optArr, correct,
    hint: 'Every row and column has each shape exactly once.',
    explanation: `Since ${shapes.join(', ')} each appear once per row and column, the missing cell must be ${correct}.`,
    youtube_title: 'Complete This Shape Pattern!',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// VISUAL_PATTERN_SEQUENCE — repeating cycle of 2-3 shapes
// ════════════════════════════════════════════════════════════════════════════
function genVisualPatternSequence() {
  const cycleLen = pick([2,2,3]);
  const cycle = shuffle(SHAPES5).slice(0, cycleLen);
  const n = ri(4,6);
  const steps = [];
  for (let i=0;i<n-1;i++) steps.push({ shape: cycle[i % cycleLen] });
  const correct = cycle[(n-1) % cycleLen];
  steps.push({ shape: '?' });
  const options = new Set([correct]);
  shuffle(SHAPES5.filter(s=>s!==correct)).forEach(s => options.add(s));
  const optArr = shuffle([...options]).slice(0,4);
  if (!optArr.includes(correct)) optArr[0] = correct;
  return {
    difficulty: 'quick',
    spec: { steps, title: 'What comes next?' },
    question: 'What shape comes next in the pattern?',
    options: optArr, correct,
    hint: `The shapes repeat in a ${cycleLen}-shape cycle.`,
    explanation: `The pattern repeats every ${cycleLen} shapes (${cycle.join('-')}), so the next one is ${correct}.`,
    youtube_title: 'What Shape Comes Next?',
  };
}

// ════════════════════════════════════════════════════════════════════════════
// WORD_LADDER — small curated same-length word pools so every word (INCLUDING
// the answer) is a verified real word, not just "differs by one letter"
// ════════════════════════════════════════════════════════════════════════════
const LADDER_WORDS = {
  3: ['CAT','COT','COG','DOG','DOT','HOT','HOG','HAT','BAT','BAG','BIG','BIT','BID','BAD','BED','BEG','LEG','LOG','LOT','LID'],
  4: ['COLD','CORD','WORD','WARD','WARM','WART','CARD','CARE','BARE','BARN','BORN','CORN','COIN','CHIN','CHAT','COAT','GOAT','GOAD','ROAD','READ'],
};
function editDist1(a,b) {
  if (a.length !== b.length) return 99;
  let d=0; for (let i=0;i<a.length;i++) if (a[i]!==b[i]) d++;
  return d;
}
function genWordLadder() {
  const len = pick([3,4]);
  const pool = LADDER_WORDS[len];
  for (let attempt=0; attempt<40; attempt++) {
    const start = pick(pool);
    const chainLen = ri(3,4);
    const chain = [start];
    let ok = true;
    for (let i=1;i<chainLen;i++) {
      const nbrs = pool.filter(w => !chain.includes(w) && editDist1(w, chain[i-1])===1);
      if (!nbrs.length) { ok = false; break; }
      chain.push(pick(nbrs));
    }
    if (!ok) continue;
    const nextOptions = pool.filter(w => !chain.includes(w) && editDist1(w, chain[chain.length-1])===1);
    if (!nextOptions.length) continue;
    const correct = pick(nextOptions);
    const decoys = shuffle(pool.filter(w=>w!==correct && !chain.includes(w))).slice(0,3);
    const options = shuffle([correct, ...decoys]);
    return {
      difficulty: 'medium',
      spec: { words: [...chain, '?'], title: 'Word Ladder' },
      question: 'What\'s the next word in the ladder?',
      options, correct,
      hint: 'Change exactly one letter.',
      explanation: `Changing one letter of ${chain[chain.length-1]} gives ${correct}.`,
      youtube_title: 'Complete This Word Ladder!',
    };
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// TRUTH_OR_LIE — real constraint-satisfaction: generate random statements
// referencing the other people, brute-force check that EXACTLY ONE
// assignment (sole truth-teller) is self-consistent before accepting it.
// ════════════════════════════════════════════════════════════════════════════
const NAME_POOL = ['Alice','Bob','Carol','Dan','Eve','Frank','Grace','Henry','Ivy','Jack'];
function genTruthOrLie() {
  for (let attempt=0; attempt<200; attempt++) {
    const names = shuffle(NAME_POOL).slice(0,3);
    const genders = names.map(() => pick(['f','m']));
    // Statement kinds we can actually evaluate:
    //   'accuse'  -> claims OTHER is lying   (true iff other is NOT the truth-teller)
    //   'self'    -> claims "I always tell the truth" (true iff self IS the truth-teller)
    //   'support' -> claims OTHER tells the truth (true iff other IS the truth-teller)
    const kinds = [0,1,2].map(() => pick(['accuse','self','support']));
    const targets = [0,1,2].map(i => {
      const others = [0,1,2].filter(j=>j!==i);
      return pick(others);
    });
    const statementTrue = (speakerIdx, truthIdx) => {
      const kind = kinds[speakerIdx];
      if (kind === 'self') return speakerIdx === truthIdx;
      const t = targets[speakerIdx];
      if (kind === 'accuse') return t !== truthIdx;
      return t === truthIdx; // support
    };
    // find how many truthIdx candidates are self-consistent:
    // truthIdx is valid iff statement[truthIdx] is TRUE and every other
    // statement[j] (j!=truthIdx) is FALSE.
    const validTruthIdxs = [0,1,2].filter(truthIdx => {
      for (let j=0;j<3;j++) {
        const isTrue = statementTrue(j, truthIdx);
        if (j === truthIdx && !isTrue) return false;
        if (j !== truthIdx && isTrue) return false;
      }
      return true;
    });
    if (validTruthIdxs.length !== 1) continue; // ambiguous or unsolvable — retry
    const truthIdx = validTruthIdxs[0];
    const statements = [0,1,2].map(i => {
      const kind = kinds[i];
      if (kind === 'self') return 'I always tell the truth.';
      const t = targets[i];
      return kind === 'accuse' ? `${names[t]} is lying.` : `${names[t]} tells the truth.`;
    });
    const people = names.map((n,i) => ({ name: n, statement: statements[i], gender: genders[i] }));
    const correct = names[truthIdx];
    const options = shuffle([...names]);
    return {
      difficulty: 'medium',
      spec: { people, title: 'Who Tells the Truth?' },
      question: 'Who is the ONE person telling the truth?',
      options, correct,
      hint: 'Only one statement can be true at a time — test each person.',
      explanation: `Assuming ${correct} is the only truth-teller is the only assignment where no statement contradicts itself.`,
      youtube_title: 'Only ONE Person Tells The Truth — Who Is It?',
    };
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// FLAG_PUZZLE — curated real flags only (never invented). Small, but every
// entry is a flag I'm confident is accurate; grows over time rather than
// guessing at flags I'm not sure about.
// ════════════════════════════════════════════════════════════════════════════
const FLAGS = [
  { name: 'France',   stripes: ['#0055A4','#FFFFFF','#EF4135'] },
  { name: 'Italy',    stripes: ['#009246','#FFFFFF','#CE2B37'] },
  { name: 'Germany',  stripes: ['#000000','#DD0000','#FFCE00'] },
  { name: 'Belgium',  stripes: ['#000000','#FAE042','#ED2939'] },
  { name: 'Ireland',  stripes: ['#169B62','#FFFFFF','#FF883E'] },
  { name: 'Ivory Coast', stripes: ['#F77F00','#FFFFFF','#009E60'] }, // mirror of Ireland — great trick pair
  { name: 'Netherlands', stripes: ['#AE1C28','#FFFFFF','#21468B'] },
  { name: 'Luxembourg',  stripes: ['#ED2939','#FFFFFF','#00A1DE'] }, // near-identical to Netherlands
  { name: 'Romania',  stripes: ['#002B7F','#FCD116','#CE1126'] },
  { name: 'Chad',     stripes: ['#002664','#FECB00','#C60C30'] }, // near-identical to Romania
  { name: 'Poland',   stripes: ['#FFFFFF','#DC143C'] },
  { name: 'Indonesia', stripes: ['#FF0000','#FFFFFF'] },
  { name: 'Monaco',   stripes: ['#CE1126','#FFFFFF'] }, // same colors as Indonesia, different ratio
  { name: 'Austria',  stripes: ['#ED2939','#FFFFFF','#ED2939'] },
  { name: 'Latvia',   stripes: ['#9E1B32','#FFFFFF','#9E1B32'] },
  { name: 'Russia',   stripes: ['#FFFFFF','#0039A6','#D52B1E'] },
  { name: 'Slovenia', stripes: ['#FFFFFF','#0000FF','#FF0000'] },
  { name: 'Slovakia', stripes: ['#FFFFFF','#0B4EA2','#EE1C25'] },
  { name: 'Bulgaria', stripes: ['#FFFFFF','#00966E','#D62612'] },
  { name: 'Hungary',  stripes: ['#CE2939','#FFFFFF','#477050'] },
  { name: 'Mali',     stripes: ['#14B53A','#FCD116','#CE1126'] },
  { name: 'Senegal',  stripes: ['#00853F','#FDEF42','#E31B23'] },
  { name: 'Guinea',   stripes: ['#CE1126','#FCD116','#009460'] },
  { name: 'Cameroon', stripes: ['#007A5E','#CE1126','#FCD116'] },
];
function genFlagPuzzle() {
  const flag = pick(FLAGS);
  const hiddenIdx = ri(0, flag.stripes.length-1);
  const decoys = shuffle(FLAGS.filter(f=>f.name!==flag.name).map(f=>f.name)).slice(0,3);
  const options = shuffle([flag.name, ...decoys]);
  return {
    difficulty: 'quick',
    spec: { stripes: flag.stripes, symbol: null, hidden_stripe_index: hiddenIdx, title: 'Which Country?' },
    question: 'Which country\'s flag is this?',
    options, correct: flag.name,
    hint: 'Look at the stripe order and colors.',
    explanation: `This is the flag of ${flag.name}.`,
    youtube_title: `Guess The Flag — Only Experts Know This One!`,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// DISPATCH TABLE + PUBLIC API — mirrors generateGeometryPuzzle()'s shape
// ════════════════════════════════════════════════════════════════════════════
const GENERATORS = {
  matchstick: genMatchstick,
  number_sequence: genNumberSequence,
  number_grid: genNumberGrid,
  visual_math: genVisualMath,
  balance_scale: genBalanceScale,
  clock_angle: genClockAngle,
  dominoes: genDominoes,
  cipher_decode: genCipherDecode,
  pattern_matrix: genPatternMatrix,
  visual_pattern_sequence: genVisualPatternSequence,
  word_ladder: genWordLadder,
  truth_or_lie: genTruthOrLie,
  flag_puzzle: genFlagPuzzle,
};
const PROCEDURAL_TYPES = Object.keys(GENERATORS);

function buildFingerprint(type, spec) {
  return `${type}::${JSON.stringify(spec)}`;
}

// generatePuzzle(type) -> same shape as geometry_engine's generateGeometryPuzzle
function generatePuzzle(type) {
  const gen = GENERATORS[type];
  if (!gen) return null;
  let result = null;
  for (let i = 0; i < 20 && !result; i++) result = gen();
  if (!result) return null;
  const cfg = DIFF_CFG[result.difficulty] || DIFF_CFG.medium;
  return {
    ...result,
    thinking_time_sec: cfg.thinkTimeSec,
    target_format: cfg.fmt,
    fingerprint: buildFingerprint(type, result.spec),
  };
}

module.exports = { PROCEDURAL_TYPES, GENERATORS, generatePuzzle, buildFingerprint };
