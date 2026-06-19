'use strict';
const { exec }    = require('child_process');
const util        = require('util');
const execPromise = util.promisify(exec);
const fs          = require('fs').promises;
const path        = require('path');
const puppeteer   = require('puppeteer');
const { PuppeteerScreenRecorder } = require('puppeteer-screen-recorder');
const { v4: uuidv4 } = require('uuid');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
console.log('SUPABASE_URL:', supabaseUrl);
console.log('SUPABASE_SERVICE_KEY:', supabaseKey ? '*** (set)' : 'NOT SET');
const cleanUrl = supabaseUrl ? supabaseUrl.replace(/\/$/, '') : null;
if (!cleanUrl || !supabaseKey) { console.error('Missing Supabase credentials'); process.exit(1); }

// R2 thumbnail upload — optional; if not configured, thumbnail step is skipped
const R2_ACCOUNT_ID       = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID    = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY= process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME      = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL_BASE  = process.env.R2_PUBLIC_URL_BASE; // e.g. https://pub-xxxx.r2.dev
const R2_CONFIGURED = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_URL_BASE);
if (!R2_CONFIGURED) {
  console.warn('[R2] Thumbnail upload NOT configured — missing one of R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET_NAME/R2_PUBLIC_URL_BASE. Thumbnail will be skipped.');
}
const s3Client = R2_CONFIGURED ? new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY }
}) : null;

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────
const VOICE_MAP = {
  en: 'en-US-JennyNeural', hi: 'hi-IN-SwaraNeural',
  es: 'es-ES-ElviraNeural', pt: 'pt-BR-FranciscaNeural'
};
const THEMES_DIR        = path.join(__dirname, 'themes');
const CACHE_DIR         = path.join(__dirname, 'audio_cache');
const DEFAULT_THEME     = 'particle_field';
const LOGO_PATH         = path.join(__dirname, 'assets', 'jaasX-logo-saved-for-web.png');
const DEFAULT_BG_MUSIC  = 'https://pub-3578d297d3904e1d8ffedfc9dd4102f2.r2.dev/audio/background_music/The_Midnight_Audit.mp3';
const PLATFORM_URL_BASE = 'https://jaasblog.online/quiz';

const BG_VOL_BASE = 0.10;
const BG_VOL_DUCK = 0.035;
const DUCK_RAMP   = 0.12;

const GAP_DEFAULT     = 0.25;
const GAP_AFTER_STEP2 = 0.20;
const GAP_OPTIONS     = 0.45;
const GAP_ANSWER      = 0.35;
const DEFAULT_THINKING_TIME = 10;

const TIMEOUT_FFMPEG   = 120_000;
const TIMEOUT_CURL     = 35_000;
const TIMEOUT_TTS      = 40_000;
const TIMEOUT_RECORDER = 60_000;
const TIMEOUT_JOB      = 45 * 60 * 1000;

function withTimeout(p, ms, lbl) {
  return Promise.race([p, new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`TIMEOUT ${ms}ms: ${lbl}`)), ms))]);
}

