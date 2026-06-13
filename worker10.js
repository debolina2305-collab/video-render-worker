const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const { v4: uuidv4 } = require('uuid');

// ========================
// Environment variables
// ========================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

console.log('SUPABASE_URL from env:', supabaseUrl);
console.log('SUPABASE_SERVICE_KEY from env:', supabaseKey ? '*** (set)' : 'NOT SET');

const cleanSupabaseUrl = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;

if (!cleanSupabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials (URL or key)');
  process.exit(1);
}

const baseHeaders = {
  'apikey': supabaseKey,
  'Authorization': `Bearer ${supabaseKey}`,
  'Content-Type': 'application/json'
};

// Voice map for Edge TTS (used only for: question, options, explanation text)
const VOICE_MAP = {
  en: 'en-US-JennyNeural',
  hi: 'hi-IN-SwaraNeural',
  es: 'es-ES-ElviraNeural',
  pt: 'pt-BR-FranciscaNeural'
};

const CACHE_DIR = path.join(__dirname, 'audio_cache');
const THEMES_DIR = path.join(__dirname, 'themes');
const DEFAULT_THEME = 'particle_field';

// Background music ducking config
const BG_MUSIC_BASE_VOLUME = 0.12;   // base volume of background loop (very low, per spec)
const BG_MUSIC_DUCK_VOLUME = 0.12 * 0.35; // ~65% reduction during voice/cues
const DUCK_FADE_SEC = 0.15;          // fade time for ducking ramps

// ========================
// Supabase helper
// ========================
async function fetchSupabase(p, options = {}) {
  const url = `${cleanSupabaseUrl}/rest/v1/${p}`;
  console.log(`[FETCH] ${options.method || 'GET'} ${url}`);
  const headers = { ...baseHeaders, ...(options.headers || {}) };
  if (options.method && ['POST', 'PATCH', 'PUT'].includes(options.method)) {
    headers['Prefer'] = 'return=representation';
  }
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }
  const text = await response.text();
  console.log(`[FETCH] Response length: ${text.length} chars`);
  if (!text || text.trim() === '') return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    console.error(`[FETCH] Failed to parse JSON. Raw response: ${text.substring(0, 200)}`);
    throw err;
  }
}

// ========================
// Utility helpers
// ========================
async function getAudioDuration(audioPath) {
  const { stdout } = await execPromise(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioPath}"`
  );
  return parseFloat(stdout.trim());
}

async function getVideoDuration(videoPath) {
  const { stdout } = await execPromise(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
  );
  return parseFloat(stdout.trim());
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Generate TTS audio via edge-tts (used only for question/options/explanation text)
async function generateTTS(text, voice, outputPath, fallbackSeconds = 1) {
  const clean = (text || '').trim();
  if (!clean) {
    await execPromise(
      `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${fallbackSeconds} -q:a 9 -acodec libmp3lame "${outputPath}"`
    );
    return;
  }
  const tmpTextFile = outputPath + '.txt';
  await fs.writeFile(tmpTextFile, clean, 'utf8');
  await execPromise(
    `edge-tts --voice "${voice}" --file "${tmpTextFile}" --write-media "${outputPath}"`
  );
  await fs.unlink(tmpTextFile).catch(() => {});
}

async function generateSilence(seconds, outputPath) {
  const safeSeconds = Math.max(seconds, 0.05);
  await execPromise(
    `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${safeSeconds} -q:a 9 -acodec libmp3lame "${outputPath}"`
  );
}

async function concatAudio(audioPaths, outputPath, workDir) {
  const listPath = path.join(workDir, `audiolist_${uuidv4()}.txt`);
  await fs.writeFile(listPath, audioPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await execPromise(
    `ffmpeg -y -f concat -safe 0 -i "${listPath}" -acodec libmp3lame "${outputPath}"`
  );
  await fs.unlink(listPath).catch(() => {});
}

// Download + cache a remote audio URL (R2). Returns local path.
async function downloadAudio(url, cacheKey) {
  if (!url) return null;
  await ensureDir(CACHE_DIR);
  const ext = path.extname(new URL(url).pathname) || '.mp3';
  const localPath = path.join(CACHE_DIR, `${cacheKey}${ext}`);
  if (await fileExists(localPath)) return localPath;
  try {
    await execPromise(`curl -sL --fail "${url}" -o "${localPath}" --max-time 30`);
    if (await fileExists(localPath)) return localPath;
  } catch (e) {
    console.warn(`Failed to download audio cue from ${url}:`, e.message);
  }
  return null;
}

// Pick a random active row from a cue table, optionally filtered by niche
async function pickRandomCue(table, lang, niche) {
  let query = `${table}?language_code=eq.${lang}&is_active=eq.true&select=*&limit=50`;
  let rows = await fetchSupabase(query).catch(() => null);
  if (niche && rows) {
    const nicheMatches = rows.filter(r => r.niche === niche);
    if (nicheMatches.length > 0) rows = nicheMatches;
  }
  if (!rows || rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)];
}

// Pick a random row from a table without language_code (e.g. background_music_tracks, sfx_cues)
async function pickRandomCueNoLang(table, niche) {
  let query = `${table}?is_active=eq.true&select=*&limit=50`;
  let rows = await fetchSupabase(query).catch(() => null);
  if (!rows || rows.length === 0) return null;
  if (niche) {
    const nicheMatches = rows.filter(r => r.niche === niche);
    if (nicheMatches.length > 0) rows = nicheMatches;
    else rows = rows.filter(r => !r.niche); // prefer generic (niche=null) over mismatched niche
  } else {
    const generic = rows.filter(r => !r.niche);
    if (generic.length > 0) rows = generic;
  }
  if (rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)];
}

async function bumpUsage(table, id, currentUsage) {
  if (!id) return;
  await fetchSupabase(`${table}?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ usage_count: (currentUsage || 0) + 1, last_used_at: new Date().toISOString() })
  }).catch(() => {});
}

// Convert a static image + audio into a fixed-duration mp4 clip
async function imageToClip(imagePath, audioPath, duration, workDir, name) {
  const clipPath = path.join(workDir, `${name}.mp4`);
  await execPromise(
    `ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" -c:v libx264 -t ${duration} -pix_fmt yuv420p -c:a aac -shortest "${clipPath}"`
  );
  return { path: clipPath, duration };
}

