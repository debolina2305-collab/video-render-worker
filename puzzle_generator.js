/**
 * puzzle_generator.js — PUZZLE Quiz Generator (Cloudflare Worker)
 *
 * The puzzle equivalent of worker8.js. Reads ONE pending puzzle_queue row
 * (its puzzle_type was already chosen by puzzle_seeder.js), asks the LLM for a
 * fully self-contained visual puzzle of that type, validates it (structure +
 * math sanity checks), pulls audio cues from the SAME reused pools worker8 uses,
 * builds a `puzzle` row, assigns a render format, inserts it, and fires the
 * puzzle render workflow.
 *
 * ISOLATION:
 *   • Reads (read-only): quiz_generation_settings (LLM creds), and the audio
 *     pools (quiz_hooks, timeup_cues, cta*_cues, *_intro_cues, sfx_cues,
 *     background_music_tracks, background_animation). Reading changes nothing
 *     for the trending workers.
 *   • Writes ONLY: puzzle_queue (its own row) and puzzle (new rows).
 *   • Never touches quiz / quiz_queue.
 *
 * DEPLOY: single-file drag-drop Cloudflare Worker.
 *
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY,
 *      [GITHUB_TOKEN, GITHUB_REPO] (to fire repository_dispatch trigger-puzzle-render)
 *
 * The puzzle_spec shapes below MUST match puzzleRenderers.js exactly.
 *
 * UNIQUENESS SYSTEM (3 layers):
 *   Layer 1 — puzzle_fingerprint column (unique index in Supabase):
 *             a short hash of the puzzle's core data. INSERT fails on duplicate.
 *   Layer 2 — Pre-insert check: query existing fingerprints before inserting.
 *             On collision: throw → job retry mechanism retries with a new LLM call.
 *   Layer 3 — LLM prompt injection: last 10 fingerprints for this type are sent
 *             to the LLM with "AVOID DUPLICATES" so it generates different content.
 *
 * TITLE DIVERSITY:
 *   Same Layer-3 pattern as fingerprints, applied to youtube_title so the
 *   channel stops publishing near-identical titles ("Can You Solve This X?"
 *   repeated back to back). Two pools are sent to the LLM:
 *     - last 10 titles for THIS puzzle_type (style repetition within a format)
 *     - last 15 titles across ALL puzzle_types (repetition across formats —
 *       e.g. a number_sequence and a number_grid both titled the same way
 *       back-to-back was previously invisible to this check)
 *   Both pools are also used in the post-generation similarity guard.
 *
 * CONTENT VALIDATION (updated):
 *   Every puzzle_type now gets *some* form of correctness check before insert.
 *   Where the correct answer is fully derivable (geometry, sequences, visual
 *   math, odd_one_out) validation is a hard, authoritative re-derivation —
 *   same as before. Where it previously was NOT derivable at all (matchstick,
 *   number_grid, rebus, detective) it now gets either:
 *     - a hard check where the puzzle type allows one (matchstick: real
 *       "does moving exactly one stick reach a true equation that's actually
 *       among the options" solver, built from puzzleRenderers.js's own
 *       7-segment digit map; odd_one_out: enforce the exact 16-item/4-col
 *       shape the renderer expects instead of a loose ">=6" check), or
 *     - a best-effort soft check that hard-rejects only when a rule CAN be
 *       verified and is violated, and otherwise logs a warning rather than
 *       false-rejecting a legitimate puzzle we can't fully parse
 *       (number_grid: row-sum/col-sum/row-product rule detection; detective:
 *       the stated culprit must actually be referenced by the clues; rebus:
 *       basic phrase-shape sanity).
 *
 *   NEWLY ADDED (buyer-pipeline) TYPES — same treatment, matched exactly to
 *   puzzleRenderers.js's own spec shapes for these types:
 *     - word_ladder, pattern_matrix, balance_scale, cipher_decode,
 *       area_perimeter, dominoes, clock_angle: fully derivable → hard checks.
 *     - visual_pattern_sequence, flag_puzzle, truth_or_lie: no generic
 *       derivable rule (visual/creative pattern, real-world flag lookup,
 *       free-text logic statements) → best-effort soft checks, same
 *       philosophy as rebus/detective above.
 *
 * POOL-FAILURE VISIBILITY (new):
 *   Audio/design pool loaders used to fail silently (empty array → null
 *   fields on the row, no trace anywhere). They now log loudly with
 *   console.error AND record which pools came back empty in the completed
 *   job's payload.pool_warnings, so a Supabase/RLS regression on e.g.
 *   background_music_tracks is visible instead of silently shipping videos
 *   with no music.
 *
 * FORMAT ASSIGNMENT (removed) + CROSS-FORMAT LOCK (added):
 *   This worker used to call the `assign_puzzle_format` RPC (driven by
 *   puzzle_format_config.ratio_sequence) to pick exactly ONE format for each
 *   new row, and only set that one format's *_status column to pending — the
 *   other two stayed null, so only one format worker could ever claim a given
 *   puzzle. That RPC call and the ratio-based single-format decision are gone.
 *   Every row inserted here now sets short_status, medium_status, AND
 *   long_status to their pending_* values simultaneously, so the row is open
 *   to whichever format worker gets to it first — but is_rendered (also set
 *   false here on insert) is a separate CROSS-FORMAT lock: whichever format
 *   worker claims the row first flips is_rendered to true, and every other
 *   format's poll query filters on is_rendered=eq.false, so the row becomes
 *   invisible to them. Net result: still "whichever format gets there first"
 *   like an open pool, but exactly ONE video comes out of a given row —
 *   never one per format. puzzle_format_config is no longer read anywhere in
 *   this file.
 *
 * SUPABASE SETUP (run once):
 *   alter table public.puzzle add column if not exists puzzle_fingerprint text null;
 *   create unique index if not exists idx_puzzle_fingerprint
 *     on public.puzzle (puzzle_fingerprint) where puzzle_fingerprint is not null;
 *   alter table public.puzzle add column if not exists is_rendered boolean not null default false;
 *   create index if not exists idx_puzzle_is_rendered
 *     on public.puzzle (is_rendered, is_active, puzzle_enriched)
 *     where (is_rendered = false);
 *   -- see migration.sql for the performance-tracking columns this file's
 *   -- sibling (puzzle_seeder.js + puzzle_performance_sync.js) relies on.
 */

const PUZZLE_TYPES = [
  'matchstick', 'geometry_triangle', 'geometry_right_triangle', 'geometry_straight_line',
  'number_sequence', 'number_grid', 'visual_math', 'odd_one_out', 'rebus', 'detective',
  // Buyer-pipeline types (previously supported by puzzleRenderers.js but never
  // whitelisted here — every job for one of these failed with "Unknown
  // puzzle_type" and burned through its retries. See TYPE_PROMPTS + the
  // matching validatePuzzle()/buildFingerprint() cases below.)
  'word_ladder', 'pattern_matrix', 'visual_pattern_sequence', 'balance_scale',
  'cipher_decode', 'flag_puzzle', 'area_perimeter', 'dominoes', 'clock_angle', 'truth_or_lie',
  // Procedural geometry engine — 31 shape/question families in ONE type, no
  // LLM call (see GEOMETRY_FAMILIES below). The old geometry_triangle /
  // geometry_right_triangle / geometry_straight_line / area_perimeter types
  // are LEFT IN this list (non-breaking for any in-flight queue rows) but
  // should be set is_active=false in puzzle_type_config in favor of this one.
  'geometry',
];


// ════════════════════════════════════════════════════════════════════════════
// PROCEDURAL GEOMETRY ENGINE (generation-only) — inlined, not require()'d.
//
// This file is a single-file drag-drop Cloudflare Worker (see header), so it
// can't import ./geometry_engine.js the way the Node.js render workers do.
// This block is the GENERATION half only (picks a shape family + random
// params + computes the guaranteed-correct answer via real formulas) —
// no LLM call, no SVG. The matching RENDER half (31 families, same ids,
// same `vars` shape) lives in geometry_engine.js, already wired into
// puzzleRenderers.js's RENDERERS.geometry. Keep the family `generate()` /
// `explain()` bodies below IN SYNC with geometry_engine.js's copies if you
// ever tune a formula or parameter range — they must produce the exact same
// `vars` shape since the render worker draws whatever `vars` this worker
// stores in puzzle_spec.
//
// Replaces the old geometry_triangle / geometry_right_triangle /
// geometry_straight_line / area_perimeter LLM-driven types with ONE
// puzzle_type ('geometry') covering 31 distinct shape/question families,
// each with a guaranteed-correct answer (no validatePuzzle needed) and a
// difficulty tier that maps deterministically to a video format:
//   quick  → short  (12s video / 5s countdown)
//   medium → medium (22s video / 8s countdown)
//   hard   → long   (42s video / 12s countdown)
// ════════════════════════════════════════════════════════════════════════════
const GEO_PYTH_TRIPLES = [[3,4,5],[6,8,10],[5,12,13],[8,15,17],[9,12,15],[7,24,25],[20,21,29],[12,16,20]];
const COMMON_TRIPLES = [[3,4,5],[3,4,5],[3,4,5],[6,8,10],[6,8,10],[5,12,13],[5,12,13],[9,12,15],[8,15,17],[7,24,25]];

const GEO_DIFFICULTY_CONFIG = {
  quick:  { selectWeight: 3, spreadPct: 0.12, thinkTimeSec: 5  }, // → short  (12s video)
  medium: { selectWeight: 2, spreadPct: 0.20, thinkTimeSec: 8  }, // → medium (22s video)
  hard:   { selectWeight: 1, spreadPct: 0.32, thinkTimeSec: 12 }, // → long   (42s video)
};
const GEO_DIFFICULTY_TO_FORMAT = { quick: 'short', medium: 'medium', hard: 'long' };

function geoRi(lo, hi) { return lo + Math.floor(Math.random() * (hi - lo + 1)); }
function geoPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function geoShuffle(a) { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; }

// Local aliases so the family bodies below (copied verbatim from
// geometry_engine.js) work unmodified.
const ri = geoRi, pick = geoPick;