// ─────────────────────────────────────────────
// SUPABASE
// ─────────────────────────────────────────────
const baseHeaders = {
  apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}`, 'Content-Type': 'application/json'
};
async function fetchSupabase(p, opts = {}) {
  const url = `${cleanUrl}/rest/v1/${p}`;
  console.log(`[DB] ${opts.method || 'GET'} ${url}`);
  const hdrs = { ...baseHeaders, ...(opts.headers || {}) };
  if (opts.method && ['POST','PATCH','PUT'].includes(opts.method)) hdrs.Prefer = 'return=representation';
  const res = await fetch(url, { ...opts, headers: hdrs });
  if (!res.ok) { const t = await res.text(); throw new Error(`HTTP ${res.status}: ${t}`); }
  const txt = await res.text();
  if (!txt || !txt.trim()) return null;
  return JSON.parse(txt);
}

// ─────────────────────────────────────────────
// AUDIO UTILS
// ─────────────────────────────────────────────
async function ensureDir(d) { await fs.mkdir(d, { recursive: true }); }
async function fileExists(p) { try { await fs.access(p); return true; } catch { return false; } }

function extractUrl(raw, preferKey) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (preferKey && obj[preferKey]) return obj[preferKey];
      for (const v of Object.values(obj)) if (typeof v === 'string' && v.startsWith('http')) return v;
      return null;
    } catch { return null; }
  }
  return s;
}

function encodeR2Url(url) {
  if (!url) return url;
  const si = url.indexOf('://'); if (si === -1) return url;
  const ps = url.indexOf('/', si + 3); if (ps === -1) return url;
  const origin = url.slice(0, ps);
  let out = '';
  for (let i = ps; i < url.length; i++) {
    const c = url[i];
    if (c === '%' && /^[0-9A-Fa-f]{2}$/.test(url.substr(i+1,2))) { out += url.substr(i,3); i+=2; }
    else if (/[A-Za-z0-9/?&=#.\-_~]/.test(c)) out += c;
    else out += encodeURIComponent(c);
  }
  return origin + out;
}

async function downloadAudio(url, cacheKey, preferKey) {
  const resolved = extractUrl(url, preferKey);
  if (!resolved) return null;
  await ensureDir(CACHE_DIR);
  const encoded = encodeR2Url(resolved);
  const safe    = cacheKey.replace(/[^a-zA-Z0-9_-]/g, '_');
  const local   = path.join(CACHE_DIR, `${safe}.mp3`);
  if (await fileExists(local)) { console.log(`[CACHE HIT] ${safe}`); return local; }
  console.log(`[DOWNLOAD] ${encoded}`);
  const rawFile = path.join(CACHE_DIR, `${safe}_raw`);
  try {
    await withTimeout(execPromise(`curl -sL --fail "${encoded}" -o "${rawFile}" --max-time 30`), TIMEOUT_CURL, `download ${safe}`);
    if (!(await fileExists(rawFile))) return null;
    const st = await fs.stat(rawFile);
    if (st.size === 0) { await fs.unlink(rawFile).catch(()=>{}); return null; }
    await withTimeout(execPromise(`ffmpeg -y -i "${rawFile}" -ar 44100 -ac 2 -acodec libmp3lame -q:a 4 "${local}"`), TIMEOUT_FFMPEG, `convert ${safe}`);
    await fs.unlink(rawFile).catch(()=>{});
    if (await fileExists(local)) return local;
  } catch (e) {
    console.warn(`[DOWNLOAD FAIL] ${safe}: ${e.message}`);
    await fs.unlink(rawFile).catch(()=>{});
    await fs.unlink(local).catch(()=>{});
  }
  return null;
}

async function audioDur(p) {
  try {
    const { stdout } = await withTimeout(
      execPromise(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${p}"`), 10_000, 'audioDur'
    );
    const d = parseFloat(stdout.trim()); return isNaN(d) ? 0 : d;
  } catch { return 0; }
}
async function videoDur(p) { return audioDur(p); }

async function silence(sec, out) {
  const s = Math.max(parseFloat(sec) || 0.1, 0.05);
  await withTimeout(execPromise(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=stereo -t ${s} -q:a 9 -acodec libmp3lame "${out}"`), 15_000, `silence ${s}s`);
}

async function tts(text, voice, out, fallbackSec = 1.5) {
  const t = (text || '').trim();
  if (!t) { await silence(fallbackSec, out); return; }
  const tmp = out + '.txt';
  await fs.writeFile(tmp, t, 'utf8');
  try {
    await withTimeout(execPromise(`edge-tts --voice "${voice}" --file "${tmp}" --write-media "${out}"`), TIMEOUT_TTS, 'tts');
    if (!(await fileExists(out)) || (await audioDur(out)) === 0) { console.warn('[TTS WARN] empty'); await silence(fallbackSec, out); }
  } catch (e) { console.warn(`[TTS WARN] ${e.message}`); await silence(fallbackSec, out); }
  await fs.unlink(tmp).catch(()=>{});
}

async function ffmpeg(args, label) { await withTimeout(execPromise(`ffmpeg ${args}`), TIMEOUT_FFMPEG, label || 'ffmpeg'); }

async function concatAudio(parts, out, workDir) {
  const vp = [];
  for (const p of parts) if (p && await fileExists(p)) vp.push(p);
  if (vp.length === 0) { await silence(0.5, out); return; }
  if (vp.length === 1) { await fs.copyFile(vp[0], out); return; }
  const listP = path.join(workDir, `cat_${uuidv4()}.txt`);
  await fs.writeFile(listP, vp.map(p=>`file '${p.replace(/\\/g,'/').replace(/'/g,"'\\''")}' `).join('\n'));
  await ffmpeg(`-y -f concat -safe 0 -i "${listP}" -ar 44100 -ac 2 -acodec libmp3lame "${out}"`, 'concatAudio');
  await fs.unlink(listP).catch(()=>{});
}

async function buildAudio({ prerecorded, fallbackText, fallbackSec, voice, leadGap, workDir, name }) {
  const silP  = path.join(workDir, `${name}_gap.mp3`);
  const audioP= path.join(workDir, `${name}_src.mp3`);
  const outP  = path.join(workDir, `${name}_audio.mp3`);
  const gap   = leadGap != null ? leadGap : GAP_DEFAULT;
  await silence(gap, silP);
  if (prerecorded && await fileExists(prerecorded)) { await concatAudio([silP, prerecorded], outP, workDir); }
  else { await tts(fallbackText || '', voice, audioP, fallbackSec || 1.5); await concatAudio([silP, audioP], outP, workDir); }
  return { path: outP, dur: await audioDur(outP) };
}

