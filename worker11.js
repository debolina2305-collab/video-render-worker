'use strict';
const { exec }    = require('child_process');
const util        = require('util');
const execPromise = util.promisify(exec);
const fs          = require('fs').promises;
const path        = require('path');
const https       = require('https');
const http        = require('http');

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────
const supabaseUrl    = process.env.SUPABASE_URL;
const supabaseKey    = process.env.SUPABASE_SERVICE_KEY;
const YT_CLIENT_ID  = process.env.YOUTUBE_CLIENT_ID;
const YT_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET;
const YT_REFRESH_TOKEN = process.env.YOUTUBE_REFRESH_TOKEN;

console.log('SUPABASE_URL:', supabaseUrl);
console.log('SUPABASE_SERVICE_KEY:', supabaseKey ? '*** (set)' : 'NOT SET');
console.log('YOUTUBE_CLIENT_ID:', YT_CLIENT_ID ? '*** (set)' : 'NOT SET');
console.log('YOUTUBE_CLIENT_SECRET:', YT_CLIENT_SECRET ? '*** (set)' : 'NOT SET');
console.log('YOUTUBE_REFRESH_TOKEN:', YT_REFRESH_TOKEN ? '*** (set)' : 'NOT SET');

const cleanUrl = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;
if (!cleanUrl || !supabaseKey) { console.error('[FATAL] Missing Supabase credentials'); process.exit(1); }
if (!YT_CLIENT_ID || !YT_CLIENT_SECRET || !YT_REFRESH_TOKEN) { console.error('[FATAL] Missing YouTube OAuth credentials'); process.exit(1); }

// ─────────────────────────────────────────────
// SUPABASE HELPERS
// ─────────────────────────────────────────────
async function fetchSupabase(path_, opts = {}) {
  const url = `${cleanUrl}/rest/v1/${path_}`;
  const method = opts.method || 'GET';
  console.log(`[DB] ${method} ${url}`);
  const res = await fetch(url, {
    method,
    headers: {
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal',
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
// YOUTUBE OAUTH — get fresh access token
// ─────────────────────────────────────────────
async function getAccessToken() {
  console.log('[YT] Refreshing access token...');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     YT_CLIENT_ID,
      client_secret: YT_CLIENT_SECRET,
      refresh_token: YT_REFRESH_TOKEN,
      grant_type:    'refresh_token'
    })
  });
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Failed to get access token: ${JSON.stringify(data)}`);
  }
  console.log('[YT] Access token obtained ✓');
  return data.access_token;
}

// ─────────────────────────────────────────────
// DOWNLOAD VIDEO from R2
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
// NICHE-SPECIFIC FIXED DESCRIPTION BLOCKS
// ─────────────────────────────────────────────
const NICHE_DESC = {
  sports: [
    `🏆 Love sports trivia? You're in the right place!`,
    `Every day we drop a new sports challenge — football, cricket, basketball, tennis, F1 and more.`,
    `Train your sports brain, beat your friends, and climb the leaderboard on jaasblog.online`,
  ].join('\n'),
  finance: [
    `💰 Boost your financial IQ one question at a time!`,
    `From stock markets to crypto, economics to personal finance — we make money knowledge fun.`,
    `Play the real challenge and earn ONS tokens at jaasblog.online`,
  ].join('\n'),
  tech: [
    `💻 Stay ahead in tech with daily challenges!`,
    `AI, coding, gadgets, startups — test your tech knowledge against the world.`,
    `Level up your tech IQ at jaasblog.online`,
  ].join('\n'),
  entertainment: [
    `🎬 How well do you know pop culture, movies, music and TV?`,
    `Daily entertainment trivia that keeps you sharp and your friends jealous.`,
    `Play the full challenge at jaasblog.online`,
  ].join('\n'),
  news: [
    `📰 Stay sharp on current events with daily news challenges!`,
    `Test your knowledge of breaking news, global events and trending topics.`,
    `Join the conversation at jaasblog.online`,
  ].join('\n'),
  general: [
    `🧠 Think you know everything? Prove it!`,
    `Daily general knowledge challenges covering every topic imaginable.`,
    `Compete with players worldwide at jaasblog.online`,
  ].join('\n'),
};

