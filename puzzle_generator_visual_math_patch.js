// ════════════════════════════════════════════════════════════════════════════
// PATCH for puzzle_generator.js — visual_math validator fix
//
// THE BUG: The original validator only derived icon values from SINGLE-icon
// rows. If a puzzle needs e.g. "star+grape*2=18" to derive grape's value,
// the validator skipped verification entirely — letting wrong LLM answers
// (like 14 instead of 13) pass into the database unchallenged.
//
// THE FIX: Replace the entire case 'visual_math' block in validatePuzzle()
// with the code below. It uses Gaussian elimination to solve the full linear
// system of equations, correctly handling multi-variable puzzles.
//
// HOW TO APPLY:
//   In puzzle_generator.js, inside the validatePuzzle() function,
//   find the block:  case 'visual_math': { ... }
//   and replace the ENTIRE case (from "case 'visual_math': {" to the
//   matching "break; }") with the code below.
// ════════════════════════════════════════════════════════════════════════════

    case 'visual_math': {
      const eqs = p.spec.equations;
      if (!Array.isArray(eqs) || eqs.length < 2) return { ok: false, reason: 'visual_math needs ≥2 rows' };
      const last = eqs[eqs.length - 1];
      if (String(last.result).trim() !== '?') return { ok: false, reason: 'last row must be "?"' };

      // ── Full Gaussian-elimination solver so multi-variable puzzles (e.g.
      //    star*3=24, star+grape*2=18, grape+star=?) are verified correctly.
      //    The old single-pass approach only derived values from single-icon
      //    rows — it silently skipped validation whenever a 2nd variable had
      //    to be derived from a 2-icon row, letting wrong LLM answers pass.
      const solveIconValues = (equations) => {
        // Collect all unique icon names
        const allIcons = [...new Set(equations.flatMap(eq =>
          (eq.items || []).map(it => it.icon)
        ))];
        // Build augmented coefficient matrix  [c0, c1, ..., cn | result]
        const matrix = equations.map(eq => {
          const row = new Array(allIcons.length + 1).fill(0);
          (eq.items || []).forEach(it => {
            const col = allIcons.indexOf(it.icon);
            if (col >= 0) row[col] += Number(it.count) || 0;
          });
          row[allIcons.length] = num(eq.result);
          return row;
        });
        // Gaussian elimination with partial pivoting
        const n = allIcons.length;
        const m = matrix.length;
        let col = 0;
        for (let row = 0; row < Math.min(m, n); row++) {
          let maxRow = -1, maxVal = 0;
          for (let r = row; r < m; r++) {
            if (Math.abs(matrix[r][col]) > maxVal) { maxVal = Math.abs(matrix[r][col]); maxRow = r; }
          }
          if (maxRow < 0 || maxVal < 1e-10) { col++; row--; if (col >= n) break; continue; }
          [matrix[row], matrix[maxRow]] = [matrix[maxRow], matrix[row]];
          const pivot = matrix[row][col];
          for (let c = col; c <= n; c++) matrix[row][c] /= pivot;
          for (let r = 0; r < m; r++) {
            if (r === row || Math.abs(matrix[r][col]) < 1e-12) continue;
            const f = matrix[r][col];
            for (let c = col; c <= n; c++) matrix[r][c] -= f * matrix[row][c];
          }
          col++;
        }
        // Extract solved values: a row with exactly one nonzero variable coeff is solved
        const vals = {};
        for (let r = 0; r < m; r++) {
          const nonzero = allIcons.map((_, i) => i).filter(i => Math.abs(matrix[r][i]) > 1e-10);
          if (nonzero.length === 1) {
            vals[allIcons[nonzero[0]]] = matrix[r][n] / matrix[r][nonzero[0]];
          }
        }
        return vals;
      };

      const val = solveIconValues(eqs.slice(0, -1));
      const lastItems = last.items || [];
      const allKnown = lastItems.every(it => val[it.icon] != null);
      if (allKnown) {
        const total = lastItems.reduce((s, it) => s + (Number(it.count) || 0) * val[it.icon], 0);
        const rounded = Math.round(total * 100) / 100;
        if (Math.abs(num(p.correct) - rounded) > 0.01) {
          // HARD FIX: override the LLM's wrong answer with the mathematically
          // derived correct value — don't just reject, correct and proceed.
          const correctStr = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
          console.warn(`[PGEN] visual_math: LLM said ${p.correct} but math says ${correctStr} — auto-correcting`);
          // Ensure the derived value is present in options
          if (!p.options.some(o => Math.abs(num(o) - rounded) < 0.01)) {
            // Replace the option furthest from correct with the right value
            const worstIdx = p.options.reduce((worst, o, i) =>
              Math.abs(num(o) - rounded) > Math.abs(num(p.options[worst]) - rounded) ? i : worst, 0);
            p.options[worstIdx] = correctStr;
          }
          // Re-normalize correct to match the options string exactly
          const match = p.options.find(o => Math.abs(num(o) - rounded) < 0.01);
          p.correct = match || correctStr;
        }
      } else {
        // System is under-determined (fewer equations than unknowns) —
        // trust the LLM but log which icons couldn't be derived.
        const unknowns = lastItems.filter(it => val[it.icon] == null).map(it => it.icon);
        console.warn(`[PGEN] visual_math: cannot fully solve system, unknown icon values: ${unknowns.join(', ')} — trusting LLM`);
      }
      if (!ensureCorrectInOptions()) return { ok: false, reason: 'correct not in options' };
      break;
    }
