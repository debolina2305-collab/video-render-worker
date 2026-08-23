'use strict';
const fs   = require('fs').promises;
const path = require('path');

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────
const supabaseUrl   = process.env.SUPABASE_URL;
const supabaseKey   = process.env.SUPABASE_SERVICE_KEY;
const FB_PAGE_ID    = process.env.FACEBOOK_PAGE_ID;          // <- changed from FB_PAGE_ID to FACEBOOK_PAGE_ID
const FB_PAGE_TOKEN = process.env.FACEBOOK_ACCESS_TOKEN;     // <- changed from FB_PAGE_ACCESS_TOKEN to FACEBOOK_ACCESS_TOKEN

console.log('SUPABASE_URL:',         supabaseUrl ? supabaseUrl.slice(0,40)+'...' : 'NOT SET');
console.log('SUPABASE_SERVICE_KEY:', supabaseKey  ? '*** (set)' : 'NOT SET');
console.log('FACEBOOK_PAGE_ID:',           FB_PAGE_ID   ? FB_PAGE_ID  : 'NOT SET');
console.log('FACEBOOK_ACCESS_TOKEN:', FB_PAGE_TOKEN ? '*** (set)' : 'NOT SET');

const cleanUrl = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;
if (!cleanUrl || !supabaseKey)   { console.error('[FATAL] Missing Supabase credentials'); process.exit(1); }
if (!FB_PAGE_ID || !FB_PAGE_TOKEN) { console.error('[FATAL] Missing Facebook credentials'); process.exit(1); }

