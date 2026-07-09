'use strict';
// ════════════════════════════════════════════════════════════════
// formatAssigner.js — shared polling helpers for all render workers
//
// Each render worker (short / medium / long) calls pollMyFormat()
// at startup to claim one row assigned to its own format.
// No format ever sees rows assigned to another format.
// ════════════════════════════════════════════════════════════════

const FORMAT_CONFIG = {
  short: {
    pollCol:     'short_status',
    pendingVal:  'pending_short',
    claimVal:    'rendering_short',
    doneVal:     'done_short',
    errorVal:    'error_short',
    videoUrlCol: 'short_video_url',
  },
  medium: {
    pollCol:     'medium_status',
    pendingVal:  'pending_medium',
    claimVal:    'rendering_medium',
    doneVal:     'done_medium',
    errorVal:    'error_medium',
    videoUrlCol: 'medium_video_url',
  },
  long: {
    pollCol:     'long_status',
    pendingVal:  'pending_long',
    claimVal:    'rendering_long',
    doneVal:     'done_long',
    errorVal:    'error_long',
    videoUrlCol: 'video_url',   // long format keeps the original column name
  },
};

/**
 * Poll for one pending row assigned to `format` and claim it.
 *
 * @param {Function} fetchFn   - async (pathString) => parsed JSON rows
 * @param {Function} patchFn   - async (pathString, body) => void
 * @param {string}   format    - 'short' | 'medium' | 'long'
 * @param {string}   [label]   - log prefix, e.g. '[SHORT-WORKER]'
 * @returns {{ quiz: object, cfg: object } | null}
 *   quiz = the full quiz row
 *   cfg  = the FORMAT_CONFIG entry for this format (col names, status values)
 */
async function pollMyFormat(fetchFn, patchFn, format, label = '[WORKER]') {
  const cfg = FORMAT_CONFIG[format];
  if (!cfg) throw new Error(`Unknown format "${format}". Must be short | medium | long.`);

  console.log(`${label} Polling format="${format}" column="${cfg.pollCol}"="${cfg.pendingVal}"`);

  // Also reset any stuck rows (claiming ran >30 min ago without completion)
  try {
    const stuckCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const stuckRows = await fetchFn(
      `quiz?${cfg.pollCol}=eq.${cfg.claimVal}&is_active=eq.true` +
      `&updated_at=lt.${stuckCutoff}&select=id&limit=5`
    ).catch(() => null);
    if (stuckRows?.length) {
      console.log(`${label} Resetting ${stuckRows.length} stuck ${format} rows`);
      for (const r of stuckRows) {
        await patchFn(`quiz?id=eq.${r.id}`, {
          [cfg.pollCol]: cfg.pendingVal,
          updated_at: new Date().toISOString(),
        }).catch(() => {});
      }
    }
  } catch {}

  // Poll for oldest pending row for this format
  const rows = await fetchFn(
    `quiz?${cfg.pollCol}=eq.${cfg.pendingVal}` +
    `&is_active=eq.true&quiz_enriched=eq.true` +
    `&order=created_at.asc&limit=1&select=*`
  ).catch(() => null);

  if (!rows?.length) {
    console.log(`${label} Nothing to render for format="${format}".`);
    return null;
  }

  const quiz = rows[0];
  console.log(`${label} Claimed: "${quiz.topic}" id=${quiz.id} format=${format}`);

  // Claim the row atomically — any parallel runner that polls the same
  // column will see 'rendering_*' and skip this row
  await patchFn(`quiz?id=eq.${quiz.id}`, {
    [cfg.pollCol]: cfg.claimVal,
    updated_at: new Date().toISOString(),
  }).catch(() => {});

  return { quiz, cfg };
}

/**
 * Mark the row as successfully rendered.
 * @param {Function} patchFn
 * @param {string}   quizId
 * @param {object}   cfg         - FORMAT_CONFIG entry
 * @param {string|null} videoUrl - R2 URL (or null)
 */
async function markDone(patchFn, quizId, cfg, videoUrl = null) {
  const patch = {
    [cfg.pollCol]: cfg.doneVal,
    updated_at: new Date().toISOString(),
  };
  if (videoUrl) patch[cfg.videoUrlCol] = videoUrl;

  await patchFn(`quiz?id=eq.${quizId}`, patch).catch(async () => {
    // Fall back without videoUrl if the column doesn't exist yet
    await patchFn(`quiz?id=eq.${quizId}`, {
      [cfg.pollCol]: cfg.doneVal,
      updated_at: new Date().toISOString(),
    }).catch(() => {});
  });
}

/**
 * Mark the row as failed.
 * @param {Function} patchFn
 * @param {string}   quizId
 * @param {object}   cfg
 * @param {string}   errMsg
 */
async function markError(patchFn, quizId, cfg, errMsg) {
  await patchFn(`quiz?id=eq.${quizId}`, {
    [cfg.pollCol]: cfg.errorVal,
    generation_error: `[${cfg.pollCol}] ${String(errMsg).slice(0, 700)}`,
    updated_at: new Date().toISOString(),
  }).catch(() => {});
}

module.exports = { pollMyFormat, markDone, markError, FORMAT_CONFIG };
