# Auto Quiz YouTube Shorts Pipeline — Complete Technical Tutorial

**Project:** Auto Quiz (JaasX / USA Trending Challenge)  
**Channel:** USA Trending Challenge  
**Brand:** JaasX | jaasblog.online  
**Repo:** github.com/debolina2305-collab/video-render-worker  

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Architecture Diagram](#2-architecture-diagram)
3. [Technology Stack](#3-technology-stack)
4. [Database Schema](#4-database-schema)
5. [File Structure](#5-file-structure)
6. [Worker 1: fetch_trends.py](#6-worker-1-fetch_trendspy)
7. [Worker 2: worker8.js (Quiz Generator)](#7-worker-2-worker8js-quiz-generator)
8. [Worker 3: worker10.js (Video Renderer)](#8-worker-3-worker10js-video-renderer)
9. [Worker 4: worker11.js (YouTube Publisher)](#9-worker-4-worker11js-youtube-publisher)
10. [GitHub Actions Workflows](#10-github-actions-workflows)
11. [Cloudflare R2 Storage](#11-cloudflare-r2-storage)
12. [Environment Variables & Secrets](#12-environment-variables--secrets)
13. [Complete Pipeline Flow](#13-complete-pipeline-flow)
14. [Troubleshooting Guide](#14-troubleshooting-guide)
15. [Common Errors & Fixes](#15-common-errors--fixes)
16. [Monitoring & Maintenance](#16-monitoring--maintenance)

---

## 1. System Overview

This pipeline automatically:
1. **Fetches** trending topics from Google Trends (US-focused)
2. **Generates** quiz questions using DeepSeek V3 AI
3. **Renders** a 9:16 YouTube Shorts video (1080×1920px) with animations, TTS audio, countdown timer, and background music
4. **Uploads** the video to Cloudflare R2 storage
5. **Publishes** to YouTube automatically (after human approval) with SEO-optimized title, description, tags, and custom thumbnail

**Human involvement:** Only ONE step — reviewing and approving rendered videos in Supabase before they publish to YouTube.

---

## 2. Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     TRIGGER SOURCES                              │
│  Google Trends (US) ──► fetch_trends.py (GitHub Actions/cron)  │
└────────────────────────────┬────────────────────────────────────┘
                             │ inserts rows into
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                  SUPABASE DATABASE                               │
│  trending_cache → quiz_queue → quiz table                       │
└──────┬─────────────────────────────────────────────────────────-┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  WORKER 8 (Cloudflare Worker — runs every 5 min)                │
│  Reads quiz_queue → DeepSeek V3 AI → generates quiz rows        │
│  Assigns: questions, options, hint, explanation, MI question     │
│  Picks: hook audio, sfx, countdown music, bg music, cta audio   │
│  Stores: all audio URLs + niche_challenge_no in quiz table      │
└──────┬───────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  WORKER 10 (GitHub Actions — runs every 5 min)                  │
│  Reads quiz table (video_status=pending, quiz_enriched=true)    │
│  Downloads all audio files from R2 in parallel                  │
│  Renders HTML template with Puppeteer (1080×1920)               │
│  Records each screen as video clip                              │
│  Muxes audio + video for each clip                              │
│  Concatenates all clips → applies background music ducking      │
│  Generates thumbnail → uploads video+thumbnail to R2            │
│  Updates quiz.video_status=rendered + video_url                 │
└──────┬───────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  HUMAN APPROVAL (Supabase dashboard)                            │
│  Reviewer watches video from quiz.video_url (R2 link)           │
│  Sets is_human_approved=true if good                            │
└──────┬───────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  WORKER 11 (GitHub Actions — runs 10x per day on schedule)      │
│  Reads quiz (video_status=rendered, is_human_approved=true)     │
│  Waits random 1-8 min (anti-detection delay)                    │
│  Gets fresh YouTube OAuth token                                 │
│  Downloads MP4 from R2                                          │
│  Uploads to YouTube with SEO metadata                           │
│  Sets custom thumbnail from R2                                  │
│  Updates quiz.video_status=published + youtube_video_id         │
└──────────────────────────────────────────────────────────────────┘
```

---

## 3. Technology Stack

| Component | Technology | Why |
|---|---|---|
| Trend fetching | Python + Playwright | Scrapes Google Trends CSV |
| Quiz AI | DeepSeek V3 via Vercel AI Gateway | Best quality/cost, fallback chain |
| Database | Supabase (PostgreSQL) | Realtime, REST API, free tier |
| Video template | HTML/CSS/JS | Animated, theme-able, 9:16 |
| Screen recording | Puppeteer + PuppeteerScreenRecorder | Renders HTML to video |
| TTS (voice) | Microsoft Edge TTS (edge-tts CLI) | Free, natural voices |
| Audio processing | FFmpeg | Mux, concat, duck, normalize |
| Video hosting | Cloudflare R2 | Free egress, permanent URLs |
| YouTube publishing | YouTube Data API v3 + OAuth2 | Official API |
| Automation | GitHub Actions | Free 2000 min/month |
| Workers runtime | Cloudflare Workers | Edge, low latency |

---

## 4. Database Schema

### Key Tables

**`quiz`** — Master table. One row per video.
```sql
id                     UUID PRIMARY KEY
topic                  TEXT            -- e.g. "senegal vs iraq"
niche                  TEXT            -- general|sports|finance|tech|entertainment|health
lang_code              TEXT            -- en|hi|es|pt
youtube_title          TEXT            -- AI-generated clickable title
question_1             TEXT            -- the quiz question
options_1              TEXT[]          -- 4 answer options
correct_answer_1       TEXT
explanation_1          TEXT            -- shown after reveal
hint_1                 TEXT            -- shown at T/4 during countdown
keep_5050_1            TEXT[]          -- which 2 options to keep if 50/50 used
quiz_no                BIGINT          -- e.g. 2606270005 (YYMMDDNNNN)
niche_challenge_no     BIGINT          -- per-niche counter: Sports #18, Tech #3
thinking_time_sec      INT             -- countdown timer seconds (default 10)

-- Mission Impossible (bonus hard question)
mission_impossible_question   TEXT
mission_impossible_hint       TEXT
mission_impossible_enabled    BOOLEAN
mission_options_1             TEXT[]
mission_correct_answer_1      TEXT
mission_explanation_1         TEXT

-- Audio URLs (prerecorded, stored in R2)
hook_audio_url         TEXT
question_intro_audio_url TEXT
options_intro_audio_url TEXT
timeup_audio_url       TEXT
cta2_audio_url         TEXT
cta3_audio_url         TEXT
cta4_audio_url         TEXT
mission_intro_audio_url TEXT
sfx_audio_url          JSONB           -- {"question_appear":"...","countdown_loop":"..."}
countdown_music        TEXT
background_music       TEXT
correct_answer_sfx_audio_url TEXT

-- Video pipeline status
video_status           TEXT            -- pending|processing|rendered|publishing|published|error
quiz_enriched          BOOLEAN         -- set by Worker 8 when audio URLs are populated
is_active              BOOLEAN
is_human_approved      BOOLEAN         -- human sets this to trigger publish

-- Output
video_url              TEXT            -- R2 public URL to .mp4
thumbnail_url          TEXT            -- R2 public URL to .png
youtube_video_id       TEXT            -- e.g. "orfNdeR-QsI"
published_at           TIMESTAMPTZ
render_duration_sec    INT
file_size_mb           FLOAT
```

**`quiz_queue`** — Job queue between W7 (trend fetch) and W8 (generation)
```sql
id            UUID PRIMARY KEY
job_type      TEXT        -- 'quiz_generation'
status        TEXT        -- pending|processing|completed|failed
priority      INT
niche         TEXT
trnding_topic TEXT        -- the trending topic
payload       JSONB       -- full trend data
quiz_id       UUID        -- set after W8 creates quiz row
```

**Audio cue tables** — pools of prerecorded audio, W8 picks one per quiz:
- `quiz_hooks` — hook phrases with audio_url
- `question_intro_cues` — "Your challenge is on screen" etc.
- `options_intro_cues` — "Here are your options" etc.
- `timeup_cues` — "Time's up, let's reveal" etc.
- `cta2_audio_cues`, `cta3_audio_cues`, `cta4_cues`
- `mission_impossible_cues`
- `sfx_cues` — sound effects (countdown_loop, question_appear, correct_answer)
- `background_music_tracks`

---

## 5. File Structure

```
video-render-worker/
├── .github/
│   └── workflows/
│       ├── render.yml          ← Worker 10: renders video every 5 min
│       ├── publish.yml         ← Worker 11: publishes to YouTube (10x/day)
│       └── trends.yml          ← fetch_trends.py cron trigger
├── assets/
│   └── jaasX-logo-saved-for-web.png   ← JaasX logo (loaded as base64)
├── themes/
│   ├── _base.css               ← Core layout, options, hint, timer CSS
│   └── particle_field.css      ← Default video theme
├── fetch_trends.py             ← Worker 1: Google Trends scraper
├── worker8.js                  ← Worker 2: AI quiz generator (Cloudflare)
├── worker10.js                 ← Worker 3: Video renderer (GitHub Actions)
├── worker11.js                 ← Worker 4: YouTube publisher (GitHub Actions)
├── quiz_template.html          ← HTML video template (13 screens)
├── package.json                ← Node deps: puppeteer, puppeteer-screen-recorder, uuid, @aws-sdk
└── niche_challenge_no_migration.sql  ← DB migration for niche counter
```

---

## 6. Worker 1: fetch_trends.py

**Where it runs:** GitHub Actions (cron schedule) OR locally  
**Trigger:** Schedule in `trends.yml`  
**Purpose:** Discovers trending US topics and creates quiz_queue jobs

### How it works

```
Google Trends (US, 4h window)
         │
         ▼ download CSV
46 raw trends
         │
         ▼ filter: min 2 words, min volume 1000, not duplicate
~20 valid trends
         │
         ▼ for each trend: Tavily/Google search for 200+ word context
         │
         ▼ INSERT into trending_cache
         │
         ▼ INSERT into quiz_queue (job_type=quiz_generation)
```

### Key configuration

The `trend_config` table controls behavior per channel:
```sql
SELECT * FROM trend_config WHERE country_code='us';
-- max_topics_per_run: 2  (how many topics per run)
-- time_window_hours: 24  (Google Trends window)
-- min_volume: 10000      (minimum search volume)
-- min_grounding_words: 200 (minimum context words required)
```

**IMPORTANT:** `country_code` must be stored as lowercase `'us'` in the DB. The code normalizes it.

### Waterfall strategy

The script uses a 3-stage waterfall to fill the topic quota:
1. **Stage 1 — Google Trends CSV** (real volume data, highest priority)
2. **Stage 2 — Google News RSS** (if Stage 1 doesn't fill quota)
3. **Stage 3 — Hardcoded fallback topics** (last resort)

### Troubleshooting fetch_trends.py

| Problem | Likely cause | Fix |
|---|---|---|
| `Settings: want 20 topics, window=4h` (ignoring config) | `trend_config.country_code` is uppercase 'US' but code queries lowercase | Run: `UPDATE trend_config SET country_code='us'` |
| `SKIP [too_short(1w)]` | Topic is only 1 word (e.g. "wimbledon") | Normal behavior — single words skip |
| `REJECT [thin(197w<200w)]` | Tavily returned less than 200 words of context | Normal — topic doesn't have enough web content |
| `SKIP (dup)` | Topic already in trending_cache today | Normal — deduplication working |
| CSV download fails | Google changed their UI | Check Playwright selectors in `trendspyg()` function |

---

## 7. Worker 2: worker8.js (Quiz Generator)

**Where it runs:** Cloudflare Workers  
**Trigger:** Cron (every 5 min) OR POST /generate-quiz  
**Purpose:** Reads quiz_queue → generates quiz questions with AI → inserts quiz rows

### How it works

```
quiz_queue (status=pending, job_type=quiz_generation)
         │
         ▼ mark job as processing
         │
         ▼ fetch all audio cue pools in parallel (hooks, sfx, bg_music, etc.)
         │
         ▼ call DeepSeek V3 via Vercel AI Gateway
         │   prompt: "Generate quiz questions about {topic} for {niche}"
         │   returns: JSON with questions, options, hints, MI questions
         │
         ▼ validate each question:
         │   - question ≤ 15 words
         │   - hint 2-10 words
         │   - explanation > 15 words
         │   - hint doesn't contain correct answer
         │   - question is self-contained (no "this", "that" references)
         │
         ▼ for each valid question: pick audio cues from pools
         │   (hook, sfx, countdown, bg_music, cta2, cta3, cta4, mission_intro)
         │
         ▼ INSERT into quiz table (one row per question)
         │   Sets: quiz_enriched=true, video_status=pending
         │   Sets: niche_challenge_no (per-niche counter)
         │   Sets: quiz_no (YYMMDD + 4-digit serial)
         │
         ▼ mark quiz_queue job as completed
```

### AI Model Chain

Current model: `deepseek/deepseek-v3.2` via Vercel AI Gateway  
API endpoint: `https://ai-gateway.vercel.sh/v1/chat/completions`  
Config stored in: `quiz_generation_settings` table (row id=1)

```sql
SELECT llm_model, llm_api_endpoint, temperature, max_tokens 
FROM quiz_generation_settings WHERE id=1;
```

If the AI call fails, the job retries up to 3 times before marking as `failed`.

### niche_challenge_no logic

Before generating, W8 counts existing quiz rows for this niche:
```javascript
const nicheRows = await dbGet(env, `quiz?niche=eq.${niche}&select=id`);
nicheCount = nicheRows.length;
// Each question in batch: niche_challenge_no = nicheCount + idx + 1
```

This gives Sports quiz #18, Tech quiz #3 etc. — used in the video marquee and YouTube description.

### Troubleshooting worker8.js

| Problem | Likely cause | Fix |
|---|---|---|
| `No pending jobs` | quiz_queue is empty | Check if fetch_trends.py ran successfully |
| `Failed to parse AI response` | LLM returned invalid JSON | Check `quiz_generation_settings.llm_api_key` |
| `REJECT [self-referential]` | Question says "this team" "that match" | AI prompt quality — questions need more context in prompt |
| `invalid_grant` on LLM | API key expired | Update `llm_api_key` in `quiz_generation_settings` table |
| All audio URLs null | Audio cue tables empty | Populate: `quiz_hooks`, `sfx_cues`, `background_music_tracks` etc. |
| `bumpUsage` error | Table doesn't have `last_used_at` column | `quiz_hooks`, `sfx_cues`, `background_music_tracks` don't have `last_used_at` — don't call bumpUsage on them |

---

## 8. Worker 3: worker10.js (Video Renderer)

**Where it runs:** GitHub Actions (ubuntu-latest)  
**Trigger:** `render.yml` cron every 5 minutes  
**Purpose:** Renders a complete 9:16 YouTube Shorts video from a quiz row

### How it works

```
quiz table (video_status=pending, quiz_enriched=true, is_active=true)
         │
         ▼ mark as processing
         │
         ▼ download all 14 audio files in PARALLEL from R2
         │   hook, qintro, ointro, timeup, cta1, cta2, missintro,
         │   cta3, cta4, sfx, countdown, bgmusic, correctsfx, sfxmission
         │
         ▼ load logo as base64 data URI
         │
         ▼ load quiz_template.html → replace all {{placeholders}}
         │
         ▼ launch Puppeteer browser (1080×1920 viewport)
         │
         ▼ for each of 12 screens:
         │   showOnly('.screen-class')    ← switch HTML screen
         │   buildAudio({prerecorded, fallbackTts})  ← get audio for this clip
         │   recordedClip(page, audio, duration)     ← record + mux audio
         │   pushClip(clip)               ← add to assembly list
         │
         ▼ concatMp4(clips) → one 50-55s video
         │
         ▼ applyBgMusic(video) → mix background music with ducking
         │
         ▼ generate thumbnail (Puppeteer screenshot of .thumb-screen)
         │
         ▼ upload video to R2: videos/{quiz_id}.mp4
         ▼ upload thumbnail to R2: thumbnails/{quiz_id}.png
         │
         ▼ UPDATE quiz SET video_status='rendered', video_url=..., thumbnail_url=...
```

### The 12 Video Screens

| # | Screen | Content | Audio |
|---|---|---|---|
| 1 | hook-slide | Hook phrase + logo + float icons | hook_audio_url |
| 2 | question-waiting-slide | "LIVE CHALLENGE" breaking news banner + challenge number | question_intro_audio_url |
| 3 | question-appear-slide | Question text fly-in (dramatic) | TTS question |
| 4 | options-waiting-slide | "Here are your options" | options_intro_audio_url |
| 5 | question-static | Question + all 4 options | TTS options intro |
| 6 | question-phase | Countdown timer + hint at T/4 + 50/50 at T/2 | countdown_music |
| 7 | pre-reveal-slide | "Time's up" transition | timeup_audio_url |
| 8 | answer-slide | Correct answer revealed + explanation | TTS answer + TTS explanation |
| 9 | cta2-slide | "Want to play the REAL CHALLENGE?" | cta2_audio_url |
| 10 | mission-final-slide | Mission Impossible question | TTS mission |
| 11 | comment-cta-screen | LIKE/SHARE/SUBSCRIBE + CTA4 text | SFX x3 + cta4_audio_url |
| 12 | thumb-screen | Thumbnail generation only | (no audio) |

### Audio Architecture

**TTS (Text-to-Speech):**
- Engine: Microsoft Edge TTS (`edge-tts` CLI)
- Voices: `en-US-JennyNeural` (EN), `hi-IN-SwaraNeural` (HI), `es-ES-ElviraNeural` (ES), `pt-BR-FranciscaNeural` (PT)
- TTS is the fallback when prerecorded audio download fails

**Background Music:**
- Downloaded from R2 (`quiz.background_music`)
- Applied AFTER all clips are concatenated
- Ducking: BG_VOL_BASE=0.28 (full volume), BG_VOL_DUCK=0.12 (under voice)
- Uses FFmpeg `amix` with `normalize=0` to prevent volume halving
- All voice timestamps tracked as `voiceRanges` for precise ducking

**Audio file format rules:**
- ALL clip audio: AAC 128k, 44100Hz, MONO (-ac 1)
- CRITICAL: Every clip must be MONO. Stereo + mono mismatch causes audio drop in concat.

**CTA screen audio (Like/Share/Subscribe + CTA4):**
- SFX URL: hardcoded R2 URL `audio/hint_reveal/sound10_sharp.wav`
- Timeline: LIKE sfx at 0.35s, SHARE at 1.05s, SUB at 1.75s, CTA4 audio at 2.55s
- Built using FFmpeg `amix` with `adelay` for precise per-timestamp placement
- CRITICAL: offset = CSS animation-delay + 0.25s (midpoint of 0.5s pop animation)

### Key Constants

```javascript
const BG_VOL_BASE = 0.28;   // background music volume when no voice
const BG_VOL_DUCK = 0.12;   // background music volume under voice  
const DUCK_RAMP   = 0.12;   // seconds of ramp before/after voice
const GAP_DEFAULT = 0.25;   // silence gap between audio segments
const DEFAULT_THEME = 'particle_field';
const DEFAULT_BG_MUSIC = 'https://pub-3578d297d3904e1d8ffedfc9dd4102f2.r2.dev/audio/background_music/The_Midnight_Audit.mp3';
```

### Troubleshooting worker10.js

| Problem | Log pattern | Fix |
|---|---|---|
| Audio missing from final video | `[VOLUME] clip_cta_combined_out: mean_volume=-58dB` | Check if clip was muxed as stereo — must be `-ac 1` |
| CTA4 audio not playing | No `[VOLUME] cta4_source` log | `quiz.cta4_audio_url` is null — check cta4_cues table |
| Hint overlaps option D | Visual overlap in video | Reduce `bottom:440px` in `.qp-hint` CSS |
| Video is all black | Puppeteer crash | Check Chromium deps in render.yml apt-get list |
| DOWNLOAD FAIL missintro | URL has unencoded spaces | Re-upload file to R2 with encoded filename |
| `video_url=null` | R2 credentials missing | Check R2_ACCESS_KEY/SECRET/ENDPOINT/BUCKET/PUBLIC_URL secrets |
| Video too long | Over 60s — not a Short | Check countdown timer `thinking_time_sec` — should be ≤10 |

---

## 9. Worker 4: worker11.js (YouTube Publisher)

**Where it runs:** GitHub Actions  
**Trigger:** `publish.yml` — 10 scheduled slots per day  
**Purpose:** Publishes approved videos to YouTube with full SEO metadata

### How it works

```
quiz table (video_status=rendered, is_human_approved=true, is_active=true)
         │
         ▼ random delay 1-8 minutes (anti-detection)
         │
         ▼ GET fresh YouTube access token (using refresh_token)
         │
         ▼ download MP4 from quiz.video_url (R2)
         │
         ▼ buildMetadata(quiz):
         │   - title: quiz.youtube_title (max 100 chars)
         │   - description: structured (see below)
         │   - tags: 30 fixed US+niche+channel tags (all single-word, cleaned)
         │   - categoryId: mapped from niche
         │
         ▼ YouTube resumable upload (2-step):
         │   Step 1: POST metadata → get upload URL
         │   Step 2: PUT video bytes to upload URL
         │
         ▼ setThumbnail: POST thumbnail PNG from R2 to YouTube
         │   (requires 1000+ subscribers — 403 if below threshold)
         │
         ▼ UPDATE quiz SET video_status='published', youtube_video_id=..., published_at=...
```

### YouTube Description Structure

```
🎯 Play the REAL CHALLENGE: jaasblog.online/quiz/{niche} and earn real ONS tokens!
🇺🇸 Trending right now in the United States of America

Challenge ID: {quiz_no}
{Niche} Challenge No #{niche_challenge_no}

{youtube_title}

⚡ Can YOU answer this? Drop your answer in the comments below!

📚 EXPLANATION:
{explanation_1}

━━━━━━━━━━━━━━━━━━━━━━━━━
{NICHE_DESC[niche]}   ← fixed per-niche block
━━━━━━━━━━━━━━━━━━━━━━━━━

📌 Like • Share • Subscribe → New challenge every day!
🔔 Hit the bell so you never miss a challenge!

🔥 TRENDING: {trend_keywords — raw, full phrases, max 20}

#quiz #trivia #challenge #shorts #youtubeshorts ...
#{niche}quiz #{niche}challenge
#USA #US #America #UnitedStates #American
#USAQuiz #AmericaQuiz #USAChallenge #TrendingUSA ...
#{top5_trending_keywords_as_hashtags}
```

### Tag strategy

- **30 fixed tags** — single words, all lowercase, no special chars
- Includes: channel tags, niche tags, US geo + quiz combinations
- `cleanTag()` function: strips non-ASCII, strips special chars, removes spaces, max 30 chars

### Publishing Schedule (US Eastern Time)

| Slot | ET Time | UTC Cron | Audience |
|---|---|---|---|
| 1 | 7:05 AM | `5 12 * * *` | Early risers |
| 2 | 8:17 AM | `17 13 * * *` | Morning commute |
| 3 | 10:43 AM | `43 15 * * *` | Mid-morning |
| 4 | 12:11 PM | `11 17 * * *` | Lunch |
| 5 | 1:38 PM | `38 18 * * *` | Post-lunch |
| 6 | 3:22 PM | `22 20 * * *` | Afternoon |
| 7 | 5:07 PM | `7 22 * * *` | Evening commute |
| 8 | 7:33 PM | `33 0 * * *` | Prime time |
| 9 | 9:11 PM | `11 2 * * *` | Peak prime |
| 10 | 10:47 PM | `47 3 * * *` | Late night |

Plus 1-8 minute random delay inside worker11.js = no two uploads at the same exact time.

### Troubleshooting worker11.js

| Problem | Log pattern | Fix |
|---|---|---|
| `invalid_client` | `{"error":"invalid_client"}` | Wrong YOUTUBE_CLIENT_SECRET in GitHub secrets |
| `invalid_grant` | `{"error":"invalid_grant"}` | Refresh token expired — re-run OAuth flow to get new refresh_token |
| `invalidTags` 400 error | `"reason":"invalidTags"` | Tags contain special chars — `cleanTag()` must strip everything |
| Thumbnail 403 | `"doesn't have permissions to upload thumbnails"` | Channel needs 1000+ subscribers |
| `video_url is NULL` | `[PUBLISHER] video_url is NULL` | Worker 10 didn't upload to R2 — check R2 secrets in render.yml |
| No approved videos | `No approved videos ready` | Run SQL: `UPDATE quiz SET is_human_approved=true WHERE...` |

---

## 10. GitHub Actions Workflows

### render.yml — Video Renderer

Runs every 5 minutes. Renders one video per run.

```yaml
on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:          # manual trigger
```

**Required secrets:**
- `SUPABASE_SERVICE_KEY`
- `R2_ACCESS_KEY`, `R2_SECRET_KEY`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_PUBLIC_URL`

**Required vars:**
- `SUPABASE_URL`

**Key apt-get packages:**
- `ffmpeg` — video/audio processing
- `libasound2t64` — audio (NOT `libasound2` which was renamed in Ubuntu 24)
- Chromium deps: `libatk-bridge2.0-0`, `libdrm2`, `libgbm1`, `libgtk-3-0`, `libnss3`, etc.

**Python packages:**
- `edge-tts` — Microsoft TTS

### publish.yml — YouTube Publisher

Runs at 10 scheduled times per day.

**Required secrets:**
- `SUPABASE_SERVICE_KEY`
- `YOUTUBE_CLIENT_ID`
- `YOUTUBE_CLIENT_SECRET`
- `YOUTUBE_REFRESH_TOKEN`

**Required vars:**
- `SUPABASE_URL`

### trends.yml — Trend Fetcher

Runs on schedule to fetch Google Trends and populate quiz_queue.

---

## 11. Cloudflare R2 Storage

**Bucket:** `jaas-videos` (or configured bucket name)  
**Public URL base:** `https://pub-3578d297d3904e1d8ffedfc9dd4102f2.r2.dev`

### Folder structure

```
R2 Bucket/
├── videos/
│   └── {quiz_id}.mp4          ← rendered video (uploaded by Worker 10)
├── thumbnails/
│   └── {quiz_id}.png          ← video thumbnail (uploaded by Worker 10)
├── audio/
│   ├── hooks/                 ← hook phrase audio files
│   ├── question_intro/        ← "Your challenge is on screen"
│   ├── options_intro/         ← "Here are your options"
│   ├── timeup/                ← "Time's up, let's reveal"
│   ├── cta2/                  ← CTA2 audio
│   ├── cta3/                  ← CTA3 audio
│   ├── cta4/                  ← CTA4 audio
│   ├── mission_impossible/    ← Mission Impossible intro
│   ├── hint_reveal/           ← SFX for hints and pills
│   ├── question_appear/       ← SFX for question appear
│   ├── suspense/              ← countdown music
│   └── background_music/     ← background music tracks
```

**IMPORTANT URL encoding:** R2 URLs must have spaces encoded as `%20`. Files with unencoded spaces in filenames will return 404. Always upload with clean filenames.

---

## 12. Environment Variables & Secrets

### GitHub Repository Secrets

| Secret | Used by | Value |
|---|---|---|
| `SUPABASE_SERVICE_KEY` | All workers | Supabase service role key |
| `R2_ACCESS_KEY` | Worker 10 | Cloudflare R2 access key ID |
| `R2_SECRET_KEY` | Worker 10 | Cloudflare R2 secret access key |
| `R2_ENDPOINT` | Worker 10 | `https://{account}.r2.cloudflarestorage.com` |
| `R2_BUCKET` | Worker 10 | Bucket name |
| `R2_PUBLIC_URL` | Worker 10 | `https://pub-xxx.r2.dev` |
| `YOUTUBE_CLIENT_ID` | Worker 11 | Google OAuth client ID |
| `YOUTUBE_CLIENT_SECRET` | Worker 11 | Google OAuth client secret |
| `YOUTUBE_REFRESH_TOKEN` | Worker 11 | YouTube OAuth refresh token (permanent) |

### GitHub Repository Variables (non-secret)

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://xxx.supabase.co` |

### Cloudflare Worker Secrets (worker8.js)

Set via Cloudflare dashboard → Workers → Settings → Variables:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `VERCEL_AI_GATEWAY_KEY` (or stored in `quiz_generation_settings` table)

---

## 13. Complete Pipeline Flow

### Step-by-step from trending topic to YouTube

```
1. TREND FETCH (fetch_trends.py)
   ├── Queries Google Trends API for US trending topics
   ├── Filters by volume, word count, context richness
   ├── Inserts into trending_cache
   └── Creates quiz_queue jobs (job_type=quiz_generation)

2. QUIZ GENERATION (worker8.js — Cloudflare)
   ├── Picks oldest pending quiz_queue job
   ├── Fetches all audio cue pools (hooks, sfx, bg_music, etc.)
   ├── Calls DeepSeek V3: "Write quiz questions about {topic}"
   ├── Validates each question (length, self-containment, hint quality)
   ├── Picks audio URLs from cue pools (lowest usage_count first)
   ├── Calculates niche_challenge_no (per-niche counter)
   ├── Inserts quiz rows with quiz_enriched=true, video_status=pending
   └── Marks quiz_queue job as completed

3. VIDEO RENDER (worker10.js — GitHub Actions)
   ├── Finds quiz row: video_status=pending AND quiz_enriched=true
   ├── Sets video_status=processing
   ├── Downloads 14 audio files from R2 in parallel
   ├── Builds HTML from quiz_template.html + CSS themes
   ├── Launches Puppeteer (headless Chrome, 1080×1920)
   ├── Records 12 screen clips (each with muxed audio)
   ├── Concatenates clips into single video
   ├── Applies background music with voice ducking
   ├── Takes thumbnail screenshot
   ├── Uploads video + thumbnail to R2
   └── Updates quiz: video_status=rendered, video_url=..., thumbnail_url=...

4. HUMAN REVIEW
   ├── Reviewer opens Supabase dashboard
   ├── Watches video from quiz.video_url
   ├── If approved: UPDATE quiz SET is_human_approved=true
   └── If rejected: UPDATE quiz SET is_active=false

5. YOUTUBE PUBLISH (worker11.js — GitHub Actions)
   ├── Runs at scheduled times (10x per day)
   ├── Waits random 1-8 minutes (anti-detection)
   ├── Finds quiz: video_status=rendered AND is_human_approved=true
   ├── Sets video_status=publishing
   ├── Gets fresh YouTube access token
   ├── Downloads MP4 from R2
   ├── Uploads to YouTube with metadata (title/description/tags/category)
   ├── Sets custom thumbnail from R2
   └── Updates quiz: video_status=published, youtube_video_id=...
```

---

## 14. Troubleshooting Guide

### Diagnosing by video_status

| `video_status` | Meaning | Action |
|---|---|---|
| `pending` | Waiting for Worker 10 to pick up | Check render.yml workflow is running |
| `processing` | Worker 10 is rendering | Wait — if stuck >30min, reset to `pending` |
| `rendered` | Video ready, awaiting approval | Go to Supabase, watch video, approve |
| `publishing` | Worker 11 is uploading | Wait — if stuck >30min, reset to `rendered` |
| `published` | Live on YouTube | Check `youtube_video_id` for the link |
| `error` | Something failed | Check `generation_error` column for message |

### Reset a stuck video

```sql
-- Reset a video stuck in processing
UPDATE quiz SET video_status='pending' 
WHERE id='your-quiz-id' AND video_status='processing';

-- Reset a video stuck in publishing  
UPDATE quiz SET video_status='rendered'
WHERE id='your-quiz-id' AND video_status='publishing';

-- Bulk approve videos for publishing
UPDATE quiz SET is_human_approved=true
WHERE video_status='rendered' 
  AND video_url IS NOT NULL
  AND is_active=true
  AND is_human_approved=false
ORDER BY created_at ASC
LIMIT 10;
```

### Check pipeline health

```sql
-- Overview of all video statuses
SELECT video_status, COUNT(*) as count 
FROM quiz 
GROUP BY video_status 
ORDER BY count DESC;

-- Videos ready to publish (approved but not yet published)
SELECT id, topic, youtube_title, created_at 
FROM quiz 
WHERE video_status='rendered' AND is_human_approved=true
ORDER BY created_at ASC;

-- Recent errors
SELECT id, topic, generation_error, updated_at
FROM quiz
WHERE video_status='error'
ORDER BY updated_at DESC
LIMIT 10;

-- Per-niche challenge numbers
SELECT niche, MAX(niche_challenge_no) as latest_no, COUNT(*) as total
FROM quiz
GROUP BY niche;
```

---

## 15. Common Errors & Fixes

### Audio errors

**Problem:** CTA4 audio not playing in video  
**Root cause:** CTA clip was built as stereo (2ch) but all other clips are mono (1ch). Channel mismatch causes audio to be dropped during FFmpeg concat.  
**Fix:** Always use `-ac 1` in CTA clip mux command.

**Problem:** Background music inaudible  
**Root cause:** `amix` filter normalizes by dividing all inputs — halving volume  
**Fix:** Use `normalize=0` in amix filter: `amix=inputs=2:duration=first:normalize=0`

**Problem:** SFX doesn't sync with pill animation  
**Root cause:** SFX timestamp fired at animation-delay start, but pill is still scaling in  
**Fix:** SFX timestamp = CSS animation-delay + 0.25s (midpoint of 0.5s pop animation)

**Problem:** Mission Impossible audio download fails  
**Root cause:** `mission IMPOSSIBLE. be smart enough an.wav` has unencoded spaces in R2 URL  
**Fix:** Re-upload file to R2 with properly URL-encoded filename

### Video errors

**Problem:** Option D hidden behind hint  
**Root cause:** Marquee pushed down → content area starts lower → option D overlaps hint  
**Fix:** Reduce `question-phase padding-top` and check `.qp-hint { bottom: }` value

**Problem:** Challenge ID overlaps niche marquee  
**Root cause:** `challenge-no top` value + font height > marquee `margin-top`  
**Fix:** Formula: `marquee margin-top = challenge-no top + font-height + desired-gap`

### YouTube errors

**Problem:** `invalidTags` 400 error  
**Root cause:** Tags contain special characters (`&`, `/`, `-`, spaces)  
**Fix:** `cleanTag()` function: strip non-ASCII, strip non-alphanumeric, remove ALL spaces

**Problem:** `invalid_client` on access token  
**Root cause:** Wrong `YOUTUBE_CLIENT_SECRET` in GitHub secrets  
**Fix:** Go to Google Cloud Console → Credentials → copy exact client secret → update GitHub secret

**Problem:** `invalid_grant` on access token  
**Root cause:** Refresh token expired or revoked  
**Fix:** Re-run the OAuth flow (Steps 4-5 from setup) to get a new refresh_token

**Problem:** Thumbnail 403 error  
**Root cause:** YouTube requires 1000 subscribers for API thumbnail upload  
**Fix:** Not a bug — will work automatically after 1000 subs. Video still publishes fine.

### Database errors

**Problem:** `trend_config` settings ignored (uses defaults)  
**Root cause:** `country_code` stored as `'US'` but query uses lowercase `'us'`  
**Fix:** `UPDATE trend_config SET country_code='us' WHERE country_code='US'`

**Problem:** `niche_challenge_no` is null on old quiz rows  
**Root cause:** Column added after rows were created  
**Fix:** Run `niche_challenge_no_migration.sql` in Supabase SQL editor

---

## 16. Monitoring & Maintenance

### Daily checks

1. **GitHub Actions** → check render.yml and publish.yml for failures
2. **Supabase** → check `video_status='error'` rows and `generation_error` messages
3. **YouTube Studio** → verify published videos have correct metadata

### Weekly tasks

1. Approve batch of 10+ videos for the coming week:
```sql
UPDATE quiz SET is_human_approved=true
WHERE video_status='rendered' AND video_url IS NOT NULL
AND is_active=true AND is_human_approved=false
ORDER BY created_at ASC LIMIT 10;
```

2. Check audio cue pools aren't running low:
```sql
SELECT 'hooks' as table, COUNT(*) as rows FROM quiz_hooks WHERE is_active=true
UNION ALL
SELECT 'cta4', COUNT(*) FROM cta4_cues WHERE is_active=true
UNION ALL
SELECT 'bg_music', COUNT(*) FROM background_music_tracks WHERE is_active=true;
```

3. Monitor YouTube quota — API limit is 10,000 units/day. Each upload costs ~1600 units. Max ~6 uploads/day safely. At 10 uploads/day, request quota increase from Google.

### Adding new audio cues

When adding new audio to R2:
1. Upload file with **no spaces in filename** (use underscores or hyphens)
2. Insert row into relevant cue table with full R2 URL
3. Set `is_active=true`, `usage_count=0`

Example:
```sql
INSERT INTO cta4_cues (audio_url, is_active, usage_count)
VALUES (
  'https://pub-3578d297d3904e1d8ffedfc9dd4102f2.r2.dev/audio/cta4/your_new_file.wav',
  true, 0
);
```

### Refreshing YouTube token

The refresh_token doesn't expire unless revoked. Access tokens expire in 1 hour — Worker 11 automatically refreshes them. If you get `invalid_grant`:

1. Open this URL (replace CLIENT_ID):
```
https://accounts.google.com/o/oauth2/auth?client_id=YOUR_CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob&response_type=code&scope=https://www.googleapis.com/auth/youtube.upload&access_type=offline&prompt=consent
```
2. Login → Allow → copy the code
3. Run the curl command to exchange for new refresh_token
4. Update `YOUTUBE_REFRESH_TOKEN` in GitHub secrets

---

## Summary

The pipeline is fully automated from trending topic discovery to YouTube publishing. The only human touchpoint is the approval step in Supabase — watch the video, set `is_human_approved=true`.

**Pipeline capacity:** With current settings:
- Renders up to 288 videos/day (every 5 min, 24h)
- Publishes 10 videos/day to YouTube
- Per-niche challenge numbers increment automatically
- Every video gets unique SEO description with trending keywords

**Cost:** Near-zero. GitHub Actions free tier (2000 min/month), Cloudflare Workers free tier, Supabase free tier, Cloudflare R2 free egress, DeepSeek V3 API (~$0.002/quiz).