// Picks a random entry from an array of pre-written variants — see the same
// helper in puzzle_publisher_youtube.js for the full rationale (avoiding
// byte-identical boilerplate across every post on the channel).
function pickVariant(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ─────────────────────────────────────────────
// SUPABASE HELPERS  (identical pattern to worker11)
// ─────────────────────────────────────────────
async function fetchSupabase(path_, opts = {}) {
  const url    = `${cleanUrl}/rest/v1/${path_}`;
  const method = opts.method || 'GET';
  console.log(`[DB] ${method} ${url.slice(0, 100)}`);
  const res = await fetch(url, {
    method,
    headers: {
      'apikey':        supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type':  'application/json',
      'Prefer':        method === 'POST' ? 'return=representation' : 'return=minimal',
      ...(opts.headers || {})
    },
    body: opts.body
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase ${method} ${path_} → HTTP ${res.status}: ${txt}`);
  }
  const txt = await res.text();
  try { return txt ? JSON.parse(txt) : null; } catch { return txt; }
}

// ─────────────────────────────────────────────
// DOWNLOAD VIDEO from R2  (identical to worker11)
// ─────────────────────────────────────────────
async function downloadVideo(videoUrl, destPath) {
  console.log(`[DOWNLOAD] ${videoUrl.slice(0, 80)}...`);
  const res = await fetch(videoUrl);
  if (!res.ok) throw new Error(`Video download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(destPath, buf);
  const stat = await fs.stat(destPath);
  console.log(`[DOWNLOAD] OK — ${(stat.size / 1024 / 1024).toFixed(2)} MB`);
  return destPath;
}

// ─────────────────────────────────────────────
// NICHE-SPECIFIC FACEBOOK DESCRIPTIONS
// Facebook Reels performs best with:
//  - 3–5 lines max (mobile-first reading)
//  - strong first line (shown before "see more")
//  - clear CTA with link
//  - hashtags at bottom (FB algorithm uses them)
// ─────────────────────────────────────────────
// NOTE: same issue as puzzle_publisher_youtube.js — niche is always 'brain'
// for this pipeline and there was no 'brain' key, so every FB Reel got the
// exact same 'general' paragraph. Now an array; buildDescription() picks
// one at random via pickVariant().
// NOTE: niche is always 'brain' for this pipeline — FB_BRAIN_VARIANTS is
// the pool actually used on every single post. Bumped to 10 variants.
const FB_BRAIN_VARIANTS = [
`🧠 Can you answer this in 10 seconds?

Test your knowledge on what's TRENDING in America right now — one question, one chance, one winner.

💡 Play the FULL challenge & earn ONS tokens → jaasblog.online

#Quiz #Trivia #USAChallenge #Trending #TrendingNow #QuizTime #Challenge #Viral`,
`🧠 Think you can beat this one?

A new brain challenge every day — built from what's actually trending, right now.

💡 Play the full version & earn ONS tokens → jaasblog.online

#Quiz #Trivia #BrainChallenge #Trending #QuizTime #Challenge #Viral`,
`🧠 10 seconds. One question. Are you in?

JaasX drops a fresh puzzle daily — some easy, some sneaky. This one's for you to find out.

💡 Play the full challenge & earn ONS tokens → jaasblog.online

#Quiz #Trivia #Puzzle #Trending #QuizTime #Challenge #Viral`,
`🧠 Most people get this wrong the first time.

Every day, a new puzzle built from real trending topics — think it through before you answer.

💡 Play the full challenge & earn ONS tokens → jaasblog.online

#Quiz #Trivia #BrainTeaser #Trending #QuizTime #Challenge #Viral`,
`🧠 This one looks easy. It usually isn't.

JaasX posts a brand-new brain challenge every single day — take your best shot.

💡 Play the full challenge & earn ONS tokens → jaasblog.online

#Quiz #Trivia #MindGame #Trending #QuizTime #Challenge #Viral`,
`🧠 Stop scrolling — 10 seconds, one question.

A fresh puzzle every day, pulled straight from what's trending right now.

💡 Play the full challenge & earn ONS tokens → jaasblog.online

#Quiz #Trivia #DailyChallenge #Trending #QuizTime #Viral`,
`🧠 Smart people get tripped up by this one.

JaasX Brain Challenge tests real-world knowledge, one quick question at a time.

💡 Play the full challenge & earn ONS tokens → jaasblog.online

#Quiz #Trivia #BrainChallenge #Trending #QuizTime #Viral`,
`🧠 One puzzle. Ten seconds. No do-overs.

A new brain teaser every day — some are quick wins, some are traps.

💡 Play the full challenge & earn ONS tokens → jaasblog.online

#Quiz #Trivia #Puzzle #Trending #QuizTime #Challenge`,
`🧠 Here's today's challenge — can you crack it?

Quick logic, everyday knowledge, one solid puzzle. Lock in your answer.

💡 Play the full challenge & earn ONS tokens → jaasblog.online

#Quiz #Trivia #BrainTeaser #Trending #QuizChallenge #Viral`,
`🧠 Slow down — this one rewards a second look.

Looks obvious, plays a little sneaky. New puzzle daily.

💡 Play the full challenge & earn ONS tokens → jaasblog.online

#Quiz #Trivia #MindGame #Trending #QuizTime #Challenge`,
];

const NICHE_DESC = {

  general: FB_BRAIN_VARIANTS,

  brain: FB_BRAIN_VARIANTS,

  sports: [
`🏆 Sports fans — how sharp is your game knowledge?

One trending sports question. 10 seconds. Can you beat it?

💡 Play the full sports challenge → jaasblog.online/quiz/sports

#SportsQuiz #SportsTrivia #USASports #QuizChallenge #Trending #Sports #NFL #NBA #Soccer #Viral`,
  ],

  finance: [
`💰 Your financial IQ is being tested — RIGHT NOW.

Markets. Crypto. Stocks. One question from today's trending headlines.

💡 Play the full finance challenge → jaasblog.online/quiz/finance

#FinanceQuiz #MoneyTrivia #CryptoQuiz #StockMarket #USAFinance #Trending #Viral #QuizChallenge`,
  ],

  tech: [
`💻 Can you keep up with today's tech world?

One question. Trending right now in American tech. 10 seconds to answer.

💡 Play the full tech challenge → jaasblog.online/quiz/tech

#TechQuiz #AIChallenge #TechTrending #USATech #Gadgets #Viral #QuizTime #Trending`,
  ],

  entertainment: [
`🎬 Pop culture. Movies. Music. TV. All trending.

Think you know your entertainment? Prove it in 10 seconds.

💡 Play the full entertainment challenge → jaasblog.online/quiz/entertainment

#EntertainmentQuiz #PopCulture #MovieTrivia #MusicQuiz #TVQuiz #Trending #Viral #USAEntertainment`,
  ],

  news: [
`📰 The world is moving fast — are YOU keeping up?

One question from today's biggest US news story.

💡 Play the full news challenge → jaasblog.online/quiz/news

#NewsQuiz #BreakingNews #USANews #CurrentEvents #Trending #Viral #QuizChallenge #TrendingNow`,
  ],

  health: [
`🏥 How much do you REALLY know about health?

One question from today's trending health headline. 10 seconds.

💡 Play the full health challenge → jaasblog.online/quiz/health

#HealthQuiz #WellnessChallenge #MedicalTrivia #USAHealth #Trending #Viral #QuizTime #HealthTips`,
  ],

};

// ─────────────────────────────────────────────
// BUILD Facebook post description
//
// FB ALGORITHM STRATEGY:
//   Facebook uses keywords in Reels descriptions to categorise and
//   distribute content to relevant audiences — exactly like YouTube.
//   ALL trending keywords must appear in the description, not just a few.
//
//   FB description structure (optimised for reach):
//     Line 1:   Hook question (stops the scroll)
//     Line 2:   ALL trending keywords — FB reads first ~130 chars heavily
//     Line 3:   CTA with link
//     ...       Niche block, explanation, hashtags
//
//   FB Reels description limit: 2200 chars.
// ─────────────────────────────────────────────
function buildDescription(quiz) {
  const niche      = (quiz.niche || 'general').toLowerCase();
  const nicheFixed = pickVariant(NICHE_DESC[niche] || NICHE_DESC.general);
  const title      = (quiz.youtube_title || quiz.topic || '').trim();
  const quizNo     = quiz.quiz_no     || '';
  const nicheNo    = quiz.niche_challenge_no || '';
  const kwRaw      = (quiz.trend_keywords || '').split(',').map(t => t.trim()).filter(Boolean);

  // ALL trending keywords as bullet line — FB algorithm keyword signal
  const trendingSentence = kwRaw.length
    ? `🔍 Trending: ${kwRaw.join(' • ')}`
    : '';

  // ALL trending keywords as hashtags — FB hashtag distribution signal
  // Use ALL keywords, not just top 5
  const trendHashtags = kwRaw
    .map(k => '#' + k.replace(/[^a-zA-Z0-9]/g, '').slice(0, 25))
    .filter(h => h.length > 2)
    .join(' ');

  // Rotating hook prefix + CTA line — previously static strings repeated on
  // every single post.
  const hookEmoji = pickVariant(['❓', '🤔', '👀', '🧠', '⚡', '💭', '🔥', '🎯']);
  const ctaLine = pickVariant([
    `💡 Play the full challenge → jaasblog.online/quiz/${niche}`,
    `💡 Want the interactive version? → jaasblog.online/quiz/${niche}`,
    `💡 Full challenge + ONS tokens → jaasblog.online/quiz/${niche}`,
    `💡 Play it for real (and earn ONS tokens) → jaasblog.online/quiz/${niche}`,
    `💡 There's a playable version → jaasblog.online/quiz/${niche}`,
    `💡 Prefer to play than watch? → jaasblog.online/quiz/${niche}`,
    `💡 Get the full experience → jaasblog.online/quiz/${niche}`,
  ]);

  const lines = [
    // ── Line 1: Hook (scroll-stopper) ──
    title ? `${hookEmoji} ${title}` : '',
    ``,
    // ── Line 2: ALL trending keywords (FB algorithm reads this first) ──
    trendingSentence,
    ``,
    // ── Line 3: CTA with link ──
    ctaLine,
    ``,
    // ── Niche block ──
    nicheFixed,
    ``,
    // ── Explanation (unique content per Reel — good for reach) ──
    quiz.explanation_1 ? `📚 ${quiz.explanation_1}` : '',
    ``,
    // ── Identity + challenge number ──
    `Challenge ID: ${quizNo} | US Trending Challenge #${nicheNo}`,
    ``,
    // ── ALL trending keywords as hashtags ──
    trendHashtags,
  ].filter(l => l !== null && l !== undefined && l !== false);

  return lines.join('\n').trim().slice(0, 2200); // FB Reels description limit
}

// ─────────────────────────────────────────────
// FACEBOOK GRAPH API — Reels upload (3-step)
//
// Facebook Reels video upload flow:
//   Step 1: POST /{page-id}/video_reels  → start upload session → upload_url + video_id
//   Step 2: POST <upload_url>            → binary upload of the mp4 file
//   Step 3: POST /{page-id}/video_reels  → finish/publish with description
//
// Docs: https://developers.facebook.com/docs/video-api/guides/reels-publishing
// ─────────────────────────────────────────────
async function uploadToFacebook(videoPath, description) {
  const stat     = await fs.stat(videoPath);
  const fileSize = stat.size;
  const baseUrl  = `https://graph.facebook.com/v21.0/${FB_PAGE_ID}`;

  // ── STEP 1: Initialise upload session ──────────────────────────────────────
  console.log(`[PZ-FB] Step 1 — initialising Reels upload session (${(fileSize/1024/1024).toFixed(2)} MB)...`);
  const initRes = await fetch(`${baseUrl}/video_reels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upload_phase:   'start',
      access_token:   FB_PAGE_TOKEN,
      file_size:      fileSize,
    })
  });
  const initData = await initRes.json();
  if (!initRes.ok || initData.error) {
    throw new Error(`FB init upload failed: ${JSON.stringify(initData)}`);
  }
  const { upload_url, video_id } = initData;
  if (!upload_url || !video_id) {
    throw new Error(`FB init missing upload_url or video_id: ${JSON.stringify(initData)}`);
  }
  console.log(`[PZ-FB] Step 1 ✓ — video_id=${video_id}`);

  // ── STEP 2: Binary upload ───────────────────────────────────────────────────
  console.log(`[PZ-FB] Step 2 — uploading binary...`);
  const videoBuf = await fs.readFile(videoPath);
  const uploadRes = await fetch(upload_url, {
    method:  'POST',
    headers: {
      'Authorization':          `OAuth ${FB_PAGE_TOKEN}`,
      'Content-Type':           'application/octet-stream',
      'Content-Length':         String(fileSize),
      'file_size':              String(fileSize),
      'offset':                 '0',
    },
    body: videoBuf
  });
  const uploadData = await uploadRes.json();
  if (!uploadRes.ok || uploadData.error) {
    throw new Error(`FB binary upload failed: ${JSON.stringify(uploadData)}`);
  }
  // Success response contains h (bytes received) — verify full file uploaded
  if (uploadData.h !== undefined && uploadData.h < fileSize) {
    throw new Error(`FB upload incomplete: received ${uploadData.h} of ${fileSize} bytes`);
  }
  console.log(`[PZ-FB] Step 2 ✓ — binary upload complete`);

  // ── STEP 3: Finish + publish ────────────────────────────────────────────────
  console.log(`[PZ-FB] Step 3 — publishing Reel...`);
  const finishRes = await fetch(`${baseUrl}/video_reels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      upload_phase:    'finish',
      access_token:    FB_PAGE_TOKEN,
      video_id,
      video_state:     'PUBLISHED',       // publish immediately
      description,
      title:           description.split('\n')[0].replace(/^[^\w]*/,'').slice(0, 255),
    })
  });
  const finishData = await finishRes.json();
  if (!finishRes.ok || finishData.error) {
    throw new Error(`FB publish failed: ${JSON.stringify(finishData)}`);
  }
  const fbReelUrl = `https://www.facebook.com/reel/${video_id}`;
  console.log(`[PZ-FB] Step 3 ✓ — published: ${fbReelUrl}`);
  return { videoId: video_id, fbReelUrl };
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function processPublish() {

  // Random startup delay: 1–6 minutes (same anti-detection pattern as worker11)
  // const delayMs  = (60 + Math.floor(Math.random() * 300)) * 1000;
  // const delayMin = (delayMs / 60000).toFixed(1);
  // console.log(`[FB-PUBLISHER] Random startup delay: ${delayMin} min (anti-detection)`);
  // await new Promise(r => setTimeout(r, delayMs));

  console.log('[FB-PUBLISHER] Checking for approved videos to publish to Facebook...');

  // Poll across ALL FOUR formats' own status column — short_status,
  // medium_status, long_status, micro_status — instead of only short_status.
  // Previously medium/long/micro rows were completely invisible to the
  // Facebook publisher even when done + approved.
  const rows = await fetchSupabase(
    'puzzle?or=(short_status.eq.done_short,medium_status.eq.done_medium,long_status.eq.done_long,micro_status.eq.done_micro)' +
    '&is_human_approved=eq.true' +
    '&is_active=eq.true' +
    '&fb_video_id=is.null' +
    '&select=*&order=created_at.desc&limit=1'
  );

  if (!rows?.length) {
    console.log('[FB-PUBLISHER] No approved videos ready for Facebook.');
    return;
  }

  const quiz = rows[0];
  console.log(`[FB-PUBLISHER] Publishing: ${quiz.id} — "${quiz.topic}"`);
  // Resolve the video URL for whichever format this row actually is:
  //   short  → short_video_url   medium → medium_video_url
  //   long   → video_url         micro  → micro_video_url
  const videoUrlToUse = quiz.short_video_url || quiz.medium_video_url || quiz.video_url || quiz.micro_video_url;
  console.log(`[FB-PUBLISHER] video_url=${videoUrlToUse}`);

  if (!videoUrlToUse) {
    console.error('[FB-PUBLISHER] video url is NULL — cannot publish without video file in R2');
    await fetchSupabase(`puzzle?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        generation_error: 'fb_publish: video url is null',
        updated_at: new Date().toISOString()
      })
    }).catch(() => {});
    return;
  }

  // Mark as fb_publishing to prevent duplicate runs if workflow fires again
  await fetchSupabase(`puzzle?id=eq.${quiz.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fb_publish_status: 'publishing',
      updated_at: new Date().toISOString()
    })
  });

  const videoPath = `/tmp/${quiz.id}_fb.mp4`;

  try {
    // 1. Download video from R2 (whichever format's URL this row resolved to)
    await downloadVideo(videoUrlToUse, videoPath);

    // 2. Build description
    const description = buildDescription(quiz);
    console.log(`[FB-PUBLISHER] Description preview:\n${description.slice(0, 200)}...`);

    // 3. Upload to Facebook as Reel
    const { videoId, fbReelUrl } = await uploadToFacebook(videoPath, description);

    // 4. Update Supabase — mark as published to Facebook
    await fetchSupabase(`puzzle?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        fb_video_id:       videoId,
        fb_reel_url:       fbReelUrl,
        fb_publish_status: 'published',
        fb_published_at:   new Date().toISOString(),
        updated_at:        new Date().toISOString()
      })
    });

    console.log(`[FB-PUBLISHER] ✓ Published to Facebook: ${fbReelUrl}`);

  } catch (e) {
    console.error(`[FB-PUBLISHER] FAILED: ${e.message}`);
    // Reset so it can be retried
    await fetchSupabase(`puzzle?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        fb_publish_status: 'failed',
        generation_error:  `fb_publish failed: ${e.message}`,
        updated_at:        new Date().toISOString()
      })
    }).catch(() => {});
    process.exit(1);
  } finally {
    await fs.unlink(videoPath).catch(() => {});
  }
}

processPublish()
  .then(() => { console.log('[FB-PUBLISHER] Done.'); process.exit(0); })
  .catch(err => { console.error('[FB-PUBLISHER] Fatal:', err); process.exit(1); });
