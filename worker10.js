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

// Fixed-phrase cache dir (pre-generatable, reused across videos)
const FIXED_PHRASES_DIR = path.join(__dirname, 'fixed_audio');
// Suspense/clock SFX library (pre-downloaded files expected here)
const SFX_DIR = path.join(__dirname, 'sfx');

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

// Generate TTS audio via edge-tts. Falls back to silence if text is empty.
async function generateTTS(text, voice, outputPath, fallbackSeconds = 1) {
  const clean = (text || '').trim();
  if (!clean) {
    await execPromise(
      `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${fallbackSeconds} -q:a 9 -acodec libmp3lame "${outputPath}"`
    );
    return;
  }
  // Write text to a temp file to avoid shell-escaping issues with quotes/apostrophes
  const tmpTextFile = outputPath + '.txt';
  await fs.writeFile(tmpTextFile, clean, 'utf8');
  await execPromise(
    `edge-tts --voice "${voice}" --file "${tmpTextFile}" --write-media "${outputPath}"`
  );
  await fs.unlink(tmpTextFile).catch(() => {});
}

// Get (or generate) a fixed/reused phrase audio file, cached by language+key
async function getFixedPhraseAudio(key, text, voice, lang) {
  await ensureDir(FIXED_PHRASES_DIR);
  const cachedPath = path.join(FIXED_PHRASES_DIR, `${key}_${lang}.mp3`);
  if (await fileExists(cachedPath)) {
    return cachedPath;
  }
  await generateTTS(text, voice, cachedPath, 1);
  return cachedPath;
}

