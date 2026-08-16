'use strict';
// ════════════════════════════════════════════════════════════════════════════
// puzzleAssigner.js — shared polling helpers for all PUZZLE render workers
//
// Direct clone of formatAssigner.js with two changes:
//   1. Polls the `puzzle` table (not `quiz`)
//   2. Dedup is by `topic` (which for puzzles is "Matchstick Move #12" etc.)
//
// poll column behaviour is IDENTICAL to formatAssigner so the existing logic
// for stuck-reset / topic-first dedup / skipped revival all transfer exactly.
// The puzzle render workers never touch quiz / quiz_queue.
// ════════════════════════════════════════════════════════════════════════════

const PUZZLE_FORMAT_CONFIG = {
  short: {
    pollCol:     'short_status',
    pendingVal:  'pending_short',
    claimVal:    'rendering_short',
    doneVal:     'done_short',
    errorVal:    'error_short',
    skipVal:     'skipped_short',
    videoUrlCol: 'short_video_url',
  },
  // Distinct from `short` — puzzle_render_short.js (intro) and
  // puzzlerenderswithoutintro.js (no intro) used to share `short_status`,
  // which meant they raced for the same rows and only one could ever render
  // a given puzzle. Split into its own column so a puzzle can be rendered by
  // BOTH the intro and no-intro variants (deliberate fan-out — see
  // `fanout_enabled` below), not a race.
  short_nointro: {
    pollCol:     'short_nointro_status',
    pendingVal:  'pending_short_nointro',
    claimVal:    'rendering_short_nointro',
    doneVal:     'done_short_nointro',
    errorVal:    'error_short_nointro',
    skipVal:     'skipped_short_nointro',
    videoUrlCol: 'short_nointro_video_url',
  },
  medium: {
    pollCol:     'medium_status',
    pendingVal:  'pending_medium',
    claimVal:    'rendering_medium',
    doneVal:     'done_medium',
    errorVal:    'error_medium',
    skipVal:     'skipped_medium',
    videoUrlCol: 'medium_video_url',
  },
  long: {
    pollCol:     'long_status',
    pendingVal:  'pending_long',
    claimVal:    'rendering_long',
    doneVal:     'done_long',
    errorVal:    'error_long',
    skipVal:     'skipped_long',
    videoUrlCol: 'video_url',
  },
};

