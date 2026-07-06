'use strict';
const fs   = require('fs').promises;
const path = require('path');

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────
const supabaseUrl   = process.env.SUPABASE_URL;
const supabaseKey   = process.env.SUPABASE_SERVICE_KEY;
const FB_PAGE_ID    = process.env.FB_PAGE_ID;          // numeric Page ID
const FB_PAGE_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN; // permanent page token

console.log('SUPABASE_URL:',         supabaseUrl ? supabaseUrl.slice(0,40)+'...' : 'NOT SET');
console.log('SUPABASE_SERVICE_KEY:', supabaseKey  ? '*** (set)' : 'NOT SET');
console.log('FB_PAGE_ID:',           FB_PAGE_ID   ? FB_PAGE_ID  : 'NOT SET');
console.log('FB_PAGE_ACCESS_TOKEN:', FB_PAGE_TOKEN ? '*** (set)' : 'NOT SET');

const cleanUrl = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;
if (!cleanUrl || !supabaseKey)   { console.error('[FATAL] Missing Supabase credentials'); process.exit(1); }
if (!FB_PAGE_ID || !FB_PAGE_TOKEN) { console.error('[FATAL] Missing Facebook credentials'); process.exit(1); }

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
const NICHE_DESC = {

  general: `🧠 Can you answer this in 10 seconds?

Test your knowledge on what's TRENDING in America right now — one question, one chance, one winner.

💡 Play the FULL challenge & earn ONS tokens → jaasblog.online

#Quiz #Trivia #USAChallenge #Trending #TrendingNow #QuizTime #Challenge #Viral`,

  sports: `🏆 Sports fans — how sharp is your game knowledge?

One trending sports question. 10 seconds. Can you beat it?

💡 Play the full sports challenge → jaasblog.online/quiz/sports

#SportsQuiz #SportsTrivia #USASports #QuizChallenge #Trending #Sports #NFL #NBA #Soccer #Viral`,

  finance: `💰 Your financial IQ is being tested — RIGHT NOW.

Markets. Crypto. Stocks. One question from today's trending headlines.

💡 Play the full finance challenge → jaasblog.online/quiz/finance

#FinanceQuiz #MoneyTrivia #CryptoQuiz #StockMarket #USAFinance #Trending #Viral #QuizChallenge`,

  tech: `💻 Can you keep up with today's tech world?

One question. Trending right now in American tech. 10 seconds to answer.

💡 Play the full tech challenge → jaasblog.online/quiz/tech

#TechQuiz #AIChallenge #TechTrending #USATech #Gadgets #Viral #QuizTime #Trending`,

  entertainment: `🎬 Pop culture. Movies. Music. TV. All trending.

Think you know your entertainment? Prove it in 10 seconds.

💡 Play the full entertainment challenge → jaasblog.online/quiz/entertainment

#EntertainmentQuiz #PopCulture #MovieTrivia #MusicQuiz #TVQuiz #Trending #Viral #USAEntertainment`,

  news: `📰 The world is moving fast — are YOU keeping up?

One question from today's biggest US news story.

💡 Play the full news challenge → jaasblog.online/quiz/news

#NewsQuiz #BreakingNews #USANews #CurrentEvents #Trending #Viral #QuizChallenge #TrendingNow`,

  health: `🏥 How much do you REALLY know about health?

One question from today's trending health headline. 10 seconds.

💡 Play the full health challenge → jaasblog.online/quiz/health

#HealthQuiz #WellnessChallenge #MedicalTrivia #USAHealth #Trending #Viral #QuizTime #HealthTips`,

};