// ─────────────────────────────────────────────
// BUILD YouTube metadata from quiz row
// ─────────────────────────────────────────────
function buildMetadata(quiz) {
  const niche = (quiz.niche || 'general').toLowerCase();

  const categoryMap = {
    sports:'17', tech:'28', technology:'28',
    finance:'22', entertainment:'24', news:'25', general:'22'
  };
  const categoryId = categoryMap[niche] || '22';

  const title = (quiz.youtube_title || quiz.topic || 'Quiz Challenge').slice(0, 100);
  const nicheLabel = niche.charAt(0).toUpperCase() + niche.slice(1);
  const nicheNo    = quiz.niche_challenge_no || '';
  const quizNo     = quiz.quiz_no || '';
  const nicheFixed = NICHE_DESC[niche] || NICHE_DESC.general;

  // Trending keywords → hashtags (clean, no spaces, max 20)
  const kwRaw = (quiz.trend_keywords || '').split(',').map(t => t.trim()).filter(Boolean);
  const hashtagsFromKw = kwRaw
    .slice(0, 20)
    .map(k => '#' + k.replace(/[^a-zA-Z0-9]/g, ''))
    .filter(h => h.length > 1)
    .join(' ');

  // Base hashtags
  const baseHashtags = `#quiz #trivia #challenge #shorts #youtubeshorts #quiztime #USATrendingChallenge #JaasX #${niche}quiz #${niche}challenge`;

  // Build description
  const description = [
    `🎯 Play the REAL CHALLENGE: jaasblog.online/quiz/${niche} and earn real ONS tokens!`,
    ``,
    `Challenge ID: ${quizNo}`,
    `${nicheLabel} Challenge No #${nicheNo}`,
    ``,
    `${title}`,
    ``,
    `⚡ Can YOU answer this? Drop your answer in the comments below!`,
    ``,
    // Answer explanation — gives SEO-rich unique content per video
    quiz.explanation_1 ? `📚 EXPLANATION:\n${quiz.explanation_1}` : '',
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━`,
    nicheFixed,
    `━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📌 Like • Share • Subscribe → New challenge every day!`,
    `🔔 Hit the bell so you never miss a challenge!`,
    ``,
    // Trending keywords as plain text for SEO
    kwRaw.length ? `🔥 TRENDING: ${kwRaw.slice(0, 15).join(', ')}` : '',
    ``,
    `${baseHashtags}`,
    hashtagsFromKw,
  ].filter(line => line !== null && line !== undefined).join('\n').slice(0, 5000); // YT max 5000 chars

  // Tags: base + trending keywords (YouTube max 500 chars total)
  const baseTags = [
    'quiz','trivia','challenge','shorts','youtubeshorts','quiztime',
    'USATrendingChallenge','JaasX', niche, `${niche}quiz`, `${niche}challenge`,
    'ONStoken','jaasblog'
  ];
  let tagsTotal = baseTags.join('').length;
  const extraTags = [];
  for (const kw of kwRaw) {
    const clean = kw.slice(0, 30);
    if (tagsTotal + clean.length < 480) { extraTags.push(clean); tagsTotal += clean.length; }
    if (extraTags.length >= 17) break; // keep total ≤ 30
  }
  const tags = [...baseTags, ...extraTags].slice(0, 30);

  console.log(`[META] description length=${description.length} tags=${tags.length}`);
  return { title, description, tags, categoryId };
}

// ─────────────────────────────────────────────
// SET Custom Thumbnail from R2
// ─────────────────────────────────────────────
async function setThumbnail(accessToken, videoId, thumbnailUrl) {
  if (!thumbnailUrl) { console.log('[THUMB] No thumbnail_url — skipping'); return; }
  try {
    console.log(`[THUMB] Downloading thumbnail: ${thumbnailUrl.slice(0,70)}...`);
    const res = await fetch(thumbnailUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    console.log(`[THUMB] Downloaded ${(buf.length/1024).toFixed(0)} KB — uploading to YouTube...`);

    const thumbRes = await fetch(
      `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}&uploadType=media`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'image/png',
          'Content-Length': String(buf.length)
        },
        body: buf
      }
    );

    if (!thumbRes.ok) {
      const err = await thumbRes.text();
      // Thumbnail upload failure is non-fatal — video is already live
      console.warn(`[THUMB] Upload failed (non-fatal): HTTP ${thumbRes.status} — ${err.slice(0,200)}`);
      return;
    }
    console.log(`[THUMB] ✓ Custom thumbnail set successfully`);
  } catch (e) {
    console.warn(`[THUMB] Failed (non-fatal): ${e.message}`);
  }
}

// ─────────────────────────────────────────────
// UPLOAD to YouTube (resumable upload)
// ─────────────────────────────────────────────
async function uploadToYouTube(accessToken, videoPath, metadata) {
  const { title, description, tags, categoryId } = metadata;
  const stat = await fs.stat(videoPath);
  const fileSize = stat.size;

  // Step 1: initiate resumable upload session
  console.log(`[YT] Initiating upload: "${title}" (${(fileSize/1024/1024).toFixed(2)} MB)`);
  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(fileSize)
      },
      body: JSON.stringify({
        snippet: {
          title,
          description,
          tags,
          categoryId,
          defaultLanguage: 'en',
          defaultAudioLanguage: 'en'
        },
        status: {
          privacyStatus: 'public',   // publish immediately as public
          selfDeclaredMadeForKids: false,
          madeForKids: false
        }
      })
    }
  );

  if (!initRes.ok) {
    const err = await initRes.text();
    throw new Error(`YouTube init upload failed: HTTP ${initRes.status} — ${err}`);
  }

  const uploadUrl = initRes.headers.get('location');
  if (!uploadUrl) throw new Error('No upload URL in YouTube response');
  console.log(`[YT] Got resumable upload URL ✓`);

  // Step 2: upload the actual video bytes
  console.log(`[YT] Uploading ${(fileSize/1024/1024).toFixed(2)} MB...`);
  const videoBuffer = await fs.readFile(videoPath);

  const uploadRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(fileSize)
    },
    body: videoBuffer
  });

  if (!uploadRes.ok && uploadRes.status !== 201) {
    const err = await uploadRes.text();
    throw new Error(`YouTube upload failed: HTTP ${uploadRes.status} — ${err}`);
  }

  const result = await uploadRes.json();
  const videoId = result.id;
  if (!videoId) throw new Error(`No video ID in response: ${JSON.stringify(result)}`);

  const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`[YT] Upload complete ✓ — ${youtubeUrl}`);
  return { videoId, youtubeUrl };
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function processPublish() {
  console.log('[PUBLISHER] Checking for approved videos to publish...');

  // Poll for quiz rows that are:
  // - rendered (video exists in R2)
  // - human approved
  // - not yet published
  const rows = await fetchSupabase(
    'quiz?video_status=eq.rendered&is_human_approved=eq.true&is_active=eq.true' +
    '&select=*&order=created_at.asc&limit=1'
  );

  if (!rows?.length) {
    console.log('[PUBLISHER] No approved videos ready to publish.');
    return;
  }

  const quiz = rows[0];
  console.log(`[PUBLISHER] Publishing: ${quiz.id} — ${quiz.topic}`);
  console.log(`[PUBLISHER] video_url=${quiz.video_url}`);

  if (!quiz.video_url) {
    console.error('[PUBLISHER] video_url is NULL — cannot publish without video file in R2');
    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ generation_error: 'video_url is null — video not uploaded to R2', updated_at: new Date().toISOString() })
    });
    return;
  }

  // Mark as processing to prevent duplicate runs
  await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ video_status: 'publishing', updated_at: new Date().toISOString() })
  });

  try {
    // 1. Get fresh YouTube access token
    const accessToken = await getAccessToken();

    // 2. Download video from R2
    const videoPath = `/tmp/${quiz.id}.mp4`;
    await downloadVideo(quiz.video_url, videoPath);

    // 3. Build metadata
    const metadata = buildMetadata(quiz);
    console.log(`[PUBLISHER] Title: "${metadata.title}"`);
    console.log(`[PUBLISHER] Category: ${metadata.categoryId}, Tags: ${metadata.tags.slice(0,5).join(', ')}...`);

    // 4. Upload to YouTube
    const { videoId, youtubeUrl } = await uploadToYouTube(accessToken, videoPath, metadata);

    // 5. Set custom thumbnail from R2
    await setThumbnail(accessToken, videoId, quiz.thumbnail_url);

    // 6. Update Supabase — mark as published
    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        video_status: 'published',
        youtube_video_id: videoId,
        published_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    });

    console.log(`[PUBLISHER] ✓ Published: ${youtubeUrl}`);
    console.log(`[PUBLISHER] ✓ quiz.youtube_video_id = ${videoId}`);

    // 7. Cleanup
    await fs.unlink(videoPath).catch(() => {});

  } catch (e) {
    console.error(`[PUBLISHER] FAILED: ${e.message}`);
    // Reset status so it can be retried
    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        video_status: 'rendered',   // back to rendered so it can be retried
        generation_error: `publish failed: ${e.message}`,
        updated_at: new Date().toISOString()
      })
    }).catch(() => {});
    process.exit(1);
  }
}

processPublish()
  .then(() => { console.log('[PUBLISHER] Done.'); process.exit(0); })
  .catch(err => { console.error('[PUBLISHER] Fatal:', err); process.exit(1); });
