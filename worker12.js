'use strict';

// ═══════════════════════════════════════════════════════════════
// WORKER 12 — Quiz Blog Generator (GitHub Actions)
//
// Reads quiz_queue rows that have a completed quiz (quiz_enriched=true)
// but no blog yet (no matching quiz_blog_posts row).
// Uses the Tavily research already stored in quiz_queue.payload
// plus the quiz questions from the quiz table.
// Calls DeepSeek V3 (config from quiz_generation_settings table,
// same as Worker 8) to generate a 1000-word blog post as HTML.
// Inserts into quiz_blog_posts table.
// After publishing, pings Bing IndexNow for instant indexing.
// ═══════════════════════════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL?.replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) { console.error('[FATAL] Missing Supabase env'); process.exit(1); }

// ─────────────────────────────────────────────
// SUPABASE HELPERS
// ─────────────────────────────────────────────
async function supabase(path, opts = {}) {
  const url    = `${SUPABASE_URL}/rest/v1/${path}`;
  const method = opts.method || 'GET';
  console.log(`[DB] ${method} ${url.split('?')[0]}`);
  const res = await fetch(url, {
    method,
    headers: {
      'apikey':        SUPABASE_KEY,
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        method === 'POST' ? 'return=representation' : 'return=minimal',
      ...(opts.headers || {}),
    },
    body: opts.body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${txt.slice(0, 300)}`);
  }
  const txt = await res.text();
  try { return txt ? JSON.parse(txt) : null; } catch { return txt; }
}

// ─────────────────────────────────────────────
// LOAD LLM CONFIG FROM quiz_generation_settings
// Exactly the same pattern as Worker 8
// ─────────────────────────────────────────────
async function loadLLMConfig() {
  const rows = await supabase('quiz_generation_settings?id=eq.1&limit=1');
  const config = rows?.[0];
  if (!config) throw new Error('quiz_generation_settings row not found — run quiz_generation_settings.sql first');

  const apiKey   = config.llm_api_key;
  const model    = config.llm_model;
  const endpoint = config.llm_api_endpoint || 'https://ai-gateway.vercel.sh/v1/chat/completions';

  if (!apiKey) throw new Error('llm_api_key is empty in quiz_generation_settings');
  if (!model)  throw new Error('llm_model is empty in quiz_generation_settings');

  console.log(`[W12] LLM config: model=${model} endpoint=${endpoint.split('/')[2]}`);
  return { apiKey, model, endpoint };
}

// ─────────────────────────────────────────────
// LLM CALL
// ─────────────────────────────────────────────
async function callLLM({ apiKey, model, endpoint }, systemPrompt, userPrompt) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      // Was 3500 — already tight for a 1000-word body + table_html + chart_data.
      // With FAQ now required to be 5-6 items (previously only ever 1, due to
      // the grouping bug), output length grows further. Raised with headroom
      // so JSON doesn't get truncated mid-object (which would fail parseBlogJSON).
      max_tokens:  6000,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`LLM call failed: ${res.status} — ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ─────────────────────────────────────────────
// SLUG GENERATOR
// ─────────────────────────────────────────────
function makeSlug(topic, quizNo) {
  const base = topic
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/-$/, '');
  return `${base}-${quizNo || Date.now()}`;
}

// ─────────────────────────────────────────────
// WORD COUNT (strips HTML tags)
// ─────────────────────────────────────────────
function countWords(html = '') {
  return (html || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
}

// ─────────────────────────────────────────────
// INDEXNOW — ping Bing after every blog publish
// ─────────────────────────────────────────────
async function pingIndexNow(urls) {
  if (!urls || urls.length === 0) return;
  const KEY = '6723e2112d2a4d87b629b37a8dfbfad7';
  try {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host:        'jaasblog.online',
        key:         KEY,
        keyLocation: `https://jaasblog.online/quiz/${KEY}.txt`,
        urlList:     urls,
      }),
    });
    if (res.status === 200) {
      console.log(`[W12] ✓ IndexNow pinged ${urls.length} URL(s) → Bing will index within 24h`);
    } else {
      console.warn(`[W12] IndexNow returned HTTP ${res.status} — URLs may not be submitted`);
    }
  } catch (e) {
    console.warn(`[W12] IndexNow ping failed (non-fatal): ${e.message}`);
  }
}

// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// SIMPLE HASH — picks layout mode from topic string
// ─────────────────────────────────────────────
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

// ─────────────────────────────────────────────
// LAYOUT MODE DEFINITIONS
// 5 structurally distinct blog formats
// ─────────────────────────────────────────────
const LAYOUT_MODES = {
  1: {
    name: 'news_report',
    tone: 'Write like a professional US news journalist — factual, direct, inverted-pyramid structure. Short punchy paragraphs (2-3 sentences each). First sentence of each section must grab attention with the most important fact.',
    wordTarget: 1150,
    section1Label: 'What Happened: The Full Story',
    section1Goal: '300-word blow-by-blow account of key events with specific names, dates, and places. Use the most important detail first, then context.',
    section2Label: 'By The Numbers: Key Statistics',
    section2Goal: '240-word data-rich breakdown. Open with the most surprising number. Use a bulleted list of at least 4 statistics from the research.',
    section3Label: 'Reaction and What Comes Next',
    section3Goal: '200-word forward-looking analysis. What are experts, fans, or officials saying? What happens next? Close with a concrete prediction.',
    introGoal: '180-word punchy news lede. Answer who/what/when/where in the first 2 sentences, then explain why it matters to US readers.',
    conclusionGoal: '100-word summary restating the 3 most important takeaways, then a call to action to play the quiz.',
  },
  2: {
    name: 'deep_dive',
    tone: 'Write like a senior analyst for The Atlantic or Vox — curious, thorough, willing to explain complexity. Use at least one analogy per section. Each paragraph must add new insight rather than restate the previous point.',
    wordTarget: 1200,
    section1Label: 'The Background: Why This Matters Now',
    section1Goal: '310-word historical context and root-cause analysis. Connect this event to a broader trend or pattern. Include at least one analogy that makes it relatable.',
    section2Label: 'Breaking It Down: What You Need to Know',
    section2Goal: '280-word granular breakdown using bold sub-headings (<strong>) for each sub-point. Cover at least 3 distinct angles from the research.',
    section3Label: 'The Bigger Picture: What This Means for Americans',
    section3Goal: '220-word impact analysis. Be specific about which groups of Americans are affected and exactly how — economic, social, or cultural consequences.',
    introGoal: '160-word thought-provoking hook. Open with a surprising fact or counter-intuitive question, then explain why this topic deserves more attention than it is getting.',
    conclusionGoal: '110-word synthesis that ties the three sections together and leaves the reader with one memorable insight.',
  },
  3: {
    name: 'feature_story',
    tone: 'Write like a feature writer for ESPN Magazine or Rolling Stone — vivid, scene-setting, human-centred. Open each section with a concrete scene or dramatic detail from the research before zooming out. Stay factual but make it feel alive.',
    wordTarget: 1150,
    section1Label: 'Setting the Scene',
    section1Goal: '290-word narrative scene-setter. Open with a specific moment, date, place, or dramatic detail from the research, then provide background context that explains how we got here.',
    section2Label: 'The Key Players and What Is at Stake',
    section2Goal: '260-word profile of the key people, teams, or organisations. What do they stand to gain or lose? Use 2-3 short character sketches (3-4 sentences each).',
    section3Label: 'The Next Chapter: What Happens Now',
    section3Goal: '210-word forward-looking narrative. What unresolved tension remains? What are the possible outcomes? End with an emotional or dramatic closing line.',
    introGoal: '190-word cinematic opening. Drop the reader directly into the story — a moment, a quote, a striking image — before widening the lens to explain why this is a trending story.',
    conclusionGoal: '100-word closing that brings the narrative full-circle and invites the reader to test their knowledge.',
  },
  4: {
    name: 'listicle_guide',
    tone: 'Write like a BuzzFeed senior editor meets Time magazine — punchy numbered insights, each with a bold headline and a paragraph of explanation. Every point must be distinct and surprising. No filler, no repetition.',
    wordTarget: 1100,
    section1Label: '5 Things You Need to Know About This Story',
    section1Goal: '290-word numbered list using <ol><li> tags. Each of the 5 items gets a bold sub-heading (<strong>) and 2-3 sentences of explanation. Only include facts from the research.',
    section2Label: 'The Numbers That Tell the Real Story',
    section2Goal: '230-word section with a bulleted list (<ul><li>) of the 4 most striking statistics, each with 2 sentences of explanation. Follow with a short paragraph synthesising what the numbers mean.',
    section3Label: '3 Reasons This Story Is Not Going Away',
    section3Goal: '210-word forward section structured as 3 numbered reasons (<ol><li>) with bold sub-headings. Each reason must be distinct — one predictive, one economic, one human-interest.',
    introGoal: '150-word hook that promises the reader something surprising. Start with the least-known fact about this story.',
    conclusionGoal: '90-word punchy close. Summarise in 3 bullet points then invite readers to take the quiz.',
  },
  5: {
    name: 'qa_authority',
    tone: 'Write like a knowledgeable friend who happens to be an expert — warm, conversational, backed by facts. Use second-person ("you") occasionally. Define any jargon immediately when it appears. No waffle, no padding.',
    wordTarget: 1150,
    section1Label: 'The Quick Answer: Here Is What Actually Happened',
    section1Goal: '260-word plain-English explanation as if answering a friend who just asked "wait, what is going on?" Define any technical terms, use one short analogy, and avoid jargon.',
    section2Label: 'What Most People Get Wrong About This',
    section2Goal: '275-word myth-busting section covering 2-3 common misconceptions or oversimplifications about this topic (based on the research), with clear corrections.',
    section3Label: 'What You Should Actually Care About',
    section3Goal: '210-word practical "so what?" section explaining why this story affects the reader personally — their money, health, entertainment, sport, or daily life depending on the niche.',
    introGoal: '165-word conversational opener. Start with the most common question people have about this topic, answer it immediately in one sentence, then explain why the full story is more interesting.',
    conclusionGoal: '100-word friendly close. Recap the 2-3 things the reader now knows that they did not before, and invite them to play the challenge.',
  },
};

