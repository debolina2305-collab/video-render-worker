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
// BUILD YouTube metadata from quiz row
// ─────────────────────────────────────────────
function buildMetadata(quiz) {
  const niche = (quiz.niche || 'general').toLowerCase();

  // Category IDs: 22=People&Blogs, 17=Sports, 28=Science&Tech, 24=Entertainment, 25=News
  const categoryMap = {
    sports:        '17',
    tech:          '28',
    technology:    '28',
    finance:       '22',
    entertainment: '24',
    news:          '25',
    general:       '22'
  };
  const categoryId = categoryMap[niche] || '22';

  // Title — use youtube_title from DB, fallback to topic
  const title = (quiz.youtube_title || quiz.topic || 'Quiz Challenge').slice(0, 100);

  // Description
  const niceNo = quiz.niche_challenge_no || quiz.quiz_no || '';
  const nicheLabel = niche.charAt(0).toUpperCase() + niche.slice(1);
  const description = [
    `${title}`,
    ``,
    `🏆 ${nicheLabel} Challenge No #${niceNo}`,
    ``,
    `Can YOU answer this? Drop your answer in the comments!`,
    ``,
    quiz.affiliate_url ? `🎯 Play the REAL CHALLENGE and earn ONS tokens: ${quiz.affiliate_url}` : `🎯 Play the REAL CHALLENGE: ${quiz.blog_page_url || 'https://jaasblog.online'}`,
    ``,
    `📌 Like • Share • Subscribe for daily challenges!`,
    ``,
    `#quiz #challenge #trivia #${niche} #shorts #youtubeshorts #quiztime #USATrendingChallenge`
  ].join('\n');

  // Tags
  const tags = [
    'quiz', 'trivia', 'challenge', niche, 'shorts', 'youtubeshorts',
    'quiztime', 'USATrendingChallenge', 'JaasX',
    ...(quiz.trend_keywords || '').split(',').map(t => t.trim()).filter(Boolean).slice(0, 10)
  ].slice(0, 30); // YouTube max 30 tags

  return { title, description, tags, categoryId };
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

    // 5. Update Supabase — mark as published
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

    // 6. Cleanup
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
