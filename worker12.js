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
// BUILD BLOG PROMPT
// ─────────────────────────────────────────────
function buildPrompt(job, quizRows) {
  const topic    = job.trnding_topic || job.topic || 'Unknown topic';
  const niche    = job.niche || 'general';
  const payload  = job.payload || {};
  const research = (job.searched_text || '').slice(0, 4000);
  const sources  = (payload.tavily_sources || []).slice(0, 6);
  const images   = (payload.tavily_images  || []).slice(0, 5);

  // Build quiz Q&A from the quiz rows — ALL questions included
  const realQuizCount = Math.min(quizRows.length, 6);
  const quizQA = quizRows.slice(0, realQuizCount).map((q, i) => {
    const opts = (q.options_1 || []).map((o, j) => `${['A','B','C','D'][j]}) ${o}`).join(' | ');
    return `QUESTION_${i+1}:\nQ: ${q.question_1}\nOptions: ${opts}\nCorrect Answer: ${q.correct_answer_1}\nExplanation: ${q.explanation_1 || 'Correct based on research.'}`;
  }).join('\n\n');

  // Requirement: every blog needs 5-6 FAQ items total. Real quiz questions
  // (with their exact options/answer) are used first; if the topic has
  // fewer than 5 question variants, the LLM fills the remainder with
  // general knowledge FAQs about the topic so the total always lands at 5-6.
  const MIN_FAQ = 5;
  const MAX_FAQ = 6;
  const targetFaqCount = Math.max(MIN_FAQ, Math.min(realQuizCount, MAX_FAQ));
  const extraFaqNeeded = Math.max(0, targetFaqCount - realQuizCount);

  const sourceList = sources.map(s => `- ${s.title || s.domain}: ${s.url}`).join('\n');
  const imageList  = images.map((img, i) => `Image ${i+1}: ${img.url} (${img.description || topic})`).join('\n');

  const systemPrompt = `You are an expert SEO content writer creating trending quiz companion blog posts for jaasblog.online. 
Write engaging, factual, well-structured HTML blog posts about trending US topics.
Always write in clear US English. Be factual, engaging, and cite the research provided.
Return ONLY valid JSON — no markdown fences, no preamble, no explanation outside the JSON.`;

  const userPrompt = `Write a 1000-word SEO blog post about: "${topic}" (niche: ${niche})

RESEARCH DATA (use this as your factual foundation — do not invent facts not supported here):
${research || 'Use general knowledge about this trending US topic.'}

QUIZ QUESTIONS — CRITICAL: You MUST include ALL ${realQuizCount} questions in the faq_html field. Every single QUESTION_1 through QUESTION_${realQuizCount} must appear as a separate faq-item div. Do not combine, skip, or summarize any question.
${quizQA || 'No quiz data available.'}
${extraFaqNeeded > 0 ? `
FAQ TOP-UP — REQUIRED: This topic only has ${realQuizCount} quiz question(s), but every blog post needs ${MIN_FAQ}-${MAX_FAQ} FAQ items total. After the ${realQuizCount} quiz-recap FAQ item(s) above, you MUST write ${extraFaqNeeded} additional general-knowledge FAQ item(s) about "${topic}" (real questions a curious reader would ask, answered factually from the research data). Use the SAME faq-item HTML structure (question + answer), just without the A/B/C/D options line since these aren't quiz questions. Total faq-item divs in faq_html must be exactly ${targetFaqCount}.` : ''}

AVAILABLE IMAGES (reference by URL in suggested_inline_image):
${imageList || 'No images available.'}

DATA SOURCES (cite these at bottom):
${sourceList || 'General knowledge sources.'}

Return a JSON object with EXACTLY these fields (all HTML values use proper HTML tags — <p>, <strong>, <ul>, <li>, <h3>, <table>, <tr>, <th>, <td> etc.):
{
  "title": "Compelling SEO title under 65 characters",
  "meta_description": "SEO meta description under 155 characters",
  "meta_keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "hero_image_alt": "Alt text for hero image describing the topic",
  "suggested_inline_image_url": "URL of best image from the list above for inline use, or empty string",
  "suggested_inline_image_alt": "Alt text for the inline image",
  "introduction_html": "<p>150-word engaging introduction that hooks the reader and explains why this topic is trending...</p>",
  "section_1_heading": "Background: [descriptive heading about history/context]",
  "section_1_html": "<p>250 words of background and context about ${topic}...</p>",
  "section_2_heading": "Key Facts: [descriptive heading about main facts]",
  "section_2_html": "<p>250 words covering the most important facts, statistics, and details...</p><ul><li>Key fact 1</li><li>Key fact 2</li></ul>",
  "section_3_heading": "Impact and Significance: [descriptive heading]",
  "section_3_html": "<p>200 words about why this matters to US audiences and what happens next...</p>",
  "table_caption": "Key Statistics: ${topic}",
  "table_html": "<table><thead><tr><th>Fact</th><th>Detail</th></tr></thead><tbody><tr><td>...</td><td>...</td></tr><!-- 5-6 rows of real data from the research --></tbody></table>",
  "faq_html": "<div class='quiz-faq'><h3>Test Your Knowledge: ${topic}</h3>IMPORTANT: Output EXACTLY ${targetFaqCount} faq-item divs total — ${realQuizCount} quiz-recap item(s) first, then ${extraFaqNeeded} general-knowledge item(s). Do NOT skip any. Format like this:\n<div class='faq-item'><p class='faq-question'><strong>Q1: [exact question text from QUESTION_1]</strong><br>Options: A) [opt] | B) [opt] | C) [opt] | D) [opt]</p><p class='faq-answer'>✅ <strong>Answer:</strong> [correct answer]. [explanation text]</p></div><!-- one such div per real quiz question --><div class='faq-item'><p class='faq-question'><strong>[General FAQ question about the topic]</strong></p><p class='faq-answer'>[Factual answer from research]</p></div><!-- one such div per top-up FAQ, no options line --></div>",
  "conclusion_html": "<p>100-word conclusion summarising key points and encouraging the reader to play the interactive quiz.</p><p>🎯 <a href='https://jaasblog.online/quiz/${niche}'>Play the full ${niche} challenge on JaasX →</a></p>",
  "chart_data": null
}

CHART_DATA RULES (very important — read carefully before filling chart_data):
- Look at the research data for the MOST visually interesting numeric comparison (scores, stats, counts, percentages).
- If you find suitable numbers: output a chart object. If no real numbers exist in the research, output null.
- Use "bar" type for raw counts/stats (scores, goals, points, years, quantities between entities).
- Use "donut" type for percentages or proportions that add up to ~100.
- 2 to 6 data points maximum. Every value MUST be a real number — never a string, never null.
- Title must describe what is charted in under 6 words.
- ONLY use numbers from the research — never invent values.
- Bar chart example: {"type":"bar","title":"Shots on Target","unit":"","data":[{"label":"Team A","value":6},{"label":"Team B","value":4}]}
- Donut chart example: {"type":"donut","title":"Ball Possession","unit":"%","data":[{"label":"Team A","value":58},{"label":"Team B","value":42}]}`;

  return { systemPrompt, userPrompt };
}

// ─────────────────────────────────────────────
// PARSE LLM RESPONSE
// ─────────────────────────────────────────────
function parseBlogJSON(raw) {
  // Strip markdown fences if present
  let clean = raw.trim();
  clean = clean.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  // Find first { to last }
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

  // Load LLM config from quiz_generation_settings (same table as Worker 8)
  const llmConfig = await loadLLMConfig();

  // Get ALL quiz rows that have NO blog yet — Supabase filters server-side.
  // No limit needed — only rows genuinely missing a blog are returned.
  // Strategy: get all quiz_ids that already have a blog, then fetch quiz rows NOT in that set.
  const existingBlogQuizIds = await supabase(
    'quiz_blog_posts?select=quiz_id'
  ).then(rows => (rows || []).filter(r => r.quiz_id).map(r => r.quiz_id));
  console.log(`[W12] ${existingBlogQuizIds.length} quiz_ids already have blogs`);

  // Build NOT IN filter — if no blogs exist yet, fetch all enriched quizzes
  let quizFilter = 'quiz?quiz_enriched=eq.true&is_active=eq.true' +
    '&select=id,topic,topic_slug,niche,quiz_no,niche_challenge_no,' +
    'question_1,options_1,correct_answer_1,explanation_1,blog_slug,' +
    'created_at&order=created_at.asc';

  if (existingBlogQuizIds.length > 0) {
    // PostgREST NOT IN filter: id=not.in.(uuid1,uuid2,...)
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
      // Find the matching quiz_queue job for this topic to get Tavily data
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
        if (words < 400) console.warn(`[W12] ⚠️ Thin Tavily data: only ${words} words — blog quality may be lower. Newer queue rows should have 1500+ words.`);
        else console.log(`[W12] Tavily data: ${words} words, ${imgs} images, ${srcs} sources ✓`);
      }

      // Build prompt using job (Tavily data) + all quiz rows for this topic
      const fakeJob = job || {
        trnding_topic: primaryQuiz.topic,
        niche:         primaryQuiz.niche,
        searched_text: '',
        payload:       {}
      };
      const { systemPrompt, userPrompt } = buildPrompt(fakeJob, allRows);

      // Call DeepSeek
      console.log('[W12] Calling DeepSeek via quiz_generation_settings config...');
      const rawResponse = await callLLM(llmConfig, systemPrompt, userPrompt);
      console.log(`[W12] LLM response: ${rawResponse.length} chars`);

      // Parse response
      const blog = parseBlogJSON(rawResponse);

      // Pick best hero image
      const tavilyImages   = job?.payload?.tavily_images || [];
      const heroImageUrl   = tavilyImages[0]?.url || primaryQuiz.topic_image_url || null;
      const heroImageAlt   = blog.hero_image_alt || primaryQuiz.topic;
      const inlineImageUrl = blog.suggested_inline_image_url || tavilyImages[1]?.url || null;
      const inlineImageAlt = blog.suggested_inline_image_alt || primaryQuiz.topic;

      // Calculate total word count
      const totalWords = [
        blog.introduction_html, blog.section_1_html, blog.section_2_html,
        blog.section_3_html, blog.faq_html, blog.conclusion_html
      ].reduce((sum, h) => sum + countWords(h), 0);

      const blogSlug = makeSlug(primaryQuiz.topic, primaryQuiz.quiz_no);

      // Build the row to insert
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

        // Content
        introduction_html:    blog.introduction_html    || null,
        section_1_heading:    blog.section_1_heading    || null,
        section_1_html:       blog.section_1_html       || null,
        section_2_heading:    blog.section_2_heading    || null,
        section_2_html:       blog.section_2_html       || null,
        section_3_heading:    blog.section_3_heading    || null,
        section_3_html:       blog.section_3_html       || null,
        // Wrapped so the frontend has a stable, scoped hook to style against
        // (`.jx-table-wrap table`) — LLM-generated <table> markup has no
        // classes of its own, so unstyled it renders as a bare, unreadable
        // browser-default table. See jx-table.css for the matching styles.
        table_html:           blog.table_html ? `<div class="jx-table-wrap">${blog.table_html}</div>` : null,
        table_caption:        blog.table_caption        || null,
        faq_html:             blog.faq_html             || null,
        conclusion_html:      blog.conclusion_html      || null,
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

        // Status — draft until manually published
        status:               'draft',
        is_published:         false,

        created_at:           new Date().toISOString(),
        updated_at:           new Date().toISOString(),
      };

      // Insert into quiz_blog_posts
      await supabase('quiz_blog_posts', {
        method:  'POST',
        headers: { 'Prefer': 'return=minimal' },
        body:    JSON.stringify(blogRow),
      });

      console.log(`[W12] ✓ Blog created: slug="${blogSlug}" words=${totalWords}`);
      console.log(`[W12] ✓ Title: "${blog.title}"`);
      generated++;

    } catch (err) {
      console.error(`[W12] FAILED for "${primaryQuiz.topic}": ${err.message}`);

      // Insert a draft row with error so we know it was attempted
      try {
        const errSlug = makeSlug(primaryQuiz.topic, primaryQuiz.quiz_no);
        if (!existingSlugs.has(errSlug)) {
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
        }
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
