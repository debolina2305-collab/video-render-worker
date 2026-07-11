'use strict';
// ════════════════════════════════════════════════════════════════
// formatAssigner.js — shared polling helpers for all render workers
//
// Each render worker (short / medium / long) calls pollMyFormat()
// at startup to claim ONE row assigned to its own format.
// No format ever sees rows assigned to another format.
//
// TOPIC-FIRST DEDUP (single source of truth for all three formats):
// Worker 8 inserts several quiz rows per trending topic (q1, q2, q3…),
// each a separate row that shares the same raw `topic` string but a
// different topic_slug. assign_video_format() round-robins a format to
// each row, so ONE topic can produce >1 pending row for the SAME format.
//
//   RULE 1  Always pick the NEWEST topic first (freshest trending first).
//   RULE 2  Render only ONE video per topic per run — the newest row for
//           that topic. Mark every OTHER pending row for the same topic as
//           'skipped_<format>' so they don't clog the queue.
//   RULE 3  Only fall back to a skipped/second row for a topic when there
//           is NO fresher topic waiting (i.e. nothing pending at all).
//
// Everything below is scoped to THIS format's own status column
// (short_status / medium_status / long_status) and its own done/skip
// values, so the three workers never fight over the same rows.
// ════════════════════════════════════════════════════════════════

const FORMAT_CONFIG = {
  short: {
    pollCol:     'short_status',
    pendingVal:  'pending_short',
    claimVal:    'rendering_short',
    doneVal:     'done_short',
    errorVal:    'error_short',
    skipVal:     'skipped_short',   // other rows for the same topic parked here
    videoUrlCol: 'short_video_url',
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
    videoUrlCol: 'video_url',   // long format keeps the original column name
  },
};