// ─────────────────────────────────────────────
// BUILD BLOG PROMPT
// ─────────────────────────────────────────────
function buildPrompt(job, quizRows) {
  const topic    = job.trnding_topic || job.topic || 'Unknown topic';
  const niche    = job.niche || 'general';
  const payload  = job.payload || {};
  const research = (job.searched_text || '').slice(0, 4000);
  const sources  = (payload.tavily_sources || []).slice(0, 6);
  const images   = (payload.tavily_images  || []).slice(0, 5);

  // Pick layout deterministically from topic hash — same topic always gets same layout
  const layoutMode = (hashStr(topic) % 5) + 1;
  const layout = LAYOUT_MODES[layoutMode];
  console.log(`[W12] Layout mode: ${layoutMode} (${layout.name}) for topic="${topic}"`);

  // Build quiz Q&A from the quiz rows — ALL questions included
  const realQuizCount = Math.min(quizRows.length, 6);
  const quizQA = quizRows.slice(0, realQuizCount).map((q, i) => {
    const opts = (q.options_1 || []).map((o, j) => `${['A','B','C','D'][j]}) ${o}`).join(' | ');
    return `QUESTION_${i+1}:\nQ: ${q.question_1}\nOptions: ${opts}\nCorrect Answer: ${q.correct_answer_1}\nExplanation: ${q.explanation_1 || 'Correct based on research.'}`;
  }).join('\n\n');

  const MIN_FAQ = 5;
  const MAX_FAQ = 6;
  const targetFaqCount = Math.max(MIN_FAQ, Math.min(realQuizCount, MAX_FAQ));
  const extraFaqNeeded = Math.max(0, targetFaqCount - realQuizCount);

  const sourceList = sources.map(s => `- ${s.title || s.domain}: ${s.url}`).join('\n');
  const imageList  = images.map((img, i) => `Image ${i+1}: ${img.url} (${img.description || topic})`).join('\n');

  // Niche-specific tone booster
  const nicheTone = {
    sports:        'Focus on performance statistics, records, player/team storylines, fan impact, and competitive drama.',
    finance:       'Focus on market movements, investor implications, economic data, and concrete effects on everyday Americans\' finances.',
    tech:          'Focus on innovation impact, user adoption numbers, industry disruption, and what this means for consumers.',
    entertainment: 'Focus on the cultural/celebrity angle, audience reaction, box office or streaming numbers, and broader pop-culture significance.',
    health:        'Focus on health outcomes, medical evidence quality, what Americans should change in their behaviour, and credible expert guidance.',
    general:       'Focus on the human-interest angle and the specific reasons this story is resonating across all demographics in the US right now.',
  }[niche] || 'Focus on the aspects most relevant to a general US audience.';

  const systemPrompt = `You are an expert SEO content writer creating trending quiz companion blog posts for jaasblog.online.

WRITING STYLE FOR THIS POST: ${layout.tone}

NICHE FOCUS: ${nicheTone}

WORD COUNT TARGET: ${layout.wordTarget} words across all HTML text fields combined. This is a minimum, not a maximum — write thoroughly.

Every fact, statistic, name, and date must come from the RESEARCH DATA provided. Do not invent information.

Return ONLY valid JSON with no markdown fences, no preamble, no explanation outside the JSON object.`;


  const userPrompt = `Write a ${layout.wordTarget}-word SEO blog post about: "${topic}" (niche: ${niche})

RESEARCH DATA — use ONLY these facts, do not invent anything:
${research || 'Use general knowledge about this trending US topic.'}

QUIZ QUESTIONS — CRITICAL: You MUST include ALL ${realQuizCount} questions in the faq_html field. Every QUESTION_1 through QUESTION_${realQuizCount} must appear as a separate faq-item div. Do not combine, skip, or summarise any question.
${quizQA || 'No quiz data available.'}
${extraFaqNeeded > 0 ? `
FAQ TOP-UP — REQUIRED: After the ${realQuizCount} quiz-recap FAQ items, write ${extraFaqNeeded} additional general-knowledge FAQ items about "${topic}" (questions a curious reader would ask, answered from the research). Use the SAME faq-item HTML structure but WITHOUT the A/B/C/D options line. Continue the Q-numbering: Q${realQuizCount + 1} through Q${targetFaqCount}. Total faq-item divs must be exactly ${targetFaqCount}.` : `
Number every faq-item sequentially: Q1 through Q${targetFaqCount}. No item may be missing its "Q<N>: " prefix.`}

AVAILABLE IMAGES (reference by URL in suggested_inline_image_url):
${imageList || 'No images available.'}

DATA SOURCES (cite these):
${sourceList || 'General knowledge sources.'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LAYOUT MODE ${layoutMode}: ${layout.name.toUpperCase()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

introduction_html  → ${layout.introGoal}
section_1_heading  → Use exactly: "${layout.section1Label}"
section_1_html     → ${layout.section1Goal}
section_2_heading  → Use exactly: "${layout.section2Label}"
section_2_html     → ${layout.section2Goal}
section_3_heading  → Use exactly: "${layout.section3Label}"
section_3_html     → ${layout.section3Goal}
conclusion_html    → ${layout.conclusionGoal} Do NOT include links — a challenge link is appended automatically.

IMPORTANT WRITING RULES:
- Every section must be substantively different from the others — no repeating the same points in different words
- Use <strong> for emphasis on key terms and statistics
- Use <ul><li> or <ol><li> where the content is list-like (do not force lists where prose is more natural)
- introduction_html and all section_html fields must each be ≥ 120 words individually
- section_1_html must be the longest section
- Write for a reader who knows nothing about this topic beyond the headline

Return a JSON object with EXACTLY these fields:
{
  "title": "Compelling SEO title under 65 characters — unique angle not just the topic name",
  "meta_description": "SEO meta description 140-155 characters with primary keyword",
  "meta_keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "hero_image_alt": "Descriptive alt text for hero image",
  "suggested_inline_image_url": "URL from the image list above best matching the section_2 content, or empty string",
  "suggested_inline_image_alt": "Alt text for the inline image",
  "introduction_html": "<p>[${layout.introGoal}]</p>",
  "section_1_heading": "${layout.section1Label}",
  "section_1_html": "<p>[${layout.section1Goal}]</p>",
  "section_2_heading": "${layout.section2Label}",
  "section_2_html": "<p>[${layout.section2Goal}]</p>",
  "section_3_heading": "${layout.section3Label}",
  "section_3_html": "<p>[${layout.section3Goal}]</p>",
  "table_caption": "Key Statistics: ${topic}",
  "table_html": "<table><thead><tr><th>Fact</th><th>Detail</th></tr></thead><tbody><tr><td>...</td><td>...</td></tr></tbody></table>",
  "faq_html": "<div class='quiz-faq'><h3>Test Your Knowledge: ${topic}</h3>EXACTLY ${targetFaqCount} faq-item divs. Every item question text starts with 'Q<N>: '. Quiz-recap items (Q1-Q${realQuizCount}) include the options line. Top-up items (Q${realQuizCount+1}-Q${targetFaqCount}) do NOT include options. Format: <div class='faq-item'><p class='faq-question'><strong>Q1: [question]</strong><br>Options: A) [opt] | B) [opt] | C) [opt] | D) [opt]</p><p class='faq-answer'>✅ <strong>Answer:</strong> [correct]. [explanation]</p></div></div>",
  "conclusion_html": "<p>[${layout.conclusionGoal}]</p>",
  "chart_data": null
}

CHART_DATA RULES — fill chart_data if and only if the research contains real numeric data worth visualising:
- "bar"   → comparing discrete entities (scores, counts between teams/people)
- "line"  → change over time or ranked sequence (year-by-year, growth trend)
- "donut" → parts of a whole adding to ~100% (market share, possession %, vote %)
- "hbar"  → horizontal bar for long text labels (player names, country names)
- 2-6 data points. Every value MUST be a real number from the research — never null, never invented.
- Bar:   {"type":"bar",  "title":"Shots on Target",   "unit":"",     "data":[{"label":"Argentina","value":8},{"label":"Cape Verde","value":3}]}
- Line:  {"type":"line", "title":"Goals by Year",     "unit":"goals","data":[{"label":"2018","value":6},{"label":"2022","value":7}]}
- Donut: {"type":"donut","title":"Ball Possession",   "unit":"%",    "data":[{"label":"Argentina","value":62},{"label":"Cape Verde","value":38}]}
- Hbar:  {"type":"hbar", "title":"Top Goal Scorers",  "unit":"goals","data":[{"label":"Lionel Messi","value":7},{"label":"Harry Kane","value":4}]}
If no suitable real numbers exist in the research, output null.`;

  return { systemPrompt, userPrompt, layoutMode };
}

