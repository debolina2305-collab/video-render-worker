const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

console.log('SUPABASE_URL:', supabaseUrl);
console.log('SUPABASE_SERVICE_KEY:', supabaseKey ? '***' : 'missing');

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing credentials');
  process.exit(1);
}

const cleanUrl = supabaseUrl.replace(/\/$/, '');
const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`, 'Content-Type': 'application/json' };

async function fetchSupabase(path, options = {}) {
  const url = `${cleanUrl}/rest/v1/${path}`;
  const res = await fetch(url, { headers, ...options });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getAudioDuration(audioPath) {
  const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 ${audioPath}`);
  return parseFloat(stdout.trim());
}

async function processJobs() {
  const jobs = await fetchSupabase('quiz_queue?job_type=eq.video_render&status=eq.pending&limit=1');
  if (!jobs || jobs.length === 0) {
    console.log('No pending jobs');
    return;
  }
  const job = jobs[0];
  console.log(`Job ${job.id} for quiz ${job.quiz_id}`);

  await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'processing', started_at: new Date().toISOString() })
  });

  const quizzes = await fetchSupabase(`quiz?id=eq.${job.quiz_id}`);
  if (!quizzes || quizzes.length === 0) throw new Error('Quiz not found');
  const quiz = quizzes[0];

  const workDir = `/tmp/video_${uuidv4()}`;
  await fs.mkdir(workDir, { recursive: true });

  // Build HTML with only hook slide visible
  let html = quiz.quiz_css_video;
  // Replace simple placeholders (just hook_phrase)
  html = html.replace(/{{hook_phrase}}/g, quiz.hook_phrase || '');
  const htmlPath = path.join(workDir, 'index.html');
  await fs.writeFile(htmlPath, html);

  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });

  // Only process hook slide
  const slideSelector = '.hook-slide';
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) el.style.display = 'flex';
  }, slideSelector);
  await new Promise(resolve => setTimeout(resolve, 500));
  const imagePath = path.join(workDir, 'hook.png');
  await page.screenshot({ path: imagePath, fullPage: true });
  console.log('Screenshot taken');

  // Generate audio for hook phrase
  const voice = 'en-US-JennyNeural';
  const text = quiz.hook_phrase || 'Test audio';
  const audioPath = path.join(workDir, 'hook.mp3');
  const safeText = text.replace(/"/g, '\\"');
  await execPromise(`edge-tts --voice "${voice}" --text "${safeText}" --write-media ${audioPath}`);
  console.log('TTS audio generated');

  const duration = await getAudioDuration(audioPath);
  console.log(`Audio duration: ${duration}s`);

  // Create video clip
  const clipPath = path.join(workDir, 'clip.mp4');
  await execPromise(`ffmpeg -loop 1 -i ${imagePath} -i ${audioPath} -c:v libx264 -t ${duration} -c:a aac -shortest -y ${clipPath}`);
  console.log('Video clip created');

  // Copy to artifact
  const artifactPath = `/tmp/${job.id}_video.mp4`;
  await fs.copyFile(clipPath, artifactPath);
  console.log(`Video saved as artifact: ${artifactPath}`);
  await fs.writeFile('/tmp/artifact_ready', artifactPath);

  await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString() })
  });

  await fs.rm(workDir, { recursive: true, force: true });
  console.log('Job completed');
}

processJobs().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
