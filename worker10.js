const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const fs = require('fs').promises;
const path = require('path');
const puppeteer = require('puppeteer');
const { v4: uuidv4 } = require('uuid');

// ========================
// Environment
// ========================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

console.log('SUPABASE_URL from env:', supabaseUrl);
console.log('SUPABASE_SERVICE_KEY from env:', supabaseKey ? '*** (set)' : 'NOT SET');

const cleanSupabaseUrl = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;
if (!cleanSupabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
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

// ========================
// Audio utilities with retry and fallback
// ========================
async function getAudioDuration(file) {
  const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`);
  return parseFloat(stdout.trim());
}

async function generateSilentAudio(outputPath, durationSec = 1) {
  await execPromise(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${durationSec} -q:a 9 -acodec libmp3lame "${outputPath}"`);
}

async function ttsWithFallback(text, voice, outPath, fallbackSec = 2) {
  if (!text?.trim()) {
    await generateSilentAudio(outPath, fallbackSec);
    return;
  }

  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const tmp = outPath + '.txt';
      await fs.writeFile(tmp, text, 'utf8');
      await execPromise(`edge-tts --voice "${voice}" --file "${tmp}" --write-media "${outPath}"`);
      await fs.unlink(tmp).catch(() => {});
      console.log(`TTS succeeded for: ${text.substring(0, 50)}...`);
      return; // success
    } catch (err) {
      console.warn(`TTS attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) {
        console.warn(`Falling back to silent audio for: ${text.substring(0, 50)}...`);
        await generateSilentAudio(outPath, fallbackSec);
      } else {
        await new Promise(r => setTimeout(r, 2000 * attempt)); // exponential backoff
      }
    }
  }
}

// Fixed phrase cache (still uses ttsWithFallback)
const FIXED_DIR = '/tmp/fixed_audio';
async function getFixedPhrase(key, text, voice) {
  await fs.mkdir(FIXED_DIR, { recursive: true });
  const cachePath = `${FIXED_DIR}/${key}_${voice}.mp3`;
  try {
    await fs.access(cachePath);
    return cachePath;
  } catch {
    await ttsWithFallback(text, voice, cachePath);
    return cachePath;
  }
}

// ========================
// Unique background CSS
// ========================
function getUniqueBackgroundCSS(quiz) {
  if (quiz.quiz_background_css && quiz.quiz_background_css.trim()) {
    return quiz.quiz_background_css;
  }
  const hue1 = Math.floor(Math.random() * 360);
  const hue2 = (hue1 + 40) % 360;
  const hue3 = (hue1 + 80) % 360;
  return `
    <style>
      .dynamic-bg {
        position: fixed; inset: 0; z-index: 0;
        background: linear-gradient(135deg, hsl(${hue1}, 70%, 10%), hsl(${hue2}, 70%, 20%), hsl(${hue3}, 70%, 15%));
        background-size: 200% 200%;
        animation: bgShift 12s ease infinite;
      }
      .dynamic-bg::before {
        content: ''; position: absolute; inset: 0;
        background-image: radial-gradient(circle at 20% 40%, rgba(255,255,255,0.1) 2%, transparent 2.5%),
                          radial-gradient(circle at 80% 70%, rgba(255,255,255,0.08) 1.5%, transparent 2%);
        background-size: 60px 60px, 40px 40px;
        animation: floatDots 20s linear infinite;
      }
      @keyframes bgShift { 0%{background-position:0% 0%;} 50%{background-position:100% 100%;} 100%{background-position:0% 0%;} }
      @keyframes floatDots { from { transform: translate(0,0); } to { transform: translate(40px, 40px); } }
    </style>
    <div class="dynamic-bg"></div>
  `;
}

// ========================
// Build full HTML for one question
// ========================
async function buildHTML(quiz, qIdx, workDir, lang, thinkingTimeSec, engagementText, customBgCSS) {
  const options = quiz[`options_${qIdx}`] || [];
  const correct = quiz[`correct_answer_${qIdx}`] || '';
  const hint = quiz[`hint_${qIdx}`] || '';
  const keep5050 = quiz[`keep_5050_${qIdx}`] || [];
  const eliminateIdx = [0,1,2,3].filter(i => !keep5050.includes(i) && !keep5050.includes(String(i)));
  const ctaUrl = `jaasblog.online/q/${quiz.niche}/${lang}/${quiz.topic_slug}`;

  const templatePath = path.join(__dirname, 'quiz_template.html');
  let template = await fs.readFile(templatePath, 'utf8');

  const replacements = {
    '{{hook_phrase}}': quiz.hook_phrase || '🔥 STOP SCROLLING!',
    '{{topic}}': quiz.topic || '',
    '{{engagement_text}}': engagementText,
    '{{question_appearance_text}}': quiz.question_appearance_text || 'Here Is Your Challenge – Solve It',
    '{{question}}': quiz[`question_${qIdx}`] || '',
    '{{options[0]}}': options[0] || '',
    '{{options[1]}}': options[1] || '',
    '{{options[2]}}': options[2] || '',
    '{{options[3]}}': options[3] || '',
    '{{opt0_class}}': eliminateIdx.includes(0) ? 'eliminate' : '',
    '{{opt1_class}}': eliminateIdx.includes(1) ? 'eliminate' : '',
    '{{opt2_class}}': eliminateIdx.includes(2) ? 'eliminate' : '',
    '{{opt3_class}}': eliminateIdx.includes(3) ? 'eliminate' : '',
    '{{rev0_class}}': options[0] === correct ? 'correct' : 'wrong',
    '{{rev1_class}}': options[1] === correct ? 'correct' : 'wrong',
    '{{rev2_class}}': options[2] === correct ? 'correct' : 'wrong',
    '{{rev3_class}}': options[3] === correct ? 'correct' : 'wrong',
    '{{hint}}': hint,
    '{{correct_answer}}': correct,
    '{{explanation}}': quiz[`explanation_${qIdx}`] || '',
    '{{cta_text}}': quiz.cta_text || 'Like, Share & Subscribe!',
    '{{cta2_text}}': quiz.cta2_text || 'Accept the real challenge – earn ONS tokens!',
    '{{blog_page_url}}': quiz.blog_page_url || ctaUrl,
    '{{affiliate_text}}': quiz.affiliate_text || 'Want the best credit card? Follow the description link!',
    '{{affiliate_url}}': quiz.affiliate_url || quiz.cta_affiliate_url || '',
    '{{mission_question}}': quiz.mission_impossible_question || '',
    '{{mission_hint}}': quiz.mission_impossible_hint || '',
    '{{mission_trigger}}': quiz.mission_impossible_trigger_line || 'Comment your answer below!',
    '{{thinking_time}}': thinkingTimeSec,
    '{{unique_bg}}': customBgCSS
  };
  for (const [k, v] of Object.entries(replacements)) {
    template = template.split(k).join(String(v));
  }
  const htmlPath = path.join(workDir, 'index.html');
  await fs.writeFile(htmlPath, template);
  return htmlPath;
}

// ========================
// Main video builder
// ========================
async function buildVideo(quiz, qIdx, lang, workDir) {
  const voice = { en: 'en-US-JennyNeural', hi: 'hi-IN-SwaraNeural', es: 'es-ES-ElviraNeural', pt: 'pt-BR-FranciscaNeural' }[lang] || 'en-US-JennyNeural';
  const thinkingSec = quiz.thinking_time || 18;
  const engagementText = (quiz.quiz_intro_speech || '') + ' ' + (quiz.engagement_prompt || '');
  const customBg = getUniqueBackgroundCSS(quiz);

  const htmlPath = await buildHTML(quiz, qIdx, workDir, lang, thinkingSec, engagementText, customBg);
  
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'load', timeout: 120000 });

  const clips = [];

  async function screenShot(selector, name) {
    await page.evaluate(sel => {
      document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
      const target = document.querySelector(sel);
      if (target) target.classList.add('active');
    }, selector);
    await new Promise(r => setTimeout(r, 500));
    const img = path.join(workDir, `${name}.png`);
    await page.screenshot({ path: img });
    return img;
  }

  async function imageClip(img, audioPath, name, durationOverride = null) {
    const dur = durationOverride || await getAudioDuration(audioPath);
    const clip = path.join(workDir, `${name}.mp4`);
    await execPromise(`ffmpeg -y -loop 1 -i "${img}" -i "${audioPath}" -c:v libx264 -t ${dur} -pix_fmt yuv420p -c:a aac -shortest "${clip}"`);
    return { path: clip, duration: dur };
  }

  // 1. Hook
  const hookImg = await screenShot('.hook-slide', 'hook');
  const hookAudio = path.join(workDir, 'hook.mp3');
  await ttsWithFallback(quiz.hook_phrase, voice, hookAudio, 3);
  let hookDur = await getAudioDuration(hookAudio);
  hookDur = Math.max(hookDur, 2.5);
  clips.push(await imageClip(hookImg, hookAudio, 'hook_clip', hookDur));

  // 2. Intro
  const introImg = await screenShot('.intro-slide', 'intro');
  const introAudio = path.join(workDir, 'intro.mp3');
  await ttsWithFallback(quiz.quiz_intro_speech, voice, introAudio, 5);
  let introDur = await getAudioDuration(introAudio);
  introDur = Math.max(introDur, 4);
  clips.push(await imageClip(introImg, introAudio, 'intro_clip', introDur));

  // 3. Challenge announcement
  const challengeAudio = await getFixedPhrase('challenge', 'Here is your challenge. Solve it.', voice);
  const challengeDur = await getAudioDuration(challengeAudio);
  const challengeImg = await screenShot('.intro-slide', 'challenge_static');
  clips.push(await imageClip(challengeImg, challengeAudio, 'challenge_clip', challengeDur));

  // 4. Question phase recording
  await page.evaluate(() => {
    document.querySelectorAll('.screen').forEach(el => el.classList.remove('active'));
    const q = document.querySelector('.question-phase');
    if (q) q.classList.add('active');
  });
  await new Promise(r => setTimeout(r, 500));

  const questionVideoRaw = path.join(workDir, 'question_phase_raw.mp4');
  const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
  const recorder = new PuppeteerScreenRecorder(page, { fps: 30, videoFrame: { width: 1080, height: 1920 }, aspectRatio: '9:16' });
  await recorder.start(questionVideoRaw);
  await new Promise(r => setTimeout(r, thinkingSec * 1000));
  await recorder.stop();

  // 5. "And your options are"
  const optionsAudio = await getFixedPhrase('options', 'And your options are.', voice);
  const optionsDur = await getAudioDuration(optionsAudio);
  const optionsImg = await screenShot('.question-phase', 'options_static');
  clips.push(await imageClip(optionsImg, optionsAudio, 'options_clip', optionsDur));

  // Recorded phase
  const questionDur = await getVideoDuration(questionVideoRaw);
  clips.push({ path: questionVideoRaw, duration: questionDur });

  // 6. Time up + correct answer
  const timeupAudio = path.join(workDir, 'timeup.mp3');
  await ttsWithFallback(`Time's up. The correct answer is ${quiz[`correct_answer_${qIdx}`] || ''}.`, voice, timeupAudio, 3);
  const timeupDur = await getAudioDuration(timeupAudio);
  const answerImg = await screenShot('.answer-slide', 'answer_static');
  clips.push(await imageClip(answerImg, timeupAudio, 'timeup_clip', timeupDur));

  // 7. Explanation
  const explImg = await screenShot('.explanation-slide', 'explanation');
  const explAudio = path.join(workDir, 'explanation.mp3');
  await ttsWithFallback(quiz[`explanation_${qIdx}`], voice, explAudio, 5);
  const explDur = await getAudioDuration(explAudio);
  clips.push(await imageClip(explImg, explAudio, 'explanation_clip', explDur));

  // 8. CTA1 (affiliate)
  const cta1Img = await screenShot('.cta-slide', 'cta1');
  const cta1Audio = path.join(workDir, 'cta1.mp3');
  const cta1Text = `${quiz.affiliate_text || 'Want the best credit card?'} Follow the description link: ${quiz.affiliate_url || ''}`;
  await ttsWithFallback(cta1Text, voice, cta1Audio, 4);
  const cta1Dur = await getAudioDuration(cta1Audio);
  clips.push(await imageClip(cta1Img, cta1Audio, 'cta1_clip', cta1Dur));

  // 9. CTA2 (website challenge)
  await page.evaluate(text => {
    const el = document.querySelector('.cta-slide .cta-text');
    if (el) el.textContent = text;
  }, quiz.cta2_text || 'Accept the real challenge – go to our site and earn real ONS tokens!');
  await new Promise(r => setTimeout(r, 200));
  const cta2Img = path.join(workDir, 'cta2.png');
  await page.screenshot({ path: cta2Img });
  const cta2Audio = path.join(workDir, 'cta2.mp3');
  await ttsWithFallback(quiz.cta2_text || 'Accept the real challenge. Go to our site and earn real ONS tokens.', voice, cta2Audio, 4);
  const cta2Dur = await getAudioDuration(cta2Audio);
  clips.push(await imageClip(cta2Img, cta2Audio, 'cta2_clip', cta2Dur));

  // 10. Mission Impossible question
  const missionQImg = await screenShot('.mission-slide', 'mission_q');
  const missionQAudio = path.join(workDir, 'mission_q.mp3');
  await ttsWithFallback(quiz.mission_impossible_question, voice, missionQAudio, 3);
  const missionQDur = await getAudioDuration(missionQAudio);
  clips.push(await imageClip(missionQImg, missionQAudio, 'mission_q_clip', missionQDur));

  // 11. Gap before hint
  const gapAudio = path.join(workDir, 'gap.mp3');
  await generateSilentAudio(gapAudio, 2.5);
  clips.push(await imageClip(missionQImg, gapAudio, 'gap_clip', 2.5));

  // 12. Mission hint reveal
  await page.evaluate(() => {
    const hintEl = document.querySelector('.mission-hint');
    if (hintEl) hintEl.classList.add('shown');
  });
  await new Promise(r => setTimeout(r, 200));
  const missionHintImg = path.join(workDir, 'mission_hint.png');
  await page.screenshot({ path: missionHintImg });
  const missionHintAudio = path.join(workDir, 'mission_hint.mp3');
  await ttsWithFallback(quiz.mission_impossible_hint + ' ' + quiz.mission_impossible_trigger_line, voice, missionHintAudio, 3);
  const missionHintDur = await getAudioDuration(missionHintAudio);
  clips.push(await imageClip(missionHintImg, missionHintAudio, 'mission_hint_clip', missionHintDur));

  // 13. Final CTA
  await page.evaluate(() => {
    const el = document.querySelector('.cta-slide .cta-text');
    if (el) el.textContent = '👍 Like, Share, & Challenge your friend! Subscribe to get the answer to Mission Impossible!';
  });
  await new Promise(r => setTimeout(r, 200));
  const finalCtaImg = path.join(workDir, 'final_cta.png');
  await page.screenshot({ path: finalCtaImg });
  const finalAudio = path.join(workDir, 'final.mp3');
  await ttsWithFallback('Like, share, and challenge your friend! Subscribe to get the answer to the mission impossible question.', voice, finalAudio, 5);
  const finalDur = await getAudioDuration(finalAudio);
  clips.push(await imageClip(finalCtaImg, finalAudio, 'final_cta_clip', finalDur));

  await browser.close();

  // Concat all clips
  const concatList = clips.map(c => `file '${c.path}'`).join('\n');
  const listPath = path.join(workDir, 'concat.txt');
  await fs.writeFile(listPath, concatList);
  const outputPath = path.join(workDir, 'final.mp4');
  await execPromise(`ffmpeg -y -f concat -safe 0 -i "${listPath}" -c:v libx264 -c:a aac -movflags +faststart "${outputPath}"`);
  return outputPath;
}

async function getVideoDuration(videoPath) {
  const { stdout } = await execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`);
  return parseFloat(stdout.trim());
}

// ========================
// Job processor
// ========================
async function processJobs() {
  console.log('Checking pending video jobs...');
  const jobs = await fetchSupabase('quiz_queue?job_type=eq.video_render&status=eq.pending&order=created_at.asc&limit=1');
  if (!jobs?.length) { console.log('No pending jobs'); return; }
  const job = jobs[0];
  console.log(`Processing job ${job.id} for quiz ${job.quiz_id}`);

  await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'processing', started_at: new Date().toISOString() })
  });

  try {
    const quizzes = await fetchSupabase(`quiz?id=eq.${job.quiz_id}`);
    if (!quizzes?.length) throw new Error('Quiz not found');
    const quiz = quizzes[0];
    const qIdx = job.payload?.question_index || 1;
    const lang = quiz.lang_code || 'en';
    const workDir = `/tmp/video_${uuidv4()}`;
    await fs.mkdir(workDir, { recursive: true });

    const videoPath = await buildVideo(quiz, qIdx, lang, workDir);
    const stats = await fs.stat(videoPath);
    console.log(`Video size: ${(stats.size / (1024*1024)).toFixed(2)} MB`);

    const artifactPath = `/tmp/${job.id}_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);
    await fs.writeFile('/tmp/artifact_ready', artifactPath);

    await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed', completed_at: new Date().toISOString() })
    });
    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ video_status: 'rendered' })
    });
    await fs.rm(workDir, { recursive: true, force: true });
    console.log(`Job ${job.id} completed`);
  } catch (err) {
    console.error('Job failed:', err);
    await fetchSupabase(`quiz_queue?id=eq.${job.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'failed', last_error: err.message })
    });
    throw err;
  }
}

processJobs().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
