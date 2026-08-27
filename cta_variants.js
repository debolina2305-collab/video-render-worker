'use strict';
// ════════════════════════════════════════════════════════════════════════════
// cta_variants.js — CTA display variation for the puzzle video pipeline
//
// puzzle_template.html's comment-cta-screen (and the mission-impossible bonus
// screen's mi-cta3 block) used to hard-code the exact same icons/wording
// every single render: "👍 LIKE", "🔁 SHARE", "🔔 SUBSCRIBE", "✍️" for the
// CTA4 card. Every video in the channel looked identical at that beat.
//
// This module picks ONE variant per render (deterministically, from the
// quiz/puzzle id, so re-rendering the same row is stable) and the render
// workers inject it into the {{CTA_LIKE_ICON}} / {{CTA_LIKE_TEXT}} /
// {{CTA_SHARE_ICON}} / {{CTA_SHARE_TEXT}} / {{CTA_SUB_ICON}} /
// {{CTA_SUB_TEXT}} / {{CTA4_ICON}} placeholders in puzzle_template.html.
//
// Order (like -> share -> subscribe) is left fixed since it matches viewer
// expectation and the CSS classes (cta-pill-like/-share/-sub) carry distinct
// colors per action — only the icon + wording rotates.
// ════════════════════════════════════════════════════════════════════════════

const CTA_VARIANTS = [
  { likeIcon: '👍', likeText: 'LIKE',              shareIcon: '🔁', shareText: 'SHARE',              subIcon: '🔔', subText: 'SUBSCRIBE',        cta4Icon: '✍️' },
  { likeIcon: '❤️', likeText: 'DOUBLE TAP',         shareIcon: '📤', shareText: 'SEND TO A FRIEND',   subIcon: '🔔', subText: 'FOLLOW',           cta4Icon: '💬' },
  { likeIcon: '👍', likeText: 'SMASH LIKE',         shareIcon: '🔁', shareText: 'SHARE THIS',         subIcon: '⭐', subText: 'FOLLOW FOR MORE',  cta4Icon: '🗨️' },
  { likeIcon: '❤️', likeText: 'LIKE IF YOU GOT IT', shareIcon: '📲', shareText: 'TAG A FRIEND',        subIcon: '🔔', subText: 'SUBSCRIBE NOW',    cta4Icon: '✍️' },
  { likeIcon: '👍', likeText: 'LIKE',               shareIcon: '🔗', shareText: 'SHARE THE CHALLENGE',subIcon: '🔔', subText: 'JOIN THE CLUB',    cta4Icon: '💭' },
  { likeIcon: '🔥', likeText: 'LIKE THIS',          shareIcon: '🔁', shareText: 'REPOST IT',           subIcon: '🔔', subText: 'HIT SUBSCRIBE',    cta4Icon: '✍️' },
  { likeIcon: '👍', likeText: 'DROP A LIKE',        shareIcon: '📤', shareText: 'SHARE WITH A FRIEND', subIcon: '⭐', subText: 'FOLLOW ALONG',    cta4Icon: '💬' },
];

// Simple deterministic hash of the id string so the SAME puzzle row always
// gets the SAME variant if re-rendered, but different rows spread across
// the whole pool.
function hashSeed(id) {
  const s = String(id || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

function pickCtaVariant(id) {
  const idx = hashSeed(id) % CTA_VARIANTS.length;
  return CTA_VARIANTS[idx];
}

// Builds the {{...}} -> value map for puzzle_template.html's CTA placeholders.
// `forceFollow` (used by the short-nointro variant, which historically
// rewrote "SUBSCRIBE" -> "FOLLOW AND SUBSCRIBE") ensures the word FOLLOW is
// present in the subscribe pill regardless of which variant was picked.
function ctaVariantVars(id, opts = {}) {
  const v = pickCtaVariant(id);
  let subText = v.subText;
  if (opts.forceFollow && !/FOLLOW/i.test(subText)) {
    subText = `FOLLOW AND ${subText}`;
  }
  return {
    '{{CTA_LIKE_ICON}}':  v.likeIcon,
    '{{CTA_LIKE_TEXT}}':  v.likeText,
    '{{CTA_SHARE_ICON}}': v.shareIcon,
    '{{CTA_SHARE_TEXT}}': v.shareText,
    '{{CTA_SUB_ICON}}':   v.subIcon,
    '{{CTA_SUB_TEXT}}':   subText,
    '{{CTA4_ICON}}':      v.cta4Icon,
  };
}

module.exports = { CTA_VARIANTS, pickCtaVariant, ctaVariantVars };