// ========================
// Audio segment builder
// ========================
// A "segment" = { type: 'voice'|'silence'|'sfx', path?, duration }
// buildSegmentTrack concatenates segments into one audio file and returns
// {path, duration, voiceRanges} where voiceRanges = [{start,end}] in seconds
// for segments that should duck the background music.
async function buildSegmentTrack(segments, workDir, name) {
  const parts = [];
  let cursor = 0;
  const voiceRanges = [];

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    let segPath = seg.path;
    let segDur = seg.duration;

    if (seg.type === 'silence') {
      segPath = path.join(workDir, `${name}_sil_${i}.mp3`);
      await generateSilence(segDur, segPath);
    } else {
      segDur = segDur != null ? segDur : await getAudioDuration(segPath);
    }

    parts.push(segPath);
    if (seg.type === 'voice' || seg.type === 'sfx_duck') {
      voiceRanges.push({ start: cursor, end: cursor + segDur });
    }
    cursor += segDur;
  }

  const combinedPath = path.join(workDir, `${name}_combined.mp3`);
  await concatAudio(parts, combinedPath, workDir);
  const totalDur = await getAudioDuration(combinedPath);
  return { path: combinedPath, duration: totalDur, voiceRanges };
}

// Apply background music with ducking under voiceRanges, mixed with the
// foreground (voice/cue) track, for the FULL video duration.
async function mixBackgroundMusic(foregroundPath, totalDuration, voiceRanges, bgMusicPath, workDir) {
  if (!bgMusicPath) return foregroundPath; // no bg music available -> foreground only

  // Loop/trim bg music to totalDuration
  const bgTrimmed = path.join(workDir, 'bg_trimmed.mp3');
  await execPromise(
    `ffmpeg -y -stream_loop -1 -i "${bgMusicPath}" -t ${totalDuration} -acodec libmp3lame "${bgTrimmed}"`
  );

  // Build a volume filter with ducking envelope using FFmpeg's volume
  // expression + enable/between for each voice range.
  let volumeExpr;
  if (voiceRanges.length === 0) {
    volumeExpr = `volume=${BG_MUSIC_BASE_VOLUME}`;
  } else {
    // Build per-range duck filters chained via "volume=enable='between(t,a,b)':volume=X"
    // FFmpeg volume filter supports only one enable condition per instance,
    // so chain multiple volume filters - one per range - each ducking just that window,
    // with the base volume applied first.
    const filters = [`volume=${BG_MUSIC_BASE_VOLUME}`];
    for (const r of voiceRanges) {
      const start = Math.max(0, r.start - DUCK_FADE_SEC).toFixed(2);
      const end = (r.end + DUCK_FADE_SEC).toFixed(2);
      const ratio = (BG_MUSIC_DUCK_VOLUME / BG_MUSIC_BASE_VOLUME).toFixed(4);
      filters.push(`volume=enable='between(t,${start},${end})':volume=${ratio}`);
    }
    volumeExpr = filters.join(',');
  }

  const bgDucked = path.join(workDir, 'bg_ducked.mp3');
  await execPromise(
    `ffmpeg -y -i "${bgTrimmed}" -af "${volumeExpr}" -acodec libmp3lame "${bgDucked}"`
  );

  // Mix ducked bg with foreground
  const mixedPath = path.join(workDir, 'audio_with_bg.mp3');
  await execPromise(
    `ffmpeg -y -i "${foregroundPath}" -i "${bgDucked}" -filter_complex "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[a]" -map "[a]" -acodec libmp3lame "${mixedPath}"`
  );
  return mixedPath;
}

// ========================
// Job processing
// ========================
async function processJobs() {
  console.log('Checking for pending video jobs...');
  const jobs = await fetchSupabase(
    'quiz_queue?job_type=eq.video_render&status=eq.pending&order=created_at.asc&limit=1'
  );
  if (!jobs || jobs.length === 0) {
    console.log('No pending jobs');
    return;
  }
  const job = jobs[0];
  console.log(`Processing job ${job.id} for quiz ${job.quiz_id}`);

  await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'processing', started_at: new Date().toISOString() })
  });

  try {
    const quizzes = await fetchSupabase(`quiz?id=eq.${job.quiz_id}`);
    if (!quizzes || quizzes.length === 0) throw new Error('Quiz not found');
    const quiz = quizzes[0];

    const qIdx = (job.payload && job.payload.question_index) || 1;
    const lang = quiz.lang_code || 'en';

    const workDir = `/tmp/video_${uuidv4()}`;
    await ensureDir(workDir);

    const videoPath = await buildVideo(quiz, qIdx, lang, workDir);

    const stats = await fs.stat(videoPath);
    console.log(`Video created: ${videoPath}, size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);
    const durationSec = await getVideoDuration(videoPath);
    console.log(`Final duration: ${durationSec.toFixed(2)}s`);

    const artifactPath = `/tmp/${job.id}_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);
    console.log(`Video saved as artifact: ${artifactPath}`);
    await fs.writeFile('/tmp/artifact_ready', artifactPath);

    await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString() })
    });

    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        render_duration_sec: Math.round(durationSec),
        video_status: 'rendered'
      })
    });

    await fs.rm(workDir, { recursive: true, force: true });
    console.log(`Job ${job.id} completed successfully`);
  } catch (err) {
    console.error('Job failed:', err);
    await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: 'failed',
        last_error: String(err.message || err),
        retry_count: (job.retry_count || 0) + 1
      })
    }).catch(e => console.error('Failed to update queue row:', e));
    throw err;
  }
}

