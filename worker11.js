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

  general: `🧠 Think you know everything? Let's find out!

Welcome to USA Trending Challenge — where we turn today's hottest trending topics into quiz challenges that test your real-world knowledge.

Every day, a new challenge. Every answer, a chance to prove you're smarter than 99% of viewers.

💡 Play the REAL interactive challenge, earn ONS tokens, and compete with players worldwide at jaasblog.online`,

  sports: `🏆 How deep is your sports knowledge?

From World Cup drama to NBA finals, F1 pit stops to Wimbledon classics — USA Trending Challenge covers every sport trending right now in America and beyond.

Answer today's challenge, drop your score in the comments, and challenge your friends!

💡 Play the full interactive sports challenge and earn ONS tokens at jaasblog.online/quiz/sports`,

  finance: `💰 Your financial IQ is being tested — right now.

Markets crash, crypto spikes, companies rise and fall — do you understand what's really happening with money?

USA Trending Challenge makes finance fun, fast, and competitive. One question. Ten seconds. How smart is your money brain?

💡 Play the full finance challenge and earn ONS tokens at jaasblog.online/quiz/finance`,

  tech: `💻 The tech world moves fast — can you keep up?

AI breakthroughs, startup collapses, gadget launches, coding legends — if it's trending in tech, we're quizzing it.

USA Trending Challenge keeps your tech knowledge razor-sharp with daily bite-sized challenges built from real headlines.

💡 Play the full tech challenge and earn ONS tokens at jaasblog.online/quiz/tech`,

  entertainment: `🎬 Pop culture. Movies. Music. TV. All trending. All quizzed.

Think you know your Oscars from your Grammys? Your Marvel from your DC? Your Billboard Hot 100 from your Spotify Wrapped?

USA Trending Challenge puts your entertainment knowledge on trial — daily, fast, and totally addictive.

💡 Play the full entertainment challenge and earn ONS tokens at jaasblog.online/quiz/entertainment`,

  news: `📰 The world is moving fast. Are you keeping up?

From geopolitics to viral moments, election results to breaking headlines — USA Trending Challenge quizzes you on what's actually happening in the world today.

Stay informed, stay sharp, and beat everyone else in the comments.

💡 Play the full news challenge and earn ONS tokens at jaasblog.online/quiz/news`,

  health: `🏥 How much do you really know about health and wellness?

From medical breakthroughs to nutrition myths, mental health to fitness trends — USA Trending Challenge tests your health IQ with real questions from real headlines.

One question. Ten seconds. Could save your life — or at least win an argument.

💡 Play the full health challenge and earn ONS tokens at jaasblog.online/quiz/health`,

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

  // Parse trending keywords — used in both description (raw) and tags (cleaned)
  const kwRaw = (quiz.trend_keywords || '').split(',').map(t => t.trim()).filter(Boolean);

  // Description: use RAW trend_keywords (full phrases, special chars OK in description)
  const rawTrendingLine = kwRaw.length
    ? `🔥 TRENDING: ${kwRaw.slice(0, 20).join(', ')}`
    : '';

  // Description hashtags: only short clean ones from top 5 keywords (visible + clickable)
  const descHashtags = kwRaw
    .slice(0, 5)
    .map(k => '#' + k.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20))
    .filter(h => h.length > 2)
    .join(' ');

  const baseHashtags = [
    // Channel
    '#quiz #trivia #challenge #shorts #youtubeshorts #quiztime',
    '#USATrendingChallenge #JaasX',
    // Niche
    `#${niche}quiz #${niche}challenge #${niche}trivia`,
    // US geo + quiz combinations
    '#USA #US #America #UnitedStates #American',
    '#USAQuiz #AmericaQuiz #USAChallenge #AmericaChallenge',
    '#USATrivia #TrendingUSA #USTrending #Trending #Viral',
  ].join(' ');

  // Build description
  const description = [
    `🎯 Play the REAL CHALLENGE: jaasblog.online/quiz/${niche} and earn real ONS tokens!`,
    `🇺🇸 Trending right now in the United States of America`,
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
    rawTrendingLine,
    ``,
    `${baseHashtags}`,
    descHashtags,
  ].filter(line => line !== null && line !== undefined).join('\n').slice(0, 5000); // YT max 5000 chars

  // Tags: base + US geo tags + cleaned trending keywords
  // YouTube rules: plain text only, no special chars, max 30 chars per tag, max 500 chars total
  const baseTags = [
    // Channel identity
    'quiz', 'trivia', 'challenge', 'shorts', 'youtubeshorts', 'quiztime',
    'USATrendingChallenge', 'JaasX', 'ONStoken', 'jaasblog',
    // Niche specific
    niche, `${niche}quiz`, `${niche}challenge`, `${niche}trivia`,
    // US geo + quiz combinations
    'usa', 'us', 'america', 'unitedstates', 'american',
    'usaquiz', 'americaquiz', 'usachallenge', 'americachallenge',
    'ustrivia', 'americatrivia', 'trendingusa', 'ustrending',
    'trending', 'viral', 'usatrending'
  ];
  const cleanTag = t => t
    .toLowerCase()
    .replace(/[^\x00-\x7F]/g, '')   // strip ALL non-ASCII (emojis, unicode)
    .replace(/[^a-z0-9\s]/g, '')    // strip special chars
    .replace(/\s+/g, '')            // remove ALL spaces → single word tag
    .trim()
    .slice(0, 30);                  // max 30 chars per tag

  const extraTags = [];
  let tagsCharCount = baseTags.join('').length;
  for (const kw of kwRaw) {
    const cleaned = cleanTag(kw);
    if (!cleaned || cleaned.length < 2) continue;
    if (tagsCharCount + cleaned.length > 480) break;
    if (extraTags.length >= 17) break;
    extraTags.push(cleaned);
    tagsCharCount += cleaned.length;
  }
  const tags = [...baseTags, ...extraTags].slice(0, 30);
  console.log(`[META] tags sample: ${JSON.stringify(tags.slice(0,5))}`);

  console.log(`[META] description length=${description.length} tags=${tags.length}`);
  console.log(`[META] ALL TAGS: ${JSON.stringify(tags)}`);
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
    console.error(`[YT] Init upload error body: ${err}`);
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
  // ── Random startup delay: 1–8 minutes ────────────────────────────────────
  // Adds human-like variance so uploads don't happen at the exact same second
  // every day even when cron fires at the same time.
  const delayMs = (60 + Math.floor(Math.random() * 420)) * 1000; // 60–480 seconds
  const delayMin = (delayMs / 60000).toFixed(1);
  console.log(`[PUBLISHER] Random startup delay: ${delayMin} min (anti-detection)`);
  await new Promise(r => setTimeout(r, delayMs));
  // ─────────────────────────────────────────────────────────────────────────

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

    // 7. Promote the linked blog post to published if it exists and is still draft.
    // Worker 12 now publishes immediately on creation, but this handles edge cases:
    // blogs generated before that fix, or cases where blog creation raced ahead
    // of video publishing and was left in draft.
    if (quiz.blog_slug) {
      try {
        await fetchSupabase(
          `quiz_blog_posts?slug=eq.${encodeURIComponent(quiz.blog_slug)}&is_published=eq.false`,
          {
            method: 'PATCH',
            body: JSON.stringify({
              status:       'published',
              is_published: true,
              published_at: new Date().toISOString(),
              updated_at:   new Date().toISOString(),
            })
          }
        );
        console.log(`[PUBLISHER] ✓ Blog promoted: slug=${quiz.blog_slug}`);
      } catch (blogErr) {
        console.warn(`[PUBLISHER] Could not promote blog (non-fatal): ${blogErr.message}`);
      }
    }

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
