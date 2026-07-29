'use strict';
const fs   = require('fs').promises;
const path = require('path');

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────
const supabaseUrl  = process.env.SUPABASE_URL;
const supabaseKey  = process.env.SUPABASE_SERVICE_KEY;
const IG_ACCOUNT_ID = process.env.IG_ACCOUNT_ID;   // Instagram Business Account ID
const IG_TOKEN      = process.env.IG_ACCESS_TOKEN;  // Page Access Token

console.log('SUPABASE_URL:',         supabaseUrl  ? supabaseUrl.slice(0, 40) + '...' : 'NOT SET');
console.log('SUPABASE_SERVICE_KEY:', supabaseKey  ? '*** (set)' : 'NOT SET');
console.log('IG_ACCOUNT_ID:',        IG_ACCOUNT_ID || 'NOT SET');
console.log('IG_ACCESS_TOKEN:',      IG_TOKEN     ? '*** (set)' : 'NOT SET');

const cleanUrl = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;
if (!cleanUrl || !supabaseKey)     { console.error('[FATAL] Missing Supabase credentials'); process.exit(1); }
if (!IG_ACCOUNT_ID || !IG_TOKEN)  { console.error('[FATAL] Missing Instagram credentials'); process.exit(1); }

// ─────────────────────────────────────────────
// SUPABASE HELPERS  (same pattern as facebook publisher)
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
// NICHE-SPECIFIC INSTAGRAM CAPTIONS
// Instagram Reels best practices:
//  - First line is the hook (shown before "more" cut-off ~125 chars)
//  - 3–5 relevant hashtags (IG algorithm prefers focused tags, not 30)
//  - Emojis increase engagement on mobile
//  - Max caption: 2200 chars
// ─────────────────────────────────────────────
const NICHE_CAPTIONS = {

  general: `🧠 Can you answer this in 10 seconds?\n\nTest your brain on what's TRENDING right now — one question, one chance.\n\n💡 Play the full challenge → jaasblog.online\n\n#BrainChallenge #QuizTime #Trending #Trivia #Challenge`,

  brain: `🧠 Think fast — can you crack this?\n\nOne brain-bending question. 10 seconds on the clock. Go!\n\n💡 Full challenge at jaasblog.online\n\n#BrainTeaser #QuizChallenge #MindGame #Trivia #BrainChallenge`,

  sports: `🏆 Sports fans — how sharp is your game IQ?\n\nOne trending sports question. 10 seconds. Can you beat it?\n\n💡 Full sports challenge → jaasblog.online/quiz/sports\n\n#SportsQuiz #SportsTrivia #QuizChallenge #Trending #Sports`,

  finance: `💰 How strong is your financial IQ?\n\nMarkets. Crypto. Stocks. One question from today's trends.\n\n💡 Full finance challenge → jaasblog.online/quiz/finance\n\n#FinanceQuiz #MoneyMindset #CryptoQuiz #StockMarket #Trending`,

  tech: `💻 Can you keep up with today's tech world?\n\nOne trending tech question. 10 seconds to answer.\n\n💡 Full tech challenge → jaasblog.online/quiz/tech\n\n#TechQuiz #AIChallenge #TechTrending #Gadgets #Viral`,

  entertainment: `🎬 Pop culture. Movies. Music. TV. All trending.\n\nThink you know your entertainment? Prove it in 10 seconds.\n\n💡 Full challenge → jaasblog.online/quiz/entertainment\n\n#EntertainmentQuiz #PopCulture #MovieTrivia #MusicQuiz #TVQuiz`,

  news: `📰 The world is moving fast — are YOU keeping up?\n\nOne question from today's biggest headline.\n\n💡 Full news challenge → jaasblog.online/quiz/news\n\n#NewsQuiz #CurrentEvents #Trending #Viral #QuizChallenge`,

  health: `🏥 How much do you REALLY know about health?\n\nOne trending health question. 10 seconds on the clock.\n\n💡 Full health challenge → jaasblog.online/quiz/health\n\n#HealthQuiz #WellnessChallenge #MedicalTrivia #HealthTips #Trending`,
};