// ========================
// Theme resolution (unchanged from previous version)
// ========================
async function resolveThemeCss(quiz) {
  const base = await fs.readFile(path.join(THEMES_DIR, '_base.css'), 'utf8');

  let themeCss = '';
  let themeDecoHtml = '';

  if ((quiz.niche || '').toLowerCase() === 'general' && quiz.quiz_css_video && quiz.quiz_css_video.trim()) {
    themeCss = base + '\n/* ---- LLM-GENERATED (quiz_css_video) ---- */\n' + quiz.quiz_css_video;
    themeDecoHtml = '';
  } else {
    const themeId = quiz.visual_theme_id || DEFAULT_THEME;
    let themeFile = path.join(THEMES_DIR, `${themeId}.css`);
    if (!(await fileExists(themeFile))) {
      console.warn(`Theme '${themeId}' not found, falling back to '${DEFAULT_THEME}'`);
      themeFile = path.join(THEMES_DIR, `${DEFAULT_THEME}.css`);
    }
    const themeSpecific = await fs.readFile(themeFile, 'utf8');
    themeCss = base + '\n/* ---- THEME: ' + (quiz.visual_theme_id || DEFAULT_THEME) + ' ---- */\n' + themeSpecific;
    themeDecoHtml = buildThemeDecoHtml(quiz.visual_theme_id || DEFAULT_THEME);
  }

  const accent1 = quiz.theme_accent_primary || '#00e0ff';
  const accent2 = quiz.theme_accent_secondary || '#7b2ff7';
  const accent3 = quiz.theme_accent_tertiary || '#ff2ec4';
  themeCss = themeCss
    .split('{{accent_primary}}').join(accent1)
    .split('{{accent_secondary}}').join(accent2)
    .split('{{accent_tertiary}}').join(accent3);

  return { themeCss, themeDecoHtml };
}

function buildThemeDecoHtml(themeId) {
  switch (themeId) {
    case 'neon_grid':
      return `<div class="theme-deco"></div><div class="theme-deco2"></div>`;
    case 'coin_orbit':
      return `<div class="theme-deco">
                <div class="coin coin1">$</div>
                <div class="coin coin2">¢</div>
                <div class="coin coin3">€</div>
                <div class="coin coin4">₹</div>
              </div>`;
    case 'chart_pulse':
      return `<div class="theme-deco">
                <div class="bar"></div><div class="bar"></div><div class="bar"></div>
                <div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div>
              </div>
              <div class="theme-deco2">
                <svg viewBox="0 0 1080 200" preserveAspectRatio="none">
                  <path d="M0,150 C150,50 300,180 450,100 C600,20 750,160 900,80 C1000,30 1050,90 1080,60"/>
                </svg>
              </div>`;
    case 'paper_trail':
      return `<div class="theme-deco">
                <div class="doc doc1"></div><div class="doc doc2"></div>
                <div class="doc doc3"></div><div class="doc doc4"></div>
              </div>`;
    case 'vault_glow':
      return `<div class="theme-deco">
                <div class="vault-ring vr1"></div>
                <div class="vault-ring vr2"></div>
                <div class="vault-ring vr3"></div>
              </div>`;
    case 'skyline_dusk':
      return `<div class="theme-deco">
                <div class="bldg"></div><div class="bldg"></div><div class="bldg"></div>
                <div class="bldg"></div><div class="bldg"></div><div class="bldg"></div><div class="bldg"></div>
              </div>`;
    case 'global_orbit':
      return `<div class="theme-deco"><div class="lat-line ll1"></div><div class="lat-line ll2"></div></div>`;
    case 'confetti_pop':
      return `<div class="theme-deco">
                ${Array.from({ length: 14 }).map((_, i) => {
                  const left = (i * 7 + 3) % 100;
                  const dur = 3 + (i % 5);
                  const delay = (i * 0.3) % 4;
                  const colors = ['var(--accent-1)', 'var(--accent-2)', 'var(--accent-3)', '#ffd166', '#00ff8c'];
                  const color = colors[i % colors.length];
                  const size = 10 + (i % 4) * 4;
                  return `<div class="confetti-bg" style="left:${left}%; width:${size}px; height:${size * 1.6}px; background:${color}; animation-duration:${dur}s; animation-delay:${delay}s;"></div>`;
                }).join('')}
              </div>`;
    case 'shield_secure':
      return `<div class="theme-deco">
                <svg viewBox="0 0 200 240" preserveAspectRatio="xMidYMid meet">
                  <path d="M100,10 L180,40 L180,120 C180,180 140,220 100,230 C60,220 20,180 20,120 L20,40 Z"/>
                </svg>
              </div>
              <div class="shield-pulse"></div>`;
    case 'particle_field':
      return `<div class="theme-deco">
                ${Array.from({ length: 18 }).map((_, i) => {
                  const left = (i * 5 + 2) % 100;
                  const size = 6 + (i % 5) * 3;
                  const dur = 8 + (i % 6) * 2;
                  const delay = (i * 0.7) % 10;
                  return `<div class="particle" style="left:${left}%; bottom:-20px; width:${size}px; height:${size}px; animation-duration:${dur}s; animation-delay:${delay}s;"></div>`;
                }).join('')}
              </div>`;
    case 'aurora':
    default:
      return '';
  }
}