// ─────────────────────────────────────────────
// BUILD Facebook post description
// ─────────────────────────────────────────────
function buildDescription(quiz) {
  const niche      = (quiz.niche || 'general').toLowerCase();
  const nicheFixed = NICHE_DESC[niche] || NICHE_DESC.general;
  const title      = (quiz.youtube_title || quiz.topic || '').trim();
  const quizNo     = quiz.quiz_no     || '';
  const nicheNo    = quiz.niche_challenge_no || '';
  const kwRaw      = (quiz.trend_keywords || '').split(',').map(t => t.trim()).filter(Boolean);

  // Extra hashtags from trend keywords (top 5, cleaned)
  const trendTags = kwRaw
    .slice(0, 5)
    .map(k => '#' + k.replace(/[^a-zA-Z0-9]/g, '').slice(0, 25))
    .filter(h => h.length > 2)
    .join(' ');

  const lines = [
    title ? `❓ ${title}` : '',
    '',
    nicheFixed,
    '',
    trendTags,
    '',
    `Challenge ID: ${quizNo} | US Trending Challenge #${nicheNo}`,
  ].filter(l => l !== undefined);

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
  console.log(`[FB] Step 1 — initialising Reels upload session (${(fileSize/1024/1024).toFixed(2)} MB)...`);
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
  console.log(`[FB] Step 1 ✓ — video_id=${video_id}`);

  // ── STEP 2: Binary upload ───────────────────────────────────────────────────
  console.log(`[FB] Step 2 — uploading binary...`);
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
  console.log(`[FB] Step 2 ✓ — binary upload complete`);

  // ── STEP 3: Finish + publish ────────────────────────────────────────────────
  console.log(`[FB] Step 3 — publishing Reel...`);
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
  console.log(`[FB] Step 3 ✓ — published: ${fbReelUrl}`);
  return { videoId: video_id, fbReelUrl };
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function processPublish() {

  // Random startup delay: 1–6 minutes (same anti-detection pattern as worker11)
  const delayMs  = (60 + Math.floor(Math.random() * 300)) * 1000;
  const delayMin = (delayMs / 60000).toFixed(1);
  console.log(`[FB-PUBLISHER] Random startup delay: ${delayMin} min (anti-detection)`);
  await new Promise(r => setTimeout(r, delayMs));

  console.log('[FB-PUBLISHER] Checking for approved videos to publish to Facebook...');

  // Poll for quiz rows that are:
  //  - rendered (video exists in R2)
  //  - human approved
  //  - not yet posted to Facebook  (fb_video_id IS NULL)
  //  - is_active = true
  // Note: we publish to Facebook regardless of YouTube publish status —
  // FB and YT pipelines are independent. A video can go to FB before YT
  // or after, whichever publishes first.
  const rows = await fetchSupabase(
    'quiz?video_status=eq.rendered' +
    '&is_human_approved=eq.true' +
    '&is_active=eq.true' +
    '&fb_video_id=is.null' +
    '&select=*&order=created_at.asc&limit=1'
  );

  if (!rows?.length) {
    console.log('[FB-PUBLISHER] No approved videos ready for Facebook.');
    return;
  }

  const quiz = rows[0];
  console.log(`[FB-PUBLISHER] Publishing: ${quiz.id} — "${quiz.topic}"`);
  console.log(`[FB-PUBLISHER] video_url=${quiz.video_url}`);

  if (!quiz.video_url) {
    console.error('[FB-PUBLISHER] video_url is NULL — cannot publish without video file in R2');
    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        generation_error: 'fb_publish: video_url is null',
        updated_at: new Date().toISOString()
      })
    }).catch(() => {});
    return;
  }

  // Mark as fb_publishing to prevent duplicate runs if workflow fires again
  await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fb_publish_status: 'publishing',
      updated_at: new Date().toISOString()
    })
  });

  const videoPath = `/tmp/${quiz.id}_fb.mp4`;

  try {
    // 1. Download video from R2
    await downloadVideo(quiz.video_url, videoPath);

    // 2. Build description
    const description = buildDescription(quiz);
    console.log(`[FB-PUBLISHER] Description preview:\n${description.slice(0, 200)}...`);

    // 3. Upload to Facebook as Reel
    const { videoId, fbReelUrl } = await uploadToFacebook(videoPath, description);

    // 4. Update Supabase — mark as published to Facebook
    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
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
    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
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