function _normTopic(t) {
  return (t || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

async function pollPuzzleFormat(fetchFn, patchFn, format, label = '[PZ-WORKER]') {
  const cfg = PUZZLE_FORMAT_CONFIG[format];
  if (!cfg) throw new Error(`Unknown puzzle format "${format}". Must be short | medium | long.`);

  console.log(`${label} Polling puzzle format="${format}" column="${cfg.pollCol}"="${cfg.pendingVal}"`);

  // ── Reset stuck rows (claimed >30 min ago without completion) ──────────
  // Also clears is_rendered — a stuck/never-finished claim never actually
  // produced a video, so the cross-format lock should release too, not just
  // this format's own status column.
  try {
    const stuckCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const stuckRows = await fetchFn(
      `puzzle?${cfg.pollCol}=eq.${cfg.claimVal}&is_active=eq.true` +
      `&updated_at=lt.${stuckCutoff}&select=id&limit=5`
    ).catch(() => null);
    if (stuckRows?.length) {
      console.log(`${label} Resetting ${stuckRows.length} stuck ${format} puzzle row(s)`);
      for (const r of stuckRows) {
        await patchFn(`puzzle?id=eq.${r.id}`, {
          [cfg.pollCol]: cfg.pendingVal,
          is_rendered: false,
          updated_at: new Date().toISOString(),
        }).catch(() => {});
      }
    }
  } catch {}

  // ── Fetch all pending rows for this format, newest first ───────────────
  // is_rendered=eq.false is the CROSS-FORMAT guard for ORDINARY rows: once
  // ANY format claims one, is_rendered flips true and every other format's
  // poll excludes it — one row produces exactly one video, whichever format
  // gets there first. That's still the default for every LLM-driven type.
  //
  // FANOUT rows (fanout_enabled=true — currently only the procedural
  // geometry engine's rows) are the deliberate exception: the same puzzle
  // is meant to be rendered by SEVERAL formats independently (e.g. an
  // "easy" geometry puzzle → micro + short-nointro + short + medium + long,
  // all five). For those rows is_rendered must NOT gate anything — the
  // `or=(is_rendered.eq.false,fanout_enabled.eq.true)` below lets a fanout
  // row stay visible to every format's poll no matter what is_rendered is,
  // while ordinary rows (fanout_enabled defaults false) keep the exact old
  // exclusive behavior. Each format's OWN status column (pending → claimed
  // → done) still prevents that SAME format from double-claiming it.
  let pendingRows = await fetchFn(
    `puzzle?${cfg.pollCol}=eq.${cfg.pendingVal}` +
    `&is_active=eq.true&puzzle_enriched=eq.true` +
    `&or=(is_rendered.eq.false,fanout_enabled.eq.true)` +
    `&order=created_at.desc&limit=500` +
    `&select=id,topic,topic_slug,puzzle_type,created_at`
  ).catch(() => null);

  // Fallback: revive newest skipped row if nothing pending
  if (!pendingRows?.length) {
    const skipped = await fetchFn(
      `puzzle?${cfg.pollCol}=eq.${cfg.skipVal}` +
      `&is_active=eq.true&puzzle_enriched=eq.true` +
      `&or=(is_rendered.eq.false,fanout_enabled.eq.true)` +
      `&order=created_at.desc&limit=1&select=id,topic,topic_slug,puzzle_type,created_at`
    ).catch(() => null);
    if (skipped?.length) {
      const revive = skipped[0];
      console.log(`${label} No fresh puzzles — reviving skipped: "${revive.topic}" (${revive.id})`);
      await patchFn(`puzzle?id=eq.${revive.id}`, {
        [cfg.pollCol]: cfg.pendingVal,
        updated_at: new Date().toISOString(),
      }).catch(() => {});
      pendingRows = [revive];
    }
  }

  if (!pendingRows?.length) {
    console.log(`${label} Nothing to render for format="${format}".`);
    return null;
  }

  // ── Group by puzzle_type (analogous to topic grouping in formatAssigner) ─
  // For puzzles, `puzzle_type` is the "topic" axis — we render at most one
  // matchstick per run, one detective per run, etc. This prevents the queue
  // filling up with 20 matchstick rows while detectives wait forever.
  const typeMap = new Map();
  for (const r of pendingRows) {
    const key = _normTopic(r.puzzle_type || r.topic);
    if (!key) continue;
    if (!typeMap.has(key)) typeMap.set(key, []);
    typeMap.get(key).push(r);
  }
  console.log(`${label} ${typeMap.size} distinct puzzle_type(s), ${pendingRows.length} pending ${format} row(s)`);

  // Count already-done rows per type
  const doneCounts = {};
  for (const [key, rows] of typeMap) {
    const sample = rows[0];
    const done = await fetchFn(
      `puzzle?puzzle_type=eq.${encodeURIComponent(sample.puzzle_type || sample.topic)}` +
      `&${cfg.pollCol}=eq.${cfg.doneVal}&select=id&limit=50`
    ).catch(() => null);
    doneCounts[key] = done?.length || 0;
  }

  // Sort: fewest done first, then newest created_at
  const sortedTypes = [...typeMap.entries()].sort((a, b) => {
    const diff = (doneCounts[a[0]] ?? 0) - (doneCounts[b[0]] ?? 0);
    if (diff !== 0) return diff;
    return new Date(b[1][0].created_at) - new Date(a[1][0].created_at);
  });

  const [chosenKey, chosenRows] = sortedTypes[0];
  const chosenRow = chosenRows[0];
  console.log(`${label} Selected puzzle_type: "${chosenRow.puzzle_type}" ` +
    `(${doneCounts[chosenKey] ?? 0} already done, ${chosenRows.length} pending for it)`);

  // Park other rows for the same type
  const others = chosenRows.slice(1);
  if (others.length) {
    console.log(`${label} Skipping ${others.length} other pending row(s) for same type → ${cfg.skipVal}`);
    for (const r of others) {
      await patchFn(`puzzle?id=eq.${r.id}`, {
        [cfg.pollCol]: cfg.skipVal,
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    }
  }

  // Fetch full row + claim atomically
  const full = await fetchFn(`puzzle?id=eq.${chosenRow.id}&select=*`).catch(() => null);
  if (!full?.length) {
    console.log(`${label} Chosen row vanished — retry next run.`);
    return null;
  }
  const puzzle = full[0];

  await patchFn(`puzzle?id=eq.${puzzle.id}`, {
    [cfg.pollCol]: cfg.claimVal,
    is_rendered: true,
    updated_at: new Date().toISOString(),
  }).catch(() => {});

  console.log(`${label} Claimed: "${puzzle.topic}" id=${puzzle.id} format=${format}`);
  return { puzzle, cfg };
}

async function markPuzzleDone(patchFn, puzzleId, cfg, videoUrl = null) {
  const patch = {
    [cfg.pollCol]: cfg.doneVal,
    is_rendered: true, // defensive — should already be true from the claim step
    updated_at: new Date().toISOString(),
  };
  if (videoUrl) patch[cfg.videoUrlCol] = videoUrl;
  await patchFn(`puzzle?id=eq.${puzzleId}`, patch).catch(async () => {
    await patchFn(`puzzle?id=eq.${puzzleId}`, {
      [cfg.pollCol]: cfg.doneVal,
      is_rendered: true,
      updated_at: new Date().toISOString(),
    }).catch(() => {});
  });
}

async function markPuzzleError(patchFn, puzzleId, cfg, errMsg) {
  // Release the cross-format lock — this row never actually became a video,
  // so any format (this one on retry, or another one) should still be able
  // to claim it. Leaving is_rendered=true here would permanently strand rows
  // that fail their very first render attempt.
  await patchFn(`puzzle?id=eq.${puzzleId}`, {
    [cfg.pollCol]: cfg.errorVal,
    is_rendered: false,
    generation_error: `[puzzle-${cfg.pollCol}] ${String(errMsg).slice(0, 700)}`,
    updated_at: new Date().toISOString(),
  }).catch(() => {});
}

module.exports = { pollPuzzleFormat, markPuzzleDone, markPuzzleError, PUZZLE_FORMAT_CONFIG };
