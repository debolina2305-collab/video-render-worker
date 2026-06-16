'use strict';
const { exec }   = require('child_process');
const util       = require('util');
const execPromise = util.promisify(exec);
const fs         = require('fs').promises;
const path       = require('path');
const puppeteer  = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const { v4: uuidv4 } = require('uuid');

// ──────────────────────────────────────────────
// ENV
// ──────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
console.log('SUPABASE_URL:', supabaseUrl);
console.log('SUPABASE_SERVICE_KEY:', supabaseKey ? '*** (set)' : 'NOT SET');

const cleanUrl = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;
if (!cleanUrl || !supabaseKey) { console.error('Missing Supabase credentials'); process.exit(1); }

// ──────────────────────────────────────────────
// CONSTANTS
// ──────────────────────────────────────────────
const VOICE_MAP = {
  en: 'en-US-JennyNeural',
  hi: 'hi-IN-SwaraNeural',
  es: 'es-ES-ElviraNeural',
  pt: 'pt-BR-FranciscaNeural'
};
const THEMES_DIR = path.join(__dirname, 'themes');
const CACHE_DIR  = path.join(__dirname, 'audio_cache');
const DEFAULT_THEME = 'particle_field';

// Background music: default R2 URL (used if quiz.background_music is null)
const DEFAULT_BG_MUSIC = 'https://pub-3578d297d3904e1d8ffedfc9dd4102f2.r2.dev/audio/background_music/The_Midnight_Audit.mp3';

// Audio levels
const BG_VOL_BASE  = 0.10;   // very soft background
const BG_VOL_DUCK  = 0.035;  // ducked ~65% when voice plays
const DUCK_RAMP    = 0.12;   // fade window in seconds

// Human-like gaps
const GAP_DEFAULT  = 0.35;   // between most TTS/prerecorded beats
const GAP_AFTER_STEP2 = 0.30; // after "here is your challenge"
const GAP_OPTIONS  = 0.70;   // silence before options-intro audio
const GAP_ANSWER   = 0.50;   // silence before correct answer reveal
const GAP_EXPL     = 0.50;   // silence before explanation

// ──────────────────────────────────────────────
// SUPABASE HELPER
// ──────────────────────────────────────────────
const baseHeaders = {
  apikey: supabaseKey,
  Authorization: `Bearer ${supabaseKey}`,
  'Content-Type': 'application/json'
};

async function fetchSupabase(p, opts = {}) {
  const url = `${cleanUrl}/rest/v1/${p}`;
  console.log(`[DB] ${opts.method || 'GET'} ${url}`);
  const hdrs = { ...baseHeaders, ...(opts.headers || {}) };
  if (opts.method && ['POST','PATCH','PUT'].includes(opts.method)) hdrs.Prefer = 'return=representation';
  const res = await fetch(url, { ...opts, headers: hdrs });
  if (!res.ok) { const t = await res.text(); throw new Error(`HTTP ${res.status}: ${t}`); }
  const text = await res.text();
  if (!text || text.trim() === '') return null;
  return JSON.parse(text);
}

// ──────────────────────────────────────────────
// AUDIO UTILITIES
// ──────────────────────────────────────────────
async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }

async function fileExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

function encodeR2Url(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    u.pathname = u.pathname.split('/').map(s => encodeURIComponent(decodeURIComponent(s))).join('/');
    return u.toString();
  } catch { return url; }
}

async function downloadAudio(url, cacheKey) {
  if (!url) return null;
  await ensureDir(CACHE_DIR);
  const encoded = encodeR2Url(url);
  let ext = '.wav';
  try { ext = path.extname(new URL(encoded).pathname) || '.wav'; } catch {}
  const safe = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const local = path.join(CACHE_DIR, `${safe}${ext}`);
  if (await fileExists(local)) { console.log(`[CACHE HIT] ${safe}`); return local; }
  console.log(`[DOWNLOAD] ${encoded}`);
  try {
    await execPromise(`curl -sL --fail "${encoded}" -o "${local}" --max-time 30`);
    if (await fileExists(local)) return local;
  } catch (e) {
    console.warn(`[DOWNLOAD FAIL] ${e.message}`);
    await fs.unlink(local).catch(() => {});
  }
  return null;
}

async function audioDur(p) {
  const { stdout } = await execPromise(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`
  );
  return parseFloat(stdout.trim());
}

async function videoDur(p) {
  const { stdout } = await execPromise(
    `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`
  );
  return parseFloat(stdout.trim());
}

async function silence(sec, out) {
  const s = Math.max(parseFloat(sec) || 0.1, 0.05);
  await execPromise(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${s} -q:a 9 -acodec libmp3lame "${out}"`);
}

async function tts(text, voice, out, fallbackSec = 1.5) {
  const t = (text || '').trim();
  if (!t) { await silence(fallbackSec, out); return; }
  const tmp = out + '.txt';
  await fs.writeFile(tmp, t, 'utf8');
  await execPromise(`edge-tts --voice "${voice}" --file "${tmp}" --write-media "${out}"`);
  await fs.unlink(tmp).catch(() => {});
}