async function imgClip(img, audioP, dur, workDir, name) {
  const out = path.join(workDir, `${name}.mp4`);
  await ffmpeg(
    `-y -loop 1 -i "${img}" -i "${audioP}" -c:v libx264 -t ${dur} -pix_fmt yuv420p -r 30 ` +
    `-vf "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2" ` +
    `-c:a aac -b:a 128k -ar 44100 -shortest "${out}"`, `imgClip ${name}`
  );
  return { path: out, dur };
}

// ─────────────────────────────────────────────
// BG MUSIC DUCKING
// ─────────────────────────────────────────────
async function applyBgMusic(concatMp4, totalDur, voiceRanges, bgFile, workDir) {
  if (!bgFile || !(await fileExists(bgFile))) { console.log('[BGMUSIC] skip'); return concatMp4; }
  const bgLooped=path.join(workDir,'bg_looped.mp3'), bgDucked=path.join(workDir,'bg_ducked.mp3');
  const fgAudio=path.join(workDir,'fg_audio.mp3'), mixedAudio=path.join(workDir,'mixed_audio.mp3');
  const finalMp4=path.join(workDir,'final_with_music.mp4');
  await ffmpeg(`-y -stream_loop -1 -i "${bgFile}" -t ${totalDur} -af "volume=${BG_VOL_BASE}" -ar 44100 -acodec libmp3lame "${bgLooped}"`, 'bgLoop');
  if (voiceRanges.length > 0) {
    const ratio = (BG_VOL_DUCK/BG_VOL_BASE).toFixed(4);
    const filters = voiceRanges.map(r => {
      const s=Math.max(0,r.start-DUCK_RAMP).toFixed(3), e=(r.end+DUCK_RAMP).toFixed(3);
      return `volume=enable='between(t,${s},${e})':volume=${ratio}`;
    }).join(',');
    await ffmpeg(`-y -i "${bgLooped}" -af "${filters}" -ar 44100 -acodec libmp3lame "${bgDucked}"`, 'bgDuck');
  } else { await fs.copyFile(bgLooped, bgDucked); }
  await ffmpeg(`-y -i "${concatMp4}" -vn -ar 44100 -acodec libmp3lame "${fgAudio}"`, 'extractFg');
  await ffmpeg(`-y -i "${fgAudio}" -i "${bgDucked}" -filter_complex "[0:a]volume=1.0[fg];[1:a]volume=1.0[bg];[fg][bg]amix=inputs=2:duration=first:dropout_transition=0[a]" -map "[a]" -ar 44100 -acodec libmp3lame "${mixedAudio}"`, 'mixAudio');
  await ffmpeg(`-y -i "${concatMp4}" -i "${mixedAudio}" -c:v copy -map 0:v:0 -map 1:a:0 -c:a aac -b:a 192k -t ${totalDur} -movflags +faststart "${finalMp4}"`, 'remux');
  return finalMp4;
}

// ─────────────────────────────────────────────
// THEME + quiz_background_css
// ─────────────────────────────────────────────
async function resolveTheme(quiz) {
  const base    = await fs.readFile(path.join(THEMES_DIR,'_base.css'),'utf8');
  const themeId = quiz.visual_theme_id || DEFAULT_THEME;
  let themeFile = path.join(THEMES_DIR,`${themeId}.css`);
  if (!(await fileExists(themeFile))) { console.warn(`[THEME] '${themeId}' not found`); themeFile = path.join(THEMES_DIR,`${DEFAULT_THEME}.css`); }
  let css = base + '\n' + (await fs.readFile(themeFile,'utf8'));
  const a1=quiz.theme_accent_primary||'#00e0ff', a2=quiz.theme_accent_secondary||'#7b2ff7', a3=quiz.theme_accent_tertiary||'#ff2ec4';
  css = css.split('{{accent_primary}}').join(a1).split('{{accent_secondary}}').join(a2).split('{{accent_tertiary}}').join(a3);
  if (quiz.quiz_background_css?.trim()) {
    console.log('[THEME] Applying quiz_background_css');
    css += '\n/* === QUIZ-SPECIFIC BACKGROUND === */\n' + quiz.quiz_background_css;
  }
  return { themeCss: css, decoHtml: buildDecoHtml(themeId) };
}
function buildDecoHtml(id) {
  if (id === 'particle_field') {
    return '<div class="theme-deco">' + Array.from({length:18},(_,i)=>{
      const l=(i*5+2)%100,sz=6+(i%5)*3,d=8+(i%6)*2,dy=(i*0.7)%10;
      return `<div class="particle" style="left:${l}%;bottom:-20px;width:${sz}px;height:${sz}px;animation-duration:${d}s;animation-delay:${dy}s;"></div>`;
    }).join('') + '</div>';
  }
  return '';
}

async function getLogoDataUri() {
  try { const buf = await fs.readFile(LOGO_PATH); return `data:image/png;base64,${buf.toString('base64')}`; }
  catch (e) {
    console.warn(`[LOGO] ${e.message}`);
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  }
}