// ─────────────────────────────────────────────
// PARSE LLM RESPONSE
// ─────────────────────────────────────────────
function parseBlogJSON(raw) {
  let clean = raw.trim();
  clean = clean.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = clean.indexOf('{');
  const end   = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in LLM response');
  return JSON.parse(clean.slice(start, end + 1));
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function run() {
  console.log('[W12] Blog generator starting...');

  const llmConfig = await loadLLMConfig();

  const existingBlogQuizIds = await supabase(
    'quiz_blog_posts?select=quiz_id'
  ).then(rows => (rows || []).filter(r => r.quiz_id).map(r => r.quiz_id));
  console.log(`[W12] ${existingBlogQuizIds.length} quiz_ids already have blogs`);

  let quizFilter = 'quiz?quiz_enriched=eq.true&is_active=eq.true' +
    '&select=id,topic,topic_slug,niche,quiz_no,niche_challenge_no,' +
    'question_1,options_1,correct_answer_1,explanation_1,blog_slug,' +
    'created_at&order=created_at.asc';

  if (existingBlogQuizIds.length > 0) {
    quizFilter += `&id=not.in.(${existingBlogQuizIds.join(',')})`;
  }

  const pendingQuizzes = await supabase(quizFilter);

  if (!pendingQuizzes?.length) {
    console.log('[W12] No enriched quizzes found.');
    return;
  }
  console.log(`[W12] Found ${pendingQuizzes.length} quiz rows without blogs`);

  // Group by topic — one blog per unique topic.
  //
  // BUG FIX: this used to group by `q.topic_slug`, but Worker 8 gives every
  // question its own unique topic_slug (`${baseSlug}-q1`, `-q2`, `-q3`...).
  // That meant no two quiz rows ever shared a topic_slug, so `rows` stayed
  // empty for every topic and buildPrompt() only ever saw ONE question —
  // which is why faq_html only ever contained 1 Q&A instead of all of them.
  // Grouping by the raw `topic` string (shared by every question variant
  // for the same trending topic) fixes this.
  const topicMap = new Map();
  for (const q of pendingQuizzes) {
    if (!topicMap.has(q.topic)) topicMap.set(q.topic, { quiz: q, rows: [] });
    else topicMap.get(q.topic).rows.push(q);
  }

  if (!topicMap.size) {
    console.log('[W12] All quizzes already have blogs.');
    return;
  }

  // Cap at 5 per run to stay within GitHub Actions 20-min timeout
  // Remaining topics will be picked up in the next scheduled run
  const MAX_PER_RUN = 5;
  const topicsToProcess = [...topicMap.entries()].slice(0, MAX_PER_RUN);
  console.log(`[W12] ${topicMap.size} topics need blogs — processing ${topicsToProcess.length} this run`);

  let generated = 0;

  for (const [topicKey, { quiz: primaryQuiz, rows: extraRows }] of topicsToProcess) {
    // primaryQuiz was previously excluded from the Q&A set passed to the
    // LLM — only the (usually empty) `extraRows` array was used. Combine
    // them so ALL question variants for this topic are available.
    const allRows = [primaryQuiz, ...extraRows];
    console.log(`\n[W12] Generating blog for: "${primaryQuiz.topic}" (${allRows.length} quiz rows)`);

    try {
      const queueRows = await supabase(
        `quiz_queue?trnding_topic=ilike.${encodeURIComponent(primaryQuiz.topic)}` +
        `&select=id,trnding_topic,niche,searched_text,payload,topic_image_url&limit=1`
      );
      const job = queueRows?.[0];

      if (!job) {
        console.warn(`[W12] No quiz_queue row found for topic="${primaryQuiz.topic}" — using quiz data only`);
      } else {
        const words = (job.searched_text || '').split(/\s+/).filter(Boolean).length;
        const imgs  = (job.payload?.tavily_images || []).length;
        const srcs  = (job.payload?.tavily_sources || []).length;
        if (words < 400) console.warn(`[W12] ⚠️ Thin Tavily data: only ${words} words — blog quality may be lower.`);
        else console.log(`[W12] Tavily data: ${words} words, ${imgs} images, ${srcs} sources ✓`);
      }

      const fakeJob = job || {
        trnding_topic: primaryQuiz.topic,
        niche:         primaryQuiz.niche,
        searched_text: '',
        payload:       {}
      };
      const { systemPrompt, userPrompt, layoutMode } = buildPrompt(fakeJob, allRows);

      console.log('[W12] Calling DeepSeek via quiz_generation_settings config...');
      const rawResponse = await callLLM(llmConfig, systemPrompt, userPrompt);
      console.log(`[W12] LLM response: ${rawResponse.length} chars`);

      const blog = parseBlogJSON(rawResponse);

      const tavilyImages   = job?.payload?.tavily_images || [];

      // IMAGE PRIORITY CHAIN:
      // Hero    → Worker 10 generated 16:9 composite (best) → Wikipedia CC image → Tavily raw URL
      // Inline  → Worker 10 generated square/wide image (best) → Tavily raw [1] → Tavily raw [0]
      // Worker 10 saves dimension-sorted images to quiz.hero_image_url and quiz.inline_image_url.
      // These are used first so blog always gets the best available image.
      const heroImageUrl   = primaryQuiz.hero_image_url
                          || primaryQuiz.topic_image_url
                          || tavilyImages[0]?.url
                          || null;
      const heroImageAlt   = blog.hero_image_alt || primaryQuiz.topic;

      // Inline image: Worker 10 saves the best square/wide Tavily image to quiz.inline_image_url.
      // Fallback chain: quiz.inline_image_url → LLM suggestion → Tavily[1] → Tavily[0]
      const inlineImageUrl = primaryQuiz.inline_image_url
                          || blog.suggested_inline_image_url
                          || tavilyImages[1]?.url
                          || tavilyImages[0]?.url
                          || null;
      const inlineImageAlt = blog.suggested_inline_image_alt || primaryQuiz.topic;

      // Inline image caption — derived from Tavily image description if available
      // Used in the blog body below the inline image as a figure caption
      const inlineImageCaption = (() => {
        if (!inlineImageUrl) return null;
        // Find the matching Tavily image description
        const tavilyArr = Array.isArray(job?.payload?.tavily_images) ? job.payload.tavily_images : [];
        const matched = tavilyArr.find(img => {
          const url = typeof img === 'string' ? img : img?.url;
          return url && inlineImageUrl.includes(url.split('/').pop()?.slice(0,20) || '');
        });
        const desc = typeof matched === 'object' ? matched?.description : null;
        // Only use description if it's meaningful (>10 chars, not just a person name)
        return desc && desc.length > 10 ? desc : null;
      })();

      const totalWords = [
        blog.introduction_html, blog.section_1_html, blog.section_2_html,
        blog.section_3_html, blog.faq_html, blog.conclusion_html
      ].reduce((sum, h) => sum + countWords(h), 0);

      const blogSlug    = makeSlug(primaryQuiz.topic, primaryQuiz.quiz_no);
      const blogNiche   = primaryQuiz.niche || 'general';
      const blogCountry = (primaryQuiz.country_code || 'US').toLowerCase();

      // Fix 3: Inject correct CTA link into conclusion_html.
      // The LLM writes the conclusion paragraph text without a link.
      // Here — where blogSlug, niche, country are in scope — we append
      // the exact challenge URL so the reader lands on the quiz, not the niche listing.
      const challengeUrl = `https://jaasblog.online/quiz/${blogNiche}/${blogCountry}/${blogSlug}`;
      let conclusionHtml = blog.conclusion_html || null;
      if (conclusionHtml) {
        conclusionHtml = conclusionHtml.replace(/<a [^>]*href=['"][^'"]*jaasblog[^'"]*['"][^>]*>.*?<\/a>/gi, '').trim();
        conclusionHtml += `\n<p class="quiz-blog-cta-line">🎯 <a href="${challengeUrl}" class="quiz-blog-cta-link">▶ Play this challenge now on JaasX →</a></p>`;
      }

      const blogRow = {
        quiz_id:              primaryQuiz.id,
        quiz_queue_id:        job?.id || null,
        quiz_no:              primaryQuiz.quiz_no,
        niche:                primaryQuiz.niche || 'general',
        topic:                primaryQuiz.topic,
        slug:                 blogSlug,

        // SEO
        title:                (blog.title || primaryQuiz.topic).slice(0, 200),
        meta_description:     (blog.meta_description || '').slice(0, 160),
        meta_keywords:        blog.meta_keywords || [],

        // Images
        hero_image_url:       heroImageUrl,
        hero_image_alt:       heroImageAlt,
        inline_image_url:     inlineImageUrl,
        inline_image_alt:     inlineImageAlt,
        inline_image_caption: inlineImageCaption || null,

        // Content
        introduction_html:    blog.introduction_html    || null,
        section_1_heading:    blog.section_1_heading    || null,
        section_1_html:       blog.section_1_html       || null,
        section_2_heading:    blog.section_2_heading    || null,
        section_2_html:       blog.section_2_html       || null,
        section_3_heading:    blog.section_3_heading    || null,
        section_3_html:       blog.section_3_html       || null,
        // NOTE: no wrapper div added here. [slug].astro already wraps this
        // in <div class="quiz-blog-table-wrap"> (with full matching CSS in
        // global.css) — an earlier fix added a redundant <div class="jx-table-wrap">
        // around this before the actual frontend source had been reviewed.
        table_html:           blog.table_html           || null,
        table_caption:        blog.table_caption        || null,
        faq_html:             blog.faq_html             || null,
        conclusion_html:      conclusionHtml,
        // chart_data: raw JSONB object (bar or donut) or null — renderer handles null gracefully
        chart_data:           (blog.chart_data && typeof blog.chart_data === 'object' &&
                               blog.chart_data.type && Array.isArray(blog.chart_data.data) &&
                               blog.chart_data.data.length >= 2 &&
                               blog.chart_data.data.every(d => typeof d.value === 'number' && d.label))
                               ? blog.chart_data : null,

        // Sources and images — JSONB columns, no JSON.stringify needed
        data_sources:         job?.payload?.tavily_sources || [],
        all_images:           tavilyImages,

        // Metadata
        word_count:           totalWords,
        tavily_word_count:    (job?.searched_text || '').split(/\s+/).filter(Boolean).length,
        llm_model:            llmConfig.model,
        blog_layout_mode:     layoutMode,

        // Status — published immediately after insert (see promotion step below)
        status:               'published',
        is_published:         true,
        published_at:         new Date().toISOString(),

        created_at:           new Date().toISOString(),
        updated_at:           new Date().toISOString(),
      };

      // Insert into quiz_blog_posts
      const insertedRows = await supabase('quiz_blog_posts', {
        method:  'POST',
        headers: { 'Prefer': 'return=representation' },
        body:    JSON.stringify(blogRow),
      });
      const insertedBlog = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;
      const blogId = insertedBlog?.id;

      console.log(`[W12] ✓ Blog created: slug="${blogSlug}" words=${totalWords}`);
      console.log(`[W12] ✓ Title: "${blog.title}"`);

      // Promote from draft → published immediately.
      // Previously status was set to 'draft'/is_published=false here and
      // NOTHING ever promoted it — no Worker, no trigger, no cron.
      // All blog posts sat permanently in draft and never appeared on the site.
      if (blogId) {
        await supabase(`quiz_blog_posts?id=eq.${blogId}`, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            status:       'published',
            is_published: true,
            published_at: new Date().toISOString(),
            updated_at:   new Date().toISOString(),
          }),
        });
        console.log(`[W12] ✓ Blog promoted to published: id=${blogId}`);
      }

      // Mark blog_linked=true on all quiz rows for this topic so the
      // [slug].astro page can show a "read the blog" link and so we don't
      // generate duplicate blogs for the same topic on the next run.
      for (const qRow of allRows) {
        await supabase(`quiz?id=eq.${qRow.id}`, {
          method: 'PATCH',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({
            blog_linked:   true,
            blog_slug:     blogSlug,
            blog_page_url: `jaasblog.online/quiz/${blogRow.niche}/us/${blogSlug}`,
            updated_at:    new Date().toISOString(),
          }),
        }).catch(e => console.warn(`[W12] Could not set blog_linked on quiz ${qRow.id}: ${e.message}`));
      }
      console.log(`[W12] ✓ blog_linked=true set on ${allRows.length} quiz row(s)`);

      // ── Ping Bing IndexNow for instant indexing ──
      const blogUrl = `https://jaasblog.online/quiz/${blogNiche}/us/${blogSlug}`;
      await pingIndexNow([blogUrl]);

      generated++;

    } catch (err) {
      console.error(`[W12] FAILED for "${primaryQuiz.topic}": ${err.message}`);

      // Insert an error row so we know it was attempted
      try {
        const errSlug = makeSlug(primaryQuiz.topic, primaryQuiz.quiz_no);
        await supabase('quiz_blog_posts', {
          method:  'POST',
          headers: { 'Prefer': 'return=minimal' },
          body:    JSON.stringify({
            quiz_id:          primaryQuiz.id,
            quiz_no:          primaryQuiz.quiz_no,
            niche:            primaryQuiz.niche || 'general',
            topic:            primaryQuiz.topic,
            slug:             errSlug,
            title:            primaryQuiz.topic,
            generation_error: err.message.slice(0, 500),
            status:           'error',
            is_published:     false,
            created_at:       new Date().toISOString(),
            updated_at:       new Date().toISOString(),
          }),
        });
      } catch (e2) {
        console.warn(`[W12] Could not insert error row: ${e2.message}`);
      }
    }
  }

  console.log(`\n[W12] Done. Generated ${generated} blog post(s).`);
}

run()
  .then(() => process.exit(0))
  .catch(err => { console.error('[W12] Fatal:', err); process.exit(1); });