// Normalise a topic string so "Argentina vs. Brazil" and "argentina vs brazil"
// group together. Grouping is by raw topic (NOT topic_slug — slugs differ per
// question: base-q1, base-q2…).
function _normTopic(t) {
  return (t || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Poll for one pending row assigned to `format`, applying the topic-first
 * dedup rules, and claim it.
 *
 * @param {Function} fetchFn   - async (pathString) => parsed JSON rows (GET)
 * @param {Function} patchFn   - async (pathString, bodyObject) => void (PATCH)
 * @param {string}   format    - 'short' | 'medium' | 'long'
 * @param {string}   [label]   - log prefix, e.g. '[SHORT-WORKER]'
 * @returns {{ quiz: object, cfg: object } | null}
 */
async function pollMyFormat(fetchFn, patchFn, format, label = '[WORKER]') {
  const cfg = FORMAT_CONFIG[format];
  if (!cfg) throw new Error(`Unknown format "${format}". Must be short | medium | long.`);

  console.log(`${label} Polling format="${format}" column="${cfg.pollCol}"="${cfg.pendingVal}"`);

  // ── Reset stuck rows (claimed >30 min ago without completion) ────────────
  try {
    const stuckCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const stuckRows = await fetchFn(
      `quiz?${cfg.pollCol}=eq.${cfg.claimVal}&is_active=eq.true` +
      `&updated_at=lt.${stuckCutoff}&select=id&limit=5`
    ).catch(() => null);
    if (stuckRows?.length) {
      console.log(`${label} Resetting ${stuckRows.length} stuck ${format} row(s)`);
      for (const r of stuckRows) {
        await patchFn(`quiz?id=eq.${r.id}`, {
          [cfg.pollCol]: cfg.pendingVal,
          updated_at: new Date().toISOString(),
        }).catch(() => {});
      }
    }
  } catch {}

  // ── STEP A — fetch ALL pending rows for THIS format, newest first ────────
  let pendingRows = await fetchFn(
    `quiz?${cfg.pollCol}=eq.${cfg.pendingVal}` +
    `&is_active=eq.true&quiz_enriched=eq.true` +
    `&order=created_at.desc&limit=500` +
    `&select=id,topic,topic_slug,created_at`
  ).catch(() => null);

  // ── RULE 3 fallback — nothing fresh pending: revive newest skipped row ───
  if (!pendingRows?.length) {
    const skipped = await fetchFn(
      `quiz?${cfg.pollCol}=eq.${cfg.skipVal}` +
      `&is_active=eq.true&quiz_enriched=eq.true` +
      `&order=created_at.desc&limit=1&select=id,topic,topic_slug,created_at`
    ).catch(() => null);
    if (skipped?.length) {
      const revive = skipped[0];
      console.log(`${label} No fresh topics — reviving skipped ${format} row: "${revive.topic}" (${revive.id})`);
      await patchFn(`quiz?id=eq.${revive.id}`, {
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

  // ── STEP B — group pending rows by raw topic (Map keeps insertion order,
  //             and rows arrive newest-first, so each group[0] = newest row
  //             and the first-seen topic = newest topic) ────────────────────
  const topicMap = new Map();  // normTopic -> [rows newest first]
  for (const r of pendingRows) {
    const key = _normTopic(r.topic);
    if (!key) continue;
    if (!topicMap.has(key)) topicMap.set(key, []);
    topicMap.get(key).push(r);
  }
  console.log(`${label} ${topicMap.size} distinct topic(s), ${pendingRows.length} pending ${format} row(s)`);

  // ── STEP C — for each topic count rows already DONE for this format ──────
  const doneCounts = {};
  for (const [key, rows] of topicMap) {
    const sample = rows[0];
    const done = await fetchFn(
      `quiz?topic=eq.${encodeURIComponent(sample.topic)}` +
      `&${cfg.pollCol}=eq.${cfg.doneVal}&select=id&limit=50`
    ).catch(() => null);
    doneCounts[key] = done?.length || 0;
  }

  // ── STEP D — sort topics: fewest done first (fresh topics win), then
  //             newest topic first within the same done-count ──────────────
  const sortedTopics = [...topicMap.entries()].sort((a, b) => {
    const diff = (doneCounts[a[0]] ?? 0) - (doneCounts[b[0]] ?? 0);
    if (diff !== 0) return diff;
    return new Date(b[1][0].created_at) - new Date(a[1][0].created_at);
  });

  const [chosenKey, chosenRows] = sortedTopics[0];
  const chosenRow = chosenRows[0];  // newest row for the chosen topic
  console.log(`${label} Selected topic: "${chosenRow.topic}" ` +
    `(${doneCounts[chosenKey] ?? 0} already done, ${chosenRows.length} pending row(s) for it)`);

  // ── STEP E — RULE 2: park every OTHER pending row for the SAME topic ─────
  const others = chosenRows.slice(1);
  if (others.length) {
    console.log(`${label} Skipping ${others.length} other pending row(s) for same topic → ${cfg.skipVal}`);
    for (const r of others) {
      await patchFn(`quiz?id=eq.${r.id}`, {
        [cfg.pollCol]: cfg.skipVal,
        updated_at: new Date().toISOString(),
      }).catch(() => {});
    }
  }

  // ── Fetch the full chosen row, then claim it atomically ─────────────────
  const full = await fetchFn(`quiz?id=eq.${chosenRow.id}&select=*`).catch(() => null);
  if (!full?.length) {
    console.log(`${label} Chosen row vanished — retry next run.`);
    return null;
  }
  const quiz = full[0];

  await patchFn(`quiz?id=eq.${quiz.id}`, {
    [cfg.pollCol]: cfg.claimVal,
    updated_at: new Date().toISOString(),
  }).catch(() => {});

  console.log(`${label} Claimed: "${quiz.topic}" id=${quiz.id} format=${format}`);
  return { quiz, cfg };
}

/**
 * Mark the row as successfully rendered.
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
 */
async function markError(patchFn, quizId, cfg, errMsg) {
  await patchFn(`quiz?id=eq.${quizId}`, {
    [cfg.pollCol]: cfg.errorVal,
    generation_error: `[${cfg.pollCol}] ${String(errMsg).slice(0, 700)}`,
    updated_at: new Date().toISOString(),
  }).catch(() => {});
}

module.exports = { pollMyFormat, markDone, markError, FORMAT_CONFIG };