// ─────────────────────────────────────────────
// BUILD Instagram caption
// ─────────────────────────────────────────────
function buildCaption(quiz) {
  const niche      = (quiz.niche || 'general').toLowerCase();
  const nicheBlock = NICHE_CAPTIONS[niche] || NICHE_CAPTIONS.general;
  const title      = (quiz.youtube_title || quiz.topic || '').trim();
  const quizNo     = quiz.quiz_no || '';
  const kwRaw      = (quiz.trend_keywords || '').split(',').map(t => t.trim()).filter(Boolean);

  // Focused hashtags — IG rewards relevance over volume (5–10 is sweet spot)
  const trendHashtags = kwRaw
    .slice(0, 5)  // top 5 trending keywords only
    .map(k => '#' + k.replace(/[^a-zA-Z0-9]/g, '').slice(0, 25))
    .filter(h => h.length > 2)
    .join(' ');

  const lines = [
    title ? `❓ ${title}` : '',
    ``,
    nicheBlock,
    ``,
    quiz.explanation_1 ? `📚 ${quiz.explanation_1}` : '',
    ``,
    quizNo ? `Challenge #${quizNo}` : '',
    ``,
    trendHashtags,
  ].filter(l => l !== null && l !== undefined && l !== false);

  return lines.join('\n').trim().slice(0, 2200);
}

// ─────────────────────────────────────────────
// INSTAGRAM GRAPH API — Reels upload (2-step)
//
// Instagram Reels video upload flow:
//   Step 1: POST /{ig-account-id}/media
//           → create a container with video_url pointing to a public MP4
//           → returns creation_id
//           → poll until status_code === FINISHED
//   Step 2: POST /{ig-account-id}/media_publish
//           → publish the container
//           → returns ig_media_id
//
// Docs: https://developers.facebook.com/docs/instagram-api/guides/reels-publishing
//
// IMPORTANT: Unlike Facebook which accepts a binary upload,
// Instagram requires a PUBLICLY ACCESSIBLE video URL.
// Your R2 video URLs (already stored in short_video_url etc.) work perfectly.
// ─────────────────────────────────────────────
const IG_BASE = `https://graph.facebook.com/v21.0/${IG_ACCOUNT_ID}`;