// Concatenate audio files using a concat list
async function concatAudio(parts, out, workDir) {
  const listP = path.join(workDir, `cat_${uuidv4()}.txt`);
  await fs.writeFile(listP, parts.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
  await execPromise(`ffmpeg -y -f concat -safe 0 -i "${listP}" -acodec libmp3lame "${out}"`);
  await fs.unlink(listP).catch(() => {});
}

// Build audio: optional leading silence + audio file (prerecorded or TTS fallback)
async function buildAudio({ prerecorded, fallbackText, fallbackSec, voice, leadGap, workDir, name }) {
  const silP   = path.join(workDir, `${name}_gap.mp3`);
  const audioP = path.join(workDir, `${name}_src.mp3`);
  const outP   = path.join(workDir, `${name}_audio.mp3`);
  const gap    = leadGap != null ? leadGap : GAP_DEFAULT;

  if (prerecorded) {
    await silence(gap, silP);
    const listP = path.join(workDir, `${name}_list.txt`);
    await fs.writeFile(listP, `file '${silP}'\nfile '${prerecorded}'`);
    await execPromise(`ffmpeg -y -f concat -safe 0 -i "${listP}" -acodec libmp3lame "${outP}"`);
  } else {
    await tts(fallbackText || '', voice, audioP, fallbackSec || 1.5);
    await silence(gap, silP);
    const listP = path.join(workDir, `${name}_list.txt`);
    await fs.writeFile(listP, `file '${silP}'\nfile '${audioP}'`);
    await execPromise(`ffmpeg -y -f concat -safe 0 -i "${listP}" -acodec libmp3lame "${outP}"`);
  }
  const dur = await audioDur(outP);
  return { path: outP, dur };
}

// Make a clip: static image + audio track → mp4
async function imgClip(img, audioP, dur, workDir, name) {
  const out = path.join(workDir, `${name}.mp4`);
  await execPromise(
    `ffmpeg -y -loop 1 -i "${img}" -i "${audioP}" -c:v libx264 -t ${dur} -pix_fmt yuv420p -c:a aac -shortest "${out}"`
  );
  return { path: out, dur };
}

// ──────────────────────────────────────────────
// BACKGROUND MUSIC DUCKING
// ──────────────────────────────────────────────
// voiceRanges = [{start, end}] in the FULL video timeline (seconds)
// Builds a ducked bg audio track and mixes into the concatenated video.
async function applyBgMusic(concatMp4, totalDur, voiceRanges, bgFile, workDir) {
  if (!bgFile) return concatMp4;

  // Loop bg music to full duration, apply base volume
  const bgLooped = path.join(workDir, 'bg_looped.mp3');
  await execPromise(
    `ffmpeg -y -stream_loop -1 -i "${bgFile}" -t ${totalDur} -af "volume=${BG_VOL_BASE}" -acodec libmp3lame "${bgLooped}"`
  );

  // Build ducking envelope: for each voice range, reduce bg volume
  // We chain `volume` filter instances with `enable='between(t,a,b)'`
  const bgDucked = path.join(workDir, 'bg_ducked.mp3');
  if (voiceRanges.length > 0) {
    const ratio = (BG_VOL_DUCK / BG_VOL_BASE).toFixed(4);
    const filters = voiceRanges.map(r => {
      const s = Math.max(0, r.start - DUCK_RAMP).toFixed(3);
      const e = (r.end + DUCK_RAMP).toFixed(3);
      return `volume=enable='between(t,${s},${e})':volume=${ratio}`;
    }).join(',');
    await execPromise(`ffmpeg -y -i "${bgLooped}" -af "${filters}" -acodec libmp3lame "${bgDucked}"`);
  } else {
    await fs.copyFile(bgLooped, bgDucked);
  }

  // Extract foreground audio from video
  const fgAudio = path.join(workDir, 'fg_audio.mp3');
  await execPromise(`ffmpeg -y -i "${concatMp4}" -vn -acodec libmp3lame "${fgAudio}"`);

  // Mix: fg full vol + ducked bg
  const mixedAudio = path.join(workDir, 'mixed_audio.mp3');
  await execPromise(
    `ffmpeg -y -i "${fgAudio}" -i "${bgDucked}" ` +
    `-filter_complex "[0:a]volume=1.0[fg];[1:a]volume=1.0[bg];[fg][bg]amix=inputs=2:duration=first:dropout_transition=0[a]" ` +
    `-map "[a]" -acodec libmp3lame "${mixedAudio}"`
  );

  // Remux video with mixed audio
  const finalMp4 = path.join(workDir, 'final_with_music.mp4');
  await execPromise(
    `ffmpeg -y -i "${concatMp4}" -i "${mixedAudio}" -c:v copy -map 0:v:0 -map 1:a:0 -c:a aac -shortest -movflags +faststart "${finalMp4}"`
  );
  return finalMp4;
}

// ──────────────────────────────────────────────
// THEME RESOLUTION
// ──────────────────────────────────────────────
async function resolveTheme(quiz) {
  const base = await fs.readFile(path.join(THEMES_DIR, '_base.css'), 'utf8');
  const themeId = quiz.visual_theme_id || DEFAULT_THEME;
  let themeFile = path.join(THEMES_DIR, `${themeId}.css`);
  if (!(await fileExists(themeFile))) {
    console.warn(`Theme '${themeId}' not found, using default`);
    themeFile = path.join(THEMES_DIR, `${DEFAULT_THEME}.css`);
  }
  let themeCss = base + '\n' + (await fs.readFile(themeFile, 'utf8'));
  const a1 = quiz.theme_accent_primary   || '#00e0ff';
  const a2 = quiz.theme_accent_secondary || '#7b2ff7';
  const a3 = quiz.theme_accent_tertiary  || '#ff2ec4';
  themeCss = themeCss.split('{{accent_primary}}').join(a1)
                     .split('{{accent_secondary}}').join(a2)
                     .split('{{accent_tertiary}}').join(a3);
  const decoHtml = buildDecoHtml(themeId);
  return { themeCss, decoHtml };
}

function buildDecoHtml(id) {
  switch (id) {
    case 'neon_grid':
      return '<div class="theme-deco"></div><div class="theme-deco2"></div>';
    case 'coin_orbit':
      return '<div class="theme-deco"><div class="coin coin1">$</div><div class="coin coin2">¢</div><div class="coin coin3">€</div><div class="coin coin4">₹</div></div>';
    case 'chart_pulse':
      return '<div class="theme-deco"><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div><div class="bar"></div></div>' +
             '<div class="theme-deco2"><svg viewBox="0 0 1080 200" preserveAspectRatio="none"><path d="M0,150 C150,50 300,180 450,100 C600,20 750,160 900,80 C1000,30 1050,90 1080,60"/></svg></div>';
    case 'paper_trail':
      return '<div class="theme-deco"><div class="doc doc1"></div><div class="doc doc2"></div><div class="doc doc3"></div><div class="doc doc4"></div></div>';
    case 'vault_glow':
      return '<div class="theme-deco"><div class="vault-ring vr1"></div><div class="vault-ring vr2"></div><div class="vault-ring vr3"></div></div>';
    case 'skyline_dusk':
      return '<div class="theme-deco"><div class="bldg"></div><div class="bldg"></div><div class="bldg"></div><div class="bldg"></div><div class="bldg"></div><div class="bldg"></div><div class="bldg"></div></div>';
    case 'global_orbit':
      return '<div class="theme-deco"><div class="lat-line ll1"></div><div class="lat-line ll2"></div></div>';
    case 'confetti_pop':
      return '<div class="theme-deco">' +
        Array.from({length:14},(_,i)=>{
          const left=(i*7+3)%100, dur=3+(i%5), delay=(i*0.3)%4, size=10+(i%4)*4;
          const colors=['var(--accent-1)','var(--accent-2)','var(--accent-3)','#ffd166','#00ff8c'];
          return `<div class="confetti-bg" style="left:${left}%;width:${size}px;height:${size*1.6}px;background:${colors[i%5]};animation-duration:${dur}s;animation-delay:${delay}s;"></div>`;
        }).join('') + '</div>';
    case 'shield_secure':
      return '<div class="theme-deco"><svg viewBox="0 0 200 240"><path d="M100,10 L180,40 L180,120 C180,180 140,220 100,230 C60,220 20,180 20,120 L20,40 Z"/></svg></div><div class="shield-pulse"></div>';
    case 'particle_field':
      return '<div class="theme-deco">' +
        Array.from({length:18},(_,i)=>{
          const left=(i*5+2)%100, size=6+(i%5)*3, dur=8+(i%6)*2, delay=(i*0.7)%10;
          return `<div class="particle" style="left:${left}%;bottom:-20px;width:${size}px;height:${size}px;animation-duration:${dur}s;animation-delay:${delay}s;"></div>`;
        }).join('') + '</div>';
    case 'aurora':
    default:
      return '';
  }
}

// ──────────────────────────────────────────────
// JOB PROCESSING — reads quiz table directly
// ──────────────────────────────────────────────
async function processJobs() {
  console.log('[WORKER] Checking for pending quizzes...');

  // Fetch one pending, approved, active quiz (oldest first)
  const rows = await fetchSupabase(
    'quiz?video_status=eq.pending&is_active=eq.true&is_human_approved=eq.true' +
    '&quiz_enriched=eq.true&select=*&order=created_at.asc&limit=1'
  );

  if (!rows || rows.length === 0) {
    console.log('[WORKER] No pending quizzes.');
    return;
  }

  const quiz = rows[0];
  console.log(`[WORKER] Processing quiz: ${quiz.id} — ${quiz.topic}`);

  // Mark as processing immediately to prevent double-render
  await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ video_status: 'processing' })
  });

  const workDir = `/tmp/video_${uuidv4()}`;
  await ensureDir(workDir);

  try {
    const videoPath = await buildVideo(quiz, workDir);
    const stats     = await fs.stat(videoPath);
    const sizeMb    = parseFloat((stats.size / (1024 * 1024)).toFixed(2));
    const dur       = await videoDur(videoPath);

    console.log(`[WORKER] Done. Duration: ${dur.toFixed(2)}s, Size: ${sizeMb}MB`);

    // Save artifact
    const artifactPath = `/tmp/${quiz.id}_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);
    await fs.writeFile('/tmp/artifact_ready', artifactPath);

    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        video_status:      'rendered',
        render_duration_sec: Math.round(dur),
        file_size_mb:      sizeMb,
        updated_at:        new Date().toISOString()
      })
    });

    await fs.rm(workDir, { recursive: true, force: true });
    console.log(`[WORKER] Artifact: ${artifactPath}`);

  } catch (err) {
    console.error('[WORKER] FAILED:', err);
    await fetchSupabase(`quiz?id=eq.${quiz.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        video_status:     'error',
        generation_error: String(err.message || err).slice(0, 800),
        updated_at:       new Date().toISOString()
      })
    });
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ──────────────────────────────────────────────
// MAIN VIDEO BUILDER
// ──────────────────────────────────────────────
async function buildVideo(quiz, workDir) {
  const lang  = quiz.lang_code || 'en';
  const voice = VOICE_MAP[lang] || VOICE_MAP.en;
  const niche = quiz.niche || 'general';

  // Question data (single question per video)
  const question    = quiz.question_1    || '';
  const options     = quiz.options_1     || [];
  const correct     = quiz.correct_answer_1 || '';
  const explanation = quiz.explanation_1 || '';
  const hint        = quiz.hint_1        || '';
  const keep5050    = quiz.keep_5050_1   || [];

  // Timing
  const QTIME    = quiz.thinking_time_sec || 9;
  const HINT_AT  = QTIME / 4;        // 1/4 mark
  const FIFTY_AT = QTIME / 2;        // 1/2 mark

  // 50/50 eliminate: all options NOT in keep5050
  const allIdx    = [0,1,2,3];
  const keepIdx   = keep5050.map(v => (typeof v === 'string' ? parseInt(v) : v));
  const elimIdx   = allIdx.filter(i => !keepIdx.includes(i));
  const optClass  = i => elimIdx.includes(i) ? 'eliminate' : '';
  const revClass  = i => options[i] === correct ? 'correct' : 'wrong';

  // CTA logic: CTA1 if affiliate_url present, else CTA2
  const hasCta1  = !!(quiz.affiliate_url && quiz.affiliate_url.trim());

  // ── DOWNLOAD ALL AUDIO FROM QUIZ TABLE COLUMNS IN PARALLEL ──
  console.log('[AUDIO] Downloading audio assets...');
  const [
    hookFile, questionIntroFile, optionsIntroFile,
    timeupFile, cta1AudioFile, cta2AudioFile,
    missionIntroFile, cta3AudioFile,
    sfxFile, countdownFile, bgFile, correctSfxFile
  ] = await Promise.all([
    downloadAudio(quiz.hook_audio_url,            `hook_${quiz.id}`),
    downloadAudio(quiz.question_intro_audio_url,  `qintro_${quiz.id}`),
    downloadAudio(quiz.options_intro_audio_url,   `ointro_${quiz.id}`),
    downloadAudio(quiz.timeup_audio_url,          `timeup_${quiz.id}`),
    downloadAudio(quiz.cta1_audio_url,            `cta1_${quiz.id}`),
    downloadAudio(quiz.cta2_audio_url,            `cta2_${quiz.id}`),
    downloadAudio(quiz.mission_intro_audio_url,   `missintro_${quiz.id}`),
    downloadAudio(quiz.cta3_audio_url,            `cta3_${quiz.id}`),
    downloadAudio(quiz.sfx_audio_url,             `sfx_${quiz.id}`),
    downloadAudio(quiz.countdown_music,           `countdown_${quiz.id}`),
    downloadAudio(quiz.background_music || DEFAULT_BG_MUSIC, `bgmusic_${quiz.id}`),
    downloadAudio(quiz.correct_answer_sfx_audio_url, `correctsfx_${quiz.id}`)
  ]);

  // ── RESOLVE THEME ──
  const { themeCss, decoHtml } = await resolveTheme(quiz);

  // ── BUILD HTML ──
  let html = await fs.readFile(path.join(__dirname, 'quiz_template.html'), 'utf8');
  const R = {
    '{{theme_css}}':        themeCss,
    '{{theme_deco_html}}':  decoHtml,
    '{{hook_phrase}}':      quiz.hook_phrase || 'Stop scrolling! Can you beat this?',
    '{{question}}':         question,
    '{{options[0]}}':       options[0] || '',
    '{{options[1]}}':       options[1] || '',
    '{{options[2]}}':       options[2] || '',
    '{{options[3]}}':       options[3] || '',
    '{{opt0_class}}':       optClass(0),
    '{{opt1_class}}':       optClass(1),
    '{{opt2_class}}':       optClass(2),
    '{{opt3_class}}':       optClass(3),
    '{{rev0_class}}':       revClass(0),
    '{{rev1_class}}':       revClass(1),
    '{{rev2_class}}':       revClass(2),
    '{{rev3_class}}':       revClass(3),
    '{{hint}}':             hint,
    '{{correct_answer}}':   correct,
    '{{explanation}}':      explanation,
    '{{affiliate_text}}':   quiz.affiliate_text || 'Check the link in description!',
    '{{cta2_text}}':        quiz.cta2_text || 'Play real quiz and earn ONS tokens!',
    '{{cta3_text}}':        quiz.cta3_text || 'Like, Share & Challenge a friend! Subscribe!',
    '{{niche}}':            niche,
    '{{mission_intro_text}}': quiz.mission_intro_text || 'MISSION IMPOSSIBLE',
    '{{mission_question}}': quiz.mission_impossible_question || '',
    '{{mission_hint}}':     quiz.mission_impossible_hint || '',
    '{{qtime}}':            QTIME,
    '{{hint_time}}':        HINT_AT,
    '{{fiftyfifty_time}}':  FIFTY_AT
  };
  for (const [k,v] of Object.entries(R)) html = html.split(k).join(String(v));

  const htmlPath = path.join(workDir, 'index.html');
  await fs.writeFile(htmlPath, html);

  // ── LAUNCH PUPPETEER ──
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920 });
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 300));

  // Helper: show one screen
  const showOnly = async sel => {
    await page.evaluate(s => {
      document.querySelectorAll('.screen').forEach(e => e.classList.remove('active'));
      const el = document.querySelector(s);
      if (el) el.classList.add('active');
    }, sel);
  };

  // Helper: screenshot
  const shot = async name => {
    const p = path.join(workDir, `${name}.png`);
    await page.screenshot({ path: p });
    return p;
  };

  const clips = [];       // { path, dur }
  const voiceRanges = []; // { start, end } relative to full video timeline
  let cursor = 0;

  // Helper: push a clip and accumulate voice range + cursor
  function pushClip(clip, isVoice = true) {
    if (isVoice) voiceRanges.push({ start: cursor, end: cursor + clip.dur });
    cursor += clip.dur;
    clips.push(clip);
  }

  // ════════════════════════════════════════════
  // STEP 1: HOOK (hook_phrase text + hook_audio_url, 2-3s)
  // ════════════════════════════════════════════
  await showOnly('.hook-slide');
  await new Promise(r => setTimeout(r, 1100));
  const hookImg = await shot('hook');

  const hookAudio = await buildAudio({
    prerecorded:  hookFile,
    fallbackText: quiz.hook_phrase || 'Stop scrolling! Can you beat this?',
    fallbackSec:  2.5, voice,
    leadGap: 0.1, workDir, name: 'hook'
  });
  const hookDur = Math.max(hookAudio.dur, 2.0);
  pushClip(await imgClip(hookImg, hookAudio.path, hookDur, workDir, 'clip_hook'));

  // ════════════════════════════════════════════
  // STEP 2: question_intro_audio_url — AUDIO ONLY, waiting frame
  // ════════════════════════════════════════════
  await showOnly('.waiting-slide');
  await new Promise(r => setTimeout(r, 200));
  const waitImg = await shot('waiting');

  const step2Audio = await buildAudio({
    prerecorded:  questionIntroFile,
    fallbackText: 'Here is your challenge!',
    fallbackSec:  1.5, voice,
    leadGap: GAP_AFTER_STEP2, workDir, name: 'step2'
  });
  pushClip(await imgClip(waitImg, step2Audio.path, step2Audio.dur, workDir, 'clip_step2'));

  // ════════════════════════════════════════════
  // STEP 3: Question appears with animation (question_1 + edge TTS)
  // 0.3s gap after step 2 completion, then question bounces in
  // ════════════════════════════════════════════
  await showOnly('.question-appear-slide');
  await new Promise(r => setTimeout(r, 700)); // let card entrance play
  const qAppearImg = await shot('question_appear');

  // SFX sting (sfx_audio_url) plays first, then TTS reads question
  const qTtsPath = path.join(workDir, 'q_tts.mp3');
  await tts(question, voice, qTtsPath, 3);
  const qTtsDur = await audioDur(qTtsPath);

  const step3Parts = [];
  if (sfxFile) {
    const sfxDur = await audioDur(sfxFile);
    const sfxGap = path.join(workDir, 'sfx_gap.mp3');
    await silence(0.15, sfxGap);
    step3Parts.push(sfxFile, sfxGap, qTtsPath);
  } else {
    step3Parts.push(qTtsPath);
  }
  const step3Combined = path.join(workDir, 'step3.mp3');
  await concatAudio(step3Parts, step3Combined, workDir);
  const step3Dur = Math.max(await audioDur(step3Combined), 2);
  pushClip(await imgClip(qAppearImg, step3Combined, step3Dur, workDir, 'clip_step3'));

  // ════════════════════════════════════════════
  // STEP 4: 0.7s silence then options_intro_audio_url (audio only)
  // STEP 5: 0.3s then options appear with SFX + TTS
  // ════════════════════════════════════════════
  await showOnly('.question-static');
  await new Promise(r => setTimeout(r, 900));
  const optionsImg = await shot('options_static');

  // Build step 4+5 audio in one track: gap + options_intro + gap + (sfx+options TTS)
  const step45Parts = [];
  const gap4Path = path.join(workDir, 'gap4.mp3');
  await silence(GAP_OPTIONS, gap4Path);
  step45Parts.push(gap4Path);

  if (optionsIntroFile) {
    step45Parts.push(optionsIntroFile);
  } else {
    const ointroTts = path.join(workDir, 'ointro_tts.mp3');
    await tts('And your options are...', voice, ointroTts, 1.5);
    step45Parts.push(ointroTts);
  }

  // 0.3s gap then options SFX then each option TTS
  const gap5Path = path.join(workDir, 'gap5.mp3');
  await silence(0.3, gap5Path);
  step45Parts.push(gap5Path);

  if (sfxFile) {
    const sfxGap2 = path.join(workDir, 'sfxgap2.mp3');
    await silence(0.1, sfxGap2);
    step45Parts.push(sfxFile, sfxGap2);
  }

  for (let i = 0; i < options.length; i++) {
    if (!options[i]) continue;
    const oSil = path.join(workDir, `o_sil_${i}.mp3`);
    const oTts = path.join(workDir, `o_tts_${i}.mp3`);
    await silence(0.25, oSil);
    await tts(`${String.fromCharCode(65+i)}. ${options[i]}`, voice, oTts, 1);
    step45Parts.push(oSil, oTts);
  }

  const step45Combined = path.join(workDir, 'step45.mp3');
  await concatAudio(step45Parts, step45Combined, workDir);
  const step45Dur = Math.max(await audioDur(step45Combined), 3);
  pushClip(await imgClip(optionsImg, step45Combined, step45Dur, workDir, 'clip_step45'));

  // ════════════════════════════════════════════
  // STEP 6-8: COUNTDOWN (screen-recorded CSS animation)
  // countdown_music loops for QTIME seconds
  // Hint SFX at HINT_AT, 50/50 SFX at FIFTY_AT
  // ════════════════════════════════════════════
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 200));
  await showOnly('.question-phase');

  const rawVideo = path.join(workDir, 'phase_raw.mp4');
  const recorder = new PuppeteerScreenRecorder(page, {
    fps: 30,
    videoFrame: { width: 1080, height: 1920 },
    aspectRatio: '9:16'
  });
  await recorder.start(rawVideo);
  await new Promise(r => setTimeout(r, QTIME * 1000));
  await recorder.stop();

  // Build countdown audio bed
  const cdBase = path.join(workDir, 'cd_base.mp3');
  if (countdownFile) {
    await execPromise(
      `ffmpeg -y -stream_loop -1 -i "${countdownFile}" -t ${QTIME} -af "volume=0.75" -acodec libmp3lame "${cdBase}"`
    );
  } else {
    await silence(QTIME, cdBase);
  }

  // Layer SFX stings at HINT_AT and FIFTY_AT
  let cdFinal = cdBase;
  const stings = [];
  if (sfxFile) {
    stings.push({ file: sfxFile, delayMs: Math.round(HINT_AT  * 1000) });
    stings.push({ file: sfxFile, delayMs: Math.round(FIFTY_AT * 1000) });
  }
  if (stings.length > 0) {
    const stingMixed = path.join(workDir, 'cd_mixed.mp3');
    const ins  = [`-i "${cdBase}"`, ...stings.map(s => `-i "${s.file}"`)].join(' ');
    const dels = stings.map((s,i) => `[${i+1}:a]adelay=${s.delayMs}|${s.delayMs}[s${i}]`).join(';');
    const mix  = ['[0:a]', ...stings.map((_,i) => `[s${i}]`)].join('');
    await execPromise(
      `ffmpeg -y ${ins} -filter_complex "${dels};${mix}amix=inputs=${stings.length+1}:duration=first[a]" -map "[a]" -t ${QTIME} -acodec libmp3lame "${stingMixed}"`
    );
    cdFinal = stingMixed;
  }

  const qClipPath = path.join(workDir, 'clip_countdown.mp4');
  await execPromise(
    `ffmpeg -y -i "${rawVideo}" -i "${cdFinal}" -c:v libx264 -c:a aac -map 0:v:0 -map 1:a:0 -shortest "${qClipPath}"`
  );
  const qClipDur = await videoDur(qClipPath);
  // Countdown is its own music — mark as voice range to duck bg under it
  pushClip({ path: qClipPath, dur: qClipDur });

  // ════════════════════════════════════════════
  // STEP 9: timeup_text + timeup_audio_url (audio only, pre-reveal frame)
  // ════════════════════════════════════════════
  await page.goto(`file://${htmlPath}`, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 200));
  await showOnly('.pre-reveal-slide');
  await new Promise(r => setTimeout(r, 200));
  const preRevealImg = await shot('pre_reveal');

  const timeupAudio = await buildAudio({
    prerecorded:  timeupFile,
    fallbackText: quiz.timeup_text || "Time's up! Let's reveal the correct answer.",
    fallbackSec:  2, voice,
    leadGap: GAP_DEFAULT, workDir, name: 'timeup'
  });
  pushClip(await imgClip(preRevealImg, timeupAudio.path, timeupAudio.dur, workDir, 'clip_timeup'));

  // ════════════════════════════════════════════
  // STEP 10: 0.5s silence → correct answer revealed
  // correct_answer_sfx_audio_url + TTS correct answer text
  // ════════════════════════════════════════════
  await showOnly('.answer-slide');
  await new Promise(r => setTimeout(r, 300));
  const answerImg = await shot('answer');

  const step10Parts = [];
  const silReveal = path.join(workDir, 'sil_reveal.mp3');
  await silence(GAP_ANSWER, silReveal);
  step10Parts.push(silReveal);

  if (correctSfxFile) {
    step10Parts.push(correctSfxFile);
    const sfxGap3 = path.join(workDir, 'sfxgap3.mp3');
    await silence(0.2, sfxGap3);
    step10Parts.push(sfxGap3);
  }
  const correctTts = path.join(workDir, 'correct_tts.mp3');
  await tts(correct, voice, correctTts, 1.5);
  step10Parts.push(correctTts);

  const step10Combined = path.join(workDir, 'step10.mp3');
  await concatAudio(step10Parts, step10Combined, workDir);
  const step10Dur = Math.max(await audioDur(step10Combined), 2);
  pushClip(await imgClip(answerImg, step10Combined, step10Dur, workDir, 'clip_answer'));

  // ════════════════════════════════════════════
  // STEP 11: 0.5s silence → explanation (text + TTS, ≤20 words)
  // ════════════════════════════════════════════
  await showOnly('.explanation-slide');
  await new Promise(r => setTimeout(r, 400));
  const explImg = await shot('explanation');

  const explSil = path.join(workDir, 'expl_sil.mp3');
  const explTts = path.join(workDir, 'expl_tts.mp3');
  await silence(GAP_EXPL, explSil);
  await tts(explanation, voice, explTts, 3);
  const explCombined = path.join(workDir, 'expl.mp3');
  await concatAudio([explSil, explTts], explCombined, workDir);
  const explDur = Math.max(await audioDur(explCombined), 3);
  pushClip(await imgClip(explImg, explCombined, explDur, workDir, 'clip_expl'));

  // ════════════════════════════════════════════
  // STEP 12/13: CTA — CTA1 if affiliate_url present, else CTA2
  // ════════════════════════════════════════════
  const ctaSlide = hasCta1 ? '.cta1-slide' : '.cta2-slide';
  await showOnly(ctaSlide);
  await new Promise(r => setTimeout(r, 400));
  const ctaImg = await shot('cta');

  let ctaAudio;
  if (hasCta1) {
    ctaAudio = await buildAudio({
      prerecorded:  cta1AudioFile,
      fallbackText: quiz.affiliate_text || 'Check the link in description!',
      fallbackSec:  3, voice,
      leadGap: GAP_DEFAULT, workDir, name: 'cta1'
    });
  } else {
    ctaAudio = await buildAudio({
      prerecorded:  cta2AudioFile,
      fallbackText: quiz.cta2_text || 'Play real quiz and earn ONS tokens!',
      fallbackSec:  3, voice,
      leadGap: GAP_DEFAULT, workDir, name: 'cta2'
    });
  }
  pushClip(await imgClip(ctaImg, ctaAudio.path, ctaAudio.dur, workDir, 'clip_cta'));

  // ════════════════════════════════════════════
  // STEPS 14-18: MISSION IMPOSSIBLE flow
  // ════════════════════════════════════════════
  if (quiz.mission_impossible_enabled !== false && quiz.mission_impossible_question) {

    // ── STEP 14: Mission Impossible INTRO STING ──
    // mission-intro-slide: shows mission_intro_text with big animated label
    await showOnly('.mission-intro-slide');
    await new Promise(r => setTimeout(r, 400));
    const miIntroImg = await shot('mi_intro');

    const miIntroAudio = await buildAudio({
      prerecorded:  missionIntroFile,
      fallbackText: quiz.mission_intro_text || 'MISSION IMPOSSIBLE!',
      fallbackSec:  2, voice,
      leadGap: 0.3, workDir, name: 'mi_intro'
    });
    pushClip(await imgClip(miIntroImg, miIntroAudio.path, miIntroAudio.dur, workDir, 'clip_mi_intro'));

    // ── STEP 15: Mission question appears on screen ──
    // mission-final-slide, hint hidden, cta3 hidden
    await showOnly('.mission-final-slide');
    await page.evaluate(() => {
      document.getElementById('mi-hint').classList.remove('shown');
      document.getElementById('mi-cta3').classList.remove('shown');
    });
    await new Promise(r => setTimeout(r, 500));
    const miQImg = await shot('mi_question');

    // TTS reads the question — 1 second silence before hint appears
    const miQTts  = path.join(workDir, 'mi_q_tts.mp3');
    const miQSil  = path.join(workDir, 'mi_q_sil.mp3');
    await tts(quiz.mission_impossible_question, voice, miQTts, 2);
    await silence(1.0, miQSil);
    const miQAudio = path.join(workDir, 'mi_q_audio.mp3');
    await concatAudio([miQTts, miQSil], miQAudio, workDir);
    const miQDur = Math.max(await audioDur(miQAudio), 2);
    pushClip(await imgClip(miQImg, miQAudio, miQDur, workDir, 'clip_mi_q'));

    // ── STEP 16: Hint appears after 1s (SFX) ──
    await page.evaluate(() => {
      document.getElementById('mi-hint').classList.add('shown');
    });
    await new Promise(r => setTimeout(r, 400));
    const miHintImg = await shot('mi_hint');

    // SFX + silence (2.5s before CTA3)
    const miHintParts = [];
    if (sfxFile) { miHintParts.push(sfxFile); }
    const miHintSil = path.join(workDir, 'mi_hint_sil.mp3');
    await silence(2.5, miHintSil);
    miHintParts.push(miHintSil);
    const miHintAudio = path.join(workDir, 'mi_hint_audio.mp3');
    if (miHintParts.length > 1) {
      await concatAudio(miHintParts, miHintAudio, workDir);
    } else {
      await fs.copyFile(miHintParts[0], miHintAudio);
    }
    const miHintDur = await audioDur(miHintAudio);
    pushClip(await imgClip(miHintImg, miHintAudio, miHintDur, workDir, 'clip_mi_hint'), false);

    // ── STEP 17: CTA3 revealed 2.5s after hint ──
    await page.evaluate(() => {
      document.getElementById('mi-cta3').classList.add('shown');
    });
    await new Promise(r => setTimeout(r, 500));
    const cta3Img = await shot('cta3');

    const cta3Audio = await buildAudio({
      prerecorded:  cta3File,
      fallbackText: quiz.cta3_text || 'Like, share and challenge a friend! Subscribe!',
      fallbackSec:  4, voice,
      leadGap: 0.2, workDir, name: 'cta3'
    });
    pushClip(await imgClip(cta3Img, cta3Audio.path, cta3Audio.dur, workDir, 'clip_cta3'));

    // ── STEP 18: Hold all text 1s after CTA3 audio ends ──
    const holdSil = path.join(workDir, 'hold_sil.mp3');
    await silence(1.0, holdSil);
    pushClip(await imgClip(cta3Img, holdSil, 1.0, workDir, 'clip_hold'), false);
  }

  await browser.close();

  // ════════════════════════════════════════════
  // FINAL ASSEMBLY: concat → bg music ducking
  // ════════════════════════════════════════════
  const concatTxt = path.join(workDir, 'concat.txt');
  await fs.writeFile(concatTxt, clips.map(c => `file '${c.path}'`).join('\n'));

  const concatenated = path.join(workDir, 'concatenated.mp4');
  await execPromise(
    `ffmpeg -y -f concat -safe 0 -i "${concatTxt}" -c:v libx264 -c:a aac -movflags +faststart "${concatenated}"`
  );

  const total = await videoDur(concatenated);
  console.log(`[VIDEO] Concatenated: ${total.toFixed(2)}s | voice ranges: ${voiceRanges.length}`);

  const finalPath = await applyBgMusic(concatenated, total, voiceRanges, bgFile, workDir);
  return finalPath;
}

// ──────────────────────────────────────────────
// ENTRY POINT
// ──────────────────────────────────────────────
processJobs()
  .then(() => { console.log('[WORKER] Run complete.'); process.exit(0); })
  .catch(err => { console.error('[WORKER] Fatal:', err); process.exit(1); });