// ========================
// Main video builder
// ========================
async function buildVideo(quiz, qIdx, lang, workDir) {
  const voice = VOICE_MAP[lang] || VOICE_MAP.en;

  const options = quiz[`options_${qIdx}`] || [];
  const correctAnswer = quiz[`correct_answer_${qIdx}`] || '';
  const hint = quiz[`hint_${qIdx}`] || '';
  const keep5050 = quiz[`keep_5050_${qIdx}`] || [];
  const explanation = quiz[`explanation_${qIdx}`] || '';
  const question = quiz[`question_${qIdx}`] || '';

  // ---- Timing config ----
  // Thinking time: 8-10s. Hint @ 1/4, 50/50 @ 1/2.
  const QUESTION_TIME = quiz.thinking_time_sec || 9;
  const HINT_TIME = QUESTION_TIME / 4;
  const FIFTYFIFTY_TIME = QUESTION_TIME / 2;

  const allIdx = [0, 1, 2, 3];
  const eliminateIdx = allIdx.filter(i => !keep5050.includes(i) && !keep5050.includes(String(i)));

  // ---- Resolve theme ----
  const { themeCss, themeDecoHtml } = await resolveThemeCss(quiz);

  // ---- Build HTML from master template ----
  let html = await fs.readFile(path.join(__dirname, 'quiz_template.html'), 'utf8');

  const optClass = (i) => eliminateIdx.includes(i) ? 'eliminate' : '';
  const revClass = (i) => options[i] === correctAnswer ? 'correct' : 'wrong';

  const replacements = {
    '{{theme_css}}': themeCss,
    '{{theme_deco_html}}': themeDecoHtml,
    '{{hook_phrase}}': quiz.hook_phrase || 'Stop scrolling! Can you beat this quiz?',
    '{{question}}': question,
    '{{options[0]}}': options[0] || '',
    '{{options[1]}}': options[1] || '',
    '{{options[2]}}': options[2] || '',
    '{{options[3]}}': options[3] || '',
    '{{opt0_class}}': optClass(0),
    '{{opt1_class}}': optClass(1),
    '{{opt2_class}}': optClass(2),
    '{{opt3_class}}': optClass(3),
    '{{rev0_class}}': revClass(0),
    '{{rev1_class}}': revClass(1),
    '{{rev2_class}}': revClass(2),
    '{{rev3_class}}': revClass(3),
    '{{hint}}': hint,
    '{{correct_answer}}': correctAnswer,
    '{{explanation}}': explanation,
    '{{affiliate_text}}': quiz.affiliate_text || 'Check the link in the description!',
    '{{cta2_text}}': quiz.cta2_text || 'Want a real challenge? Visit our site and earn ONS tokens!',
    '{{blog_page_url}}': quiz.blog_page_url || `jaasblog.online/q/${quiz.niche || 'finance'}/${lang}/${quiz.topic_slug || ''}`,
    '{{mission_question}}': quiz.mission_impossible_question || '',
    '{{mission_hint}}': quiz.mission_impossible_hint || '',
    '{{qtime}}': QUESTION_TIME,
    '{{hint_time}}': HINT_TIME,
    '{{fiftyfifty_time}}': FIFTYFIFTY_TIME
  };
  for (const [key, value] of Object.entries(replacements)) {
    html = html.split(key).join(String(value));
  }

  const htmlPath = path.join(workDir, 'index.html');
  await fs.writeFile(htmlPath, html);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 300));

  const clips = []; // { path, duration, voiceRanges? } - voiceRanges relative to clip start

  async function showOnly(selector) {
    await page.evaluate((sel) => {
      document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
      const target = document.querySelector(sel);
      if (target) target.classList.add('active');
    }, selector);
  }

  // ===========================================================
  // Fetch all prerecorded cues up front (downloads cached locally)
  // ===========================================================
  const hookCue = await pickRandomCue('quiz_hooks', lang, quiz.niche);
  const questionIntroCue = await pickRandomCue('question_intro_cues', lang, null);
  const optionsIntroCue = await pickRandomCue('options_intro_cues', lang, null);
  const timeupCue = await pickRandomCue('timeup_cues', lang, null);
  const cta1Cue = await pickRandomCue('cta1_audio_cues', lang, quiz.niche);
  const cta2Cue = await pickRandomCue('cta2_audio_cues', lang, quiz.niche);
  const missionCue = await pickRandomCue('mission_impossible_cues', lang, null);
  const cta3Cue = await pickRandomCue('cta3_audio_cues', lang, null);
  const bgMusicCue = await pickRandomCueNoLang('background_music_tracks', quiz.niche);
  const sfxQuestionAppear = await pickRandomCueNoLang('sfx_cues', quiz.niche).then(async () => {
    const rows = await fetchSupabase(`sfx_cues?cue_name=eq.question_appear&is_active=eq.true&select=*&limit=10`).catch(() => null);
    return rows && rows.length ? rows[Math.floor(Math.random() * rows.length)] : null;
  });
  const sfxOptionsAppear = await (async () => {
    const rows = await fetchSupabase(`sfx_cues?cue_name=eq.options_appear&is_active=eq.true&select=*&limit=10`).catch(() => null);
    return rows && rows.length ? rows[Math.floor(Math.random() * rows.length)] : null;
  })();
  const sfxCountdownLoop = await (async () => {
    const rows = await fetchSupabase(`sfx_cues?cue_name=eq.countdown_loop&is_active=eq.true&select=*&limit=10`).catch(() => null);
    return rows && rows.length ? rows[Math.floor(Math.random() * rows.length)] : null;
  })();
  const sfxAnswerReveal = await (async () => {
    const rows = await fetchSupabase(`sfx_cues?cue_name=eq.answer_reveal&is_active=eq.true&select=*&limit=10`).catch(() => null);
    return rows && rows.length ? rows[Math.floor(Math.random() * rows.length)] : null;
  })();
  const sfxHintReveal = await (async () => {
    const rows = await fetchSupabase(`sfx_cues?cue_name=eq.hint_reveal&is_active=eq.true&select=*&limit=10`).catch(() => null);
    return rows && rows.length ? rows[Math.floor(Math.random() * rows.length)] : null;
  })();
  const sfxFiftyFifty = await (async () => {
    const rows = await fetchSupabase(`sfx_cues?cue_name=eq.fifty_fifty&is_active=eq.true&select=*&limit=10`).catch(() => null);
    return rows && rows.length ? rows[Math.floor(Math.random() * rows.length)] : null;
  })();

  // Download cached local copies
  const hookAudioFile = hookCue ? await downloadAudio(hookCue.audio_url, `hook_${hookCue.id}`) : null;
  const questionIntroFile = questionIntroCue ? await downloadAudio(questionIntroCue.audio_url, `qintro_${questionIntroCue.id}`) : null;
  const optionsIntroFile = optionsIntroCue ? await downloadAudio(optionsIntroCue.audio_url, `ointro_${optionsIntroCue.id}`) : null;
  const timeupFile = timeupCue ? await downloadAudio(timeupCue.audio_url, `timeup_${timeupCue.id}`) : null;
  const cta1File = cta1Cue ? await downloadAudio(cta1Cue.audio_url, `cta1_${cta1Cue.id}`) : null;
  const cta2File = cta2Cue ? await downloadAudio(cta2Cue.audio_url, `cta2_${cta2Cue.id}`) : null;
  const missionFile = missionCue ? await downloadAudio(missionCue.audio_url, `mission_${missionCue.id}`) : null;
  const cta3File = cta3Cue ? await downloadAudio(cta3Cue.audio_url, `cta3_${cta3Cue.id}`) : null;
  const bgMusicFile = bgMusicCue ? await downloadAudio(bgMusicCue.audio_url, `bgmusic_${bgMusicCue.id}`) : null;
  const sfxQuestionAppearFile = sfxQuestionAppear ? await downloadAudio(sfxQuestionAppear.audio_url, `sfx_qappear_${sfxQuestionAppear.id}`) : null;
  const sfxOptionsAppearFile = sfxOptionsAppear ? await downloadAudio(sfxOptionsAppear.audio_url, `sfx_oappear_${sfxOptionsAppear.id}`) : null;
  const sfxCountdownFile = sfxCountdownLoop ? await downloadAudio(sfxCountdownLoop.audio_url, `sfx_countdown_${sfxCountdownLoop.id}`) : null;
  const sfxAnswerRevealFile = sfxAnswerReveal ? await downloadAudio(sfxAnswerReveal.audio_url, `sfx_answer_${sfxAnswerReveal.id}`) : null;
  const sfxHintRevealFile = sfxHintReveal ? await downloadAudio(sfxHintReveal.audio_url, `sfx_hint_${sfxHintReveal.id}`) : null;
  const sfxFiftyFiftyFile = sfxFiftyFifty ? await downloadAudio(sfxFiftyFifty.audio_url, `sfx_5050_${sfxFiftyFifty.id}`) : null;

  // Bump usage counts (best-effort)
  if (hookCue) bumpUsage('quiz_hooks', hookCue.id, hookCue.usage_count);
  if (questionIntroCue) bumpUsage('question_intro_cues', questionIntroCue.id, questionIntroCue.usage_count);
  if (optionsIntroCue) bumpUsage('options_intro_cues', optionsIntroCue.id, optionsIntroCue.usage_count);
  if (timeupCue) bumpUsage('timeup_cues', timeupCue.id, timeupCue.usage_count);
  if (missionCue) bumpUsage('mission_impossible_cues', missionCue.id, missionCue.usage_count);
  if (cta3Cue) bumpUsage('cta3_audio_cues', cta3Cue.id, cta3Cue.usage_count);

  // Helper: human-like silence between TTS/cue beats
  async function gap(seconds) {
    const p = path.join(workDir, `gap_${uuidv4()}.mp3`);
    await generateSilence(seconds, p);
    return p;
  }

  // ===========================================================
  // STEP 1: HOOK + animated brand logo (2-3s, prerecorded audio if available)
  // ===========================================================
  await showOnly('.hook-slide');
  await new Promise(r => setTimeout(r, 1100));
  const hookImg = path.join(workDir, 'hook.png');
  await page.screenshot({ path: hookImg });

  let hookSeg;
  if (hookAudioFile) {
    hookSeg = { path: hookAudioFile, duration: await getAudioDuration(hookAudioFile) };
  } else {
    const ttsPath = path.join(workDir, 'hook_tts.mp3');
    await generateTTS(quiz.hook_phrase || hookCue?.hook_text || 'Stop scrolling! Can you beat this quiz?', voice, ttsPath, 2.5);
    hookSeg = { path: ttsPath, duration: await getAudioDuration(ttsPath) };
  }
  const hookTrack = await buildSegmentTrack(
    [{ type: 'voice', path: hookSeg.path, duration: hookSeg.duration }],
    workDir, 'step1'
  );
  const hookDur = Math.max(hookTrack.duration, 2.0);
  const hookClip = await imageToClip(hookImg, hookTrack.path, hookDur, workDir, 'clip_hook');
  clips.push({ ...hookClip, voiceRanges: hookTrack.voiceRanges });

  // ===========================================================
  // STEP 2: "Here is your challenge" - audio only, waiting frame
  // ===========================================================
  await showOnly('.waiting-slide');
  await new Promise(r => setTimeout(r, 300));
  const waitingImg = path.join(workDir, 'waiting.png');
  await page.screenshot({ path: waitingImg });

  let challengeSeg;
  if (questionIntroFile) {
    challengeSeg = { path: questionIntroFile, duration: await getAudioDuration(questionIntroFile) };
  } else {
    const ttsPath = path.join(workDir, 'challenge_tts.mp3');
    await generateTTS('Here is your challenge!', voice, ttsPath, 1.5);
    challengeSeg = { path: ttsPath, duration: await getAudioDuration(ttsPath) };
  }
  // gap before (human-like) - 0.3s leading silence between hook and this cue
  const step2Track = await buildSegmentTrack(
    [
      { type: 'silence', duration: 0.3 },
      { type: 'voice', path: challengeSeg.path, duration: challengeSeg.duration }
    ],
    workDir, 'step2'
  );
  const step2Clip = await imageToClip(waitingImg, step2Track.path, step2Track.duration, workDir, 'clip_step2');
  clips.push({ ...step2Clip, voiceRanges: step2Track.voiceRanges });

  // ===========================================================
  // STEP 3: QUESTION appears with animation (text + TTS),
  // preceded by 0.3s gap after hook TTS finished (per clarified spec:
  // hook TTS -> wait 0.3s -> question appears). The 0.3s gap was
  // already applied at the start of step 2; step 3 follows immediately
  // after step 2's audio with its own short lead-in gap.
  // ===========================================================
  await showOnly('.question-appear-slide');
  await new Promise(r => setTimeout(r, 700)); // let qp-card-question entrance animation play
  const questionImg = path.join(workDir, 'question_appear.png');
  await page.screenshot({ path: questionImg });

  const questionTtsPath = path.join(workDir, 'question_tts.mp3');
  await generateTTS(question, voice, questionTtsPath, 3);
  const questionTtsDur = await getAudioDuration(questionTtsPath);

  const step3Segments = [{ type: 'silence', duration: 0.3 }];
  if (sfxQuestionAppearFile) {
    step3Segments.push({ type: 'sfx_duck', path: sfxQuestionAppearFile, duration: await getAudioDuration(sfxQuestionAppearFile) });
    step3Segments.push({ type: 'silence', duration: 0.15 });
  }
  step3Segments.push({ type: 'voice', path: questionTtsPath, duration: questionTtsDur });
  const step3Track = await buildSegmentTrack(step3Segments, workDir, 'step3');
  const step3Clip = await imageToClip(questionImg, step3Track.path, step3Track.duration, workDir, 'clip_step3');
  clips.push({ ...step3Clip, voiceRanges: step3Track.voiceRanges });

  // ===========================================================
  // STEP 4: 0.7s silence, "and your options are" (audio only)
  // STEP 5: OPTIONS appear with animation (question-static frame)
  // ===========================================================
  await showOnly('.question-static');
  await new Promise(r => setTimeout(r, 800)); // let options entrance animation play
  const optionsImg = path.join(workDir, 'options_static.png');
  await page.screenshot({ path: optionsImg });

  let optionsIntroSeg;
  if (optionsIntroFile) {
    optionsIntroSeg = { path: optionsIntroFile, duration: await getAudioDuration(optionsIntroFile) };
  } else {
    const ttsPath = path.join(workDir, 'options_intro_tts.mp3');
    await generateTTS('And your options are...', voice, ttsPath, 1.5);
    optionsIntroSeg = { path: ttsPath, duration: await getAudioDuration(ttsPath) };
  }

  const step4Segments = [{ type: 'silence', duration: 0.7 }];
  if (sfxOptionsAppearFile) {
    step4Segments.push({ type: 'sfx_duck', path: sfxOptionsAppearFile, duration: await getAudioDuration(sfxOptionsAppearFile) });
    step4Segments.push({ type: 'silence', duration: 0.15 });
  }
  step4Segments.push({ type: 'voice', path: optionsIntroSeg.path, duration: optionsIntroSeg.duration });

  // STEP 5: now TTS-narrate each option with small gaps (text+TTS per spec)
  for (let i = 0; i < options.length; i++) {
    if (!options[i]) continue;
    const optTtsPath = path.join(workDir, `option_${i}_tts.mp3`);
    await generateTTS(`${String.fromCharCode(65 + i)}. ${options[i]}`, voice, optTtsPath, 1);
    const optDur = await getAudioDuration(optTtsPath);
    step4Segments.push({ type: 'silence', duration: 0.25 });
    step4Segments.push({ type: 'voice', path: optTtsPath, duration: optDur });
  }

  const step4Track = await buildSegmentTrack(step4Segments, workDir, 'step4');
  const step4Clip = await imageToClip(optionsImg, step4Track.path, step4Track.duration, workDir, 'clip_step4');
  clips.push({ ...step4Clip, voiceRanges: step4Track.voiceRanges });

  // ===========================================================
  // STEP 6-8: COUNTDOWN PHASE (screen recording).
  // Timer drains over QUESTION_TIME. Hint @ 1/4 with sting. 50/50 @ 1/2 with sting.
  // Countdown music plays for the full duration.
  // ===========================================================
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 200));
  await showOnly('.question-phase');

  const questionVideoRaw = path.join(workDir, 'question_phase_raw.mp4');
  const recorder = new PuppeteerScreenRecorder(page, {
    fps: 30,
    videoFrame: { width: 1080, height: 1920 },
    aspectRatio: '9:16'
  });
  await recorder.start(questionVideoRaw);
  await new Promise(r => setTimeout(r, QUESTION_TIME * 1000));
  await recorder.stop();

  // Countdown audio bed
  const countdownBase = path.join(workDir, 'countdown_base.mp3');
  if (sfxCountdownFile) {
    await execPromise(`ffmpeg -y -stream_loop -1 -i "${sfxCountdownFile}" -t ${QUESTION_TIME} -acodec libmp3lame "${countdownBase}"`);
  } else {
    await generateSilence(QUESTION_TIME, countdownBase);
  }

  // Layer hint (@1/4) and 50/50 (@1/2) stings via adelay + amix
  let countdownFinal = countdownBase;
  const stingInputs = [];
  if (sfxHintRevealFile) stingInputs.push({ file: sfxHintRevealFile, delayMs: Math.round(HINT_TIME * 1000) });
  if (sfxFiftyFiftyFile) stingInputs.push({ file: sfxFiftyFiftyFile, delayMs: Math.round(FIFTYFIFTY_TIME * 1000) });
  if (stingInputs.length > 0) {
    const mixedAudio = path.join(workDir, 'countdown_mixed.mp3');
    const inputs = [`-i "${countdownBase}"`, ...stingInputs.map(s => `-i "${s.file}"`)].join(' ');
    const delayFilters = stingInputs.map((s, idx) => `[${idx + 1}:a]adelay=${s.delayMs}|${s.delayMs}[s${idx}]`).join(';');
    const mixInputs = ['[0:a]', ...stingInputs.map((_, idx) => `[s${idx}]`)].join('');
    const filter = `${delayFilters};${mixInputs}amix=inputs=${stingInputs.length + 1}:duration=first[a]`;
    await execPromise(`ffmpeg -y ${inputs} -filter_complex "${filter}" -map "[a]" -t ${QUESTION_TIME} -acodec libmp3lame "${mixedAudio}"`);
    countdownFinal = mixedAudio;
  }

  const questionClipPath = path.join(workDir, 'clip_question.mp4');
  await execPromise(
    `ffmpeg -y -i "${questionVideoRaw}" -i "${countdownFinal}" -c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${questionClipPath}"`
  );
  const questionDur = await getVideoDuration(questionClipPath);
  // Countdown music is itself a "special sound" that should NOT be ducked
  // by background music ducking logic (no bg music overlap during this
  // phase per spec - "no overlap of sound... but only overlap with low
  // volume background music" -> we treat this whole clip's countdown
  // track as the foreground, so mark entire clip as a voice range to
  // duck the bg music under it too).
  clips.push({ path: questionClipPath, duration: questionDur, voiceRanges: [{ start: 0, end: questionDur }] });

  // ===========================================================
  // STEP 9: "Time's up! The correct answer is..." (prerecorded audio only)
  // Pre-reveal frame shown (options visible, none highlighted)
  // ===========================================================
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 200));
  await showOnly('.pre-reveal-slide');
  await new Promise(r => setTimeout(r, 300));
  const preRevealImg = path.join(workDir, 'pre_reveal.png');
  await page.screenshot({ path: preRevealImg });

  let timeupSeg;
  if (timeupFile) {
    timeupSeg = { path: timeupFile, duration: await getAudioDuration(timeupFile) };
  } else {
    const ttsPath = path.join(workDir, 'timeup_tts.mp3');
    await generateTTS(timeupCue?.lead_in_text || "Time's up! The correct answer is", voice, ttsPath, 2);
    timeupSeg = { path: ttsPath, duration: await getAudioDuration(ttsPath) };
  }
  const step9Track = await buildSegmentTrack(
    [
      { type: 'silence', duration: 0.3 },
      { type: 'voice', path: timeupSeg.path, duration: timeupSeg.duration }
    ],
    workDir, 'step9'
  );
  const step9Clip = await imageToClip(preRevealImg, step9Track.path, step9Track.duration, workDir, 'clip_step9');
  clips.push({ ...step9Clip, voiceRanges: step9Track.voiceRanges });

  // ===========================================================
  // STEP 10: 0.5s silence, then correct answer revealed (highlight/dim,
  // confetti, answer-reveal SFX only - no TTS)
  // ===========================================================
  await showOnly('.answer-slide');
  await new Promise(r => setTimeout(r, 300));
  const answerImg = path.join(workDir, 'answer.png');
  await page.screenshot({ path: answerImg });

  const step10Segments = [{ type: 'silence', duration: 0.5 }];
  if (sfxAnswerRevealFile) {
    step10Segments.push({ type: 'sfx_duck', path: sfxAnswerRevealFile, duration: await getAudioDuration(sfxAnswerRevealFile) });
  } else {
    step10Segments.push({ type: 'silence', duration: 1.0 });
  }
  const step10Track = await buildSegmentTrack(step10Segments, workDir, 'step10');
  const step10Clip = await imageToClip(answerImg, step10Track.path, step10Track.duration, workDir, 'clip_step10');
  clips.push({ ...step10Clip, voiceRanges: step10Track.voiceRanges });

  // ===========================================================
  // STEP 11: 0.5s silence, then explanation (text + TTS, <=20 words)
  // ===========================================================
  await showOnly('.explanation-slide');
  await new Promise(r => setTimeout(r, 400));
  const explImg = path.join(workDir, 'explanation.png');
  await page.screenshot({ path: explImg });

  const explTtsPath = path.join(workDir, 'explanation_tts.mp3');
  await generateTTS(explanation, voice, explTtsPath, 3);
  const explDur = await getAudioDuration(explTtsPath);
  const step11Track = await buildSegmentTrack(
    [
      { type: 'silence', duration: 0.5 },
      { type: 'voice', path: explTtsPath, duration: explDur }
    ],
    workDir, 'step11'
  );
  const step11Clip = await imageToClip(explImg, step11Track.path, step11Track.duration, workDir, 'clip_step11');
  clips.push({ ...step11Clip, voiceRanges: step11Track.voiceRanges });

  // ===========================================================
  // CTA1 / CTA2 - alternate. Pick one at random per video.
  // ===========================================================
  const useCta1 = Math.random() < 0.5;
  if (useCta1) {
    await showOnly('.cta1-slide');
    await new Promise(r => setTimeout(r, 400));
    const cta1Img = path.join(workDir, 'cta1.png');
    await page.screenshot({ path: cta1Img });

    let cta1Seg;
    if (cta1File) {
      cta1Seg = { path: cta1File, duration: await getAudioDuration(cta1File) };
    } else {
      const ttsPath = path.join(workDir, 'cta1_tts.mp3');
      await generateTTS(quiz.affiliate_text || cta1Cue?.cta_text || 'Check the link in the description!', voice, ttsPath, 3);
      cta1Seg = { path: ttsPath, duration: await getAudioDuration(ttsPath) };
    }
    const ctaTrack = await buildSegmentTrack(
      [{ type: 'silence', duration: 0.4 }, { type: 'voice', path: cta1Seg.path, duration: cta1Seg.duration }],
      workDir, 'cta1'
    );
    const ctaClip = await imageToClip(cta1Img, ctaTrack.path, ctaTrack.duration, workDir, 'clip_cta1');
    clips.push({ ...ctaClip, voiceRanges: ctaTrack.voiceRanges });
  } else {
    await showOnly('.cta2-slide');
    await new Promise(r => setTimeout(r, 400));
    const cta2Img = path.join(workDir, 'cta2.png');
    await page.screenshot({ path: cta2Img });

    let cta2Seg;
    if (cta2File) {
      cta2Seg = { path: cta2File, duration: await getAudioDuration(cta2File) };
    } else {
      const ttsPath = path.join(workDir, 'cta2_tts.mp3');
      await generateTTS(quiz.cta2_text || cta2Cue?.cta_text || 'Want a real challenge? Visit our site and earn ONS tokens!', voice, ttsPath, 3);
      cta2Seg = { path: ttsPath, duration: await getAudioDuration(ttsPath) };
    }
    const ctaTrack = await buildSegmentTrack(
      [{ type: 'silence', duration: 0.4 }, { type: 'voice', path: cta2Seg.path, duration: cta2Seg.duration }],
      workDir, 'cta2'
    );
    const ctaClip = await imageToClip(cta2Img, ctaTrack.path, ctaTrack.duration, workDir, 'clip_cta2');
    clips.push({ ...ctaClip, voiceRanges: ctaTrack.voiceRanges });
  }

  // ===========================================================
  // STEP 13: Mission Impossible question + hint (large bold, with
  // attention-grabbing intro audio if available)
  // ===========================================================
  if (quiz.mission_impossible_enabled !== false && quiz.mission_impossible_question) {
    await showOnly('.mission-final-slide');
    // Hide CTA3 text for stage 1
    await page.evaluate(() => {
      const el = document.querySelector('.cta3-text');
      if (el) el.classList.remove('show-cta3');
    });
    await new Promise(r => setTimeout(r, 400));
    const missionImg = path.join(workDir, 'mission.png');
    await page.screenshot({ path: missionImg });

    let missionSeg;
    if (missionFile) {
      missionSeg = { path: missionFile, duration: await getAudioDuration(missionFile) };
    } else {
      const ttsPath = path.join(workDir, 'mission_tts.mp3');
      await generateTTS(missionCue?.intro_text || quiz.mission_impossible_question, voice, ttsPath, 2);
      missionSeg = { path: ttsPath, duration: await getAudioDuration(ttsPath) };
    }
    const missionTrack = await buildSegmentTrack(
      [{ type: 'silence', duration: 0.4 }, { type: 'voice', path: missionSeg.path, duration: missionSeg.duration }],
      workDir, 'mission'
    );
    // Ensure this slide holds for at least 2.5s before CTA3 (step 14 timing)
    const missionDur = Math.max(missionTrack.duration, 2.5);
    const missionClip = await imageToClip(missionImg, missionTrack.path, missionDur, workDir, 'clip_mission');
    clips.push({ ...missionClip, voiceRanges: missionTrack.voiceRanges });

    // ===========================================================
    // STEP 14: After 2.5s of MI, CTA3 (final CTA) - reveal CTA3 text
    // ===========================================================
    await page.evaluate(() => {
      const el = document.querySelector('.cta3-text');
      if (el) el.classList.add('show-cta3');
    });
    await new Promise(r => setTimeout(r, 500));
    const cta3Img = path.join(workDir, 'cta3.png');
    await page.screenshot({ path: cta3Img });

    let cta3Seg;
    if (cta3File) {
      cta3Seg = { path: cta3File, duration: await getAudioDuration(cta3File) };
    } else {
      const ttsPath = path.join(workDir, 'cta3_tts.mp3');
      await generateTTS(cta3Cue?.cta_text || 'Like, share, and challenge a friend! Subscribe and write your answer in the comments!', voice, ttsPath, 4);
      cta3Seg = { path: ttsPath, duration: await getAudioDuration(ttsPath) };
    }
    const cta3Track = await buildSegmentTrack(
      [{ type: 'voice', path: cta3Seg.path, duration: cta3Seg.duration }],
      workDir, 'cta3'
    );
    const cta3Clip = await imageToClip(cta3Img, cta3Track.path, cta3Track.duration, workDir, 'clip_cta3');
    clips.push({ ...cta3Clip, voiceRanges: cta3Track.voiceRanges });

    // ===========================================================
    // STEP 15: After CTA3 audio ends, hold everything on screen for 1s
    // ===========================================================
    const holdTrack = await buildSegmentTrack([{ type: 'silence', duration: 1.0 }], workDir, 'hold');
    const holdClip = await imageToClip(cta3Img, holdTrack.path, holdTrack.duration, workDir, 'clip_hold');
    clips.push({ ...holdClip, voiceRanges: [] });
  }

  await browser.close();

  // ===========================================================
  // FINAL ASSEMBLY
  // Step A: concat all video clips (each clip's own foreground audio
  //         already mixed in)
  // Step B: build a combined voiceRanges list across the full timeline
  // Step C: overlay background music (ducked under voiceRanges) onto
  //         the concatenated video
  // ===========================================================
  const concatList = clips.map(c => `file '${c.path}'`).join('\n');
  const listPath = path.join(workDir, 'concat.txt');
  await fs.writeFile(listPath, concatList);

  const concatenated = path.join(workDir, 'concatenated.mp4');
  await execPromise(
    `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:v libx264 -c:a aac -movflags +faststart "${concatenated}"`
  );

  const totalDur = await getVideoDuration(concatenated);
  console.log(`Concatenated duration: ${totalDur.toFixed(2)}s`);

  // Build global voiceRanges (offset by cumulative clip durations)
  let cursor = 0;
  const globalVoiceRanges = [];
  for (const c of clips) {
    for (const r of (c.voiceRanges || [])) {
      globalVoiceRanges.push({ start: cursor + r.start, end: cursor + r.end });
    }
    cursor += c.duration;
  }

  let finalOutput = concatenated;
  if (bgMusicFile) {
    // Extract the concatenated audio, mix in ducked bg music, then remux with video
    const fgAudio = path.join(workDir, 'fg_audio.aac');
    await execPromise(`ffmpeg -y -i "${concatenated}" -vn -acodec copy "${fgAudio}"`);
    const fgAudioMp3 = path.join(workDir, 'fg_audio.mp3');
    await execPromise(`ffmpeg -y -i "${fgAudio}" -acodec libmp3lame "${fgAudioMp3}"`);

    const mixedAudio = await mixBackgroundMusic(fgAudioMp3, totalDur, globalVoiceRanges, bgMusicFile, workDir);

    const remuxed = path.join(workDir, 'final.mp4');
    await execPromise(
      `ffmpeg -y -i "${concatenated}" -i "${mixedAudio}" -c:v copy -map 0:v:0 -map 1:a:0 -c:a aac -shortest -movflags +faststart "${remuxed}"`
    );
    finalOutput = remuxed;
  }

  console.log(`Final output duration target: ${totalDur.toFixed(2)}s, voiceRanges: ${globalVoiceRanges.length}`);
  return finalOutput;
}

// ========================
// Entry point
// ========================
processJobs().then(() => {
  console.log('Worker finished this run');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
