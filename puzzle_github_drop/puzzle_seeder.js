/**
 * puzzle_seeder.js — Cloudflare Worker (PUZZLE PIPELINE)
 *
 * ROLE: the puzzle equivalent of fetch_trends.py. There is NO external trend
 * source for puzzles — the seeder simply decides which puzzle TYPE to produce
 * next and drops a job into puzzle_queue. The generator (puzzle_generator.js)
 * then turns each job into a full puzzle row.
 *
 * ROTATION: types are chosen weighted by puzzle_type_config.weight, breaking
 * ties by lowest usage_count / oldest last_seeded_at, so every active type
 * gets fair airtime and higher-performing types (higher weight) appear more.
 *
 * TRIGGERS:
 *   • scheduled (cron)          — seeds SEED_BATCH jobs each run
 *   • POST /seed                — manual trigger (optional ?count=N)
 *   • POST /seed?type=matchstick — force a specific type
 *   • GET  /health
 *
 * ISOLATION: only touches puzzle_type_config and puzzle_queue. The trending
 * pipeline never reads these tables.
 *
 * ENV: SUPABASE_URL, SUPABASE_SERVICE_KEY, [GENERATOR_URL] (optional — if set,
 *      the seeder pings the generator after seeding so it runs immediately).
 */

const SEED_BATCH_DEFAULT = 2;   // jobs seeded per cron run

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }
    if (request.method === 'POST' && url.pathname === '/seed') {
      const count = Math.max(1, Math.min(10, Number(url.searchParams.get('count')) || SEED_BATCH_DEFAULT));
      const forceType = url.searchParams.get('type') || null;
      const created = await seed(env, count, forceType);
      return new Response(JSON.stringify({ ok: true, created }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(seed(env, SEED_BATCH_DEFAULT, null));
  }
};

// ════════════════════════════════════════════════════════════════════════════
async function seed(env, count, forceType) {
  console.log(`[SEED] Seeding ${count} puzzle job(s)${forceType ? ` (forced type=${forceType})` : ''}`);

  // Load active types (weighted rotation candidates)
  const types = await dbGet(env,
    `puzzle_type_config?is_active=eq.true&select=*&order=usage_count.asc,last_seeded_at.asc.nullsfirst`
  ).catch(() => null);

  if (!types?.length) {
    console.warn('[SEED] No active puzzle types in puzzle_type_config — nothing to seed.');
    return [];
  }

  const createdSlugs = [];
  for (let i = 0; i < count; i++) {
    const chosen = forceType
      ? types.find(t => t.puzzle_type === forceType)
      : weightedPick(types);
    if (!chosen) { console.warn(`[SEED] type "${forceType}" not found/active`); break; }

    const row = {
      job_type:     'puzzle_generation',
      status:       'pending',
      priority:     5,
      puzzle_type:  chosen.puzzle_type,
      category:     chosen.category || 'math',
      difficulty:   chosen.difficulty || 'medium',
      lang_code:    'en',
      country_code: 'US',
      channel_name: 'JaasX Brain Challenge',
      seed_hint:    chosen.notes || null,
      payload:      { seeded_by: 'puzzle_seeder', display_name: chosen.display_name },
      created_at:   new Date().toISOString(),
    };

    try {
      const ins = await dbInsert(env, 'puzzle_queue', row);
      const id = ins?.[0]?.id || '(unknown)';
      createdSlugs.push({ id, puzzle_type: chosen.puzzle_type });
      console.log(`[SEED] Queued ${chosen.puzzle_type} → job ${id}`);

      // Bump rotation counters so the same type isn't picked repeatedly
      await dbPatch(env, 'puzzle_type_config', chosen.id, {
        usage_count:    (chosen.usage_count || 0) + 1,
        last_seeded_at: new Date().toISOString(),
      }).catch(() => {});
      chosen.usage_count = (chosen.usage_count || 0) + 1; // reflect locally for next pick
    } catch (e) {
      console.error(`[SEED] insert failed for ${chosen.puzzle_type}: ${e.message}`);
    }
  }

  // Optional: kick the generator immediately (so we don't wait for its cron)
  if (env.GENERATOR_URL && createdSlugs.length) {
    try {
      await fetch(env.GENERATOR_URL.replace(/\/$/, '') + '/generate-puzzle', { method: 'POST' });
      console.log('[SEED] Pinged generator.');
    } catch (e) { console.warn(`[SEED] generator ping failed: ${e.message}`); }
  }

  console.log(`[SEED] Done — ${createdSlugs.length} job(s) created.`);
  return createdSlugs;
}

// Weighted random pick, biased toward lower usage_count (fresher types) so
// higher weight AND fair rotation both apply.
function weightedPick(types) {
  // effective weight = configured weight, boosted for least-recently-used
  const maxUse = Math.max(1, ...types.map(t => t.usage_count || 0));
  const scored = types.map(t => {
    const freshness = 1 + (maxUse - (t.usage_count || 0)) / maxUse; // 1..2
    return { t, w: Math.max(0.01, (t.weight || 1) * freshness) };
  });
  const total = scored.reduce((s, x) => s + x.w, 0);
  let r = Math.random() * total;
  for (const x of scored) { r -= x.w; if (r <= 0) return x.t; }
  return scored[0].t;
}

// ── Supabase REST (same pattern as worker8) ─────────────────────────────────
function sbHeaders(env) {
  return {
    apikey:        env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type':'application/json'
  };
}
async function dbGet(env, path) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${path}`, { headers: sbHeaders(env) });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt.trim() ? JSON.parse(txt) : [];
}
async function dbInsert(env, table, data) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}`, {
    method: 'POST', headers: { ...sbHeaders(env), Prefer: 'return=representation' }, body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`INSERT ${table} → ${res.status}: ${await res.text()}`);
  const txt = await res.text();
  return txt.trim() ? JSON.parse(txt) : null;
}
async function dbPatch(env, table, id, data) {
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH', headers: { ...sbHeaders(env), Prefer: 'return=minimal' }, body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error(`PATCH ${table}/${id} → ${res.status}: ${await res.text()}`);
}
