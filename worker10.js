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

// Voice map for Edge TTS
const VOICE_MAP = {
  en: 'en-US-JennyNeural',
  hi: 'hi-IN-SwaraNeural',
  es: 'es-ES-ElviraNeural',
  pt: 'pt-BR-FranciscaNeural'
};

const FIXED_PHRASES_DIR = path.join(__dirname, 'fixed_audio');
const SFX_DIR = path.join(__dirname, 'sfx');
const THEMES_DIR = path.join(__dirname, 'themes');
const CACHE_DIR = path.join(__dirname, 'audio_cache');
const DEFAULT_THEME = 'particle_field';

// Human-like gap (seconds of silence) inserted between consecutive TTS beats
const TTS_GAP_SEC = 0.35;

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

// URL-encode a file path portion (handles spaces in R2 filenames)
function encodeR2Url(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    // encode only the pathname, preserving slashes
    u.pathname = u.pathname.split('/').map(seg => encodeURIComponent(decodeURIComponent(seg))).join('/');
    return u.toString();
  } catch {
    return url;
  }
}

// Download + cache a remote audio URL (R2). Returns local path or null.
async function downloadAudio(url, cacheKey) {
  if (!url) return null;
  await ensureDir(CACHE_DIR);
  const encodedUrl = encodeR2Url(url);
  const ext = path.extname(new URL(encodedUrl).pathname) || '.wav';
  const safeKey = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const localPath = path.join(CACHE_DIR, `${safeKey}${ext}`);
  if (await fileExists(localPath)) {
    console.log(`[AUDIO CACHE HIT] ${safeKey}`);
    return localPath;
  }
  try {
    console.log(`[AUDIO DOWNLOAD] ${encodedUrl}`);
    await execPromise(`curl -sL --fail "${encodedUrl}" -o "${localPath}" --max-time 30`);
    if (await fileExists(localPath)) return localPath;
  } catch (e) {
    console.warn(`[AUDIO DOWNLOAD FAILED] ${encodedUrl}:`, e.message);
    await fs.unlink(localPath).catch(() => {});
  }
  return null;
}

