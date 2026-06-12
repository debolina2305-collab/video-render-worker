const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');

// ========================
// Environment variables
// ========================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

// Supabase REST API helpers
const headers = {
  'apikey': supabaseKey,
  'Authorization': `Bearer ${supabaseKey}`,
  'Content-Type': 'application/json'
};

async function fetchSupabase(path, options = {}) {
  const url = `${supabaseUrl}/rest/v1/${path}`;
  const res = await fetch(url, { headers, ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

// ========================
// Main worker
// ========================
async function processJobs() {
  console.log('Checking for pending video jobs...');
  const jobs = await fetchSupabase(
    'quiz_queue?job_type=eq.video_render&status=eq.pending&order=created_at.asc&limit=1'
  );
  if (!jobs.length) {
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
    // Fetch quiz data
    const quizzes = await fetchSupabase(`quiz?id=eq.${job.quiz_id}`);
    if (!quizzes.length) throw new Error('Quiz not found');
    const quiz = quizzes[0];

    const { question_index = 1, video_type = 'short', thinking_time_sec = 16 } = job.payload;
    const lang = quiz.lang_code || 'en';

    // Create temp directory
    const workDir = `/tmp/video_${uuidv4()}`;
    await fs.mkdir(workDir, { recursive: true });

    // Generate slides
    const slides = await generateSlides(quiz, question_index, thinking_time_sec, workDir, lang);
    // Generate TTS audio
    const audioPaths = await generateTTS(quiz, question_index, slides, workDir, lang);
    // Assemble video
    const videoPath = await assembleVideo(slides, audioPaths, workDir);

    // Get file size
    const stats = await fs.stat(videoPath);
    console.log(`Video created: ${videoPath}, size: ${(stats.size / (1024*1024)).toFixed(2)} MB`);

    // Mark job as completed
    await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString() })
    });

    // Upload video as GitHub Actions artifact (so you can download it)
    const artifactPath = `/tmp/${job.id}_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);
    console.log(`Video saved as artifact: ${artifactPath}`);
    // The artifact will be automatically uploaded by GitHub if we output the path
    // We'll write a marker file
    await fs.writeFile('/tmp/artifact_ready', artifactPath);

    // Cleanup temp directory
    await fs.rm(workDir, { recursive: true, force: true });
    console.log(`Job ${job.id} completed successfully`);
  } catch (err) {
    console.error(`Job ${job.id} failed:`, err);
    await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'failed', last_error: err.message })
    });
    throw err; // rethrow so workflow fails
  }
}

// ========================
// Helper: Generate slides from HTML/CSS using Puppeteer
// ========================
async function generateSlides(quiz, questionIndex, thinkingTime, workDir, lang) {
  let html = quiz.quiz_css_video;
  if (!html) throw new Error('quiz_css_video is empty');

  const qIdx = questionIndex;
  const replacements = {
    '{{hook_phrase}}': quiz.hook_phrase || '',
    '{{intro_speech}}': quiz.quiz_intro_speech || '',
    '{{question}}': quiz[`question_${qIdx}`] || '',
    '{{options}}': JSON.stringify(quiz[`options_${qIdx}`] || []),
    '{{hint}}': quiz[`hint_${qIdx}`] || '',
    '{{keep_5050}}': JSON.stringify(quiz[`keep_5050_${qIdx}`] || []),
    '{{correct_answer}}': quiz[`correct_answer_${qIdx}`] || '',
    '{{explanation}}': quiz[`explanation_${qIdx}`] || '',
    '{{cta_text}}': quiz.cta_text || '',
    '{{mission_question}}': quiz.mission_impossible_question || '',
    '{{mission_hint}}': quiz.mission_impossible_hint || '',
    '{{mission_trigger}}': quiz.mission_impossible_trigger_line || '',
    '{{thinking_time}}': thinkingTime
  };
  for (const [key, value] of Object.entries(replacements)) {
    html = html.split(key).join(value);
  }

  const htmlPath = path.join(workDir, 'index.html');
  await fs.writeFile(htmlPath, html);

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

  // Adjust slide definitions to match your CSS classes
  const slideDefs = [
    { selector: '.hook-slide', duration: 2, name: 'hook' },
    { selector: '.intro-slide', duration: 4, name: 'intro' },
    { selector: '.question-phase-1', duration: thinkingTime / 3, name: 'phase1' },
    { selector: '.question-phase-2', duration: thinkingTime / 3, name: 'phase2' },
    { selector: '.question-phase-3', duration: thinkingTime - (2 * thinkingTime / 3), name: 'phase3' },
    { selector: '.answer-slide', duration: 2, name: 'answer' },
    { selector: '.explanation-slide', duration: 5, name: 'explanation' },
    { selector: '.cta-slide', duration: 5, name: 'cta' },
    { selector: '.mission-slide', duration: 1.5, name: 'mission' }
  ];

  const slides = [];
  for (let i = 0; i < slideDefs.length; i++) {
    const def = slideDefs[i];
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.style.display = 'block';
    }, def.selector);
    await page.waitForTimeout(500);
    const imagePath = path.join(workDir, `slide_${i}.png`);
    await page.screenshot({ path: imagePath, fullPage: true });
    slides.push({ path: imagePath, duration: def.duration, name: def.name });
  }

  await browser.close();
  return slides;
}

// ========================
// Helper: TTS using edge-tts (Python)
// ========================
async function generateTTS(quiz, questionIndex, slides, workDir, lang) {
  const voiceMap = {
    en: 'en-US-JennyNeural',
    hi: 'hi-IN-SwaraNeural',
    es: 'es-ES-ElviraNeural',
    pt: 'pt-BR-FranciscaNeural'
  };
  const voice = voiceMap[lang] || voiceMap.en;
  const qIdx = questionIndex;

  const texts = {
    hook: quiz.hook_phrase || '',
    intro: quiz.quiz_intro_speech || '',
    phase1: `${quiz[`question_${qIdx}`] || ''} Options: ${(quiz[`options_${qIdx}`] || []).join(', ')}. Your time starts now.`,
    phase2: '',
    phase3: '',
    answer: `Time's up! The correct answer is ${quiz[`correct_answer_${qIdx}`] || ''}.`,
    explanation: quiz[`explanation_${qIdx}`] || '',
    cta: quiz.cta_text || '',
    mission: `${quiz.mission_impossible_question || ''} Hint: ${quiz.mission_impossible_hint || ''}`
  };

  const audioPaths = [];
  for (const slide of slides) {
    const text = texts[slide.name] || '';
    const audioPath = path.join(workDir, `audio_${slide.name}.mp3`);
    if (!text.trim()) {
      await execPromise(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t ${slide.duration} -q:a 9 -acodec libmp3lame ${audioPath}`);
    } else {
      const safeText = text.replace(/"/g, '\\"');
      await execPromise(`edge-tts --voice "${voice}" --text "${safeText}" --write-media ${audioPath}`);
    }
    audioPaths.push(audioPath);
  }
  return audioPaths;
}

// ========================
// Helper: Assemble video with FFmpeg
// ========================
async function assembleVideo(slides, audioPaths, workDir) {
  const concatList = [];
  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    const audio = audioPaths[i];
    const slideVideo = path.join(workDir, `clip_${i}.mp4`);
    await execPromise(`ffmpeg -loop 1 -i ${slide.path} -i ${audio} -c:v libx264 -t ${slide.duration} -c:a aac -shortest -y ${slideVideo}`);
    concatList.push(`file '${slideVideo}'`);
  }
  const listPath = path.join(workDir, 'concat.txt');
  await fs.writeFile(listPath, concatList.join('\n'));
  const outputPath = path.join(workDir, 'final.mp4');
  await execPromise(`ffmpeg -f concat -safe 0 -i ${listPath} -c copy ${outputPath}`);
  return outputPath;
}

// ========================
// Start the worker
// ========================
processJobs().then(() => {
  console.log('Worker finished this run');
  process.exit(0);
});