async function pollContainerStatus(creationId, maxWaitMs = 5 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, 5000)); // poll every 5s
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${creationId}?fields=status_code,status&access_token=${IG_TOKEN}`
    );
    const data = await res.json();
    console.log(`[IG] Container status: ${data.status_code} — ${data.status || ''}`);
    if (data.status_code === 'FINISHED') return true;
    if (data.status_code === 'ERROR' || data.status_code === 'EXPIRED') {
      throw new Error(`IG container failed with status: ${data.status_code} — ${data.status}`);
    }
  }
  throw new Error('IG container polling timed out after 5 minutes');
}

async function uploadToInstagram(videoUrl, caption) {
  // ── STEP 1: Create media container ─────────────────────────────────────────
  console.log(`[IG] Step 1 — creating Reels container for: ${videoUrl.slice(0, 80)}...`);
  const createRes = await fetch(`${IG_BASE}/media`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_type:   'REELS',
      video_url:    videoUrl,   // must be a public URL — your R2 URLs work here
      caption,
      access_token: IG_TOKEN,
      share_to_feed: true,     // also appear on profile grid, not just Reels tab
    })
  });
  const createData = await createRes.json();
  if (!createRes.ok || createData.error) {
    throw new Error(`IG create container failed: ${JSON.stringify(createData)}`);
  }
  const creationId = createData.id;
  if (!creationId) throw new Error(`IG create container returned no id: ${JSON.stringify(createData)}`);
  console.log(`[IG] Step 1 ✓ — container id=${creationId}`);

  // ── POLL until container is ready ──────────────────────────────────────────
  console.log(`[IG] Polling container status (up to 5 min)...`);
  await pollContainerStatus(creationId);
  console.log(`[IG] Container FINISHED — ready to publish`);

  // ── STEP 2: Publish the container ──────────────────────────────────────────
  console.log(`[IG] Step 2 — publishing Reel...`);
  const publishRes = await fetch(`${IG_BASE}/media_publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      creation_id:  creationId,
      access_token: IG_TOKEN,
    })
  });
  const publishData = await publishRes.json();
  if (!publishRes.ok || publishData.error) {
    throw new Error(`IG publish failed: ${JSON.stringify(publishData)}`);
  }
  const igMediaId = publishData.id;
  if (!igMediaId) throw new Error(`IG publish returned no id: ${JSON.stringify(publishData)}`);

  const igUrl = `https://www.instagram.com/reel/${igMediaId}/`;
  console.log(`[IG] Step 2 ✓ — published: ${igUrl}`);
  return { igMediaId, igUrl };
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function processPublish() {
  console.log('[IG-PUBLISHER] Checking for approved videos to publish to Instagram...');

  // Same query pattern as Facebook publisher — poll all four format status columns
  const rows = await fetchSupabase(
    'puzzle?or=(short_status.eq.done_short,medium_status.eq.done_medium,long_status.eq.done_long,micro_status.eq.done_micro)' +
    '&is_human_approved=eq.true' +
    '&is_active=eq.true' +
    '&ig_video_id=is.null' +       // not yet published to Instagram
    '&select=*&order=created_at.desc&limit=1'
  );

  if (!rows?.length) {
    console.log('[IG-PUBLISHER] No approved videos ready for Instagram.');
    return;
  }

  const quiz = rows[0];
  console.log(`[IG-PUBLISHER] Publishing: ${quiz.id} — "${quiz.topic}"`);

  // Resolve video URL — same priority order as Facebook publisher
  const videoUrl = quiz.short_video_url || quiz.medium_video_url || quiz.video_url || quiz.micro_video_url;
  console.log(`[IG-PUBLISHER] video_url=${videoUrl}`);

  if (!videoUrl) {
    console.error('[IG-PUBLISHER] video_url is NULL — cannot publish without a video URL');
    await fetchSupabase(`puzzle?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        generation_error: 'ig_publish: video url is null',
        updated_at: new Date().toISOString()
      })
    }).catch(() => {});
    return;
  }

  // Mark as publishing to prevent duplicate runs
  await fetchSupabase(`puzzle?id=eq.${quiz.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      ig_publish_status: 'publishing',
      updated_at: new Date().toISOString()
    })
  });

  try {
    // 1. Build caption
    const caption = buildCaption(quiz);
    console.log(`[IG-PUBLISHER] Caption preview:\n${caption.slice(0, 200)}...`);

    // 2. Upload to Instagram as Reel
    // NOTE: No local download needed — IG pulls the video from your R2 URL directly
    const { igMediaId, igUrl } = await uploadToInstagram(videoUrl, caption);

    // 3. Update Supabase — mark as published to Instagram
    await fetchSupabase(`puzzle?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ig_video_id:       igMediaId,
        ig_url:            igUrl,
        ig_publish_status: 'published',
        ig_published_at:   new Date().toISOString(),
        updated_at:        new Date().toISOString()
      })
    });

    console.log(`[IG-PUBLISHER] ✓ Published to Instagram: ${igUrl}`);

  } catch (e) {
    console.error(`[IG-PUBLISHER] FAILED: ${e.message}`);
    // Reset so it can be retried
    await fetchSupabase(`puzzle?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        ig_publish_status: 'failed',
        generation_error:  `ig_publish failed: ${e.message}`,
        updated_at:        new Date().toISOString()
      })
    }).catch(() => {});
    process.exit(1);
  }
}

processPublish()
  .then(() => { console.log('[IG-PUBLISHER] Done.'); process.exit(0); })
  .catch(err => { console.error('[IG-PUBLISHER] Fatal:', err); process.exit(1); });