// ─────────────────────────────────────────────
// R2 THUMBNAIL UPLOAD
// ─────────────────────────────────────────────
async function uploadThumbnailToR2(localPngPath, quizId) {
  if (!R2_CONFIGURED) { console.log('[R2] Not configured, skipping thumbnail upload.'); return null; }
  try {
    const buf = await fs.readFile(localPngPath);
    const key = `thumbnails/${quizId}.png`;
    await withTimeout(
      s3Client.send(new PutObjectCommand({
        Bucket: R2_BUCKET_NAME, Key: key, Body: buf, ContentType: 'image/png',
        CacheControl: 'public, max-age=31536000'
      })),
      30_000, 'R2 thumbnail upload'
    );
    const publicUrl = `${R2_PUBLIC_URL_BASE.replace(/\/$/,'')}/${key}`;
    console.log(`[R2] Thumbnail uploaded: ${publicUrl}`);
    return publicUrl;
  } catch (e) {
    console.warn(`[R2] Thumbnail upload failed: ${e.message}`);
    return null;
  }
}

// ─────────────────────────────────────────────
// JOB PROCESSING
// ─────────────────────────────────────────────
async function processJobs() {
  console.log('[WORKER] Checking...');
  const stuckCutoff = new Date(Date.now()-30*60*1000).toISOString();
  const stuckRows = await fetchSupabase(`quiz?video_status=eq.processing&is_active=eq.true&updated_at=lt.${stuckCutoff}&select=id&limit=5`).catch(()=>null);
  if (stuckRows?.length) {
    console.log(`[WORKER] Resetting ${stuckRows.length} stuck rows`);
    for (const r of stuckRows) await fetchSupabase(`quiz?id=eq.${r.id}`,{method:'PATCH',body:JSON.stringify({video_status:'pending',updated_at:new Date().toISOString()})}).catch(()=>{});
  }

  const rows = await fetchSupabase('quiz?video_status=eq.pending&is_active=eq.true&quiz_enriched=eq.true&select=*&order=created_at.asc&limit=1');
  if (!rows?.length) { console.log('[WORKER] No pending quizzes.'); return; }

  const quiz = rows[0];
  console.log(`[WORKER] Processing: ${quiz.id} — ${quiz.topic}`);
  await fetchSupabase(`quiz?id=eq.${quiz.id}`,{method:'PATCH',body:JSON.stringify({video_status:'processing',updated_at:new Date().toISOString()})});

  const workDir = `/tmp/video_${uuidv4()}`;
  await ensureDir(workDir);

  try {
    const { videoPath, thumbnailUrl } = await withTimeout(buildVideo(quiz,workDir), TIMEOUT_JOB, `buildVideo ${quiz.id}`);
    const stats  = await fs.stat(videoPath);
    const sizeMb = parseFloat((stats.size/(1024*1024)).toFixed(2));
    const dur    = await videoDur(videoPath);
    console.log(`[WORKER] Done. ${dur.toFixed(1)}s, ${sizeMb}MB, thumbnail=${thumbnailUrl||'none'}`);

    const artifactPath = `/tmp/${quiz.id}_video.mp4`;
    await fs.copyFile(videoPath, artifactPath);
    await fs.writeFile('/tmp/artifact_ready', artifactPath);

    const patchBody = {
      video_status:'rendered', render_duration_sec:Math.round(dur), file_size_mb:sizeMb, updated_at:new Date().toISOString()
    };
    if (thumbnailUrl) patchBody.thumbnail_url = thumbnailUrl;
    await fetchSupabase(`quiz?id=eq.${quiz.id}`,{method:'PATCH',body:JSON.stringify(patchBody)});

    await fs.rm(workDir,{recursive:true,force:true});
    console.log(`[WORKER] Artifact: ${artifactPath}`);
  } catch (err) {
    console.error('[WORKER] FAILED:', err.message);
    await fetchSupabase(`quiz?id=eq.${quiz.id}`,{method:'PATCH',body:JSON.stringify({
      video_status:'error', generation_error:String(err.message||err).slice(0,800), updated_at:new Date().toISOString()
    })});
    await fs.rm(workDir,{recursive:true,force:true}).catch(()=>{});
    throw err;
  }
}