// Pick a suspense SFX file for the niche (falls back to default.mp3)
async function getSuspenseSfx(niche) {
  await ensureDir(SFX_DIR);
  const nicheFile = path.join(SFX_DIR, `${niche || 'default'}.mp3`);
  if (await fileExists(nicheFile)) return nicheFile;
  const defaultFile = path.join(SFX_DIR, 'default.mp3');
  if (await fileExists(defaultFile)) return defaultFile;
  // No SFX available -> generate silence matching question duration later
  return null;
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
// Main video builder
// ========================
async function buildVideo(quiz, qIdx, lang, workDir) {
  const voice = VOICE_MAP[lang] || VOICE_MAP.en;

  const options = quiz[`options_${qIdx}`] || [];
  const correctAnswer = quiz[`correct_answer_${qIdx}`] || '';
  const hint = quiz[`hint_${qIdx}`] || '';
  const keep5050 = quiz[`keep_5050_${qIdx}`] || []; // indices (0-3) to KEEP visible
  const explanation = quiz[`explanation_${qIdx}`] || '';
  const question = quiz[`question_${qIdx}`] || '';

  // ---- Timing config ----
  const QUESTION_TIME = 15;       // seconds for the animated question phase
  const HINT_TIME = QUESTION_TIME / 3;        // ~5s -> hint appears
  const FIFTYFIFTY_TIME = (QUESTION_TIME * 2) / 3; // ~10s -> 50/50 triggers
  const MISSION_HINT_DELAY = 1.8; // seconds before mission hint reveal

  // Determine which option indices to eliminate (the 2 NOT in keep_5050)
  const allIdx = [0, 1, 2, 3];
  const eliminateIdx = allIdx.filter(i => !keep5050.includes(i) && !keep5050.includes(String(i)));

  // ---- Build HTML from template ----
  let html = await fs.readFile(path.join(__dirname, 'quiz_template.html'), 'utf8');

  const optClass = (i) => eliminateIdx.includes(i) ? 'eliminate' : '';
  const revClass = (i) => {
    const opt = options[i];
    if (opt === correctAnswer) return 'correct';
    return 'wrong';
  };

  const ctaUrl = `jaasblog.online/q/${quiz.niche || 'finance'}/${lang}/${quiz.topic_slug || quiz.blog_slug || ''}`;

  const replacements = {
    '{{hook_phrase}}': quiz.hook_phrase || quiz.topic || 'Can you beat this quiz?',
    '{{topic}}': quiz.topic || '',
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
    '{{cta_text}}': quiz.cta_text || 'Like, Share & Subscribe!',
    '{{cta_url}}': ctaUrl,
    '{{mission_question}}': quiz.mission_impossible_question || '',
    '{{mission_hint}}': quiz.mission_impossible_hint || '',
    '{{mission_trigger}}': quiz.mission_impossible_trigger_line || '',
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
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

  const clips = []; // ordered list of { videoPath, audioPath, duration }

  // Helper: show only one .screen by selector
  async function showOnly(selector) {
    await page.evaluate((sel) => {
      document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
      const target = document.querySelector(sel);
      if (target) target.classList.add('active');
    }, selector);
  }

  // ---------------------------------------------------------
  // 1. HOOK / BRAND LOGO (0-3s) - static screenshot + TTS/music
  // ---------------------------------------------------------
  await showOnly('.hook-slide');
  await new Promise(r => setTimeout(r, 1100)); // allow logo animation to play out
  const hookImg = path.join(workDir, 'hook.png');
  await page.screenshot({ path: hookImg });
  const hookAudio = path.join(workDir, 'hook.mp3');
  await generateTTS(quiz.hook_phrase || quiz.topic || '', voice, hookAudio, 3);
  let hookDur = await getAudioDuration(hookAudio);
  hookDur = Math.max(hookDur, 3); // ensure at least 3s for brand intro
  clips.push(await imageToClip(hookImg, hookAudio, hookDur, workDir, 'clip_hook'));

  // ---------------------------------------------------------
  // 2. INTRO (3-9s) - static screenshot + TTS intro speech
  // ---------------------------------------------------------
  await showOnly('.intro-slide');
  await new Promise(r => setTimeout(r, 800));
  const introImg = path.join(workDir, 'intro.png');
  await page.screenshot({ path: introImg });
  const introAudio = path.join(workDir, 'intro.mp3');
  await generateTTS(quiz.quiz_intro_speech || `Today's topic: ${quiz.topic}`, voice, introAudio, 4);
  const introDur = Math.max(await getAudioDuration(introAudio), 4);
  clips.push(await imageToClip(introImg, introAudio, introDur, workDir, 'clip_intro'));

  // ---------------------------------------------------------
  // 2b. ENGAGEMENT PROMPT - random row from introduction_prompts
  // ---------------------------------------------------------
  let engagementPrompt = null;
  try {
    const prompts = await fetchSupabase(
      `introduction_prompts?language_code=eq.${lang}&is_active=eq.true&select=id,prompt_text&limit=20`
    );
    if (prompts && prompts.length > 0) {
      engagementPrompt = prompts[Math.floor(Math.random() * prompts.length)];
    }
  } catch (e) {
    console.warn('Could not fetch introduction_prompts, using fallback:', e.message);
  }
  const engagementText = engagementPrompt
    ? engagementPrompt.prompt_text
    : 'Pause the video and write your answer before time ends!';

  await showOnly('.intro-slide'); // reuse intro slide background for engagement text
  const engImg = path.join(workDir, 'engagement.png');
  await page.screenshot({ path: engImg });
  const engAudio = path.join(workDir, 'engagement.mp3');
  await generateTTS(engagementText, voice, engAudio, 4);
  const engDur = Math.max(await getAudioDuration(engAudio), 4);
  clips.push(await imageToClip(engImg, engAudio, engDur, workDir, 'clip_engagement'));

  if (engagementPrompt) {
    await fetchSupabase(`introduction_prompts?id=eq.${engagementPrompt.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ usage_count: (engagementPrompt.usage_count || 0) + 1, last_used_at: new Date().toISOString() })
    }).catch(() => {});
  }

  // ---------------------------------------------------------
  // 2c. "Your time starts now" - fixed phrase (cached per language)
  // ---------------------------------------------------------
  const timeStartsAudio = await getFixedPhraseAudio('time_starts_now', 'Your time starts now!', voice, lang);
  const timeStartsDur = Math.max(await getAudioDuration(timeStartsAudio), 1);
  // Show question phase screen with options visible but timer not yet started for this still frame
  await showOnly('.question-phase');
  await new Promise(r => setTimeout(r, 100));
  const startImg = path.join(workDir, 'time_starts.png');
  await page.screenshot({ path: startImg });
  clips.push(await imageToClip(startImg, timeStartsAudio, timeStartsDur, workDir, 'clip_time_starts'));

  // ---------------------------------------------------------
  // 3. QUESTION PHASE (14-29s) - SCREEN RECORDING of CSS animations
  //    timer drains, hint fades in at HINT_TIME, 50/50 fades at FIFTYFIFTY_TIME
  // ---------------------------------------------------------
  // Reload page to reset CSS animation state cleanly, then show question-phase
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
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

  // Build the question-phase audio track: "time starts" already played in prior clip,
  // so here we layer the suspense SFX (and silence under it) for QUESTION_TIME seconds.
  const questionAudio = path.join(workDir, 'question_audio.mp3');
  const sfxFile = await getSuspenseSfx(quiz.niche);
  if (sfxFile) {
    // Trim/loop SFX to QUESTION_TIME seconds, normalize volume
    await execPromise(
      `ffmpeg -y -i "${sfxFile}" -t ${QUESTION_TIME} -af "volume=0.6" -acodec libmp3lame "${questionAudio}"`
    );
    // If SFX shorter than QUESTION_TIME, pad with silence to exact length
    const sfxDur = await getAudioDuration(questionAudio);
    if (sfxDur < QUESTION_TIME) {
      const padded = path.join(workDir, 'question_audio_padded.mp3');
      await execPromise(
        `ffmpeg -y -i "${questionAudio}" -af "apad=whole_dur=${QUESTION_TIME}" -acodec libmp3lame "${padded}"`
      );
      await fs.rename(padded, questionAudio);
    }
  } else {
    await execPromise(
      `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${QUESTION_TIME} -q:a 9 -acodec libmp3lame "${questionAudio}"`
    );
  }

  // Mux the recorded silent video with the question audio track
  const questionClipPath = path.join(workDir, 'clip_question.mp4');
  await execPromise(
    `ffmpeg -y -i "${questionVideoRaw}" -i "${questionAudio}" -c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${questionClipPath}"`
  );
  const questionDur = await getVideoDuration(questionClipPath);
  clips.push({ path: questionClipPath, duration: questionDur });

  // ---------------------------------------------------------
  // 4. ANSWER REVEAL (29-33s) - "Time up! Correct answer is X" + dim/highlight
  // ---------------------------------------------------------
  await showOnly('.answer-slide');
  await new Promise(r => setTimeout(r, 200));
  const answerImg = path.join(workDir, 'answer.png');
  await page.screenshot({ path: answerImg });
  const answerAudio = path.join(workDir, 'answer.mp3');
  const timeUpText = `Time's up! The correct answer is ${correctAnswer}.`;
  await generateTTS(timeUpText, voice, answerAudio, 3);
  const answerDur = Math.max(await getAudioDuration(answerAudio), 3);
  clips.push(await imageToClip(answerImg, answerAudio, answerDur, workDir, 'clip_answer'));

  // ---------------------------------------------------------
  // 5. EXPLANATION (33-40s)
  // ---------------------------------------------------------
  await showOnly('.explanation-slide');
  await new Promise(r => setTimeout(r, 200));
  const explImg = path.join(workDir, 'explanation.png');
  await page.screenshot({ path: explImg });
  const explAudio = path.join(workDir, 'explanation.mp3');
  await generateTTS(explanation, voice, explAudio, 4);
  const explDur = Math.max(await getAudioDuration(explAudio), 4);
  clips.push(await imageToClip(explImg, explAudio, explDur, workDir, 'clip_explanation'));

  // ---------------------------------------------------------
  // 6. MISSION IMPOSSIBLE (two-stage: question, then +hint after 1.5-2s)
  // ---------------------------------------------------------
  if (quiz.mission_impossible_enabled !== false && quiz.mission_impossible_question) {
    await showOnly('.mission-slide');
    await new Promise(r => setTimeout(r, 200));

    // Stage 1: question only (hint hidden)
    const missionImg1 = path.join(workDir, 'mission_1.png');
    await page.screenshot({ path: missionImg1 });

    // TTS for the mission question (covers stage 1 duration)
    const missionQAudio = path.join(workDir, 'mission_q.mp3');
    await generateTTS(quiz.mission_impossible_question, voice, missionQAudio, 2);
    const missionQDur = Math.max(await getAudioDuration(missionQAudio), MISSION_HINT_DELAY);
    clips.push(await imageToClip(missionImg1, missionQAudio, missionQDur, workDir, 'clip_mission_q'));

    // Stage 2: reveal hint + trigger line
    await page.evaluate(() => {
      const hintEl = document.querySelector('.mission-hint');
      if (hintEl) hintEl.classList.add('shown');
    });
    await new Promise(r => setTimeout(r, 200));
    const missionImg2 = path.join(workDir, 'mission_2.png');
    await page.screenshot({ path: missionImg2 });

    const missionHintAudio = path.join(workDir, 'mission_hint.mp3');
    const hintText = `${quiz.mission_impossible_hint || ''} ${quiz.mission_impossible_trigger_line || ''}`.trim();
    await generateTTS(hintText, voice, missionHintAudio, 2);
    const missionHintDur = Math.max(await getAudioDuration(missionHintAudio), 2);
    clips.push(await imageToClip(missionImg2, missionHintAudio, missionHintDur, workDir, 'clip_mission_hint'));
  }

  // ---------------------------------------------------------
  // 7. CTA (40-47s)
  // ---------------------------------------------------------
  await showOnly('.cta-slide');
  await new Promise(r => setTimeout(r, 200));
  const ctaImg = path.join(workDir, 'cta.png');
  await page.screenshot({ path: ctaImg });
  const ctaAudio = path.join(workDir, 'cta.mp3');
  const ctaText = quiz.cta_description_text || quiz.cta_text ||
    'Like, share, and subscribe! Visit our website to play the live challenge and earn ONS tokens!';
  await generateTTS(ctaText, voice, ctaAudio, 5);
  const ctaDur = Math.max(await getAudioDuration(ctaAudio), 5);
  clips.push(await imageToClip(ctaImg, ctaAudio, ctaDur, workDir, 'clip_cta'));

  await browser.close();

  // ---------------------------------------------------------
  // FINAL ASSEMBLY - concat all clips
  // ---------------------------------------------------------
  const concatList = clips.map(c => `file '${c.path}'`).join('\n');
  const listPath = path.join(workDir, 'concat.txt');
  await fs.writeFile(listPath, concatList);

  const finalOutput = path.join(workDir, 'final.mp4');
  await execPromise(
    `ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:v libx264 -c:a aac -movflags +faststart "${finalOutput}"`
  );

  const totalDur = clips.reduce((sum, c) => sum + c.duration, 0);
  console.log(`Total clip-sum duration: ${totalDur.toFixed(2)}s (target 35-55s)`);

  return finalOutput;
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
// Entry point
// ========================
processJobs().then(() => {
  console.log('Worker finished this run');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