const GEOMETRY_FAMILIES = [
{
    id: 'tri_angle_sum', difficulty: 'quick', category: 'triangle', title: 'Find the Angle',
    question: 'What is the missing angle?',
    generate() {
      let b = ri(30, 85), c = ri(30, 85 - Math.max(0, b - 85));
      while (b + c >= 175) c = ri(20, 60);
      const a = 180 - b - c;
      return { vars: { a, b, c, flip: Math.random() < 0.5 }, correct: a, fmt: v => `${v}°` };
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
    
    explain: v => `Isosceles triangles have two equal base angles. (180 − ${v.apex}) ÷ 2 = ${v.base}°.`,
  },
{
    id: 'tri_exterior_angle', difficulty: 'quick', category: 'triangle', title: 'Exterior Angle',
    question: 'What is the marked exterior angle?',
    generate() {
      const i1 = ri(30, 80), i2 = ri(30, 80);
      return { vars: { i1, i2 }, correct: i1 + i2, fmt: v => `${v}°` };
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
    
    explain: v => `In a 45-45-90 triangle the hypotenuse = leg × √2 ≈ ${v.leg} × 1.414 = ${v.correct}.`,
  },
{
    id: 'tri_area_base_height', difficulty: 'quick', category: 'triangle', title: 'Triangle Area',
    question: 'What is the area of this triangle?',
    generate() {
      const base = ri(4, 16), height = ri(3, 14);
      return { vars: { base, height }, correct: (base * height) / 2, fmt: v => `${v}` };
    },
    
    explain: v => `Triangle area = ½ × base × height = ½ × ${v.base} × ${v.height} = ${(v.base*v.height)/2}.`,
  },
{
    id: 'quad_square_area', difficulty: 'quick', category: 'quadrilateral', title: 'Square Area',
    question: 'What is the area of this square?',
    generate() { const s = ri(3, 15); return { vars: { s }, correct: s * s, fmt: v => `${v}`, trap: s * 4 }; },
    
    explain: v => `Square area = side². ${v.s}² = ${v.s*v.s}.`,
  },
{
    id: 'quad_square_perimeter', difficulty: 'quick', category: 'quadrilateral', title: 'Square Perimeter',
    question: 'What is the perimeter of this square?',
    generate() { const s = ri(3, 20); return { vars: { s }, correct: s * 4, fmt: v => `${v}`, trap: s * s }; },
    
    explain: v => `Square perimeter = 4 × side = 4 × ${v.s} = ${v.s*4}.`,
  },
{
    id: 'quad_square_diagonal', difficulty: 'hard', category: 'quadrilateral', title: 'Square Diagonal',
    question: 'What is the diagonal length? (hint: × 1.4)',
    generate() { const s = pick([2,4,6,8,10]); return { vars: { s }, correct: Math.round(s*Math.SQRT2*10)/10, fmt: v => `${v}` }; },
    
    explain: v => `Square diagonal = side × √2 ≈ ${v.s} × 1.414 = ${Math.round(v.s*Math.SQRT2*10)/10}.`,
  },
{
    id: 'quad_rect_area', difficulty: 'quick', category: 'quadrilateral', title: 'Rectangle Area',
    question: 'What is the area of this rectangle?',
    generate() { const w = ri(4, 18), h = ri(3, 14); return { vars: { w, h }, correct: w * h, fmt: v => `${v}`, trap: 2*(w+h) }; },
    
    explain: v => `Rectangle area = width × height = ${v.w} × ${v.h} = ${v.w*v.h}.`,
  },
{
    id: 'quad_rect_perimeter', difficulty: 'quick', category: 'quadrilateral', title: 'Rectangle Perimeter',
    question: 'What is the perimeter of this rectangle?',
    generate() { const w = ri(4, 20), h = ri(3, 16); return { vars: { w, h }, correct: 2*(w+h), fmt: v => `${v}`, trap: w*h }; },
    
    explain: v => `Rectangle perimeter = 2 × (w + h) = 2 × (${v.w} + ${v.h}) = ${2*(v.w+v.h)}.`,
  },
{
    id: 'quad_rect_diagonal', difficulty: 'medium', category: 'quadrilateral', title: 'Rectangle Diagonal',
    question: 'What is the diagonal length?',
    generate() { const [a,b,c] = pick(COMMON_TRIPLES); return { vars: { w: a, h: b, d: c }, correct: c, fmt: v => `${v}` }; },
    
    explain: v => `Diagonal² = w² + h² → ${v.w}² + ${v.h}² = ${v.d}².`,
  },
{
    id: 'quad_rhombus_area', difficulty: 'medium', category: 'quadrilateral', title: 'Rhombus Area',
    question: 'What is the area of this rhombus?',
    generate() { const d1 = ri(4,16)*2, d2 = ri(3,12)*2; return { vars: { d1, d2 }, correct: (d1*d2)/2, fmt: v => `${v}` }; },
    
    explain: v => `Rhombus area = (d1 × d2) ÷ 2 = (${v.d1} × ${v.d2}) ÷ 2 = ${(v.d1*v.d2)/2}.`,
  },
{
    id: 'quad_parallelogram_area', difficulty: 'quick', category: 'quadrilateral', title: 'Parallelogram Area',
    question: 'What is the area of this parallelogram?',
    generate() { const base = ri(5,18), h = ri(3,12); return { vars: { base, h }, correct: base*h, fmt: v => `${v}` }; },
    
    explain: v => `Parallelogram area = base × height = ${v.base} × ${v.h} = ${v.base*v.h}.`,
  },
{
    id: 'quad_trapezoid_area', difficulty: 'medium', category: 'quadrilateral', title: 'Trapezoid Area',
    question: 'What is the area of this trapezoid?',
    generate() { const a = ri(4,10), b = ri(10,20), h = ri(3,10); return { vars: { a, b, h }, correct: ((a+b)/2)*h, fmt: v => `${v}` }; },
    
    explain: v => `Trapezoid area = ((a+b)/2) × h = ((${v.a}+${v.b})/2) × ${v.h} = ${((v.a+v.b)/2)*v.h}.`,
  },
{
    id: 'circle_area', difficulty: 'hard', category: 'circle', title: 'Circle Area',
    question: 'What is the area of this circle? (use π ≈ 3)',
    generate() { const r = ri(2,6); return { vars: { r }, correct: Math.round(3*r*r*100)/100, fmt: v => `${v}` }; },
    
    explain: v => `Circle area = πr² ≈ 3 × ${v.r}² = ${Math.round(3*v.r*v.r*100)/100}.`,
  },
{
    id: 'circle_circumference', difficulty: 'hard', category: 'circle', title: 'Circle Circumference',
    question: 'What is the circumference of this circle? (use π ≈ 3)',
    generate() { const r = ri(2,6); return { vars: { r }, correct: Math.round(2*3*r*100)/100, fmt: v => `${v}` }; },
    
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
    
    explain: v => `Arc length = 2πr × (angle/360) ≈ 2 × 3 × ${v.r} × (${v.angle}/360) = ${Math.round(2*3*v.r*(v.angle/360)*100)/100}.`,
  },
{
    id: 'compound_L_area', difficulty: 'medium', category: 'compound', title: 'L-Shape Area',
    question: 'What is the area of this L-shape?',
    generate() {
      const ow = ri(6,14), oh = ri(6,14), cw = ri(2,ow-2), ch = ri(2,oh-2);
      return { vars: { ow, oh, cw, ch }, correct: ow*oh - (ow-cw)*ch, fmt: v => `${v}` };
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
    
    explain: v => `This plus-shape is made of 5 equal squares of side ${v.unit}: 5 × ${v.unit}² = ${5*v.unit*v.unit}.`,
  },
{
    id: 'angle_on_line', difficulty: 'quick', category: 'angle', title: 'Angles on a Line',
    question: 'What is the missing angle?',
    // Trap: viewers who mix this up with vertical angles guess "equal to k"
    // instead of "180-k" — include k itself as a decoy.
    generate() { const k = ri(20,160); return { vars: { k }, correct: 180-k, fmt: v => `${v}°`, trap: k }; },
    
    explain: v => `Angles on a straight line sum to 180°: 180 − ${v.k} = ${180-v.k}°.`,
  },
{
    id: 'angle_vertical', difficulty: 'quick', category: 'angle', title: 'Vertical Angles',
    question: 'What is the marked vertical angle?',
    // Trap: vertical angles are EQUAL, but the classic mistake is answering
    // 180-k (the ADJACENT/supplementary angle) instead — that's what makes
    // "just copy the number" not actually free.
    generate() { const k = ri(20,160); return { vars: { k }, correct: k, fmt: v => `${v}°`, trap: 180 - k }; },
    
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
    
    explain: v => `Angles around a point sum to 360°: 360 − ${v.a} − ${v.b} = ${360-v.a-v.b}°.`,
  },
{
    id: 'angle_complementary', difficulty: 'quick', category: 'angle', title: 'Complementary Angles',
    question: 'These two angles are complementary. Find x.',
    // Trap: the #1 real-world mixup is complementary (90°) vs supplementary
    // (180°) — so 180-k is a genuine "wait, which one is this again?" decoy.
    generate() { const k = ri(10,80); return { vars: { k }, correct: 90-k, fmt: v => `${v}°`, trap: 180-k }; },
    
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
    
    explain: v => `Interior angle of a regular n-gon = (n−2)×180 ÷ n = (${v.n}−2)×180 ÷ ${v.n} = ${Math.round(((v.n-2)*180)/v.n*10)/10}°.`,
  },
{
    id: 'coord_distance', difficulty: 'medium', category: 'coordinate', title: 'Distance Between Points',
    question: 'What is the distance between these two points?',
    generate() {
      const [dx,dy,d] = pick(COMMON_TRIPLES);
      const x1 = ri(-4,2), y1 = ri(-4,2);
      const x2 = x1+dx, y2 = y1+dy;
      return { vars: { x1,y1,x2,y2 }, correct: d, fmt: v => `${v}` };
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
    
    explain: v => `Slope = rise/run = (${v.y2}-${v.y1})/(${v.x2}-${v.x1}) = ${v.rise}/${v.run} = ${Math.round((v.rise/v.run)*100)/100}.`,
  }
];

function geoBuildOptions(correct, fmt, spreadPct, trap) {
  const set = new Set([fmt(correct)]);
  if (trap != null && trap > 0 && Math.abs(trap - correct) > 0.001) set.add(fmt(trap));
  const spread = Math.max(1, Math.round(Math.abs(correct) * spreadPct));
  let guard = 0;
  while (set.size < 4 && guard++ < 60) {
    const mult = 1 + Math.floor(guard / 8);
    const delta = geoPick([-2, -1, 1, 2]) * spread * mult;
    const v = correct + delta;
    if (v > 0) set.add(fmt(v));
  }
  return geoShuffle([...set]).slice(0, 4);
}
function geoKeep5050(options, correct) {
  const ci = options.indexOf(correct);
  const others = options.map((_, i) => i).filter(i => i !== ci);
  return [ci, geoPick(others)].map(String);
}

const GEO_WEIGHTED_POOL = GEOMETRY_FAMILIES.flatMap(f => {
  const cfg = GEO_DIFFICULTY_CONFIG[f.difficulty] || GEO_DIFFICULTY_CONFIG.medium;
  return Array(cfg.selectWeight).fill(f);
});

// Mirrors geometry_engine.js's generateGeometryPuzzle() exactly — same
// family pool, same weighting, same option-spread/trap logic — so a
// 'geometry' row generated here renders identically via puzzleRenderers.js.
function generateGeometryPuzzle(recentFamilyIds = []) {
  const avoid = new Set(recentFamilyIds.slice(0, 5));
  let pool = GEO_WEIGHTED_POOL.filter(f => !avoid.has(f.id));
  if (!pool.length) pool = GEO_WEIGHTED_POOL;
  const family = geoPick(pool);
  const cfg = GEO_DIFFICULTY_CONFIG[family.difficulty] || GEO_DIFFICULTY_CONFIG.medium;
  const { vars, correct, fmt, trap } = family.generate();
  const correctStr = fmt(correct);
  const options = geoBuildOptions(correct, fmt, cfg.spreadPct, trap);
  if (!options.includes(correctStr)) options[0] = correctStr;
  const fillColor = geoPick(['#FFC700', '#22c55e', '#3b82f6', '#f97316', '#ec4899', '#a78bfa', '#06b6d4', '#ef4444', '#84cc16', '#e879f9']);

  const spec = { family: family.id, vars, title: family.title, fillColor };

  return {
    title: family.title,
    spec,
    question: family.question,
    options,
    correct: correctStr,
    hint: `Think about the ${family.category} formula this shape needs.`,
    explanation: family.explain(vars),
    keep_5050: geoKeep5050(options, correctStr),
    youtube_title: `Can You Solve This ${family.title}?`,
    familyId: family.id,
    difficulty: family.difficulty,
    thinking_time_sec: cfg.thinkTimeSec,
    target_format: GEO_DIFFICULTY_TO_FORMAT[family.difficulty], // 'short' | 'medium' | 'long'
  };
}

// ════════════════════════════════════════════════════════════════════════════
// PROCEDURAL ENGINE BATCH 1 — 13 more types, same no-LLM philosophy as the
// geometry engine above. Every answer is computed/verified by code. Reuses
// puzzleRenderers.js's EXISTING renderers for these types unmodified — only
// generation changes, not rendering.
// ════════════════════════════════════════════════════════════════════════════
// ri/pick reuse the existing geoRi/geoPick aliases already defined above
// for the geometry engine — same RNG helpers, no need to redefine.
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

const PROC_DIFF_CFG = {
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
// MS_SEG / solveMatchstickMove() etc. are NOT redefined here — this
// file already has an identical block (search "MATCHSTICK move-solver")
// used by validatePuzzle's matchstick case. genMatchstick() below calls
// that existing solveMatchstickMove() directly (safe: function
// declarations hoist, and it's only ever CALLED at request time, long
// after the whole module has finished loading).
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

function buildProceduralFingerprint(type, spec) {
  return `${type}::${JSON.stringify(spec)}`;
}

// generatePuzzle(type) -> same shape as geometry_engine's generateGeometryPuzzle
function generateProceduralPuzzle(type) {
  const gen = GENERATORS[type];
  if (!gen) return null;
  let result = null;
  for (let i = 0; i < 20 && !result; i++) result = gen();
  if (!result) return null;
  const cfg = PROC_DIFF_CFG[result.difficulty] || PROC_DIFF_CFG.medium;
  return {
    ...result,
    thinking_time_sec: cfg.thinkTimeSec,
    target_format: cfg.fmt,
    fingerprint: buildProceduralFingerprint(type, result.spec),
  };
}



export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/generate-puzzle') {
      await processPuzzleQueue(env);
      return new Response('OK', { status: 200 });
    }
    if (request.method === 'GET' && url.pathname === '/health') return new Response('OK', { status: 200 });
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(processPuzzleQueue(env)); }
};

// ════════════════════════════════════════════════════════════════════════════
async function processPuzzleQueue(env) {
  console.log('[PGEN] Checking pending puzzle jobs...');
  const nowIso = new Date().toISOString();

  // Fresh pending first, then retryable failed jobs (same model as worker8).
  // NOTE: the `retry_count=lt.N` here is only a cheap prefetch bound to avoid
  // scanning jobs that are obviously exhausted — the AUTHORITATIVE cap is the
  // per-job `max_retries` check just below (jobs have different max_retries,
  // which can't be expressed as a single column comparison in this query).
  // Previously this was hardcoded to `lt.10` while the real default cap is 3,
  // making the query-side bound dead weight; widened + documented instead of
  // silently doing nothing.
  let jobs = await dbGet(env,
    `puzzle_queue?job_type=eq.puzzle_generation&status=eq.pending&order=priority.desc,created_at.asc&limit=1`
  ).catch(() => null);

  if (!jobs?.length) {
    jobs = await dbGet(env,
      `puzzle_queue?job_type=eq.puzzle_generation&status=eq.failed` +
      `&retry_count=lt.50&or=(next_retry_at.is.null,next_retry_at.lte.${encodeURIComponent(nowIso)})` +
      `&order=priority.desc,created_at.asc&limit=1`
    ).catch(() => null);
    if (jobs?.length && jobs[0].retry_count >= (jobs[0].max_retries || 3)) jobs = [];
  }
  if (!jobs?.length) { console.log('[PGEN] No pending/retryable jobs.'); return; }

  const job = jobs[0];
  const puzzleType = job.puzzle_type;
  console.log(`[PGEN] Job ${job.id}: type=${puzzleType} difficulty=${job.difficulty}`);

  if (!PUZZLE_TYPES.includes(puzzleType)) {
    await failJob(env, job, `Unknown puzzle_type "${puzzleType}"`);
    return;
  }

  await dbPatch(env, 'puzzle_queue', job.id, { status: 'processing', started_at: nowIso });

  try {
    const lang        = job.lang_code || 'en';
    const category    = job.category  || 'math';
    const difficulty  = job.difficulty || 'medium';
    const channelName = job.channel_name || 'JaasX Brain Challenge';
    const niche        = 'brain';

    // ── 1a. Fetch recent fingerprints for this type (Layer 3: LLM dedup) ────
    let recentFPs = [];
    try {
      const fpRows = await dbGet(env,
        `puzzle?puzzle_type=eq.${encodeURIComponent(puzzleType)}&puzzle_fingerprint=not.is.null` +
        `&select=puzzle_fingerprint&order=created_at.desc&limit=15`
      ).catch(() => null);
      recentFPs = (fpRows || []).map(r => r.puzzle_fingerprint).filter(Boolean);
      if (recentFPs.length) console.log(`[PGEN] Recent FPs for ${puzzleType}: ${recentFPs.length} (sent to LLM)`);
    } catch {}

    // ── 1a2. Fetch recent YOUTUBE TITLES — per-type AND cross-type ─────────
    let recentTitles = [];
    let recentTitlesGlobal = [];
    try {
      const titleRows = await dbGet(env,
        `puzzle?puzzle_type=eq.${encodeURIComponent(puzzleType)}&youtube_title=not.is.null` +
        `&select=youtube_title&order=created_at.desc&limit=10`
      ).catch(() => null);
      recentTitles = (titleRows || []).map(r => r.youtube_title).filter(Boolean);
      if (recentTitles.length) console.log(`[PGEN] Recent titles for ${puzzleType}: ${recentTitles.length} (sent to LLM)`);
    } catch {}
    try {
      // Cross-type pool: catches "This X Breaks Most Brains" being reused by a
      // DIFFERENT puzzle_type right after this one used it — invisible to the
      // per-type-only check above.
      const globalRows = await dbGet(env,
        `puzzle?youtube_title=not.is.null&select=youtube_title&order=created_at.desc&limit=15`
      ).catch(() => null);
      recentTitlesGlobal = (globalRows || []).map(r => r.youtube_title).filter(Boolean);
    } catch {}

    // ── 1b. Generate the puzzle for this type ──────────────────────────────
    // 'geometry' and the 13 PROCEDURAL_TYPES (matchstick, number_sequence,
    // number_grid, visual_math, balance_scale, clock_angle, dominoes,
    // cipher_decode, pattern_matrix, visual_pattern_sequence, word_ladder,
    // truth_or_lie, flag_puzzle) are all procedural — guaranteed-correct,
    // no LLM, no validatePuzzle needed. Every other type keeps the existing
    // LLM path unchanged.
    let puzzles, model, chosen = null, chosenFingerprint = null;

    if (puzzleType === 'geometry') {
      model = 'procedural-geometry-v1';
      // recentFPs look like "geometry::tri_angle_sum::{...}" — pull the
      // family id back out so we can avoid repeating it immediately.
      const recentFamilyIds = recentFPs.map(fp => fp.split('::')[1]).filter(Boolean);
      // No LLM round-trip, so instead of "generate N candidates, pick the
      // first non-duplicate" we just retry generation itself a few times —
      // each call is free and instant.
      for (let attempt = 0; attempt < 8 && !chosen; attempt++) {
        const candidate = generateGeometryPuzzle(recentFamilyIds);
        const fp = buildFingerprint(puzzleType, candidate);
        try {
          const existing = await dbGet(env,
            `puzzle?puzzle_fingerprint=eq.${encodeURIComponent(fp)}&select=id&limit=1`
          ).catch(() => null);
          if (existing?.length) {
            console.warn(`[PGEN] Duplicate fingerprint skipped (attempt ${attempt + 1}): ${fp}`);
            continue;
          }
        } catch {}
        chosen = candidate;
        chosenFingerprint = fp;
        console.log(`[PGEN] Geometry family=${candidate.familyId} difficulty=${candidate.difficulty} → ${candidate.target_format}. Fingerprint OK: ${fp}`);
      }
      if (!chosen) throw new Error('All generated geometry puzzles were duplicates — will retry.');
      puzzles = [chosen]; // for logging parity below
    } else if (PROCEDURAL_TYPES.includes(puzzleType)) {
      model = 'procedural-batch1-v1';
      for (let attempt = 0; attempt < 8 && !chosen; attempt++) {
        const candidate = generateProceduralPuzzle(puzzleType);
        // Some generators (word_ladder, balance_scale, truth_or_lie) can
        // legitimately fail to find a valid combination on a given try —
        // that's a retry, not an error, same as a duplicate fingerprint.
        if (!candidate) { console.warn(`[PGEN] ${puzzleType} generator returned null (attempt ${attempt + 1}) — retrying.`); continue; }
        const fp = candidate.fingerprint;
        try {
          const existing = await dbGet(env,
            `puzzle?puzzle_fingerprint=eq.${encodeURIComponent(fp)}&select=id&limit=1`
          ).catch(() => null);
          if (existing?.length) {
            console.warn(`[PGEN] Duplicate fingerprint skipped (attempt ${attempt + 1}): ${fp}`);
            continue;
          }
        } catch {}
        chosen = candidate;
        chosenFingerprint = fp;
        console.log(`[PGEN] ${puzzleType} difficulty=${candidate.difficulty} → ${candidate.target_format}. Fingerprint OK: ${fp}`);
      }
      if (!chosen) throw new Error(`All generated ${puzzleType} puzzles were duplicates or invalid — will retry.`);
      puzzles = [chosen];
    } else {
      const llmResult = await generatePuzzlesWithLLM(
        env, puzzleType, difficulty, job.seed_hint, lang, recentFPs, recentTitles, recentTitlesGlobal
      );
      puzzles = llmResult.puzzles;
      model = llmResult.model;
      console.log(`[PGEN] LLM returned ${puzzles.length} candidate(s) (model=${model})`);

      // ── 2. Validate + normalise (may fix correct/options for some types) ──
      const valid = [];
      for (const p of puzzles) {
        const res = validatePuzzle(puzzleType, p);
        if (res.ok) valid.push(p);
        else console.warn(`[PGEN] REJECT: ${res.reason}`);
      }
      if (!valid.length) throw new Error('No valid puzzle survived validation.');

      // ── 2b. Build fingerprint + check for duplicates (Layers 1 & 2) ──────
      for (const candidate of valid) {
        const fp = buildFingerprint(puzzleType, candidate);
        // Layer 2: pre-insert DB check
        try {
          const existing = await dbGet(env,
            `puzzle?puzzle_fingerprint=eq.${encodeURIComponent(fp)}&select=id&limit=1`
          ).catch(() => null);
          if (existing?.length) {
            console.warn(`[PGEN] Duplicate fingerprint skipped: ${fp}`);
            continue;
          }
        } catch {}
        chosen = candidate;
        chosenFingerprint = fp;
        console.log(`[PGEN] Fingerprint OK: ${fp}`);
        break;
      }
      if (!chosen) throw new Error('All validated puzzles are duplicates — will retry with new LLM call.');
    }

    // ── 2c. Title collision guard (soft check — never blocks the insert) ──
    // True for 'geometry' and any of the 13 PROCEDURAL_TYPES — reused below
    // wherever generation-side behavior needs to branch (row difficulty/
    // thinking_time_sec, format fan-out, job payload logging).
    const isProcedural = puzzleType === 'geometry' || PROCEDURAL_TYPES.includes(puzzleType);
    // Checked against BOTH the per-type and cross-type recent-title pools.
    const allRecentTitles = [...recentTitles, ...recentTitlesGlobal];
    if (chosen.youtube_title && allRecentTitles.some(t => titlesTooSimilar(t, chosen.youtube_title))) {
      console.warn(`[PGEN] Title too similar to a recent one — appending variant tag: "${chosen.youtube_title}"`);
      chosen.youtube_title = `${chosen.youtube_title} (#${Math.floor(100 + Math.random() * 900)})`;
    }

    // ── 3. Load reused audio + design pools (ONE batch, like worker8) ─────
    const pools = await loadAllPools(env, lang, niche);
    const poolWarnings = reportEmptyPools(pools);

    // ── 4. Numbering ──────────────────────────────────────────────────────
    const now = new Date();
    const yy = String(now.getUTCFullYear()).slice(-2);
    const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(now.getUTCDate()).padStart(2, '0');
    const datePrefix = `${yy}${mm}${dd}`;
    let todayCount = 0;
    try {
      const rows = await dbGet(env, `puzzle?created_at=gte.${now.getUTCFullYear()}-${mm}-${dd}T00%3A00%3A00Z&select=id`).catch(() => null);
      todayCount = rows?.length || 0;
    } catch {}
    const serial = String(todayCount + 1).padStart(4, '0');
    const quizNo = Number(`${datePrefix}${serial}`);

    let typeCount = 0;
    try {
      const rows = await dbGet(env, `puzzle?puzzle_type=eq.${encodeURIComponent(puzzleType)}&select=id&limit=5000`).catch(() => null);
      typeCount = rows?.length || 0;
    } catch {}
    const nicheChallengeNo = typeCount + 1;

    // ── 5. Pick audio cues + design ───────────────────────────────────────
    const hook      = randomPick(pools.hooks);
    const timeup    = randomPick(pools.timeup);
    const cta1      = randomPick(pools.cta1);
    const cta2      = randomPick(pools.cta2);
    const cta3      = randomPick(pools.cta3);
    const cta4      = randomPick(pools.cta4);
    const qIntro    = randomPick(pools.qIntro);
    const optsIntro = randomPick(pools.optsIntro);
    const sfxQApp   = randomPick(pools.sfxQuestionAppear);
    const sfxOApp   = randomPick(pools.sfxOptionsAppear);
    const sfxCdown  = randomPick(pools.sfxCountdownLoop);
    const sfxCorrect= randomPick(pools.sfxCorrectAnswer);
    const bgMusic   = randomPick(pools.bgMusic);
    const bgAnim    = randomPick(pools.bgAnim);
    const bgImage   = randomPick(pools.bgImage);

    const displayName = job.payload?.display_name || puzzleType;
    const baseSlug = makeSlug(`${puzzleType}-${quizNo}`);

    // Accent colours (drive the SVG puzzle too, via puzzle_spec-independent cols)
    const accents = pickAccents();

    // ── 6. Build the puzzle row ───────────────────────────────────────────
    const row = {
      topic: `${displayName} #${nicheChallengeNo}`,
      topic_slug: baseSlug,
      niche, lang_code: lang, country_code: job.country_code || 'US',
      channel_name: channelName,
      is_active: true, puzzle_enriched: true,
      is_human_approved: false, video_status: 'pending',
      created_at: now.toISOString(), updated_at: now.toISOString(),

      // format columns — set below (open to all formats, no RPC/assignment)
      assigned_format: null, short_status: null, medium_status: null, long_status: null,
      is_rendered: false, // cross-format lock — flips true when ANY format claims this row

      // ⭐ puzzle-specific
      puzzle_type: puzzleType,
      puzzle_spec: chosen.spec,          // jsonb — plain object (NOT stringified)
      puzzle_svg: null,                  // render worker fills this in
      puzzle_fingerprint: chosenFingerprint, // uniqueness key (unique index in DB)
      // 'geometry' and PROCEDURAL_TYPES rows use their own quick/medium/hard
      // tier (drives target_format below) instead of the job's generic
      // difficulty.
      difficulty: isProcedural ? chosen.difficulty : difficulty,

      quiz_no: quizNo,
      niche_challenge_no: nicheChallengeNo,
      youtube_title: (chosen.youtube_title || '').trim() || `Can You Solve This ${displayName}?`,
      // Procedural rows carry their own tier-specific countdown (5/8/12s);
      // everything else keeps the old flat 10s default.
      thinking_time_sec: isProcedural ? chosen.thinking_time_sec : 10,
      question_appearance_text: 'Here Is Your Challenge — Solve It',
      quiz_intro_speech: buildIntroSpeech(displayName),

      // the puzzle prompt + answers
      question_1: chosen.question,
      options_1: chosen.options.slice(0, 4),
      correct_answer_1: chosen.correct,
      explanation_1: chosen.explanation || '',
      hint_1: chosen.hint || '',
      keep_5050_1: normaliseKeep5050(chosen.keep_5050, chosen.options, chosen.correct),

      // audio (reused pools)
      hook_phrase: hook?.hook_text || null,
      hook_audio_url: hook?.audio_url || null,
      timeup_text: timeup?.lead_in_text || null,
      timeup_audio_url: timeup?.audio_url || null,
      question_intro_audio_url: qIntro?.audio_url || null,
      options_intro_audio_url: optsIntro?.audio_url || null,
      sfx_audio_url: buildSfxJson({
        question_appear: sfxQApp?.audio_url || null,
        options_appear:  sfxOApp?.audio_url || null,
        countdown_loop:  sfxCdown?.audio_url || null,
      }),
      countdown_music: sfxCdown?.audio_url || null,
      correct_answer_sfx_audio_url: sfxCorrect?.audio_url || null,
      background_music: bgMusic?.audio_url || null,
      cta1_description_text: cta1?.cta_text || null,
      cta1_audio_url: cta1?.audio_url || null,
      cta2_text: cta2?.cta_text || null,
      cta2_audio_url: cta2?.audio_url || null,
      cta3_text: cta3?.cta_text || null,
      cta3_audio_url: cta3?.audio_url || null,
      cta4_text: cta4?.cue_text || 'Write your answer in the comments below!',
      cta4_audio_url: cta4?.audio_url || null,

      blog_page_url: `jaasblog.online/quiz/${niche}`,
      blog_slug: baseSlug,

      // Varied visual themes (reverted to colourful backgrounds like trending).
      // The render worker guarantees readable white text on top regardless.
      visual_theme_id: randomPick(['glass','gaming','luxury','cyberpunk','minimal','comic','space','news','neon','retro']),
      layout_variant:  randomPick(['standard','bold','compact','cinematic','split','card','overlay','spotlight']),
      countdown_style: randomPick(['ring','bar','digital','bomb','hourglass','pulse']),
      transition_style:randomPick(['fade','slide_up','zoom_in','flip','blur_in','bounce']),
      theme_accent_primary:   accents[0],
      theme_accent_secondary: accents[1],
      theme_accent_tertiary:  accents[2],
      quiz_background_css: bgAnim?.background_css || null,
      // Curated R2 image pool — rendered at 30% opacity behind every screen
      // (see puzzle_template.html's .topic-photo-overlay, re-enabled in the
      // render workers to read this column).
      puzzle_background_image_url: bgImage?.image_url || null,

      llm_provider: 'vercel-ai-gateway',
      llm_model: model,
    };

    // ── 7. Format assignment + insert ───────────────────────────────────
    // Default (non-geometry) behavior: open to ALL formats, first claim
    // wins. No assign_puzzle_format RPC, no puzzle_format_config read.
    // Each format worker claims independently via its own status column, so
    // the same puzzle can end up rendered in more than one format depending
    // on which format workers happen to run.
    //
    // 'geometry' rows use a deliberate FAN-OUT matrix instead — the same
    // puzzle is meant to become MULTIPLE videos across specific formats,
    // not a race with one winner:
    //   quick  → ALL FIVE:  micro + short-nointro + short + medium + long
    //   medium → FOUR:      short-nointro + short + medium + long (no micro)
    //   hard   → ONE:       long only (needs the full 42s/12s-countdown slot)
    // `fanout_enabled: true` is what makes this actually work — see
    // puzzleAssigner.js / puzzle_render_long.js / puzzle_render_micro.js's
    // poll queries: it stops `is_rendered` (normally a cross-format
    // exclusivity lock) from hiding this row from formats it's still
    // pending in, once a different format has already claimed it.
    // micro_status is set to the literal 'skipped_micro' (never left null)
    // for medium/hard rows — puzzle_render_micro.js treats a NULL
    // micro_status as "eligible", so null would accidentally let micro grab
    // rows we explicitly don't want it to.
    const GEOMETRY_FANOUT = {
      quick:  { micro: true,  short_nointro: true,  short: true,  medium: true,  long: true  },
      medium: { micro: false, short_nointro: true,  short: true,  medium: true,  long: true  },
      hard:   { micro: false, short_nointro: false, short: false, medium: false, long: true  },
    };

    if (isProcedural) {
      const fanout = GEOMETRY_FANOUT[chosen.difficulty] || GEOMETRY_FANOUT.medium;
      row.assigned_format = Object.entries(fanout).filter(([, on]) => on).map(([f]) => f).join('+');
      row.fanout_enabled       = true;
      row.micro_status         = fanout.micro         ? 'pending_micro'         : 'skipped_micro';
      row.short_nointro_status = fanout.short_nointro  ? 'pending_short_nointro' : null;
      row.short_status         = fanout.short          ? 'pending_short'         : null;
      row.medium_status        = fanout.medium         ? 'pending_medium'        : null;
      row.long_status          = fanout.long           ? 'pending_long'          : null;
    } else {
      row.assigned_format = null;
      row.fanout_enabled  = false;
      // Non-procedural (LLM) rows never touch micro_status/short_nointro_status —
      // leaving them null preserves today's behavior for those remaining
      // LLM-driven types (micro's NULL-is-eligible poll still picks these up
      // exactly as before; short-nointro simply never runs for them unless
      // you choose to route some of them through this fan-out later).
      row.short_status  = 'pending_short';
      row.medium_status = 'pending_medium';
      row.long_status   = 'pending_long';
    }

    const ins = await dbInsert(env, 'puzzle', row);
    const puzzleId = ins?.[0]?.id || null;
    console.log(`[PGEN] Inserted puzzle ${puzzleId} slug=${baseSlug} — ` +
      (isProcedural ? `fanned out to [${row.assigned_format}] (difficulty=${chosen.difficulty})` : 'open to short/medium/long'));

    // ── 8. Bump audio usage counts (only tables WITH last_used_at) ────────
    await bumpUsage(env, {
      quiz_hooks: hook, timeup_cues: timeup, cta1_audio_cues: cta1,
      cta2_audio_cues: cta2, cta3_audio_cues: cta3,
      question_intro_cues: qIntro, options_intro_cues: optsIntro,
      puzzle_background_images: bgImage,
    });

    // ── 9. Mark job complete ──────────────────────────────────────────────
    await dbPatch(env, 'puzzle_queue', job.id, {
      status: 'completed', completed_at: new Date().toISOString(), quiz_id: puzzleId,
      payload: {
        ...(job.payload || {}), puzzle_id: puzzleId, slug: baseSlug,
        format: isProcedural ? chosen.target_format : 'open_all',
        ...(poolWarnings.length ? { pool_warnings: poolWarnings } : {}),
      }
    });

    // ── 10. Fire the render workflow ──────────────────────────────────────
    await fireRenderDispatch(env);

    console.log(`[PGEN] Job ${job.id} done.`);
  } catch (err) {
    console.error(`[PGEN] Job ${job.id} FAILED: ${err.message}`);
    await failJob(env, job, err.message);
  }
}

async function failJob(env, job, message) {
  const newRetry = (job.retry_count || 0) + 1;
  const maxRetries = job.max_retries || 3;
  const backoff = Math.min(5 * Math.pow(2, newRetry), 360);
  const nextRetryAt = newRetry < maxRetries ? new Date(Date.now() + backoff * 60000).toISOString() : null;
  await dbPatch(env, 'puzzle_queue', job.id, {
    status: 'failed', last_error: String(message).slice(0, 700),
    retry_count: newRetry, next_retry_at: nextRetryAt, started_at: null,
  }).catch(() => {});
}

// ════════════════════════════════════════════════════════════════════════════
// TITLE SIMILARITY (cheap, dependency-free — no external NLP needed)
// ════════════════════════════════════════════════════════════════════════════
// Normalises a title to its "shape": lowercase, strip punctuation/numbers,
// drop common filler words, sort remaining tokens. Two titles with the same
// shape are considered near-duplicates even if word order/casing differs.
const TITLE_STOPWORDS = new Set([
  'the','a','an','this','can','you','your','is','are','it','to','for','of','in',
  'on','solve','crack','find','only','most','people','get','wrong','right','1','one'
]);
function titleShape(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w && !TITLE_STOPWORDS.has(w))
    .sort()
    .join(' ');
}
function titlesTooSimilar(a, b) {
  const sa = titleShape(a), sb = titleShape(b);
  if (!sa || !sb) return false;
  return sa === sb;
}

// ════════════════════════════════════════════════════════════════════════════
// LLM
// ════════════════════════════════════════════════════════════════════════════
async function generatePuzzlesWithLLM(env, puzzleType, difficulty, seedHint, lang, recentFPs = [], recentTitles = [], recentTitlesGlobal = []) {
  // Reuse the SAME working LLM credentials the trending pipeline uses.
  let config = null;
  try {
    const rows = await dbGet(env, 'quiz_generation_settings?id=eq.1&limit=1');
    if (rows?.length) config = rows[0];
  } catch (e) { console.error('[PGEN] load settings:', e.message); }
  if (!config) throw new Error('quiz_generation_settings row not found');

  const apiKey   = config.llm_api_key;
  const model    = config.llm_model;
  const endpoint = config.llm_api_endpoint || 'https://ai-gateway.vercel.sh/v1/chat/completions';
  const temperature = Number(config.temperature) || 0.7;
  const maxTokens   = Number(config.max_tokens) || 2600;
  if (!apiKey || !model) throw new Error('llm_api_key / llm_model empty in quiz_generation_settings');

  const prompt = buildPrompt(puzzleType, difficulty, seedHint, recentFPs, recentTitles, recentTitlesGlobal);

  const MODELS = [{ model, endpoint, apiKey }];
  if (config.fallback_llm_model && config.fallback_llm_provider !== 'none' && config.fallback_llm_api_key) {
    MODELS.push({ model: config.fallback_llm_model, endpoint: config.fallback_llm_api_endpoint || endpoint, apiKey: config.fallback_llm_api_key });
  }

  let lastErr;
  for (let attempt = 0; attempt < MODELS.length; attempt++) {
    const { model: m, endpoint: ep, apiKey: key } = MODELS[attempt];
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, messages: [{ role: 'user', content: prompt }], temperature, max_tokens: maxTokens })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || `LLM HTTP ${res.status}`);
      const raw = data.choices?.[0]?.message?.content || '';
      const parsed = parseJsonArray(raw);
      if (!parsed?.length) throw new Error('Empty/invalid JSON from LLM');
      return { puzzles: parsed, model: m };
    } catch (e) {
      lastErr = e; console.warn(`[PGEN] LLM attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt < MODELS.length - 1) await sleep(1500);
    }
  }
  throw new Error(`All LLM attempts failed. Last: ${lastErr?.message}`);
}

// ── Shared viral philosophy (mirrors worker8's tricky-not-hard rules) ────────
const PHILOSOPHY = `
You write puzzles for a viral short-form video channel (YouTube Shorts / Reels).
Each puzzle flashes on screen for ~10 seconds. It MUST be:
  • SELF-CONTAINED — a stranger understands it from the visual + prompt alone.
  • TRICKY, NOT HARD — most viewers THINK they can solve it, then hesitate.
    If an average person would say "I have no idea" → too hard, rewrite.
    If they'd say "obviously X" → too easy, rewrite. Aim for "wait... let me think".
  • VIRAL — the kind of puzzle people TAG a friend on or argue about in comments.
Options: exactly 4, all plausible, with at least one "obvious trap" (feels right,
is wrong). The correct answer must NOT be the most obvious-looking option.
prompt/question: <= 15 words, ends with "?", instantly readable.
hint: 2-10 words, teases without revealing.
explanation: > 15 words, a satisfying standalone reason the answer is correct.
youtube_title: 5-12 words with a curiosity hook (e.g. "99% Get This Wrong!").
  VARY THE STRUCTURE every time — do not always open with "Can You Solve/Find/Crack".
  Rotate between question-hooks, stat-hooks ("99% fail"), challenge-hooks
  ("Only a genius spots this"), and direct-claim hooks ("This breaks most brains").
keep_5050: [correctIndex, mostPlausibleWrongIndex] (two indexes 0-3).
`;

function buildPrompt(type, difficulty, seedHint, recentFPs = [], recentTitles = [], recentTitlesGlobal = []) {
  const block = TYPE_PROMPTS[type](difficulty, seedHint || '');
  const avoidBlock = recentFPs.length
    ? `\nAVOID DUPLICATES — do NOT generate any puzzle matching these already used:\n${recentFPs.join('\n')}\nGenerate something genuinely different from ALL of the above.\n`
    : '';
  const titleAvoidBlock = recentTitles.length
    ? `\nTITLE VARIETY — the last ${recentTitles.length} titles used for this puzzle type were:\n${recentTitles.map(t => `- ${t}`).join('\n')}\nYour "youtube_title" MUST use a DIFFERENT opening phrase and different sentence` +
      ` structure than every title above. Do not just swap a synonym — change the hook TYPE` +
      ` (e.g. if recent titles were all "Can You Solve...?" questions, write a stat-hook or` +
      ` direct-claim hook instead).\n`
    : '';
  const titleGlobalBlock = recentTitlesGlobal.length
    ? `\nCHANNEL-WIDE TITLE VARIETY — regardless of puzzle type, these titles were just` +
      ` used on this channel:\n${recentTitlesGlobal.slice(0, 15).map(t => `- ${t}`).join('\n')}\nAvoid repeating` +
      ` the same phrasing/hook-type as these too, even if they were a different puzzle type.\n`
    : '';
  return `You are a world-class visual puzzle designer.
${PHILOSOPHY}
DIFFICULTY: ${difficulty}
${seedHint ? `THEME NUDGE: ${seedHint}\n` : ''}${avoidBlock}${titleAvoidBlock}${titleGlobalBlock}
PUZZLE TYPE: ${type}
${block}

OUTPUT — ONLY a valid JSON array with 1 or 2 puzzle objects, no markdown, no preamble.
Each object MUST have exactly these keys:
  "title", "spec", "question", "options", "correct", "hint", "explanation", "keep_5050", "youtube_title"
"spec" must EXACTLY match the schema shown above for this type.
"correct" must be an EXACT string from "options".`;
}

// Per-type prompt blocks. Each documents the EXACT spec schema puzzleRenderers.js
// expects, plus a worked example, so the LLM fills the visual correctly.
const TYPE_PROMPTS = {
  matchstick: (d) => `
Design a matchstick equation puzzle. Show a WRONG equation made of matchsticks;
the viewer must move ONE matchstick to make it true.
spec schema:  { "equation": "6+4=4", "instruction": "Move 1 matchstick to make it true", "title": "Matchstick Move" }
  - equation: 3-7 characters using digits 0-9 and the symbols + - =  (NO spaces).
  - It must be currently FALSE but fixable by moving exactly ONE stick.
options: 4 candidate CORRECTED equations (strings), only ONE is actually reachable
  by moving a single matchstick. correct = that one.
Example question: "Move ONE matchstick to make the equation true — which works?"`,

  visual_math: (d) => `
Design an emoji/icon algebra puzzle (the classic "fruit math" viral format).
Use ONLY these icon names: apple, banana, cherry, grape, star, heart, lemon, orange.
spec schema: { "equations": [
    { "items":[{"icon":"apple","count":3}], "result":"30" },
    { "items":[{"icon":"apple","count":1},{"icon":"banana","count":2}], "result":"18" },
    { "items":[{"icon":"banana","count":1},{"icon":"apple","count":1}], "result":"?" }
  ], "title": "Solve the Puzzle" }
  - 2 to 3 rows. Use at most 2 distinct icons. count is 1-3 per item.
  - The first row(s) must let a solver deduce each icon's integer value.
  - The LAST row's result MUST be "?" — that is what the viewer solves.
  - Verify your arithmetic: the "?" value must be an integer.
options: 4 numbers (as strings). correct = the true value of the "?" row.`,

  geometry_triangle: (d) => `
Design a "find the missing angle in a triangle" puzzle. Angles sum to 180.
spec schema: { "labels":[
    {"at":"A","text":"x","highlight":true},
    {"at":"B","text":"55°"},
    {"at":"C","text":"65°"} ], "title":"Find the Angle" }
  - Exactly ONE label is the unknown (text "x", highlight true). The other two are
    numeric angles ending in "°". All three must sum to 180.
options: 4 angle values like "55°","60°","65°","70°" — all plausible, close together.
correct = the true missing angle (180 - the two known angles), formatted like "60°".`,

  geometry_right_triangle: (d) => `
Design a right-triangle "find the missing side" puzzle (Pythagoras).
STRONGLY prefer Pythagorean triples: 3-4-5, 6-8-10, 5-12-13, 8-15-17, 9-12-15, 7-24-25.
spec schema: { "leg_a":"6", "leg_b":"8", "hypotenuse":"?", "unknown":"hypotenuse", "title":"Missing Side" }
  - Two sides numeric, one is "?" and "unknown" names which ("leg_a"|"leg_b"|"hypotenuse").
  - Values must satisfy leg_a² + leg_b² = hypotenuse².
options: 4 numbers (strings). correct = the true missing side length.`,

  geometry_straight_line: (d) => `
Design an "angles on a straight line" puzzle (they sum to 180).
spec schema: { "known_angle":"125°", "unknown_glyph":"x", "title":"Find x" }
options: 4 angle values (strings ending "°"). correct = 180 - known_angle, like "55°".`,

  number_sequence: (d) => `
Design a "what number comes next" sequence puzzle with a clear single rule
(arithmetic, geometric, squares, +1/+2/+3..., Fibonacci-like, etc.).
spec schema: { "cells":["3","6","11","18","?"], "title":"What comes next?" }
  - 4 to 6 cells, the LAST cell MUST be "?".
options: 4 numbers (strings). correct = the next number by the rule.
explanation MUST state the rule (e.g. "differences grow by 1 each step").`,

  number_grid: (d) => `
Design a 3x3 number-grid puzzle where one cell is "?" and a rule links the numbers
(row sums, column sums, row/column products, etc — PREFER row-sum, column-sum, or
row-product rules specifically, since those are automatically verified downstream).
spec schema: { "rows":[["8","3","5"],["4","2","6"],["?","5","1"]], "title":"Missing Number" }
  - Exactly ONE cell is "?".
options: 4 numbers (strings). correct = the value that satisfies the rule.
explanation MUST state the rule clearly (e.g. "each row sums to 16").`,

  odd_one_out: (d) => `
Design a HARD "spot the odd one out" grid where the difference is SUBTLE.
The viewer must look carefully — a 3-year-old should NOT be able to solve it instantly.

DIFFICULTY RULES — you MUST use ONE of these subtle techniques:
1. SAME SHAPE, DIFFERENT COLOR: all items have the same shape, but one item's "color"
   (hex) is slightly different. E.g. 15 circles are #E67E22 (orange) and one is #E74C3C (red).
   The colors must LOOK similar at a glance but be detectably different on close inspection.
2. ROTATION TRICK (future): all same shape, but one faces a different direction.
   (Not supported in current renderer — use technique 1 or 3.)
3. MIXED SHAPE + SUBTLE COLOR: mostly same shape but the odd one uses a VERY SIMILAR
   shape (triangle vs arrow, circle vs oval) AND a slightly different color.

FORBIDDEN (too easy — 3-year-olds can solve these):
  - Blue square among orange triangles → TOO OBVIOUS
  - Red heart among blue circles → TOO OBVIOUS
  - Star among circles → TOO OBVIOUS
  Any case where shape AND color are both completely different → REJECTED

USE TECHNIQUE 1 (same shape, subtly different color) for maximum challenge:
  Example: 15 pentagons color "#3498DB" (blue) + 1 pentagon color "#2980B9" (darker blue)
  Example: 15 circles color "#E67E22" + 1 circle color "#D35400" (slightly darker orange)
  Example: 15 stars color "#F1C40F" + 1 star color "#F39C12" (slightly darker yellow)

spec schema: { "cols":4, "items":[ {"shape":"circle","color":"#E67E22"}, ... (16 items) ...,
  {"shape":"circle","color":"#D35400"} (exactly ONE has the subtly different color) ],
  "title":"Spot the Odd One" }
  - cols is 4, provide EXACTLY 16 items — no more, no fewer (the 4x4 grid renderer
    requires exactly 16; a wrong count will now be rejected before insert).
  - ALL items MUST have a "color" property (hex string).
  - Exactly ONE item has a subtly different color (but same shape as majority).
  - The color difference must be noticeable on close inspection but not glaringly obvious.

options: 4 cell NUMBERS (1-16 as strings) including the real odd position.
correct = the 1-based index of the odd item. (The system will re-verify this.)`,

  rebus: (d) => `
Design a rebus / word puzzle where stacked or combined word-tokens spell a phrase.
spec schema: { "tokens":["SEA","+","SUN"], "title":"Guess the Phrase" }
  - tokens: 2-4 short UPPERCASE word tokens, optionally joined by "+".
options: 4 candidate phrases (strings). correct = the intended phrase.
Keep it fun and genuinely guessable — the correct phrase should be a real word or
common phrase (1-6 words), not just the tokens glued together verbatim.`,

  detective: (d) => `
Design a bite-size whodunit "case file". Short, solvable purely from the clues.
spec schema: {
  "case_title":"The Vanishing Ruby",
  "scenario":"One-sentence setup of what was stolen / happened.",
  "clues":["clue 1","clue 2","clue 3","clue 4"],   (3-4 short clues)
  "suspects":["The Butler","The Maid","The Guest","The Cook"]  (EXACTLY 4)
}
  - The clues must logically point to exactly ONE suspect (fair-play deduction).
  - AT LEAST ONE clue must explicitly mention or clearly describe the guilty
    suspect by name/role — a solver (and the automated checker) must be able to
    connect the clues to the culprit using the text alone, not outside knowledge.
options: MUST equal the 4 suspects, in the same order.
correct = the guilty suspect (one of the suspects). 
question: "Whodunit? Who is the culprit?"  hint: a nudge toward the deduction.
explanation: name the culprit and the clue chain that proves it.`,

  // ── Buyer-pipeline types ────────────────────────────────────────────────
  word_ladder: (d) => `
Design a word-ladder puzzle. Each word changes exactly ONE letter from the word
before it, all words the SAME length, ending on a literal "?" placeholder for the
word the viewer must find (the next rung in the ladder).
spec schema: { "words":["COLD","CORD","WORD","WARD","?"], "title":"Word Ladder" }
  - 3 to 4 known words (UPPERCASE, same length, 3-5 letters), each a real common
    word, each differing from the previous by EXACTLY one letter in one position.
  - The array's LAST element MUST be the single character "?" (not a full-length
    placeholder) — it stands in for the next rung.
options: 4 candidate next-words (same length as the ladder words, UPPERCASE).
correct = a REAL common word that differs from the LAST known word by exactly
one letter in exactly one position.
question: "What's the next word in the ladder?"`,

  pattern_matrix: (d) => `
Design a 3x3 "what shape completes the pattern" matrix — a Latin-square style
IQ-test grid: EVERY row and EVERY column must contain each of the 3 shapes used
exactly once (so the missing cell is always logically forced, never a guess).
Use ONLY these shape names: circle, square, triangle, star, heart.
spec schema: { "grid":[["circle","square","triangle"],["square","triangle","circle"],
  ["triangle","circle","?"]], "title":"What comes next?" }
  - Exactly 3 distinct shapes total, arranged so each appears once per row AND
    once per column (a 3x3 Latin square). Exactly ONE cell is "?".
options: 4 shape names. correct = the one shape name that completes both that
row and that column without repeating.`,

  visual_pattern_sequence: (d) => `
Design a left-to-right shape sequence with a clear VISUAL progression a viewer
can spot (e.g. cycling through a repeating pattern of shapes, or a shape that
grows a side each step). Use ONLY these shape names: circle, square, triangle,
star, heart (these are the only ones the renderer draws correctly).
spec schema: { "steps":[{"shape":"circle"},{"shape":"square"},{"shape":"triangle"},
  {"shape":"circle"},{"shape":"?"}], "title":"What comes next?" }
  - 4 to 6 steps, the LAST step's shape MUST be the string "?".
  - Make the repeating/progressing rule genuinely followable from the image alone
    (e.g. a 3-shape cycle repeated) since there is no numeric formula to check it.
options: 4 shape names. correct = the shape that continues YOUR stated pattern.
explanation MUST clearly state the visual rule (e.g. "shapes cycle in a
circle-square-triangle repeat").`,

  balance_scale: (d) => `
Design a balance-scale puzzle. The LEFT pan holds only ONE icon type (so its
per-icon value is directly computable from left_total); the RIGHT pan holds
that SAME icon (zero or more) PLUS exactly one "?" slot — the scale is drawn
already balanced, so the right pan's total must equal left_total.
Use ONLY these icon names: apple, banana, cherry, grape, star, heart, lemon, orange.
spec schema: { "left_items":[{"icon":"apple","count":3}], "left_total":"9",
  "right_items":[{"icon":"apple","count":1},{"icon":"?","count":1}],
  "title":"Balance the Scale" }
  - left_items: exactly ONE icon type, any count 1-4. left_total: its total value
    (a multiple of count so the per-icon value is a whole number).
  - right_items: zero or more items using the SAME icon as left_items, PLUS
    exactly one item with icon "?" and a count (usually 1).
options: 4 numbers (strings). correct = the numeric value that slots into "?"
so the right pan's total equals left_total (the scale is already level).`,

  cipher_decode: (d) => `
Design a numeric-cipher puzzle that decodes to a short common English word.
key_type "a1z26": each number is that letter's alphabet position (A=1 … Z=26).
key_type "shift": each number is the alphabet position AFTER shifting the real
  letter forward by "shift" places (Caesar cipher), e.g. shift 3: A→D(4), B→E(5).
spec schema: { "word":"MATH", "encoded":[13,1,20,8], "key_type":"a1z26", "shift":0,
  "hidden_index":2, "title":"Crack the Code" }
  - word: a real common UPPERCASE English word, 3-6 letters, NOT shown to the
    viewer directly — it's only used to build "encoded" and validate the answer.
  - encoded: one number per letter of "word", computed via key_type (+shift for
    "shift" type; use shift 0 and omit real shifting for "a1z26" type).
  - hidden_index: 0-based position in "encoded"/"word" that is masked as "?" on
    screen (viewer sees the OTHER decoded-looking numbers and must infer the
    hidden LETTER from the partially-decoded word pattern).
options: 4 single UPPERCASE letters. correct = word[hidden_index] (one letter).
question: "What's the missing letter once you decode it?"`,

  flag_puzzle: (d) => `
Design a "guess the country from its flag" puzzle, with one stripe/band hidden.
spec schema: { "stripes":["#002868","#BF0A30","#ffffff"], "symbol":null,
  "hidden_stripe_index":1, "title":"Which Country?" }
  - stripes: 2-5 hex colors representing the REAL flag's horizontal/vertical
    bands top-to-bottom (or left-to-right), in the actual order of a real
    country's flag. hidden_stripe_index: which band (0-based) is masked as "?".
  - symbol (optional): a single emoji/unicode glyph shown center-flag if the
    real flag has a distinctive central emblem; else null.
options: 4 country names, all real countries with visually-similar flag styles.
correct = the actual country the (unmasked) flag belongs to.
question: "Which country's flag is this?"`,

  area_perimeter: (d) => `
Design an L-shaped "find the area or perimeter" geometry puzzle. The shape is a
rectangle (outer_w × outer_h) with a rectangular notch cut from its TOP-RIGHT
corner of width (outer_w - cut_w) and height cut_h — i.e. a step/L outline.
spec schema: { "outer_w":8, "outer_h":6, "cut_w":3, "cut_h":3, "unknown":"area",
  "title":"Find the Area" }
  - All four values are positive integers (units, e.g. cm), with 0 < cut_w <
    outer_w and 0 < cut_h < outer_h so the notch is a real partial cut.
  - unknown: "area" or "perimeter".
options: 4 numbers (strings, whole numbers work best).
correct = for "area": outer_w*outer_h - (outer_w-cut_w)*cut_h.
          for "perimeter": 2*(outer_w+outer_h) — this L-cut never changes the
          total perimeter versus the bounding rectangle, which is exactly why
          it's a good "wait, really?" viral puzzle.`,

  dominoes: (d) => `
Design a domino chain puzzle. Each tile is [top,bottom] (0-6 pips each). The
chain rule: the BOTTOM of every tile must equal the TOP of the next tile
("touching halves match"). Exactly one pip value across the whole chain is "?"
and it MUST be directly inferable from ONE adjacent known value via that rule
(so it must be an interior top or interior bottom — never the very first tile's
top or the very last tile's bottom, since those have no neighbor to check against).
spec schema: { "chain":[[3,5],[5,2],[2,4],[4,6]], "title":"Complete the Chain" }
  - 4 to 6 tiles. Replace exactly ONE pip value (interior top or interior bottom,
    per the rule above) with the string "?" before output — i.e. build a fully
    valid consistent chain first, then blank ONE eligible value.
options: 4 numbers 0-6 (as strings). correct = the true pip value at "?".`,

  clock_angle: (d) => `
Design a clock puzzle: either the ANGLE between the hour and minute hands, or
the TIME shown (question_type "time" just asks the viewer to read the clock).
spec schema: { "hour":3, "minute":30, "question_type":"angle", "title":"Clock Puzzle" }
  - hour: integer 1-12. minute: integer 0-59, in 5-minute steps for readability.
  - Prefer "angle" — it makes for a better puzzle than simply reading the time.
options: for "angle": 4 degree values as strings like "15°","75°","90°","105°".
  for "time": 4 time strings like "3:30","3:35","3:25","4:30".
correct = for "angle": the smaller angle between the hands, computed as
  min(|30*hour + 0.5*minute - 6*minute|, 360 - that), formatted like "105°".
  for "time": the literal "H:MM" shown.`,

  truth_or_lie: (d) => `
Design a bite-size knights-and-knaves logic puzzle: 3 people, each makes ONE
short statement (often about who is lying/telling the truth). Exactly ONE
person always tells the truth; the others are lying. The statements together
must let a careful reader deduce, by pure logic, exactly who the truth-teller is.
spec schema: { "people":[
    {"name":"Alice","statement":"Bob is lying.","gender":"f"},
    {"name":"Bob","statement":"I always tell the truth.","gender":"m"},
    {"name":"Carol","statement":"Alice tells the truth.","gender":"f"} ],
  "title":"Who Tells the Truth?" }
  - Exactly 3 people. gender is "f" or "m" (only affects the drawn figure).
  - Statements must be short (<=8 words) and reference people BY NAME so the
    logic chain is followable from text alone.
options: MUST equal the 3 people's names (as 3 options is fine — pad to 4 with
  a clearly-wrong 4th name only if needed, but prefer exactly the 3 real names
  plus one obviously-fictional distractor name).
correct = the one person whose statement is consistent with being the sole
truth-teller (i.e. assuming they alone tell the truth, no contradiction arises).
question: "Who is the ONE person telling the truth?"`,
};

// ════════════════════════════════════════════════════════════════════════════
// VALIDATION (+ authoritative fixes for odd_one_out / detective)
// ════════════════════════════════════════════════════════════════════════════
function wc(s) { return (s || '').trim().split(/\s+/).filter(Boolean).length; }
function num(s) { const m = String(s).match(/-?\d+(\.\d+)?/); return m ? parseFloat(m[0]) : NaN; }

function validatePuzzle(type, p) {
  // Common structural checks
  if (!p || typeof p !== 'object') return { ok: false, reason: 'not an object' };
  if (!p.spec || typeof p.spec !== 'object') return { ok: false, reason: 'missing spec' };
  if (!p.question || !String(p.question).trim().endsWith('?')) return { ok: false, reason: 'question missing/!? ' };
  if (!Array.isArray(p.options) || p.options.length < 4) return { ok: false, reason: 'need 4 options' };
  p.options = p.options.slice(0, 4).map(o => String(o));
  if (p.correct == null) return { ok: false, reason: 'missing correct' };
  p.correct = String(p.correct);

  // For most types correct must be in options (detective/odd handled below first)
  const ensureCorrectInOptions = () => {
    const idx = p.options.findIndex(o => o.trim().toLowerCase() === p.correct.trim().toLowerCase());
    if (idx === -1) return false;
    p.correct = p.options[idx];
    return true;
  };

  // hint / explanation soft rules
  if (p.hint && (wc(p.hint) < 2 || wc(p.hint) > 12)) return { ok: false, reason: `hint ${wc(p.hint)}w out of range` };
  if (!p.explanation || wc(p.explanation) <= 12) return { ok: false, reason: 'explanation too short' };
  if (wc(p.question) > 16) return { ok: false, reason: 'question too long' };

  // ── Type-specific ─────────────────────────────────────────────────────
  switch (type) {
    case 'geometry_triangle': {
      const labels = p.spec.labels;
      if (!Array.isArray(labels) || labels.length !== 3) return { ok: false, reason: 'triangle needs 3 labels' };
      const known = labels.filter(l => !l.highlight).map(l => num(l.text)).filter(n => !isNaN(n));
      if (known.length !== 2) return { ok: false, reason: 'triangle needs 2 numeric angles' };
      const missing = 180 - known[0] - known[1];
      if (missing <= 0 || missing >= 180) return { ok: false, reason: 'triangle angles invalid' };
      if (Math.abs(num(p.correct) - missing) > 0.5) return { ok: false, reason: `triangle correct≠${missing}` };
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'geometry_right_triangle': {
      const a = num(p.spec.leg_a), b = num(p.spec.leg_b), h = num(p.spec.hypotenuse);
      const unk = p.spec.unknown;
      let expect;
      if (unk === 'hypotenuse') expect = Math.sqrt(a * a + b * b);
      else if (unk === 'leg_a') expect = Math.sqrt(h * h - b * b);
      else if (unk === 'leg_b') expect = Math.sqrt(h * h - a * a);
      else return { ok: false, reason: 'unknown side not specified' };
      if (!isFinite(expect) || expect <= 0) return { ok: false, reason: 'right-triangle invalid' };
      if (Math.abs(num(p.correct) - expect) > 0.6) return { ok: false, reason: `right-triangle correct≠${expect.toFixed(2)}` };
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'geometry_straight_line': {
      const known = num(p.spec.known_angle);
      const expect = 180 - known;
      if (expect <= 0 || expect >= 180) return { ok: false, reason: 'straight-line invalid' };
      if (Math.abs(num(p.correct) - expect) > 0.5) return { ok: false, reason: `straight-line correct≠${expect}` };
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'visual_math': {
      const eqs = p.spec.equations;
      if (!Array.isArray(eqs) || eqs.length < 2) return { ok: false, reason: 'visual_math needs ≥2 rows' };
      const last = eqs[eqs.length - 1];
      if (String(last.result).trim() !== '?') return { ok: false, reason: 'last row must be "?"' };
      // best-effort solve: rows with a single distinct icon pin its value
      const val = {};
      for (const eq of eqs.slice(0, -1)) {
        const items = eq.items || [];
        const icons = [...new Set(items.map(it => it.icon))];
        if (icons.length === 1) {
          const totalCount = items.reduce((s, it) => s + (Number(it.count) || 0), 0);
          if (totalCount > 0) val[icons[0]] = num(eq.result) / totalCount;
        }
      }
      // try to evaluate "?" row if all icons known
      const lastItems = last.items || [];
      if (lastItems.every(it => val[it.icon] != null)) {
        const total = lastItems.reduce((s, it) => s + (Number(it.count) || 0) * val[it.icon], 0);
        if (Math.abs(num(p.correct) - total) > 0.01) return { ok: false, reason: `visual_math correct≠${total}` };
      }
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'number_sequence': {
      const cells = p.spec.cells;
      if (!Array.isArray(cells) || cells.length < 4) return { ok: false, reason: 'sequence needs ≥4 cells' };
      if (String(cells[cells.length - 1]).trim() !== '?') return { ok: false, reason: 'last cell must be "?"' };
      const nums = cells.slice(0, -1).map(num);
      if (nums.some(isNaN)) return { ok: false, reason: 'non-numeric sequence' };
      const predicted = predictNext(nums);
      if (predicted != null && Math.abs(num(p.correct) - predicted) > 0.01)
        return { ok: false, reason: `sequence correct≠${predicted}` };
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'number_grid': {
      const rows = p.spec.rows;
      if (!Array.isArray(rows) || !rows.length) return { ok: false, reason: 'grid missing rows' };
      const qCount = rows.flat().filter(v => String(v).trim() === '?').length;
      if (qCount !== 1) return { ok: false, reason: 'grid needs exactly one "?"' };
      // NEW: try to detect a row-sum / col-sum / row-product rule and verify it.
      // If a rule IS detectable and the LLM's "correct" contradicts it → hard
      // reject (previously nothing checked this at all). If no simple rule is
      // detectable, don't false-reject — just log it for visibility.
      const rule = detectGridRule(rows);
      if (rule) {
        if (Math.abs(num(p.correct) - rule.predicted) > 0.5) {
          return { ok: false, reason: `grid ${rule.ruleName} rule violated: expected ${rule.predicted}, got ${p.correct}` };
        }
      } else {
        console.warn('[PGEN] number_grid: no row-sum/col-sum/row-product rule detected — trusting LLM (best-effort, unverifiable rule type).');
      }
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'matchstick': {
      const eq = String(p.spec.equation || '').replace(/\s+/g, '');
      if (!/^[0-9+\-=]{3,7}$/.test(eq)) return { ok: false, reason: 'matchstick equation invalid format' };
      // NEW: actually solve it. Was previously only a format regex — nothing
      // confirmed the equation was false, or that any option was reachable by
      // moving exactly one stick.
      const check = solveMatchstickMove(eq);
      if (!check.parsedOk) return { ok: false, reason: 'matchstick equation could not be parsed as arithmetic' };
      if (!check.currentlyFalse) return { ok: false, reason: 'matchstick equation is already true — nothing to fix' };
      const reachableInOptions = p.options.filter(o => check.reachable.has(String(o).replace(/\s+/g, '')));
      if (!reachableInOptions.length) {
        return { ok: false, reason: 'matchstick: no option is reachable by moving exactly one stick' };
      }
      // Prefer the LLM's stated correct answer if it's actually reachable;
      // otherwise fall back to whichever reachable option we found.
      const normCorrect = p.correct.replace(/\s+/g, '');
      p.correct = reachableInOptions.find(o => o.replace(/\s+/g, '') === normCorrect) || reachableInOptions[0];
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'rebus': {
      if (!Array.isArray(p.spec.tokens) || p.spec.tokens.length < 2) return { ok: false, reason: 'rebus needs tokens' };
      // NEW: light sanity — a real phrase, not just tokens glued together, and
      // a sane word count for something readable on screen in ~10s.
      const cw = wc(p.correct);
      if (cw < 1 || cw > 6) return { ok: false, reason: `rebus phrase ${cw}w out of range` };
      const tokensJoined = p.spec.tokens.filter(t => t !== '+').join('').toLowerCase().replace(/\s+/g, '');
      const correctFlat = p.correct.toLowerCase().replace(/[^a-z]/g, '');
      if (tokensJoined && correctFlat && tokensJoined === correctFlat) {
        return { ok: false, reason: 'rebus answer is just the tokens glued together verbatim — not a real puzzle' };
      }
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'odd_one_out': {
      const items = p.spec.items;
      // NEW: enforce the EXACT shape puzzleRenderers.js's 4x4 grid expects.
      // Previously only ">=6" was checked, so an 8- or 12-item grid could
      // silently reach the renderer and misrender.
      if (!Array.isArray(items) || items.length !== 16) return { ok: false, reason: `odd_one_out needs exactly 16 items (got ${items?.length ?? 0})` };
      if (p.spec.cols != null && Number(p.spec.cols) !== 4) return { ok: false, reason: 'odd_one_out cols must be 4' };
      p.spec.cols = 4;
      // authoritatively determine the odd shape by majority vote
      const counts = {};
      items.forEach(it => { counts[it.shape] = (counts[it.shape] || 0) + 1; });
      const shapes = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (shapes.length < 2) return { ok: false, reason: 'no odd shape present' };
      const oddShape = shapes[shapes.length - 1][0];
      if (shapes[shapes.length - 1][1] !== 1) return { ok: false, reason: 'must be exactly one outlier' };
      const oddIdx = items.findIndex(it => it.shape === oddShape);
      // system OWNS correct + options here (removes LLM error)
      p.correct = String(oddIdx + 1);
      const opts = new Set([p.correct]);
      while (opts.size < 4) { const r = 1 + Math.floor(Math.random() * items.length); opts.add(String(r)); }
      p.options = [...opts].sort(() => Math.random() - 0.5).slice(0, 4);
      if (!p.options.includes(p.correct)) p.options[0] = p.correct;
      break;
    }
    case 'detective': {
      const s = p.spec;
      if (!s.case_title || !s.scenario || !Array.isArray(s.suspects) || s.suspects.length !== 4)
        return { ok: false, reason: 'detective needs title/scenario/4 suspects' };
      if (!Array.isArray(s.clues) || s.clues.length < 2) return { ok: false, reason: 'detective needs ≥2 clues' };
      // options MUST be the suspects; correct must be one of them
      p.options = s.suspects.map(String).slice(0, 4);
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'culprit not among suspects' };
      // NEW: the culprit must actually be referenced by the clue text — a
      // cheap but real guard against clues that describe someone else
      // entirely while "correct" points at an unrelated suspect.
      const culpritKeywords = String(p.correct).toLowerCase().replace(/^the\s+/, '').split(/\s+/).filter(w => w.length > 2);
      const clueText = s.clues.join(' ').toLowerCase();
      const supported = culpritKeywords.length === 0 || culpritKeywords.some(k => clueText.includes(k));
      if (!supported) return { ok: false, reason: 'detective: clues never reference the stated culprit' };
      break;
    }

    // ── Buyer-pipeline types ──────────────────────────────────────────────
    case 'word_ladder': {
      const words = p.spec.words;
      if (!Array.isArray(words) || words.length < 4) return { ok: false, reason: 'word_ladder needs ≥4 entries (≥3 known + "?")' };
      const last = String(words[words.length - 1] || '').trim();
      if (last !== '?') return { ok: false, reason: 'word_ladder last entry must be literal "?"' };
      const known = words.slice(0, -1).map(w => String(w || '').trim().toUpperCase());
      if (known.some(w => !/^[A-Z]+$/.test(w))) return { ok: false, reason: 'word_ladder words must be letters only' };
      const len = known[0].length;
      if (known.some(w => w.length !== len)) return { ok: false, reason: 'word_ladder words must all be the same length' };
      // each consecutive pair must differ by exactly one letter
      for (let i = 1; i < known.length; i++) {
        const diff = [...known[i]].filter((ch, j) => ch !== known[i - 1][j]).length;
        if (diff !== 1) return { ok: false, reason: `word_ladder step ${i} changes ${diff} letters, must be exactly 1` };
      }
      // correct must itself be one letter away from the last known word, same length
      const correctUp = p.correct.trim().toUpperCase();
      if (correctUp.length !== len) return { ok: false, reason: 'word_ladder correct answer wrong length' };
      const lastKnown = known[known.length - 1];
      const diffFromLast = [...correctUp].filter((ch, j) => ch !== lastKnown[j]).length;
      if (diffFromLast !== 1) return { ok: false, reason: 'word_ladder correct answer must differ from prior word by exactly one letter' };
      p.correct = correctUp;
      p.options = p.options.map(o => String(o).trim().toUpperCase());
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'pattern_matrix': {
      const grid = p.spec.grid;
      if (!Array.isArray(grid) || grid.length !== 3 || grid.some(r => !Array.isArray(r) || r.length !== 3))
        return { ok: false, reason: 'pattern_matrix needs a 3x3 grid' };
      const flat = grid.flat().map(v => String(v).trim().toLowerCase());
      const qCount = flat.filter(v => v === '?').length;
      if (qCount !== 1) return { ok: false, reason: 'pattern_matrix needs exactly one "?"' };
      let qr = -1, qc = -1;
      grid.forEach((row, r) => row.forEach((v, c) => { if (String(v).trim() === '?') { qr = r; qc = c; } }));
      // Latin-square check: the missing shape is whatever's absent from BOTH its row and column
      const rowVals = grid[qr].map(v => String(v).trim().toLowerCase()).filter(v => v !== '?');
      const colVals = grid.map(row => String(row[qc]).trim().toLowerCase()).filter(v => v !== '?');
      const allShapes = new Set(flat.filter(v => v !== '?'));
      const missingFromRow = [...allShapes].filter(s => !rowVals.includes(s));
      const missingFromCol = [...allShapes].filter(s => !colVals.includes(s));
      const candidates = missingFromRow.filter(s => missingFromCol.includes(s));
      if (candidates.length !== 1) {
        console.warn('[PGEN] pattern_matrix: grid is not a clean 3x3 Latin square — trusting LLM (best-effort, could not uniquely derive missing shape).');
      } else if (p.correct.trim().toLowerCase() !== candidates[0]) {
        return { ok: false, reason: `pattern_matrix correct≠${candidates[0]} (Latin-square rule)` };
      }
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'visual_pattern_sequence': {
      // No generic derivable rule (arbitrary visual progression) — best-effort
      // structural check only, same philosophy as rebus/detective.
      const steps = p.spec.steps;
      if (!Array.isArray(steps) || steps.length < 4 || steps.length > 6)
        return { ok: false, reason: 'visual_pattern_sequence needs 4-6 steps' };
      const lastShape = String(steps[steps.length - 1]?.shape || '').trim();
      if (lastShape !== '?') return { ok: false, reason: 'visual_pattern_sequence last step must have shape "?"' };
      const ALLOWED = new Set(['circle', 'square', 'triangle', 'star', 'heart']);
      const knownShapes = steps.slice(0, -1).map(s => String(s.shape || '').trim().toLowerCase());
      if (knownShapes.some(s => !ALLOWED.has(s))) return { ok: false, reason: 'visual_pattern_sequence: shape not in allowed renderer set' };
      if (!ALLOWED.has(p.correct.trim().toLowerCase())) return { ok: false, reason: 'visual_pattern_sequence: correct answer not in allowed renderer set' };
      console.warn('[PGEN] visual_pattern_sequence: no generic rule to verify — trusting LLM (best-effort).');
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'balance_scale': {
      const left = p.spec.left_items, right = p.spec.right_items;
      const leftTotal = num(p.spec.left_total);
      if (!Array.isArray(left) || left.length !== 1) return { ok: false, reason: 'balance_scale left_items must be exactly one icon type' };
      if (!Array.isArray(right) || !right.length) return { ok: false, reason: 'balance_scale needs right_items' };
      const leftIcon = left[0].icon, leftCount = Number(left[0].count) || 0;
      if (!leftIcon || leftCount <= 0 || isNaN(leftTotal)) return { ok: false, reason: 'balance_scale invalid left pan' };
      const perIconValue = leftTotal / leftCount;
      if (!Number.isFinite(perIconValue)) return { ok: false, reason: 'balance_scale left pan not derivable' };
      const qSlots = right.filter(it => it.icon === '?');
      if (qSlots.length !== 1) return { ok: false, reason: 'balance_scale right_items needs exactly one "?" icon slot' };
      const knownRight = right.filter(it => it.icon !== '?');
      if (knownRight.some(it => it.icon !== leftIcon)) {
        console.warn('[PGEN] balance_scale: right pan uses an icon not established on the left — cannot verify, trusting LLM.');
      } else {
        const knownRightTotal = knownRight.reduce((s, it) => s + (Number(it.count) || 0) * perIconValue, 0);
        const qCount = Number(qSlots[0].count) || 1;
        const predicted = (leftTotal - knownRightTotal) / qCount;
        if (Math.abs(num(p.correct) - predicted) > 0.01) {
          return { ok: false, reason: `balance_scale correct≠${predicted} (derived from left pan value)` };
        }
      }
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'cipher_decode': {
      const word = String(p.spec.word || '').trim().toUpperCase();
      const encoded = p.spec.encoded;
      const keyType = p.spec.key_type === 'shift' ? 'shift' : 'a1z26';
      const shiftN = Number(p.spec.shift) || 0;
      const hiddenIdx = Number(p.spec.hidden_index);
      if (!/^[A-Z]{3,6}$/.test(word)) return { ok: false, reason: 'cipher_decode word must be 3-6 letters' };
      if (!Array.isArray(encoded) || encoded.length !== word.length) return { ok: false, reason: 'cipher_decode encoded length must match word length' };
      if (isNaN(hiddenIdx) || hiddenIdx < 0 || hiddenIdx >= word.length) return { ok: false, reason: 'cipher_decode hidden_index out of range' };
      const encodeLetter = ch => {
        const pos = ch.charCodeAt(0) - 64; // A=1
        if (keyType === 'shift') return ((pos - 1 + shiftN) % 26 + 26) % 26 + 1;
        return pos;
      };
      for (let i = 0; i < word.length; i++) {
        const expected = encodeLetter(word[i]);
        if (Number(encoded[i]) !== expected) return { ok: false, reason: `cipher_decode encoded[${i}]≠${expected} for letter ${word[i]}` };
      }
      const correctLetter = p.correct.trim().toUpperCase();
      if (correctLetter !== word[hiddenIdx]) return { ok: false, reason: `cipher_decode correct≠${word[hiddenIdx]}` };
      if (correctLetter.length !== 1) return { ok: false, reason: 'cipher_decode correct must be a single letter' };
      p.correct = correctLetter;
      p.options = p.options.map(o => String(o).trim().toUpperCase());
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'flag_puzzle': {
      // Real-world lookup (which country owns this flag) isn't something we
      // can re-derive without a flag database — best-effort structural check,
      // same philosophy as rebus/detective/flag-style free-knowledge types.
      const stripes = p.spec.stripes;
      if (!Array.isArray(stripes) || stripes.length < 2 || stripes.length > 5) return { ok: false, reason: 'flag_puzzle needs 2-5 stripes' };
      if (stripes.some(c => !/^#[0-9a-fA-F]{6}$/.test(String(c)))) return { ok: false, reason: 'flag_puzzle stripes must be hex colors' };
      const hiddenIdx = Number(p.spec.hidden_stripe_index);
      if (isNaN(hiddenIdx) || hiddenIdx < 0 || hiddenIdx >= stripes.length) return { ok: false, reason: 'flag_puzzle hidden_stripe_index out of range' };
      console.warn('[PGEN] flag_puzzle: country identity not re-derivable without a flag database — trusting LLM (best-effort).');
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'area_perimeter': {
      const ow = num(p.spec.outer_w), oh = num(p.spec.outer_h), cw = num(p.spec.cut_w), ch = num(p.spec.cut_h);
      const unknown = p.spec.unknown === 'perimeter' ? 'perimeter' : 'area';
      if ([ow, oh, cw, ch].some(v => isNaN(v) || v <= 0)) return { ok: false, reason: 'area_perimeter needs positive numeric dims' };
      if (cw >= ow || ch >= oh) return { ok: false, reason: 'area_perimeter cut must be smaller than the outer rectangle' };
      const expect = unknown === 'perimeter' ? 2 * (ow + oh) : (ow * oh - (ow - cw) * ch);
      if (Math.abs(num(p.correct) - expect) > 0.5) return { ok: false, reason: `area_perimeter correct≠${expect} (${unknown})` };
      p.spec.unknown = unknown;
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'dominoes': {
      const chain = p.spec.chain;
      if (!Array.isArray(chain) || chain.length < 4 || chain.length > 6) return { ok: false, reason: 'dominoes needs a 4-6 tile chain' };
      if (chain.some(t => !Array.isArray(t) || t.length !== 2)) return { ok: false, reason: 'dominoes: each tile must be [top,bottom]' };
      // find the single "?" across the flattened chain
      const flatCells = []; // {i, side, val}
      chain.forEach((t, i) => { flatCells.push({ i, side: 'top', val: String(t[0]).trim() }, { i, side: 'bottom', val: String(t[1]).trim() }); });
      const qCells = flatCells.filter(c => c.val === '?');
      if (qCells.length !== 1) return { ok: false, reason: 'dominoes needs exactly one "?" pip across the whole chain' };
      const q = qCells[0];
      if ((q.side === 'top' && q.i === 0) || (q.side === 'bottom' && q.i === chain.length - 1)) {
        return { ok: false, reason: 'dominoes: "?" must be an interior pip with a neighbor to check against (not the chain\'s outer ends)' };
      }
      // verify the rest of the chain already satisfies bottom[i] === top[i+1]
      for (let i = 0; i < chain.length - 1; i++) {
        const bottom = String(chain[i][1]).trim(), top = String(chain[i + 1][0]).trim();
        if (bottom === '?' || top === '?') continue;
        if (bottom !== top) return { ok: false, reason: `dominoes: tile ${i} bottom (${bottom}) doesn't match tile ${i + 1} top (${top})` };
      }
      // derive the expected value from the adjacent known cell
      let predicted = null;
      if (q.side === 'bottom') predicted = String(chain[q.i + 1][0]).trim();
      else predicted = String(chain[q.i - 1][1]).trim();
      if (predicted === '?' || predicted == null) return { ok: false, reason: 'dominoes: "?" neighbor is not a known value' };
      const predictedNum = num(predicted);
      if (isNaN(predictedNum) || predictedNum < 0 || predictedNum > 6) return { ok: false, reason: 'dominoes: derived pip value out of 0-6 range' };
      if (Math.abs(num(p.correct) - predictedNum) > 0.01) return { ok: false, reason: `dominoes correct≠${predictedNum}` };
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'clock_angle': {
      const hour = Number(p.spec.hour), minute = Number(p.spec.minute);
      const qtype = p.spec.question_type === 'time' ? 'time' : 'angle';
      if (!Number.isInteger(hour) || hour < 1 || hour > 12) return { ok: false, reason: 'clock_angle hour must be 1-12' };
      if (!Number.isInteger(minute) || minute < 0 || minute > 59) return { ok: false, reason: 'clock_angle minute must be 0-59' };
      p.spec.question_type = qtype;
      if (qtype === 'angle') {
        const raw = Math.abs(30 * (hour % 12) + 0.5 * minute - 6 * minute);
        const expect = Math.min(raw, 360 - raw);
        if (Math.abs(num(p.correct) - expect) > 1) return { ok: false, reason: `clock_angle correct≠${expect.toFixed(0)}°` };
      } else {
        const expectStr = `${hour}:${String(minute).padStart(2, '0')}`;
        if (p.correct.replace(/\s+/g, '') !== expectStr) return { ok: false, reason: `clock_angle correct≠${expectStr}` };
      }
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
    case 'truth_or_lie': {
      // General free-text logic solving isn't something we can re-derive
      // reliably — best-effort structural check, same philosophy as
      // rebus/detective/flag_puzzle above.
      const people = p.spec.people;
      if (!Array.isArray(people) || people.length !== 3) return { ok: false, reason: 'truth_or_lie needs exactly 3 people' };
      if (people.some(pp => !pp.name || !pp.statement)) return { ok: false, reason: 'truth_or_lie: every person needs a name and statement' };
      if (people.some(pp => wc(pp.statement) > 10)) return { ok: false, reason: 'truth_or_lie: statements must be short (<=10 words)' };
      const names = people.map(pp => String(pp.name).trim());
      if (!names.some(n => n.toLowerCase() === p.correct.trim().toLowerCase())) {
        return { ok: false, reason: 'truth_or_lie: correct answer must be one of the 3 named people' };
      }
      console.warn('[PGEN] truth_or_lie: free-text logic statements not re-derivable — trusting LLM (best-effort).');
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }

    default:
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
  }
  return { ok: true };
}

// Detect arithmetic / geometric / second-difference-constant sequences.
function predictNext(nums) {
  const n = nums.length;
  if (n < 2) return null;
  const diffs = nums.slice(1).map((v, i) => v - nums[i]);
  if (diffs.every(d => d === diffs[0])) return nums[n - 1] + diffs[0];           // arithmetic
  if (nums.every(v => v !== 0) && nums.slice(1).every((v, i) => v / nums[i] === diffs[0] / 1 ? false : true)) {
    const ratio = nums[1] / nums[0];
    if (nums.slice(1).every((v, i) => Math.abs(v / nums[i] - ratio) < 1e-9)) return nums[n - 1] * ratio; // geometric
  }
  const dd = diffs.slice(1).map((v, i) => v - diffs[i]);
  if (dd.length && dd.every(x => x === dd[0])) {                                  // quadratic (const 2nd diff)
    const nextDiff = diffs[diffs.length - 1] + dd[0];
    return nums[n - 1] + nextDiff;
  }
  return null; // unknown rule → trust the LLM
}

// ════════════════════════════════════════════════════════════════════════════
// NUMBER_GRID rule detection (best-effort: row-sum, col-sum, row-product)
// Returns { ruleName, predicted } if a consistent rule is found among the
// COMPLETE rows/cols (the ones without "?"), else null.
// ════════════════════════════════════════════════════════════════════════════
function detectGridRule(rows) {
  const R = rows.length, C = rows[0]?.length || 0;
  if (!R || !C) return null;
  let qr = -1, qc = -1;
  rows.forEach((row, r) => row.forEach((v, c) => { if (String(v).trim() === '?') { qr = r; qc = c; } }));
  if (qr < 0) return null;
  const grid = rows.map(row => row.map(v => (String(v).trim() === '?' ? null : num(v))));
  if (grid.flat().some(v => v !== null && isNaN(v))) return null; // non-numeric grid, can't check

  const close = (a, b) => Math.abs(a - b) < 1e-6;

  // row-sum rule
  const rowSums = grid.filter((_, r) => r !== qr).map(row => row.reduce((s, v) => s + v, 0));
  if (rowSums.length && rowSums.every(s => close(s, rowSums[0]))) {
    const knownInQRow = grid[qr].filter(v => v !== null).reduce((s, v) => s + v, 0);
    return { ruleName: 'row-sum', predicted: rowSums[0] - knownInQRow };
  }

  // column-sum rule
  const colSums = [];
  for (let c = 0; c < C; c++) {
    if (c === qc) continue;
    let s = 0; for (let r = 0; r < R; r++) s += grid[r][c];
    colSums.push(s);
  }
  if (colSums.length && colSums.every(s => close(s, colSums[0]))) {
    let knownInQCol = 0; for (let r = 0; r < R; r++) if (r !== qr) knownInQCol += grid[r][qc];
    return { ruleName: 'col-sum', predicted: colSums[0] - knownInQCol };
  }

  // row-product rule (only meaningful if nothing is zero)
  if (grid.flat().every(v => v !== 0)) {
    const rowProducts = grid.filter((_, r) => r !== qr).map(row => row.reduce((p, v) => p * v, 1));
    if (rowProducts.length && rowProducts.every(p => close(p, rowProducts[0]))) {
      const knownProdInQRow = grid[qr].filter(v => v !== null).reduce((p, v) => p * v, 1);
      if (knownProdInQRow !== 0) return { ruleName: 'row-product', predicted: rowProducts[0] / knownProdInQRow };
    }
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════════
// MATCHSTICK move-solver — built directly from puzzleRenderers.js's own
// seven-segment digit map, so "is this equation actually fixable by moving
// one stick, and is the fix among the given options" is a real answer instead
// of an assumption.
// ════════════════════════════════════════════════════════════════════════════
const MS_SEG = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc',
  '5': 'afgcd', '6': 'afgecd', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
};
const MS_ALL_SEGS = 'abcdefg'.split('');
function canonSegs(str) { return str.split('').sort().join(''); }
// digit -> canonical sorted segment string, and the reverse lookup
const MS_CANON_TO_DIGIT = Object.fromEntries(Object.entries(MS_SEG).map(([d, s]) => [canonSegs(s), d]));

function evalSimpleExpr(expr) {
  // supports a chain like "12+3-4" (digits and single +/- operators, no parens)
  const m = expr.match(/^(\d+)([+\-]\d+)*$/);
  if (!m) return null;
  const parts = expr.match(/[+\-]?\d+/g);
  if (!parts) return null;
  return parts.reduce((s, p) => s + parseInt(p, 10), 0);
}
function evalEquation(eq) {
  const sides = eq.split('=');
  if (sides.length !== 2) return null;
  const l = evalSimpleExpr(sides[0]);
  const r = evalSimpleExpr(sides[1]);
  if (l == null || r == null) return null;
  return { left: l, right: r, isTrue: l === r };
}

function solveMatchstickMove(eq) {
  const parsedOriginal = evalEquation(eq);
  if (!parsedOriginal) return { parsedOk: false, currentlyFalse: false, reachable: new Set() };

  const digitIdx = [];
  for (let i = 0; i < eq.length; i++) if (MS_SEG[eq[i]]) digitIdx.push(i);
  if (digitIdx.length < 2) return { parsedOk: true, currentlyFalse: !parsedOriginal.isTrue, reachable: new Set() };

  // For each digit position: which single-segment removals / additions land
  // on another valid digit.
  const removalOptions = []; // {i, to}
  const additionOptions = []; // {i, to}
  for (const i of digitIdx) {
    const digit = eq[i];
    const segs = MS_SEG[digit].split('');
    for (const seg of segs) {
      const remaining = segs.filter(s => s !== seg);
      const to = MS_CANON_TO_DIGIT[canonSegs(remaining.join(''))];
      if (to != null) removalOptions.push({ i, to });
    }
    for (const seg of MS_ALL_SEGS) {
      if (segs.includes(seg)) continue;
      const added = [...segs, seg];
      const to = MS_CANON_TO_DIGIT[canonSegs(added.join(''))];
      if (to != null) additionOptions.push({ i, to });
    }
  }

  const reachable = new Set();
  for (const rem of removalOptions) {
    for (const add of additionOptions) {
      if (add.i === rem.i) continue; // moving a stick between two DIFFERENT digit positions
      const chars = eq.split('');
      chars[rem.i] = rem.to;
      chars[add.i] = add.to;
      const candidate = chars.join('');
      const parsed = evalEquation(candidate);
      if (parsed && parsed.isTrue) reachable.add(candidate);
    }
  }

  return { parsedOk: true, currentlyFalse: !parsedOriginal.isTrue, reachable };
}

// ════════════════════════════════════════════════════════════════════════════
// AUDIO / DESIGN POOLS (reused tables — same loaders as worker8)
// ════════════════════════════════════════════════════════════════════════════
async function loadAllPools(env, lang, niche) {
  const [hooks, timeup, cta1, cta2, cta3, cta4, qIntro, optsIntro,
    sfxQuestionAppear, sfxOptionsAppear, sfxCountdownLoop, sfxCorrectAnswer, bgMusic, bgAnim, bgImage] = await Promise.all([
    pickCuePool(env, 'quiz_hooks', lang, niche, true),
    pickCuePool(env, 'timeup_cues', lang, null, false),
    pickCuePool(env, 'cta1_audio_cues', lang, niche, true),
    pickCuePool(env, 'cta2_audio_cues', lang, niche, true),
    pickCuePool(env, 'cta3_audio_cues', lang, null, false),
    pickCta4Pool(env, lang),
    pickCuePool(env, 'question_intro_cues', lang, null, false),
    pickCuePool(env, 'options_intro_cues', lang, null, false),
    pickSfxPool(env, 'question_appear', niche),
    pickSfxPool(env, 'options_appear', niche),
    pickSfxPool(env, 'countdown_loop', niche),
    pickSfxPool(env, 'correct_answer', niche),
    pickBgMusicPool(env, niche),
    pickBgAnimPool(env, niche),
    pickBgImagePool(env, niche),
  ]);
  return { hooks, timeup, cta1, cta2, cta3, cta4, qIntro, optsIntro,
    sfxQuestionAppear, sfxOptionsAppear, sfxCountdownLoop, sfxCorrectAnswer, bgMusic, bgAnim, bgImage };
}

// Curated R2-hosted background image pool for the .topic-photo-overlay
// (30% opacity behind every screen — see puzzle_template.html). Random pick,
// same shape as pickBgMusicPool/pickBgAnimPool above.
async function pickBgImagePool(env, niche) {
  try {
    const filter = niche ? `&or=(niche.eq.${encodeURIComponent(niche)},niche.is.null)` : '';
    const rows = await dbGet(env, `puzzle_background_images?is_active=eq.true${filter}&order=usage_count.asc&limit=30`).catch(() => null);
    return rows || [];
  } catch { return []; }
}

// NEW: audio/design pools used to fail silently — an empty pool just meant
// `null` on the row with no trace anywhere. This makes it loud: logs an
// ERROR for every empty pool and returns the list so it can be stamped onto
// the completed job's payload for later inspection (e.g. a dashboard query
// on puzzle_queue.payload->>'pool_warnings').
function reportEmptyPools(pools) {
  // Only flag pools whose absence visibly degrades the video (missing hook/
  // music/background is noticeable; a missing CTA variant less so, but we
  // still report everything empty so nothing is silently swallowed).
  const warnings = [];
  for (const [name, arr] of Object.entries(pools)) {
    if (!arr || !arr.length) {
      warnings.push(name);
      console.error(`[PGEN] Pool "${name}" returned EMPTY — this puzzle will ship with a null/degraded value for it. Check Supabase table + RLS.`);
    }
  }
  return warnings;
}

async function pickCuePool(env, table, lang, niche, hasNicheCol) {
  try {
    let rows = await dbGet(env, `${table}?is_active=eq.true&or=(language_code.eq.${lang},language_code.is.null)&limit=50`).catch(() => null);
    if (!rows?.length) rows = await dbGet(env, `${table}?is_active=eq.true&limit=50`).catch(() => null);
    if (!rows?.length) return [];
    if (niche && hasNicheCol) { const nr = rows.filter(r => r.niche === niche || !r.niche); if (nr.length) return nr; }
    return rows;
  } catch { return []; }
}
async function pickSfxPool(env, cueName, niche) {
  try {
    const filter = niche ? `&or=(niche.eq.${encodeURIComponent(niche)},niche.is.null)` : '';
    const rows = await dbGet(env, `sfx_cues?is_active=eq.true&cue_name=eq.${encodeURIComponent(cueName)}${filter}&limit=20`).catch(() => null);
    return rows || [];
  } catch { return []; }
}
async function pickBgMusicPool(env, niche) {
  try {
    const filter = niche ? `&or=(niche.eq.${encodeURIComponent(niche)},niche.is.null)` : '';
    const rows = await dbGet(env, `background_music_tracks?is_active=eq.true${filter}&order=usage_count.asc&limit=20`).catch(() => null);
    return rows || [];
  } catch { return []; }
}
async function pickBgAnimPool(env, niche) {
  try {
    const filter = niche ? `or=(niche.eq.${encodeURIComponent(niche)},niche.eq.general,niche.is.null)` : 'niche.eq.general';
    let rows = await dbGet(env, `background_animation?is_active=eq.true&${filter}&limit=20`).catch(() => null);
    if (rows?.length) return rows;
    rows = await dbGet(env, `background_animation?is_active=eq.true&limit=20`).catch(() => null);
    return rows || [];
  } catch { return []; }
}
async function pickCta4Pool(env, lang) {
  try {
    let rows = await dbGet(env, `cta4_cues?is_active=eq.true&or=(lang_code.eq.${encodeURIComponent(lang)},lang_code.is.null)&order=usage_count.asc&limit=20`).catch(() => null);
    if (rows?.length) return rows;
    rows = await dbGet(env, `cta4_cues?is_active=eq.true&order=usage_count.asc&limit=20`).catch(() => null);
    return rows || [];
  } catch { return []; }
}

async function bumpUsage(env, map) {
  const proms = [];
  for (const [table, row] of Object.entries(map)) {
    if (!row?.id) continue;
    proms.push(dbPatch(env, table, row.id, {
      usage_count: (row.usage_count || 0) + 1, last_used_at: new Date().toISOString()
    }).catch(() => {}));
  }
  await Promise.all(proms);
}

// ── repository_dispatch → puzzle render workflow ────────────────────────────
async function fireRenderDispatch(env) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) { console.log('[PGEN] No GITHUB_TOKEN/REPO — skipping dispatch.'); return; }
  try {
    const res = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'JaasX-PuzzleGen',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'trigger-puzzle-render' }),
    });
    console.log(`[PGEN] repository_dispatch trigger-puzzle-render → ${res.status}`);
  } catch (e) { console.warn(`[PGEN] dispatch failed: ${e.message}`); }
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════
function randomPick(a) { return a?.length ? a[Math.floor(Math.random() * a.length)] : null; }
function pickAccents() {
  const P = ['#00cfff','#00ff88','#c9a227','#ff2d78','#007aff','#ff1c44','#a78bfa','#cc0000','#ff00ff','#ff6b00'];
  const S = ['#0080ff','#ff3c00','#e8c84a','#bf00ff','#5ac8fa','#ffcc00','#60a5fa','#ff4444','#00ffff','#ffd700'];
  const T = ['#a0f0ff','#ffdd00','#f5e17a','#ff9d00','#34c759','#1a8cff','#f472b6','#ffffff','#ffff00','#00e676'];
  return [randomPick(P), randomPick(S), randomPick(T)];
}
function normaliseKeep5050(raw, options, correct) {
  const correctIdx = options.findIndex(o => o?.trim().toLowerCase() === correct?.trim().toLowerCase());
  let keep = Array.isArray(raw) ? raw.map(v => parseInt(v, 10)).filter(n => !isNaN(n) && n >= 0 && n <= 3) : [];
  if (correctIdx >= 0 && !keep.includes(correctIdx)) keep = [correctIdx];
  keep = [...new Set(keep)];
  if (keep.length < 2) for (let i = 0; i < 4; i++) if (!keep.includes(i)) { keep.push(i); break; }
  if (keep.length > 2) keep = keep.slice(0, 2);
  return keep.map(String);
}
function buildIntroSpeech(name) {
  const t = [`Today's brain teaser: ${name}. Can you crack it?`, `Here's a ${name} to test your mind. Ready?`,
    `Think you're smart? Try this ${name}!`, `Most people fail this ${name}. Can you solve it?`];
  return t[Math.floor(Math.random() * t.length)];
}
function buildSfxJson(m) { try { return JSON.stringify(m); } catch { return null; } }
function makeSlug(t) { return (t || '').toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/-+/g, '-').slice(0, 80); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════════════════════════════
// UNIQUENESS — fingerprint builder
// Returns a short canonical string that uniquely identifies the puzzle's
// core content. Used as the unique key in the puzzle table.
// ════════════════════════════════════════════════════════════════════════════
function buildFingerprint(type, p) {
  try {
    switch (type) {
      case 'matchstick':
        return `matchstick::${(p.spec.equation || '').replace(/\s+/g, '')}`;

      case 'geometry_triangle': {
        const known = (p.spec.labels || [])
          .filter(l => !l.highlight)
          .map(l => String(l.text).replace(/°/g, '').trim())
          .sort()
          .join('-');
        return `triangle::${known}`;
      }

      case 'geometry_right_triangle': {
        const sides = [p.spec.leg_a, p.spec.leg_b, p.spec.hypotenuse]
          .map(v => String(v || '?').trim())
          .join('-');
        return `right_triangle::${sides}::${p.spec.unknown || ''}`;
      }

      case 'geometry_straight_line':
        return `straight_line::${String(p.spec.known_angle || '').replace(/°/g, '').trim()}`;

      case 'number_sequence': {
        const cells = (p.spec.cells || []).filter(c => c !== '?').join(',');
        return `sequence::${cells}`;
      }

      case 'number_grid': {
        const flat = (p.spec.rows || []).flat()
          .filter(v => v !== '?').join(',');
        return `grid::${flat}`;
      }

      case 'visual_math': {
        // fingerprint = row values, skipping the "?" row
        const rows = (p.spec.equations || []).slice(0, -1)
          .map(eq => (eq.items || []).map(it => `${it.icon}x${it.count}`).join('+') + '=' + eq.result)
          .join('|');
        return `visual_math::${rows}`;
      }

      case 'odd_one_out': {
        // fingerprint = majority color + odd color + position
        const items = p.spec.items || [];
        const colorCounts = {};
        items.forEach(it => { colorCounts[it.color || ''] = (colorCounts[it.color || ''] || 0) + 1; });
        const sorted = Object.entries(colorCounts).sort((a,b) => b[1]-a[1]);
        const majorColor = sorted[0]?.[0] || '';
        const oddColor   = sorted[sorted.length-1]?.[0] || '';
        const oddIdx     = items.findIndex(it => it.color === oddColor);
        return `odd_one_out::${majorColor}::${oddColor}::pos${oddIdx}`;
      }

      case 'rebus': {
        const tokens = (p.spec.tokens || []).filter(t => t !== '+').join('+');
        return `rebus::${tokens.toUpperCase()}`;
      }

      case 'detective':
        return `detective::${(p.spec.case_title || '').toLowerCase().replace(/\s+/g,'-').slice(0,40)}`;

      // ── Buyer-pipeline types ────────────────────────────────────────────
      case 'word_ladder':
        return `word_ladder::${(p.spec.words || []).filter(w => w !== '?').join('-').toUpperCase()}`;

      case 'pattern_matrix':
        return `pattern_matrix::${(p.spec.grid || []).flat().join(',')}`;

      case 'visual_pattern_sequence':
        return `visual_pattern_sequence::${(p.spec.steps || []).map(s => s.shape).join(',')}`;

      case 'balance_scale': {
        const left = (p.spec.left_items || []).map(it => `${it.icon}x${it.count}`).join('+');
        const right = (p.spec.right_items || []).map(it => `${it.icon}x${it.count}`).join('+');
        return `balance_scale::${left}=${p.spec.left_total}::${right}`;
      }

      case 'cipher_decode':
        return `cipher_decode::${(p.spec.word || '').toUpperCase()}::${p.spec.key_type || 'a1z26'}::${p.spec.shift || 0}`;

      case 'flag_puzzle':
        return `flag_puzzle::${(p.spec.stripes || []).join(',')}::${p.spec.symbol || ''}`;

      case 'area_perimeter':
        return `area_perimeter::${p.spec.outer_w}x${p.spec.outer_h}-cut${p.spec.cut_w}x${p.spec.cut_h}::${p.spec.unknown}`;

      case 'dominoes':
        return `dominoes::${(p.spec.chain || []).map(t => t.join('/')).join('-')}`;

      case 'clock_angle':
        return `clock_angle::${p.spec.hour}:${p.spec.minute}::${p.spec.question_type || 'angle'}`;

      case 'truth_or_lie':
        return `truth_or_lie::${(p.spec.people || []).map(pp => pp.name).join(',')}`;

      case 'geometry':
        // p.spec.family (e.g. 'tri_angle_sum') + rounded vars — the question/
        // title text is IDENTICAL across every instance of a family, so
        // fingerprinting on those (the default fallback below) would treat
        // every angle-sum puzzle as one big duplicate. family+vars is the
        // real uniqueness key here.
        return `geometry::${p.spec.family}::${JSON.stringify(p.spec.vars)}`;

      default:
        // fallback: hash the question text
        return `${type}::${(p.question || '').toLowerCase().replace(/\s+/g,'_').slice(0,60)}`;
    }
  } catch (e) {
    // If fingerprint building fails, use question text as fallback
    return `${type}::${(p.question || '').toLowerCase().replace(/\s+/g,'_').slice(0,60)}`;
  }
}

function parseJsonArray(text) {
  let s = String(text).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  const m = s.match(/\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  try { const one = JSON.parse(s); return Array.isArray(one) ? one : [one]; } catch {}
  return null;
}

// ── Supabase REST ───────────────────────────────────────────────────────────
function sbHeaders(env) {
  return { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
}
async function dbGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  const txt = await res.text(); return txt.trim() ? JSON.parse(txt) : [];
}
async function dbPatch(env, table, id, data) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: { ...sbHeaders(env), Prefer: 'return=minimal' }, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`PATCH ${table}/${id} → ${res.status}: ${await res.text()}`);
}
async function dbInsert(env, table, data) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}`, {
    method: 'POST', headers: { ...sbHeaders(env), Prefer: 'return=representation' }, body: JSON.stringify(data) });
  if (!res.ok) throw new Error(`INSERT ${table} → ${res.status}: ${await res.text()}`);
  const txt = await res.text(); return txt.trim() ? JSON.parse(txt) : null;
}
async function dbRpc(env, fn, params = {}) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: sbHeaders(env), body: JSON.stringify(params) });
  if (!res.ok) throw new Error(`RPC ${fn} → ${res.status}: ${await res.text()}`);
  const txt = await res.text(); return txt.trim() ? JSON.parse(txt) : null;
}
