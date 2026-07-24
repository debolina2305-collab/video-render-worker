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
const supabaseUrl      = process.env.SUPABASE_URL;
const supabaseKey      = process.env.SUPABASE_SERVICE_KEY;
const YT_CLIENT_ID     = process.env.YOUTUBE_CLIENT_ID;
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

Welcome to JaasX Brain Challenge — where we turn today's hottest trending topics into quiz challenges that test your real-world knowledge.

Every day, a new challenge. Every answer, a chance to prove you're smarter than 99% of viewers.

💡 Play the REAL interactive challenge, earn ONS tokens, and compete with players worldwide at jaasblog.online`,

  sports: `🏆 How deep is your sports knowledge?

From World Cup drama to NBA finals, F1 pit stops to Wimbledon classics — JaasX Brain Challenge covers every sport trending right now in America and beyond.

Answer today's challenge, drop your score in the comments, and challenge your friends!

💡 Play the full interactive sports challenge and earn ONS tokens at jaasblog.online/quiz/brain`,

  finance: `💰 Your financial IQ is being tested — right now.

Markets crash, crypto spikes, companies rise and fall — do you understand what's really happening with money?

JaasX Brain Challenge makes finance fun, fast, and competitive. One question. Ten seconds. How smart is your money brain?

💡 Play the full finance challenge and earn ONS tokens at jaasblog.online/quiz/brain`,

  tech: `💻 The tech world moves fast — can you keep up?

AI breakthroughs, startup collapses, gadget launches, coding legends — if it's trending in tech, we're quizzing it.

JaasX Brain Challenge keeps your tech knowledge razor-sharp with daily bite-sized challenges built from real headlines.

💡 Play the full tech challenge and earn ONS tokens at jaasblog.online/quiz/brain`,

  entertainment: `🎬 Pop culture. Movies. Music. TV. All trending. All quizzed.

Think you know your Oscars from your Grammys? Your Marvel from your DC? Your Billboard Hot 100 from your Spotify Wrapped?

JaasX Brain Challenge puts your entertainment knowledge on trial — daily, fast, and totally addictive.

💡 Play the full entertainment challenge and earn ONS tokens at jaasblog.online/quiz/brain`,

  news: `📰 The world is moving fast. Are you keeping up?

From geopolitics to viral moments, election results to breaking headlines — JaasX Brain Challenge quizzes you on what's actually happening in the world today.

Stay informed, stay sharp, and beat everyone else in the comments.

💡 Play the full news challenge and earn ONS tokens at jaasblog.online/quiz/brain`,

  health: `🏥 How much do you really know about health and wellness?

From medical breakthroughs to nutrition myths, mental health to fitness trends — JaasX Brain Challenge tests your health IQ with real questions from real headlines.

One question. Ten seconds. Could save your life — or at least win an argument.