// ─────────────────────────────────────────────
// MAIN VIDEO BUILDER
// ─────────────────────────────────────────────
async function buildVideo(quiz, workDir) {
  const lang  = quiz.lang_code || 'en';
  const voice = VOICE_MAP[lang] || VOICE_MAP.en;
  const niche = quiz.niche || 'general';

  const question    = quiz.question_1       || '';
  const options     = quiz.options_1        || [];
  const correct     = quiz.correct_answer_1 || '';
  const hint        = quiz.hint_1           || '';
  const keep5050    = quiz.keep_5050_1      || [];
  const introSpeech = quiz.quiz_intro_speech|| '';

  // MI: skip entire segment if mission_impossible_question is null (requirement A)
  const miQuestion = quiz.mission_impossible_question || null;
  const miOptions  = quiz.mission_options_1           || [];
  const hasMI      = !!(miQuestion);

  const QTIME    = Math.min(quiz.thinking_time_sec || DEFAULT_THINKING_TIME, 12);
  const HINT_AT  = QTIME / 4;
  const FIFTY_AT = QTIME / 2;

  const allIdx  = [0,1,2,3];
  const keepIdx = keep5050.map(v=>(typeof v==='string'?parseInt(v):v));
  const elimIdx = allIdx.filter(i=>!keepIdx.includes(i));
  const optClass= i=>elimIdx.includes(i)?'eliminate':'';
  const revClass= i=>options[i]===correct?'correct':'wrong';
  const hasCta1 = !!(quiz.cta1_description_text?.trim() || quiz.affiliate_url?.trim());

  console.log('[LOGO] Loading...');
  const logoDataUri = await getLogoDataUri();

  console.log('[AUDIO] Downloading...');
  const [
    hookFile, questionIntroFile, optionsIntroFile,
    timeupFile, cta1AudioFile, cta2AudioFile,
    missionIntroFile, cta3AudioFile,
    sfxFile, countdownFile, bgFile, correctSfxFile
  ] = await Promise.all([
    downloadAudio(quiz.hook_audio_url,               `hook_${quiz.id}`),
    downloadAudio(quiz.question_intro_audio_url,     `qintro_${quiz.id}`),
    downloadAudio(quiz.options_intro_audio_url,      `ointro_${quiz.id}`),
    downloadAudio(quiz.timeup_audio_url,             `timeup_${quiz.id}`),
    downloadAudio(quiz.cta1_audio_url,               `cta1_${quiz.id}`),
    downloadAudio(quiz.cta2_audio_url,               `cta2_${quiz.id}`),
    downloadAudio(quiz.mission_intro_audio_url,      `missintro_${quiz.id}`),
    downloadAudio(quiz.cta3_audio_url,               `cta3_${quiz.id}`),
    downloadAudio(quiz.sfx_audio_url,                `sfx_${quiz.id}`,'question_appear'),
    downloadAudio(quiz.countdown_music,              `countdown_${quiz.id}`),
    downloadAudio(quiz.background_music||DEFAULT_BG_MUSIC,`bgmusic_${quiz.id}`),
    downloadAudio(quiz.correct_answer_sfx_audio_url, `correctsfx_${quiz.id}`)
  ]);

  const { themeCss, decoHtml } = await resolveTheme(quiz);

  let html = await fs.readFile(path.join(__dirname,'quiz_template.html'),'utf8');
  const R = {
    '{{theme_css}}':themeCss, '{{theme_deco_html}}':decoHtml, '{{LOGO_DATA_URI}}':logoDataUri,
    '{{hook_phrase}}':quiz.hook_phrase||'Stop scrolling! Can you beat this?',
    '{{quiz_intro_speech}}':introSpeech,
    '{{question}}':question,
    '{{options[0]}}':options[0]||'', '{{options[1]}}':options[1]||'',
    '{{options[2]}}':options[2]||'', '{{options[3]}}':options[3]||'',
    '{{opt0_class}}':optClass(0), '{{opt1_class}}':optClass(1),
    '{{opt2_class}}':optClass(2), '{{opt3_class}}':optClass(3),
    '{{rev0_class}}':revClass(0), '{{rev1_class}}':revClass(1),
    '{{rev2_class}}':revClass(2), '{{rev3_class}}':revClass(3),
    '{{hint}}':hint, '{{correct_answer}}':correct,
    '{{cta1_description_text}}':quiz.cta1_description_text||quiz.affiliate_text||'',
    '{{cta2_text}}':quiz.cta2_text||'Play real quiz and earn ONS tokens!',
    '{{cta3_text}}':quiz.cta3_text||'Like, Share & Challenge a friend! Subscribe!',
    '{{niche}}':niche,
    '{{platform_url}}': `${PLATFORM_URL_BASE}/${niche}`,
    '{{mission_intro_text}}':quiz.mission_intro_text||'Are you smart enough?',
    '{{mission_question}}':miQuestion||'',
    '{{mi_option_0}}':miOptions[0]||'', '{{mi_option_1}}':miOptions[1]||'',
    '{{mi_option_2}}':miOptions[2]||'', '{{mi_option_3}}':miOptions[3]||'',
    '{{qtime}}':QTIME, '{{hint_time}}':HINT_AT, '{{fiftyfifty_time}}':FIFTY_AT
  };
  for (const [k,v] of Object.entries(R)) html=html.split(k).join(String(v??''));
  const htmlPath = path.join(workDir,'index.html');
  await fs.writeFile(htmlPath,html);

  const browser = await puppeteer.launch({
    headless:'new',
    args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
          '--disable-gpu','--disable-web-security','--allow-file-access-from-files']
  });
  const page = await browser.newPage();
  await page.setViewport({width:1080,height:1920});
  await page.goto(`file://${htmlPath}`,{waitUntil:'domcontentloaded'});
  await new Promise(r=>setTimeout(r,600));

  const showOnly = async sel => {
    await page.evaluate(s=>{
      document.querySelectorAll('.screen').forEach(e=>e.classList.remove('active'));
      const el=document.querySelector(s); if(el) el.classList.add('active');
    },sel);
    await new Promise(r=>setTimeout(r,150));
  };
  const shot = async name => { const p=path.join(workDir,`${name}.png`); await page.screenshot({path:p}); return p; };

  const clips=[], voiceRanges=[];
  let cursor=0;
  function pushClip(clip, isVoice=true) {
    if(isVoice) voiceRanges.push({start:cursor,end:cursor+clip.dur});
    cursor+=clip.dur; clips.push(clip);
  }

  // ══ DEDICATED THUMBNAIL — captured first, before any other state changes ══
  // Original design combining hook + question + niche background (requirement B)
  await showOnly('.thumb-screen');
  await new Promise(r=>setTimeout(r,500)); // let any entrance animation settle
  const thumbImg = await shot('thumbnail_master');
  let thumbnailUrl = null;
  if (R2_CONFIGURED) {
    thumbnailUrl = await uploadThumbnailToR2(thumbImg, quiz.id);
  }

  // ══ STEP 1: HOOK ══
  await showOnly('.hook-slide');
  await page.evaluate(()=>{
    const lw = document.querySelector('.hook-slide .logo-wrap');
    if(lw){ lw.style.animation='none'; lw.style.opacity='1'; lw.style.transform='scale(1) rotate(0deg)'; }
    lw?.offsetHeight;
    if(lw){ lw.style.animation=''; lw.style.opacity=''; lw.style.transform=''; }
  });
  await new Promise(r=>setTimeout(r,1000));
  const hookImg = await shot('hook');
  const hookAudio = await buildAudio({
    prerecorded:hookFile, fallbackText:quiz.hook_phrase||'Stop scrolling!',
    fallbackSec:2.5, voice, leadGap:0.1, workDir, name:'hook'
  });
  pushClip(await imgClip(hookImg,hookAudio.path,Math.max(hookAudio.dur,2.5),workDir,'clip_hook'));

  // ══ STEP 2: Intro text flash (1.5s, no TTS) ══
  await showOnly('.waiting-slide');
  await new Promise(r=>setTimeout(r,300));
  const waitImg = await shot('waiting');
  const waitSil = path.join(workDir,'wait_sil.mp3'); await silence(1.5,waitSil);
  pushClip(await imgClip(waitImg,waitSil,1.5,workDir,'clip_wait'),false);

  // ══ STEP 3: Question appears ══
  await showOnly('.question-appear-slide');
  await new Promise(r=>setTimeout(r,700));
  const qAppearImg = await shot('question_appear');
  const step3Parts=[];
  if(questionIntroFile){ step3Parts.push(questionIntroFile); const g=path.join(workDir,'qi_gap.mp3'); await silence(0.2,g); step3Parts.push(g); }
  if(sfxFile){ const g=path.join(workDir,'sfx_gap.mp3'); await silence(0.1,g); step3Parts.push(sfxFile,g); }
  const qTts=path.join(workDir,'q_tts.mp3'); await tts(question,voice,qTts,3); step3Parts.push(qTts);
  const step3Combined=path.join(workDir,'step3.mp3');
  await concatAudio(step3Parts,step3Combined,workDir);
  pushClip(await imgClip(qAppearImg,step3Combined,Math.max(await audioDur(step3Combined),2),workDir,'clip_step3'));

  // ══ STEP 4-5: Options + "time starts now" ══
  await showOnly('.question-static');
  await new Promise(r=>setTimeout(r,900));
  const optionsImg = await shot('options_static');
  const s45p=[];
  const g4=path.join(workDir,'gap4.mp3'); await silence(GAP_OPTIONS,g4); s45p.push(g4);
  if(optionsIntroFile){ s45p.push(optionsIntroFile); }
  else { const oi=path.join(workDir,'ointro_tts.mp3'); await tts('And your options are',voice,oi,1.5); s45p.push(oi); }
  const g5=path.join(workDir,'gap5.mp3'); await silence(0.2,g5); s45p.push(g5);
  if(sfxFile){ const sg=path.join(workDir,'sfxgap2.mp3'); await silence(0.1,sg); s45p.push(sfxFile,sg); }
  for(let i=0;i<options.length;i++){
    if(!options[i]) continue;
    const os=path.join(workDir,`o_sil_${i}.mp3`); await silence(0.2,os);
    const ot=path.join(workDir,`o_tts_${i}.mp3`); await tts(`${String.fromCharCode(65+i)}. ${options[i]}`,voice,ot,1);
    s45p.push(os,ot);
  }
  const sng=path.join(workDir,'start_now_gap.mp3'); await silence(0.3,sng);
  const snt=path.join(workDir,'start_now.mp3');
  await tts(`You have only ${QTIME} seconds to crack the challenge — time starts now!`,voice,snt,2);
  s45p.push(sng,snt);
  const step45Combined=path.join(workDir,'step45.mp3');
  await concatAudio(s45p,step45Combined,workDir);
  pushClip(await imgClip(optionsImg,step45Combined,Math.max(await audioDur(step45Combined),3),workDir,'clip_step45'));

  // ══ STEP 6-8: COUNTDOWN ══
  await page.goto(`file://${htmlPath}`,{waitUntil:'domcontentloaded'});
  await new Promise(r=>setTimeout(r,400));
  await showOnly('.question-phase');
  await page.evaluate(()=>{ document.querySelector('.question-phase')?.offsetHeight; });
  await new Promise(r=>setTimeout(r,100));

  const rawVideo=path.join(workDir,'phase_raw.mp4');
  const recorder=new PuppeteerScreenRecorder(page,{fps:30,videoFrame:{width:1080,height:1920},aspectRatio:'9:16'});
  await recorder.start(rawVideo);
  await new Promise(r=>setTimeout(r,QTIME*1000));
  await withTimeout(recorder.stop(),TIMEOUT_RECORDER,'recorder.stop()');

  const cdBase=path.join(workDir,'cd_base.mp3');
  if(countdownFile){ await ffmpeg(`-y -stream_loop -1 -i "${countdownFile}" -t ${QTIME} -af "volume=0.75" -ar 44100 -acodec libmp3lame "${cdBase}"`, 'cdLoop'); }
  else { await silence(QTIME,cdBase); }
  let cdFinal=cdBase;
  if(sfxFile){
    const stingMixed=path.join(workDir,'cd_mixed.mp3');
    const hMs=Math.round(HINT_AT*1000), fMs=Math.round(FIFTY_AT*1000);
    await ffmpeg(`-y -i "${cdBase}" -i "${sfxFile}" -i "${sfxFile}" -filter_complex "[1:a]adelay=${hMs}|${hMs}[s0];[2:a]adelay=${fMs}|${fMs}[s1];[0:a][s0][s1]amix=inputs=3:duration=first[a]" -map "[a]" -t ${QTIME} -ar 44100 -acodec libmp3lame "${stingMixed}"`, 'cdStings');
    cdFinal=stingMixed;
  }
  const qClipRaw=path.join(workDir,'phase_h264.mp4'), qClipPath=path.join(workDir,'clip_countdown.mp4');
  await ffmpeg(`-y -i "${rawVideo}" -c:v libx264 -pix_fmt yuv420p -r 30 -vf "scale=1080:1920" "${qClipRaw}"`, 'reencodeRecording');
  await ffmpeg(`-y -i "${qClipRaw}" -i "${cdFinal}" -c:v libx264 -c:a aac -b:a 128k -ar 44100 -map 0:v:0 -map 1:a:0 -shortest -t ${QTIME} "${qClipPath}"`, 'countdownClip');
  pushClip({path:qClipPath,dur:await videoDur(qClipPath)});

  // ══ STEP 9: Timeup ══
  await page.goto(`file://${htmlPath}`,{waitUntil:'domcontentloaded'});
  await new Promise(r=>setTimeout(r,300));
  await showOnly('.pre-reveal-slide');
  const preRevealImg = await shot('pre_reveal');
  const timeupAudio = await buildAudio({
    prerecorded:timeupFile, fallbackText:quiz.timeup_text||"Time's up! Let's reveal the correct answer.",
    fallbackSec:2, voice, leadGap:GAP_DEFAULT, workDir, name:'timeup'
  });
  pushClip(await imgClip(preRevealImg,timeupAudio.path,timeupAudio.dur,workDir,'clip_timeup'));

  // ══ STEP 10: Answer reveal ══
  await showOnly('.answer-slide');
  await new Promise(r=>setTimeout(r,300));
  const answerImg = await shot('answer');
  const s10p=[];
  const silRev=path.join(workDir,'sil_reveal.mp3'); await silence(GAP_ANSWER,silRev); s10p.push(silRev);
  if(correctSfxFile){ s10p.push(correctSfxFile); const sg3=path.join(workDir,'sfxgap3.mp3'); await silence(0.15,sg3); s10p.push(sg3); }
  const correctTts=path.join(workDir,'correct_tts.mp3'); await tts(correct,voice,correctTts,1.5); s10p.push(correctTts);
  const step10Combined=path.join(workDir,'step10.mp3');
  await concatAudio(s10p,step10Combined,workDir);
  pushClip(await imgClip(answerImg,step10Combined,Math.max(await audioDur(step10Combined),2),workDir,'clip_answer'));

  // ══ STEP 11: CTA ══
  await showOnly(hasCta1?'.cta1-slide':'.cta2-slide');
  await new Promise(r=>setTimeout(r,400));
  const ctaImg = await shot('cta');
  const ctaAudio = await buildAudio({
    prerecorded:hasCta1?cta1AudioFile:cta2AudioFile,
    fallbackText:hasCta1
      ?(quiz.cta1_description_text||quiz.affiliate_text||'Check the link in description!')
      :(quiz.cta2_text||'Play real quiz and earn ONS tokens!'),
    fallbackSec:3, voice, leadGap:GAP_DEFAULT, workDir, name:hasCta1?'cta1':'cta2'
  });
  pushClip(await imgClip(ctaImg,ctaAudio.path,ctaAudio.dur,workDir,'clip_cta'));

  // ══ STEPS 12-17: MISSION IMPOSSIBLE (skip entirely if mission_impossible_question is null) ══
  if (hasMI) {
    // ── State A: MI intro (huge title + tagline, sfx then mission_intro_audio) ──
    await showOnly('.mission-intro-slide');
    await new Promise(r=>setTimeout(r,400));
    const miIntroImg = await shot('mi_intro');
    const miIntroParts=[];
    if(sfxFile){ const g=path.join(workDir,'sfx_mi_gap.mp3'); await silence(0.15,g); miIntroParts.push(g,sfxFile); const g2=path.join(workDir,'sfx_mi_gap2.mp3'); await silence(0.3,g2); miIntroParts.push(g2); }
    if(missionIntroFile){ miIntroParts.push(missionIntroFile); }
    else { const mt=path.join(workDir,'mi_tts.mp3'); await tts(quiz.mission_intro_text||'MISSION IMPOSSIBLE!',voice,mt,2); miIntroParts.push(mt); }
    const miIntroAudio=path.join(workDir,'mi_intro_audio.mp3');
    await concatAudio(miIntroParts,miIntroAudio,workDir);
    pushClip(await imgClip(miIntroImg,miIntroAudio,Math.max(await audioDur(miIntroAudio),2),workDir,'clip_mi_intro'));

    // ── State B: question + 4 options visible (no TTS), cta3 hidden — checklist items 4,5 ──
    await showOnly('.mission-final-slide');
    await page.evaluate(()=>{
      const c=document.getElementById('mi-cta3');
      if(c){ c.classList.remove('show-cta3'); c.style.opacity='0'; c.style.transform='translateY(30px) scale(0.9)'; }
    });
    await new Promise(r=>setTimeout(r,600)); // let option fly-in animations finish
    const miQImg = await shot('mi_question_with_options');
    const miQSil=path.join(workDir,'mi_q_sil.mp3'); await silence(2.5,miQSil); // checklist item 6: 2.5s before cta3
    pushClip(await imgClip(miQImg,miQSil,2.5,workDir,'clip_mi_q'),false);

    // ── State C: cta3_text fades in + cta3 audio — checklist items 6,7 ──
    await page.evaluate(()=>{
      const c=document.getElementById('mi-cta3');
      if(c){ c.classList.add('show-cta3'); c.style.opacity=''; c.style.transform=''; }
    });
    await new Promise(r=>setTimeout(r,400));
    const cta3Img = await shot('mi_with_cta3');
    const cta3Audio = await buildAudio({
      prerecorded:cta3AudioFile, fallbackText:quiz.cta3_text||'Like, share and challenge a friend! Subscribe!',
      fallbackSec:4, voice, leadGap:0.15, workDir, name:'cta3'
    });
    pushClip(await imgClip(cta3Img,cta3Audio.path,cta3Audio.dur,workDir,'clip_cta3'));

    // ── State D: 1s frozen hold — checklist item 11 ──
    const holdSil=path.join(workDir,'hold_sil.mp3'); await silence(1.0,holdSil);
    pushClip(await imgClip(cta3Img,holdSil,1.0,workDir,'clip_hold'),false);
  }

  await browser.close();

  // ══ FINAL ASSEMBLY ══
  console.log(`[VIDEO] Assembling ${clips.length} clips...`);
  const concatTxt=path.join(workDir,'concat.txt');
  await fs.writeFile(concatTxt,clips.map(c=>`file '${c.path.replace(/'/g,"'\\''")}' `).join('\n'));
  const concatenated=path.join(workDir,'concatenated.mp4');
  await ffmpeg(`-y -f concat -safe 0 -i "${concatTxt}" -c:v libx264 -pix_fmt yuv420p -r 30 -c:a aac -b:a 128k -ar 44100 -movflags +faststart "${concatenated}"`, 'finalConcat');
  const total=await videoDur(concatenated);
  console.log(`[VIDEO] Concatenated: ${total.toFixed(1)}s`);
  const finalVideoPath = await applyBgMusic(concatenated,total,voiceRanges,bgFile,workDir);
  return { videoPath: finalVideoPath, thumbnailUrl };
}

processJobs()
  .then(()=>{ console.log('[WORKER] Done.'); process.exit(0); })
  .catch(err=>{ console.error('[WORKER] Fatal:',err); process.exit(1); });