// Pick a random active cue from a table filtered by language (and optionally niche)
async function pickRandomCue(table, lang, niche) {
  const rows = await fetchSupabase(
    `${table}?language_code=eq.${lang}&is_active=eq.true&select=*&limit=50`
  ).catch(() => null);
  if (!rows || rows.length === 0) return null;
  let candidates = rows;
  if (niche) {
    const nicheMatch = rows.filter(r => r.niche === niche);
    if (nicheMatch.length > 0) candidates = nicheMatch;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Pick a random active SFX cue by cue_name (no language filter)
async function pickSfxCue(cueName) {
  const rows = await fetchSupabase(
    `sfx_cues?cue_name=eq.${cueName}&is_active=eq.true&select=*&limit=20`
  ).catch(() => null);
  if (!rows || rows.length === 0) return null;
  return rows[Math.floor(Math.random() * rows.length)];
}

// Pick background music (niche match preferred, then generic)
async function pickBgMusic(niche) {
  const rows = await fetchSupabase(
    `background_music_tracks?is_active=eq.true&select=*&limit=30`
  ).catch(() => null);
  if (!rows || rows.length === 0) return null;
  let candidates = rows.filter(r => r.niche === niche);
  if (candidates.length === 0) candidates = rows.filter(r => !r.niche);
  if (candidates.length === 0) candidates = rows;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

// Bump usage count (best-effort, non-blocking)
function bumpUsage(table, id, currentCount) {
  if (!id) return;
  fetchSupabase(`${table}?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      usage_count: (currentCount || 0) + 1,
      last_used_at: new Date().toISOString()
    })
  }).catch(() => {});
}

// Generate TTS audio via edge-tts. Falls back to silence if text is empty.
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

// Generate N seconds of silence
async function generateSilence(seconds, outputPath) {
  const safe = Math.max(parseFloat(seconds) || 0.1, 0.05);
  await execPromise(
    `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${safe} -q:a 9 -acodec libmp3lame "${outputPath}"`
  );
}

// Concatenate multiple audio files into one (used to add human-like gaps between TTS beats)
async function concatAudio(audioPaths, outputPath, workDir) {
  const listPath = path.join(workDir, `audiolist_${uuidv4()}.txt`);
  await fs.writeFile(listPath, audioPaths.map(p => `file '${p}'`).join('\n'));
  await execPromise(
    `ffmpeg -y -f concat -safe 0 -i "${listPath}" -acodec libmp3lame "${outputPath}"`
  );
  await fs.unlink(listPath).catch(() => {});
}

async function getFixedPhraseAudio(key, text, voice, lang) {
  await ensureDir(FIXED_PHRASES_DIR);
  const cachedPath = path.join(FIXED_PHRASES_DIR, `${key}_${lang}.mp3`);
  if (await fileExists(cachedPath)) {
    return cachedPath;
  }
  await generateTTS(text, voice, cachedPath, 1);
  return cachedPath;
}

async function getSuspenseSfx(niche) {
  await ensureDir(SFX_DIR);
  const nicheFile = path.join(SFX_DIR, `${niche || 'default'}.mp3`);
  if (await fileExists(nicheFile)) return nicheFile;
  const defaultFile = path.join(SFX_DIR, 'default.mp3');
  if (await fileExists(defaultFile)) return defaultFile;
  return null;
}

// Short SFX stings for hint / 50-50 reveal (optional files)
async function getStingSfx(name) {
  await ensureDir(SFX_DIR);
  const f = path.join(SFX_DIR, `${name}.mp3`);
  if (await fileExists(f)) return f;
  return null;
}

// Convert a static image + audio into a fixed-duration mp4 clip
async function imageToClip(imagePath, audioPath, duration, workDir, name) {
  const clipPath = path.join(workDir, `${name}.mp4`);
  await execPromise(
    `ffmpeg -y -loop 1 -i "${imagePath}" -i "${audioPath}" -c:v libx264 -t ${duration} -pix_fmt yuv420p -c:a aac -shortest "${clipPath}"`
  );
  return { path: clipPath, duration };
}

// Build a TTS clip with a leading human-like gap (silence) before the speech.
// Returns {path, duration} of the combined audio.
async function buildGappedAudio(text, voice, workDir, name, fallbackSeconds, gapSec = TTS_GAP_SEC) {
  const speechPath = path.join(workDir, `${name}_speech.mp3`);
  await generateTTS(text, voice, speechPath, fallbackSeconds);

  if (gapSec <= 0) {
    return { path: speechPath, duration: Math.max(await getAudioDuration(speechPath), fallbackSeconds) };
  }
  const gapPath = path.join(workDir, `${name}_gap.mp3`);
  await generateSilence(gapSec, gapPath);

  const combinedPath = path.join(workDir, `${name}_combined.mp3`);
  await concatAudio([gapPath, speechPath], combinedPath, workDir);
  const dur = await getAudioDuration(combinedPath);
  return { path: combinedPath, duration: Math.max(dur, fallbackSeconds + gapSec) };
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

    // Single question per video — default to question_1
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
// Theme resolution
// ========================
async function resolveThemeCss(quiz) {
  const base = await fs.readFile(path.join(THEMES_DIR, '_base.css'), 'utf8');

  let themeCss = '';
  let themeDecoHtml = '';

  if ((quiz.niche || '').toLowerCase() === 'general' && quiz.quiz_css_video && quiz.quiz_css_video.trim()) {
    // General niche: fully LLM-generated CSS (steps 1-15 baked in by worker 9).
    // We still wrap with the base for the option/timer/mission mechanics as a safety net,
    // but the LLM CSS can override anything via higher specificity / later declaration.
    themeCss = base + '\n/* ---- LLM-GENERATED (quiz_css_video) ---- */\n' + quiz.quiz_css_video;
    themeDecoHtml = ''; // general CSS is expected to be self-contained; no extra deco markup
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

  // Inject accent colors (fallback to sensible defaults)
  const accent1 = quiz.theme_accent_primary || '#00e0ff';
  const accent2 = quiz.theme_accent_secondary || '#7b2ff7';
  const accent3 = quiz.theme_accent_tertiary || '#ff2ec4';
  themeCss = themeCss
    .split('{{accent_primary}}').join(accent1)
    .split('{{accent_secondary}}').join(accent2)
    .split('{{accent_tertiary}}').join(accent3);

  return { themeCss, themeDecoHtml };
}

// Returns the extra .theme-deco markup each theme expects (matches its CSS selectors)
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
    case 'aurora':
    case 'particle_field':
    default:
      if (themeId === 'particle_field') {
        return `<div class="theme-deco">
                  ${Array.from({ length: 18 }).map((_, i) => {
                    const left = (i * 5 + 2) % 100;
                    const size = 6 + (i % 5) * 3;
                    const dur = 8 + (i % 6) * 2;
                    const delay = (i * 0.7) % 10;
                    return `<div class="particle" style="left:${left}%; bottom:-20px; width:${size}px; height:${size}px; animation-duration:${dur}s; animation-delay:${delay}s;"></div>`;
                  }).join('')}
                </div>`;
      }
      return ''; // aurora needs no extra deco markup
  }
}

// ========================
// Main video builder — 15-step flow
// ========================
async function buildVideo(quiz, qIdx, lang, workDir) {
  const voice = VOICE_MAP[lang] || VOICE_MAP.en;

  const options   = quiz[`options_${qIdx}`] || [];
  const correctAnswer = quiz[`correct_answer_${qIdx}`] || '';
  const hint      = quiz[`hint_${qIdx}`] || '';
  const keep5050  = quiz[`keep_5050_${qIdx}`] || [];
  const explanation = quiz[`explanation_${qIdx}`] || '';
  const question  = quiz[`question_${qIdx}`] || '';

  // Timing: 8-10s thinking. Hint @ 1/4, 50/50 @ 1/2.
  const QUESTION_TIME   = quiz.thinking_time_sec || 9;
  const HINT_TIME       = QUESTION_TIME / 4;
  const FIFTYFIFTY_TIME = QUESTION_TIME / 2;
  const MISSION_WAIT    = 2.5; // seconds before CTA3 appears after MI question

  const allIdx = [0, 1, 2, 3];
  const eliminateIdx = allIdx.filter(i =>
    !keep5050.includes(i) && !keep5050.includes(String(i))
  );

  // ---- Resolve visual theme ----
  const { themeCss, themeDecoHtml } = await resolveThemeCss(quiz);

  // ---- Build HTML ----
  let html = await fs.readFile(path.join(__dirname, 'quiz_template.html'), 'utf8');
  const optClass = (i) => eliminateIdx.includes(i) ? 'eliminate' : '';
  const revClass = (i) => options[i] === correctAnswer ? 'correct' : 'wrong';

  // CTA logic: CTA1 (affiliate) if quiz.affiliate_url present, else CTA2 fallback
  const hasCta1 = !!(quiz.affiliate_url && quiz.affiliate_url.trim());
  const ctaSlideClass = hasCta1 ? 'cta1-slide' : 'cta2-slide';

  const replacements = {
    '{{theme_css}}':       themeCss,
    '{{theme_deco_html}}': themeDecoHtml,
    '{{hook_phrase}}':     quiz.hook_phrase || 'Stop scrolling! Can you beat this quiz?',
    '{{question}}':        question,
    '{{options[0]}}':      options[0] || '',
    '{{options[1]}}':      options[1] || '',
    '{{options[2]}}':      options[2] || '',
    '{{options[3]}}':      options[3] || '',
    '{{opt0_class}}':      optClass(0),
    '{{opt1_class}}':      optClass(1),
    '{{opt2_class}}':      optClass(2),
    '{{opt3_class}}':      optClass(3),
    '{{rev0_class}}':      revClass(0),
    '{{rev1_class}}':      revClass(1),
    '{{rev2_class}}':      revClass(2),
    '{{rev3_class}}':      revClass(3),
    '{{hint}}':            hint,
    '{{correct_answer}}':  correctAnswer,
    '{{explanation}}':     explanation,
    '{{affiliate_text}}':  quiz.affiliate_text || 'Check the link in description!',
    '{{cta2_text}}':       quiz.cta2_text || 'Want a real challenge? Earn ONS tokens!',
    '{{blog_page_url}}':   quiz.blog_page_url || 'https://jaasblog.online/quiz',
    '{{mission_question}}': quiz.mission_impossible_question || '',
    '{{mission_hint}}':    quiz.mission_impossible_hint || '',
    '{{qtime}}':           QUESTION_TIME,
    '{{hint_time}}':       HINT_TIME,
    '{{fiftyfifty_time}}': FIFTYFIFTY_TIME
  };
  for (const [k, v] of Object.entries(replacements)) {
    html = html.split(k).join(String(v));
  }
  const htmlPath = path.join(workDir, 'index.html');
  await fs.writeFile(htmlPath, html);

  // ---- Fetch all prerecorded audio cues in parallel ----
  console.log('[CUES] Fetching prerecorded audio cues...');
  const [
    hookCue, questionIntroCue, optionsIntroCue,
    timeupCue, cta2AudioCue, cta3Cue, missionCue,
    bgMusicCue,
    sfxQAppear, sfxCountdown, sfxHint, sfxFiftyFifty
  ] = await Promise.all([
    pickRandomCue('quiz_hooks', lang, quiz.niche),
    pickRandomCue('question_intro_cues', lang, null),
    pickRandomCue('options_intro_cues', lang, null),
    pickRandomCue('timeup_cues', lang, null),
    pickRandomCue('cta2_audio_cues', lang, quiz.niche),
    pickRandomCue('cta3_audio_cues', lang, null),
    pickRandomCue('mission_impossible_cues', lang, null),
    pickBgMusic(quiz.niche),
    pickSfxCue('question_appear'),
    pickSfxCue('countdown_loop'),
    pickSfxCue('hint_reveal'),
    pickSfxCue('fifty_fifty')
  ]);

  // Download all cues to local cache in parallel
  const [
    hookFile, questionIntroFile, optionsIntroFile,
    timeupFile, cta2AudioFile, cta3File, missionFile,
    bgMusicFile,
    sfxQAppearFile, sfxCountdownFile, sfxHintFile, sfxFiftyFiftyFile
  ] = await Promise.all([
    hookCue         ? downloadAudio(hookCue.audio_url,          `hook_${hookCue.id}`) : null,
    questionIntroCue? downloadAudio(questionIntroCue.audio_url, `qintro_${questionIntroCue.id}`) : null,
    optionsIntroCue ? downloadAudio(optionsIntroCue.audio_url,  `ointro_${optionsIntroCue.id}`) : null,
    timeupCue       ? downloadAudio(timeupCue.audio_url,        `timeup_${timeupCue.id}`) : null,
    cta2AudioCue    ? downloadAudio(cta2AudioCue.audio_url,     `cta2_${cta2AudioCue.id}`) : null,
    cta3Cue         ? downloadAudio(cta3Cue.audio_url,          `cta3_${cta3Cue.id}`) : null,
    missionCue      ? downloadAudio(missionCue.audio_url,       `mission_${missionCue.id}`) : null,
    bgMusicCue      ? downloadAudio(bgMusicCue.audio_url,       `bgmusic_${bgMusicCue.id}`) : null,
    sfxQAppear      ? downloadAudio(sfxQAppear.audio_url,       `sfx_qa_${sfxQAppear.id}`) : null,
    sfxCountdown    ? downloadAudio(sfxCountdown.audio_url,     `sfx_cd_${sfxCountdown.id}`) : null,
    sfxHint         ? downloadAudio(sfxHint.audio_url,          `sfx_hint_${sfxHint.id}`) : null,
    sfxFiftyFifty   ? downloadAudio(sfxFiftyFifty.audio_url,    `sfx_50_${sfxFiftyFifty.id}`) : null
  ]);

  // Bump usage counts (fire-and-forget)
  if (hookCue)          bumpUsage('quiz_hooks', hookCue.id, hookCue.usage_count);
  if (questionIntroCue) bumpUsage('question_intro_cues', questionIntroCue.id, questionIntroCue.usage_count);
  if (optionsIntroCue)  bumpUsage('options_intro_cues', optionsIntroCue.id, optionsIntroCue.usage_count);
  if (timeupCue)        bumpUsage('timeup_cues', timeupCue.id, timeupCue.usage_count);
  if (missionCue)       bumpUsage('mission_impossible_cues', missionCue.id, missionCue.usage_count);
  if (cta3Cue)          bumpUsage('cta3_audio_cues', cta3Cue.id, cta3Cue.usage_count);

  // ---- Launch Puppeteer ----
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 300));

  const clips = []; // { path, duration }

  async function showOnly(selector) {
    await page.evaluate((sel) => {
      document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
      const el = document.querySelector(sel);
      if (el) el.classList.add('active');
    }, selector);
  }

  async function screenshot(name) {
    const p = path.join(workDir, `${name}.png`);
    await page.screenshot({ path: p });
    return p;
  }

  // Helper: build a clip from an audio file (prerecorded or TTS fallback) + image
  async function makeClip(imgPath, audioFile, fallbackText, fallbackDur, name, leadSilence = 0.35) {
    let audioPath;
    let dur;
    if (audioFile) {
      // prerecorded: prepend human-like silence
      const silPath = path.join(workDir, `${name}_sil.mp3`);
      await generateSilence(leadSilence, silPath);
      const combined = path.join(workDir, `${name}_audio.mp3`);
      const listP = path.join(workDir, `${name}_list.txt`);
      await fs.writeFile(listP, `file '${silPath}'\nfile '${audioFile}'`);
      await execPromise(`ffmpeg -y -f concat -safe 0 -i "${listP}" -acodec libmp3lame "${combined}"`);
      audioPath = combined;
      dur = Math.max(await getAudioDuration(combined), fallbackDur);
    } else {
      // TTS fallback
      const ttsPath = path.join(workDir, `${name}_tts.mp3`);
      await generateTTS(fallbackText, voice, ttsPath, fallbackDur);
      const silPath = path.join(workDir, `${name}_sil.mp3`);
      await generateSilence(leadSilence, silPath);
      const combined = path.join(workDir, `${name}_audio.mp3`);
      const listP = path.join(workDir, `${name}_list.txt`);
      await fs.writeFile(listP, `file '${silPath}'\nfile '${ttsPath}'`);
      await execPromise(`ffmpeg -y -f concat -safe 0 -i "${listP}" -acodec libmp3lame "${combined}"`);
      audioPath = combined;
      dur = Math.max(await getAudioDuration(combined), fallbackDur + leadSilence);
    }
    return imageToClip(imgPath, audioPath, dur, workDir, `clip_${name}`);
  }

  // ============================================================
  // STEP 1: HOOK + animated brand logo (2-3s, prerecorded or TTS)
  // ============================================================
  await showOnly('.hook-slide');
  await new Promise(r => setTimeout(r, 1100));
  const hookImg = await screenshot('hook');
  const hookClip = await makeClip(
    hookImg, hookFile,
    quiz.hook_phrase || 'Stop scrolling! Can you beat this quiz?',
    2.5, 'hook', 0.1
  );
  clips.push(hookClip);

  // ============================================================
  // STEP 2: "Here is your challenge" — PRERECORDED AUDIO ONLY,
  // no text on screen. Waiting frame (logo pulse).
  // ============================================================
  await showOnly('.waiting-slide');
  await new Promise(r => setTimeout(r, 300));
  const waitingImg = await screenshot('waiting');
  const challengeClip = await makeClip(
    waitingImg, questionIntroFile,
    'Here is your challenge!',
    1.5, 'challenge', 0.3
  );
  clips.push(challengeClip);

  // ============================================================
  // STEP 3: Question appears with animation (text + TTS).
  // Question card bounces in. SFX "question_appear" sting plays.
  // ============================================================
  await showOnly('.question-appear-slide');
  await new Promise(r => setTimeout(r, 700)); // let qp-card entrance animation play
  const questionAppearImg = await screenshot('question_appear');

  // Build audio: SFX sting -> 0.15s gap -> question TTS
  const qTtsPath = path.join(workDir, 'question_tts.mp3');
  await generateTTS(question, voice, qTtsPath, 3);
  const qTtsDur = await getAudioDuration(qTtsPath);

  const qAudioParts = [];
  const qListPath = path.join(workDir, 'q_audio_list.txt');
  if (sfxQAppearFile) {
    const sfxDur = await getAudioDuration(sfxQAppearFile);
    const microGap = path.join(workDir, 'micro_gap.mp3');
    await generateSilence(0.15, microGap);
    qAudioParts.push(sfxQAppearFile, microGap, qTtsPath);
    await fs.writeFile(qListPath, qAudioParts.map(p => `file '${p}'`).join('\n'));
    const qCombined = path.join(workDir, 'q_combined.mp3');
    await execPromise(`ffmpeg -y -f concat -safe 0 -i "${qListPath}" -acodec libmp3lame "${qCombined}"`);
    const qDur = Math.max(await getAudioDuration(qCombined), sfxDur + 0.15 + qTtsDur);
    clips.push(await imageToClip(questionAppearImg, qCombined, qDur, workDir, 'clip_question_appear'));
  } else {
    const qDur = Math.max(qTtsDur, 2);
    clips.push(await imageToClip(questionAppearImg, qTtsPath, qDur, workDir, 'clip_question_appear'));
  }

  // ============================================================
  // STEP 4: 0.7s silence on screen then "And your options are"
  //         PRERECORDED AUDIO ONLY (no text on screen).
  //         Question card still visible, options not yet shown.
  // ============================================================
  // Same question-appear frame (question visible, no options yet)
  const step4Audio = path.join(workDir, 'step4.mp3');
  const step4List = path.join(workDir, 'step4_list.txt');
  const step4Sil = path.join(workDir, 'step4_sil.mp3');
  await generateSilence(0.7, step4Sil);
  if (optionsIntroFile) {
    await fs.writeFile(step4List, `file '${step4Sil}'\nfile '${optionsIntroFile}'`);
    await execPromise(`ffmpeg -y -f concat -safe 0 -i "${step4List}" -acodec libmp3lame "${step4Audio}"`);
  } else {
    const optIntroTts = path.join(workDir, 'options_intro_tts.mp3');
    await generateTTS('And your options are...', voice, optIntroTts, 1.5);
    await fs.writeFile(step4List, `file '${step4Sil}'\nfile '${optIntroTts}'`);
    await execPromise(`ffmpeg -y -f concat -safe 0 -i "${step4List}" -acodec libmp3lame "${step4Audio}"`);
  }
  const step4Dur = await getAudioDuration(step4Audio);
  clips.push(await imageToClip(questionAppearImg, step4Audio, step4Dur, workDir, 'clip_step4'));

  // ============================================================
  // STEP 5: Options appear with animation (text + TTS each option)
  // ============================================================
  await showOnly('.question-static');
  await new Promise(r => setTimeout(r, 900));
  const optionsImg = await screenshot('options_static');

  const optionsParts = [];
  const optionsListPath = path.join(workDir, 'options_parts_list.txt');
  for (let i = 0; i < options.length; i++) {
    if (!options[i]) continue;
    const silP = path.join(workDir, `opt_sil_${i}.mp3`);
    const ttsP = path.join(workDir, `opt_tts_${i}.mp3`);
    await generateSilence(0.25, silP);
    await generateTTS(`${String.fromCharCode(65 + i)}. ${options[i]}`, voice, ttsP, 1);
    optionsParts.push(silP, ttsP);
  }
  const optionsCombined = path.join(workDir, 'options_combined.mp3');
  if (optionsParts.length > 0) {
    await fs.writeFile(optionsListPath, optionsParts.map(p => `file '${p}'`).join('\n'));
    await execPromise(`ffmpeg -y -f concat -safe 0 -i "${optionsListPath}" -acodec libmp3lame "${optionsCombined}"`);
  } else {
    await generateSilence(2, optionsCombined);
  }
  const optionsDur = Math.max(await getAudioDuration(optionsCombined), 2);
  clips.push(await imageToClip(optionsImg, optionsCombined, optionsDur, workDir, 'clip_options'));

  // ============================================================
  // STEP 6-8: COUNTDOWN phase (screen-recorded).
  // Countdown SFX loops. Hint @ 1/4 and 50/50 @ 1/2 with stings.
  // ============================================================
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

  // Build countdown audio bed
  const countdownBase = path.join(workDir, 'countdown_base.mp3');
  if (sfxCountdownFile) {
    await execPromise(
      `ffmpeg -y -stream_loop -1 -i "${sfxCountdownFile}" -t ${QUESTION_TIME} -af "volume=0.7" -acodec libmp3lame "${countdownBase}"`
    );
  } else {
    await generateSilence(QUESTION_TIME, countdownBase);
  }

  // Layer hint + 50/50 stings via adelay+amix
  let countdownFinal = countdownBase;
  const stings = [];
  if (sfxHintFile)       stings.push({ file: sfxHintFile,       delayMs: Math.round(HINT_TIME * 1000) });
  if (sfxFiftyFiftyFile) stings.push({ file: sfxFiftyFiftyFile, delayMs: Math.round(FIFTYFIFTY_TIME * 1000) });
  if (stings.length > 0) {
    const mixedPath = path.join(workDir, 'countdown_mixed.mp3');
    const inputs = [`-i "${countdownBase}"`, ...stings.map(s => `-i "${s.file}"`)].join(' ');
    const delays  = stings.map((s, idx) => `[${idx+1}:a]adelay=${s.delayMs}|${s.delayMs}[s${idx}]`).join(';');
    const mix     = ['[0:a]', ...stings.map((_, i) => `[s${i}]`)].join('');
    await execPromise(
      `ffmpeg -y ${inputs} -filter_complex "${delays};${mix}amix=inputs=${stings.length+1}:duration=first[a]" -map "[a]" -t ${QUESTION_TIME} -acodec libmp3lame "${mixedPath}"`
    );
    countdownFinal = mixedPath;
  }

  const questionClipPath = path.join(workDir, 'clip_question.mp4');
  await execPromise(
    `ffmpeg -y -i "${questionVideoRaw}" -i "${countdownFinal}" -c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${questionClipPath}"`
  );
  const questionDur = await getVideoDuration(questionClipPath);
  clips.push({ path: questionClipPath, duration: questionDur });

  // ============================================================
  // STEP 9: "Time's up, let's reveal the correct answer"
  //         PRERECORDED AUDIO ONLY. Pre-reveal frame (no highlight yet).
  // ============================================================
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 200));
  await showOnly('.pre-reveal-slide');
  await new Promise(r => setTimeout(r, 300));
  const preRevealImg = await screenshot('pre_reveal');
  const timeupClip = await makeClip(
    preRevealImg, timeupFile,
    "Time's up! Let's reveal the correct answer.",
    2, 'timeup', 0.3
  );
  clips.push(timeupClip);

  // ============================================================
  // STEP 10: 0.5s silence, correct answer highlighted (sound only)
  // ============================================================
  await showOnly('.answer-slide');
  await new Promise(r => setTimeout(r, 300));
  const answerImg = await screenshot('answer');
  const revealSilPath = path.join(workDir, 'reveal_sil.mp3');
  await generateSilence(0.5, revealSilPath);
  clips.push(await imageToClip(answerImg, revealSilPath, 0.5, workDir, 'clip_answer_silent'));

  // ============================================================
  // STEP 11: 0.5s silence then explanation (text + TTS, ≤20 words)
  // ============================================================
  await showOnly('.explanation-slide');
  await new Promise(r => setTimeout(r, 400));
  const explImg = await screenshot('explanation');
  const explSil = path.join(workDir, 'expl_sil.mp3');
  const explTts = path.join(workDir, 'expl_tts.mp3');
  await generateSilence(0.5, explSil);
  await generateTTS(explanation, voice, explTts, 3);
  const explCombined = path.join(workDir, 'expl_combined.mp3');
  const explList = path.join(workDir, 'expl_list.txt');
  await fs.writeFile(explList, `file '${explSil}'\nfile '${explTts}'`);
  await execPromise(`ffmpeg -y -f concat -safe 0 -i "${explList}" -acodec libmp3lame "${explCombined}"`);
  const explDur = Math.max(await getAudioDuration(explCombined), 3.5);
  clips.push(await imageToClip(explImg, explCombined, explDur, workDir, 'clip_explanation'));

  // ============================================================
  // CTA: affiliate_url present → CTA1 (affiliate), else CTA2 (platform)
  // ============================================================
  if (hasCta1) {
    await showOnly('.cta1-slide');
    await new Promise(r => setTimeout(r, 400));
    const cta1Img = await screenshot('cta1');
    // CTA1 has no prerecorded file — use TTS from quiz.affiliate_text
    const cta1Tts = path.join(workDir, 'cta1_tts.mp3');
    const cta1Sil = path.join(workDir, 'cta1_sil.mp3');
    await generateSilence(0.35, cta1Sil);
    await generateTTS(
      quiz.affiliate_text || 'Check the link in the description for a great deal!',
      voice, cta1Tts, 3
    );
    const cta1Combined = path.join(workDir, 'cta1_combined.mp3');
    const cta1List = path.join(workDir, 'cta1_list.txt');
    await fs.writeFile(cta1List, `file '${cta1Sil}'\nfile '${cta1Tts}'`);
    await execPromise(`ffmpeg -y -f concat -safe 0 -i "${cta1List}" -acodec libmp3lame "${cta1Combined}"`);
    const cta1Dur = Math.max(await getAudioDuration(cta1Combined), 3);
    clips.push(await imageToClip(cta1Img, cta1Combined, cta1Dur, workDir, 'clip_cta1'));
  } else {
    await showOnly('.cta2-slide');
    await new Promise(r => setTimeout(r, 400));
    const cta2Img = await screenshot('cta2');
    const cta2Clip = await makeClip(
      cta2Img, cta2AudioFile,
      quiz.cta2_text || 'Want a real challenge? Visit jaasblog.online/quiz and earn ONS tokens!',
      3, 'cta2', 0.35
    );
    clips.push(cta2Clip);
  }

  // ============================================================
  // STEP 13: Mission Impossible question (large bold, prerecorded intro)
  // ============================================================
  if (quiz.mission_impossible_enabled !== false && quiz.mission_impossible_question) {
    // Stage 1: MI question only (CTA3 hidden)
    await showOnly('.mission-final-slide');
    await page.evaluate(() => {
      const el = document.querySelector('.cta3-text');
      if (el) el.classList.remove('show-cta3');
    });
    await new Promise(r => setTimeout(r, 400));
    const missionImg = await screenshot('mission');

    // Audio: MI intro prerecorded sting, then brief gap
    let missionAudio;
    let missionDur;
    if (missionFile) {
      const mSil = path.join(workDir, 'mission_sil.mp3');
      await generateSilence(0.3, mSil);
      const mCombined = path.join(workDir, 'mission_combined.mp3');
      const mList = path.join(workDir, 'mission_list.txt');
      await fs.writeFile(mList, `file '${mSil}'\nfile '${missionFile}'`);
      await execPromise(`ffmpeg -y -f concat -safe 0 -i "${mList}" -acodec libmp3lame "${mCombined}"`);
      missionAudio = mCombined;
      missionDur = Math.max(await getAudioDuration(mCombined), MISSION_WAIT);
    } else {
      const mTts = path.join(workDir, 'mission_tts.mp3');
      await generateTTS(quiz.mission_impossible_question, voice, mTts, MISSION_WAIT);
      missionAudio = mTts;
      missionDur = Math.max(await getAudioDuration(mTts), MISSION_WAIT);
    }
    clips.push(await imageToClip(missionImg, missionAudio, missionDur, workDir, 'clip_mission'));

    // ============================================================
    // STEP 14: CTA3 revealed (after MISSION_WAIT), prerecorded audio
    // ============================================================
    await page.evaluate(() => {
      const el = document.querySelector('.cta3-text');
      if (el) el.classList.add('show-cta3');
    });
    await new Promise(r => setTimeout(r, 500));
    const cta3Img = await screenshot('cta3');
    const cta3Clip = await makeClip(
      cta3Img, cta3File,
      'Like, share, and challenge a friend! Subscribe and write your answer in the comments!',
      4, 'cta3', 0.2
    );
    clips.push(cta3Clip);

    // ============================================================
    // STEP 15: Hold all text on screen for 1 second after CTA3 audio ends
    // ============================================================
    const holdSil = path.join(workDir, 'hold_sil.mp3');
    await generateSilence(1.0, holdSil);
    clips.push(await imageToClip(cta3Img, holdSil, 1.0, workDir, 'clip_hold'));
  }

  await browser.close();

  // ============================================================
  // FINAL ASSEMBLY
  // ============================================================
  const concatList = clips.map(c => `file '${c.path}'`).join('\n');
  const listPath = path.join(workDir, 'concat.txt');
  await fs.writeFile(listPath, concatList);

  const concatenated = path.join(workDir, 'concatenated.mp4');
  await execPromise(
    `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:v libx264 -c:a aac -movflags +faststart "${concatenated}"`
  );

  const totalDur = await getVideoDuration(concatenated);
  console.log(`Concatenated duration: ${totalDur.toFixed(2)}s`);

  // Mix background music with ducking
  let finalOutput = concatenated;
  if (bgMusicFile) {
    const bgLooped = path.join(workDir, 'bg_looped.mp3');
    await execPromise(
      `ffmpeg -y -stream_loop -1 -i "${bgMusicFile}" -t ${totalDur} -af "volume=0.10" -acodec libmp3lame "${bgLooped}"`
    );
    const fgAudio = path.join(workDir, 'fg_audio.mp3');
    await execPromise(`ffmpeg -y -i "${concatenated}" -vn -acodec libmp3lame "${fgAudio}"`);
    const mixedAudio = path.join(workDir, 'mixed_audio.mp3');
    // amix: foreground at full vol + bg at 0.10 base; bg naturally ducks
    // because foreground TTS dominates perceptually at these relative levels.
    await execPromise(
      `ffmpeg -y -i "${fgAudio}" -i "${bgLooped}" -filter_complex "[0:a]volume=1.0[fg];[1:a]volume=0.10[bg];[fg][bg]amix=inputs=2:duration=first:dropout_transition=0[a]" -map "[a]" -acodec libmp3lame "${mixedAudio}"`
    );
    const finalPath = path.join(workDir, 'final.mp4');
    await execPromise(
      `ffmpeg -y -i "${concatenated}" -i "${mixedAudio}" -c:v copy -map 0:v:0 -map 1:a:0 -c:a aac -shortest -movflags +faststart "${finalPath}"`
    );
    finalOutput = finalPath;
  }

  console.log(`Final video ready: ${finalOutput}`);
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