💡 Play the full health challenge and earn ONS tokens at jaasblog.online/quiz/brain`,

};

// ─────────────────────────────────────────────
// BUILD YouTube metadata from quiz row
//
// SEO STRATEGY (v2):
//   TITLE   — top trending keyword injected if it fits and isn't already there.
//             YouTube title is the #1 search ranking signal.
//
//   DESC    — trending keywords NOW appear in lines 1-4 (above the fold /
//             "Show more" cut-off). YouTube indexes the first ~150 chars most
//             heavily, and Google Search shows the first 157 chars as the
//             snippet. Explanation (unique per video) comes next for E-E-A-T.
//             Niche block, CTAs, and hashtags follow below the fold.
//
//   TAGS    — top trending keywords added as first tags (tier-1), then base
//             channel/niche/geo tags. Tags now primarily drive "suggested
//             videos" sidebar placement rather than search ranking.
// ─────────────────────────────────────────────
function buildMetadata(quiz) {
  const niche = (quiz.niche || 'general').toLowerCase();

  const categoryMap = {
    sports:'17', tech:'28', technology:'28',
    finance:'22', entertainment:'24', news:'25', general:'22'
  };
  const categoryId = categoryMap[niche] || '22';

  const nicheLabel = niche.charAt(0).toUpperCase() + niche.slice(1);
  const nicheNo    = quiz.niche_challenge_no || '';
  const quizNo     = quiz.quiz_no || '';
  const nicheFixed = NICHE_DESC[niche] || NICHE_DESC.general;

  // ── Parse trending keywords ────────────────────────────────────────────────
  const kwRaw = (quiz.trend_keywords || '').split(',').map(t => t.trim()).filter(Boolean);

  // ── TITLE: inject top trending keyword if it fits and isn't already there ──
  // The LLM-generated youtube_title already has the core hook. We append the
  // single most-searched keyword phrase so the title matches live search intent.
  // Example: "🔥 99% Can't Name Egypt's World Cup Record!" + " | Egypt World Cup"
  let title = (quiz.youtube_title || quiz.topic || 'Brain Puzzle Challenge').trim();
  if (kwRaw.length) {
    const topKw = kwRaw[0]; // highest-volume keyword (first in list from fetch_trends)
    if (!title.toLowerCase().includes(topKw.toLowerCase())) {
      const candidate = `${title} | ${topKw}`;
      // Only append if it stays under YouTube's 100-char title limit
      if (candidate.length <= 100) {
        title = candidate;
        console.log(`[META] Title keyword injected: "${topKw}"`);
      } else {
        console.log(`[META] Title keyword skipped (too long): "${topKw}"`);
      }
    } else {
      console.log(`[META] Title already contains top keyword: "${topKw}"`);
    }
  }
  title = title.slice(0, 100);

  // ── Trending keyword lines for description ─────────────────────────────────
  // ALL keywords as a natural bullet line — appears on line 2 of description
  // so YouTube + Google index them at maximum weight (first ~150 chars).
  // No reason to limit to 3 — more keywords = more search surface area.
  const trendingSentence = kwRaw.length
    ? `🔍 Trending now: ${kwRaw.join(' • ')}`
    : '';

  // Full trending line also kept below fold — belt-and-suspenders for context signal
  const rawTrendingLine = kwRaw.length
    ? `🔥 TRENDING: ${kwRaw.join(', ')}`
    : '';

  // ── Hashtags ───────────────────────────────────────────────────────────────
  // Top 5 trending keywords as hashtags (visible + clickable in description)
  const descHashtags = kwRaw
    .slice(0, 5)
    .map(k => '#' + k.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20))
    .filter(h => h.length > 2)
    .join(' ');

  const baseHashtags = [
    '#quiz #trivia #challenge #shorts #youtubeshorts #quiztime',
    '#USATrendingChallenge #JaasX',
    `#brainpuzzle #mathpuzzle #detectivepuzzle`,
    '#USA #US #America #UnitedStates #American',
    '#USAQuiz #AmericaQuiz #USAChallenge #AmericaChallenge',
    '#USATrivia #TrendingUSA #USTrending #Trending #Viral',
  ].join(' ');

  // ── DESCRIPTION ────────────────────────────────────────────────────────────
  // Structure (optimised for search ranking):
  //
  //  ABOVE THE FOLD (~first 150 chars — highest indexing weight):
  //    Line 1: CTA with link (drives clicks, signals relevance)
  //    Line 2: Top 3 trending keywords as natural sentence ← NEW
  //    Line 3: US audience signal
  //
  //  ABOVE "SHOW MORE" (~first 300 chars — shown in search result snippet):
  //    Challenge ID + niche number
  //    Video title (question)
  //    Engagement CTA
  //
  //  BELOW "SHOW MORE":
  //    Explanation (unique E-E-A-T content per video)
  //    Niche fixed block
  //    Subscribe/bell CTA
  //    Full trending keywords line (context signal)
  //    Hashtags
  //
  const description = [
    // ── ABOVE THE FOLD ──
    `🧠 Solve more puzzles: jaasblog.online/quiz/brain and earn real ONS tokens!`,
    trendingSentence,                                          // ← top 3 keywords, line 2
    `🇺🇸 Trending right now in the United States of America`,
    ``,
    // ── ABOVE SHOW MORE ──
    `Challenge ID: ${quizNo}`,
    `${nicheLabel} Challenge No #${nicheNo}`,
    ``,
    title,
    ``,
    `⚡ Can YOU answer this? Drop your answer in the comments below!`,
    ``,
    // ── BELOW SHOW MORE ──
    quiz.explanation_1 ? `📚 EXPLANATION:\n${quiz.explanation_1}` : '',
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━━━━`,
    nicheFixed,
    `━━━━━━━━━━━━━━━━━━━━━━━━━`,
    ``,
    `📌 Like • Share • Subscribe → New challenge every day!`,
    `🔔 Hit the bell so you never miss a challenge!`,
    ``,
    rawTrendingLine,                                           // all keywords, below fold
    ``,
    baseHashtags,
    descHashtags,
  ].filter(line => line !== null && line !== undefined && line !== false)
   .join('\n')
   .slice(0, 5000); // YouTube max 5000 chars

  // ── TAGS ───────────────────────────────────────────────────────────────────
  // YouTube tag rules: plain ASCII only, max 30 chars per tag, max 500 chars total.
  //
  // Priority order (v2):
  //   TIER 1: cleaned trending keywords — these connect to currently-searched terms
  //           and drive "suggested videos" placement on related content
  //   TIER 2: channel identity tags
  //   TIER 3: niche + US geo tags
  //
  // Putting trending tags FIRST means they get priority in YouTube's tag parsing
  // (YouTube reads tags left-to-right for relevance weighting).
  const cleanTag = t => t
    .toLowerCase()
    .replace(/[^\x00-\x7F]/g, '')   // strip non-ASCII (emojis, unicode)
    .replace(/[^a-z0-9\s]/g, '')    // strip special chars
    .replace(/\s+/g, '')            // collapse spaces → single word
    .trim()
    .slice(0, 30);                  // max 30 chars per tag

  // TIER 1: trending keywords (up to 12, fitted within char budget)
  const trendingTags = [];
  let tagsCharCount = 0;
  for (const kw of kwRaw) {
    const cleaned = cleanTag(kw);
    if (!cleaned || cleaned.length < 2) continue;
    if (tagsCharCount + cleaned.length > 200) break; // reserve 300 chars for base tags
    if (trendingTags.length >= 12) break;
    trendingTags.push(cleaned);
    tagsCharCount += cleaned.length;
  }

  // TIER 2 + 3: channel identity + niche + US geo
  const baseTags = [
    'puzzle', 'brainteaser', 'challenge', 'shorts', 'youtubeshorts', 'mindgames',
    'JaasXBrainChallenge', 'JaasX', 'BrainPuzzle', 'jaasblog',
    niche, `${niche}quiz`, `${niche}challenge`, `${niche}trivia`,
    'usa', 'us', 'america', 'unitedstates', 'american',
    'usaquiz', 'americaquiz', 'usachallenge', 'americachallenge',
    'ustrivia', 'americatrivia', 'trendingusa', 'ustrending',
    'trending', 'viral', 'usatrending'
  ];

  // Merge: trending tags first, then base tags, deduplicated, max 30 total
  const seen = new Set(trendingTags);
  const finalTags = [...trendingTags];
  for (const t of baseTags) {
    if (!seen.has(t)) { seen.add(t); finalTags.push(t); }
    if (finalTags.length >= 30) break;
  }

  console.log(`[META] title="${title}"`);
  console.log(`[META] description length=${description.length}`);
  console.log(`[META] tags (${finalTags.length}): ${JSON.stringify(finalTags)}`);
  console.log(`[META] trending keywords in desc: ${kwRaw.slice(0,5).join(' | ')}${kwRaw.length > 5 ? ` ... +${kwRaw.length-5} more` : ''}`);

  return { title, description, tags: finalTags, categoryId };
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
          privacyStatus: 'public',
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
  // Random startup delay: 1–8 minutes (human-like variance, anti-detection)
  // const delayMs  = (60 + Math.floor(Math.random() * 420)) * 1000;
  // const delayMin = (delayMs / 60000).toFixed(1);
  // console.log(`[PZ-YT] Random startup delay: ${delayMin} min (anti-detection)`);
  // await new Promise(r => setTimeout(r, delayMs));

  console.log('[PZ-YT] Checking for approved videos to publish...');

  // order=created_at.desc → newest/most-trending quiz publishes first.
  // Trending topics have a short shelf life — always publish the latest one.
  // NOTE: checks all three formats' own status column — short_status,
  // medium_status, long_status — so medium/long rows are no longer invisible
  // to the publisher. (Previously this only ever checked short_status, which
  // meant medium/long videos could sit "done" + approved forever without
  // ever being picked up.)
  const rows = await fetchSupabase(
    'puzzle?or=(short_status.eq.done_short,medium_status.eq.done_medium,long_status.eq.done_long)' +
    '&is_human_approved=eq.true&is_active=eq.true' +
    '&youtube_video_id=is.null' +
    '&select=*&order=created_at.desc&limit=1'
  );

  if (!rows?.length) {
    console.log('[PZ-YT] No approved videos ready to publish.');
    return;
  }

  const quiz = rows[0];
  console.log(`[PZ-YT] Publishing: ${quiz.id} — ${quiz.topic}`);
  // Resolve the video URL for whichever format this row actually is:
  //   long   → video_url (already the native column for long)
  //   medium → medium_video_url
  //   short  → short_video_url
  if (!quiz.video_url) quiz.video_url = quiz.medium_video_url || quiz.short_video_url;
  console.log(`[PZ-YT] video_url=${quiz.video_url}`);

  if (!quiz.video_url) {
    console.error('[PZ-YT] video_url is NULL — cannot publish without video file in R2');
    await fetchSupabase(`puzzle?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        generation_error: 'video_url is null — video not uploaded to R2',
        updated_at: new Date().toISOString()
      })
    });
    return;
  }

  // Mark as publishing to prevent duplicate runs
  await fetchSupabase(`puzzle?id=eq.${quiz.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ video_status: 'publishing', updated_at: new Date().toISOString() })
  });

  try {
    // 1. Get fresh YouTube access token
    const accessToken = await getAccessToken();

    // 2. Download video from R2
    const videoPath = `/tmp/${quiz.id}.mp4`;
    await downloadVideo(quiz.video_url, videoPath);

    // 3. Build metadata (SEO v2 — trending keywords in title + top of description)
    const metadata = buildMetadata(quiz);
    console.log(`[PZ-YT] Title: "${metadata.title}"`);
    console.log(`[PZ-YT] Category: ${metadata.categoryId}, Tags: ${metadata.tags.slice(0,5).join(', ')}...`);

    // 4. Upload to YouTube
    const { videoId, youtubeUrl } = await uploadToYouTube(accessToken, videoPath, metadata);

    // 5. Set custom thumbnail from R2
    await setThumbnail(accessToken, videoId, quiz.thumbnail_url);

    // 6. Update Supabase — mark as published
    await fetchSupabase(`puzzle?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        video_status:     'published',
        youtube_video_id: videoId,
        published_at:     new Date().toISOString(),
        updated_at:       new Date().toISOString()
      })
    });

    // 7. Promote linked blog post if still draft
    // Worker12 publishes on creation, but this handles edge cases / race conditions
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
        console.log(`[PZ-YT] ✓ Blog promoted: slug=${quiz.blog_slug}`);
      } catch (blogErr) {
        console.warn(`[PZ-YT] Could not promote blog (non-fatal): ${blogErr.message}`);
      }
    }

    console.log(`[PZ-YT] ✓ Published: ${youtubeUrl}`);
    console.log(`[PZ-YT] ✓ quiz.youtube_video_id = ${videoId}`);

    // 8. Cleanup temp file
    await fs.unlink(videoPath).catch(() => {});

  } catch (e) {
    console.error(`[PZ-YT] FAILED: ${e.message}`);
    // Reset to rendered so it can be retried
    await fetchSupabase(`puzzle?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        video_status:     'rendered',
        generation_error: `publish failed: ${e.message}`,
        updated_at:       new Date().toISOString()
      })
    }).catch(() => {});
    process.exit(1);
  }
}

processPublish()
  .then(() => { console.log('[PZ-YT] Done.'); process.exit(0); })
  .catch(err => { console.error('[PZ-YT] Fatal:', err); process.exit(1); });
