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

async function fetchSupabase(path, options = {}) {
  const url = `${cleanSupabaseUrl}/rest/v1/${path}`;
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

async function getAudioDuration(audioPath) {
  const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${audioPath}`);
  return parseFloat(stdout.trim());
}

async function processJobs() {
  console.log('Checking for pending video jobs...');
  try {
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

    const quizzes = await fetchSupabase(`quiz?id=eq.${job.quiz_id}`);
    if (!quizzes || quizzes.length === 0) throw new Error('Quiz not found');
    const quiz = quizzes[0];

    const { question_index = 1, video_type = 'short', thinking_time_sec = 16 } = job.payload;
    const lang = quiz.lang_code || 'en';

    const workDir = `/tmp/video_${uuidv4()}`;
    await fs.mkdir(workDir, { recursive: true });

    // Generate slides and audio with dynamic durations
    const slideData = await generateSlidesAndAudio(quiz, question_index, thinking_time_sec, workDir, lang);
    const videoPath = await assembleVideo(slideData, workDir);

    const stats = await fs.stat(videoPath);
    console.log(`Video created: ${videoPath}, size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB`);

    await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString() })
    });

    const artifactPath = `/tmp/${job.id}_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);
    console.log(`Video saved as artifact: ${artifactPath}`);
    await fs.writeFile('/tmp/artifact_ready', artifactPath);

    await fs.rm(workDir, { recursive: true, force: true });
    console.log(`Job ${job.id} completed successfully`);
  } catch (err) {
    console.error('Job failed:', err);
    throw err;
  }
}

async function generateSlidesAndAudio(quiz, questionIndex, thinkingTime, workDir, lang) {
  let html = quiz.quiz_css_video;
  if (!html) throw new Error('quiz_css_video is empty');

  const qIdx = questionIndex;
  const options = quiz[`options_${qIdx}`] || [];
  const optionsText = options.map((opt, idx) => `${String.fromCharCode(65+idx)}) ${opt}`).join('\n');
  const keep5050 = quiz[`keep_5050_${qIdx}`] || [];

  // Replace placeholders in HTML
  const replacements = {
    '{{hook_phrase}}': quiz.hook_phrase || '',
    '{{intro_speech}}': quiz.quiz_intro_speech || '',
    '{{question}}': quiz[`question_${qIdx}`] || '',
    '{{options}}': optionsText,
    '{{options[0]}}': options[0] || '',
    '{{options[1]}}': options[1] || '',
    '{{options[2]}}': options[2] || '',
    '{{options[3]}}': options[3] || '',
    '{{hint}}': quiz[`hint_${qIdx}`] || '',
    '{{keep_5050}}': keep5050.join(', '),
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

  // Slide definitions
  const slideDefinitions = [
    { selector: '.hook-slide', textKey: 'hook', name: 'hook' },
    { selector: '.intro-slide', textKey: 'intro', name: 'intro' },
    { selector: '.question-phase-1', textKey: 'phase1', name: 'phase1' },
    { selector: '.question-phase-2', textKey: 'phase2', name: 'phase2' },
    { selector: '.question-phase-3', textKey: 'phase3', name: 'phase3' },
    { selector: '.answer-slide', textKey: 'answer', name: 'answer' },
    { selector: '.explanation-slide', textKey: 'explanation', name: 'explanation' },
    { selector: '.cta-slide', textKey: 'cta', name: 'cta' },
    { selector: '.mission-slide', textKey: 'mission', name: 'mission' }
  ];

  // TTS texts
  const voiceMap = { en: 'en-US-JennyNeural', hi: 'hi-IN-SwaraNeural', es: 'es-ES-ElviraNeural', pt: 'pt-BR-FranciscaNeural' };
  const voice = voiceMap[lang] || voiceMap.en;

  const ttsTexts = {
    hook: quiz.hook_phrase || '',
    intro: quiz.quiz_intro_speech || '',
    phase1: `${quiz[`question_${qIdx}`] || ''}. Options: ${options.join(', ')}. Your time starts now.`,
    phase2: `Hint: ${quiz[`hint_${qIdx}`] || ''}`,
    phase3: `50/50 removed. Remaining options: ${keep5050.join(', ')}`,
    answer: `Time's up! Correct answer is ${quiz[`correct_answer_${qIdx}`] || ''}.`,
    explanation: quiz[`explanation_${qIdx}`] || '',
    cta: quiz.cta_text || '',
    mission: `${quiz.mission_impossible_question || ''} Hint: ${quiz.mission_impossible_hint || ''} ${quiz.mission_impossible_trigger_line || ''}`
  };

  const slideData = [];

  for (const def of slideDefinitions) {
    // Make slide visible
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (el) el.style.display = 'flex';
    }, def.selector);
    await new Promise(resolve => setTimeout(resolve, 500));

    // Screenshot
    const imagePath = path.join(workDir, `${def.name}.png`);
    await page.screenshot({ path: imagePath, fullPage: true });
    console.log(`Screenshot saved: ${imagePath}`);

    // Audio
    const text = ttsTexts[def.textKey] || '';
    let audioPath = path.join(workDir, `${def.name}.mp3`);
    if (!text.trim()) {
      await execPromise(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t 1 -q:a 9 -acodec libmp3lame ${audioPath}`);
      console.log(`Silent audio generated for ${def.name}`);
    } else {
      const safeText = text.replace(/"/g, '\\"');
      await execPromise(`edge-tts --voice "${voice}" --text "${safeText}" --write-media ${audioPath}`);
      console.log(`TTS audio generated for ${def.name}`);
    }
    const duration = await getAudioDuration(audioPath);
    console.log(`Audio duration for ${def.name}: ${duration}s`);

    slideData.push({
      imagePath,
      audioPath,
      duration: Math.max(duration, 0.5)
    });
  }

  await browser.close();
  return slideData;
}

async function assembleVideo(slideData, workDir) {
  const concatList = [];
  for (let i = 0; i < slideData.length; i++) {
    const { imagePath, audioPath, duration } = slideData[i];
    const clipPath = path.join(workDir, `clip_${i}.mp4`);
    await execPromise(`ffmpeg -loop 1 -i ${imagePath} -i ${audioPath} -c:v libx264 -t ${duration} -c:a aac -shortest -y ${clipPath}`);
    concatList.push(`file '${clipPath}'`);
  }
  const listPath = path.join(workDir, 'concat.txt');
  await fs.writeFile(listPath, concatList.join('\n'));
  const outputPath = path.join(workDir, 'final.mp4');
  await execPromise(`ffmpeg -f concat -safe 0 -i ${listPath} -c copy ${outputPath}`);
  return outputPath;
}

processJobs().then(() => {
  console.log('Worker finished this run');
  process.exit(0);
}).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
