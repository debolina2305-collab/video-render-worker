#!/usr/bin/env python3
"""
fetch_trends.py — Multi-source trending topic fetcher
Modes: trends | rss | fallback | all
Requirements: pip install trendspyg feedparser requests tavily-python
Secrets: SUPABASE_URL, SUPABASE_SERVICE_KEY, TAVILY_API_KEY
"""

import os, re, sys, time, json, logging, argparse
from datetime import datetime, timezone
from urllib.parse import quote

import requests
import feedparser
from tavily import TavilyClient

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('fetch_trends')

SUPABASE_URL         = os.environ['SUPABASE_URL'].rstrip('/')
SUPABASE_SERVICE_KEY = os.environ['SUPABASE_SERVICE_KEY']
TAVILY_API_KEY       = os.environ['TAVILY_API_KEY']
tavily               = TavilyClient(api_key=TAVILY_API_KEY)

# NOTE: These trendspyg values are now FALLBACK DEFAULTS only. The live
# settings come from the trend_config table (per-channel) via load_trend_config().
# Edit settings in Supabase trend_config, not here.
TRENDSPYG_MIN_VOLUME = 20000  # fallback min search volume if trend_config missing
TRENDSPYG_DELAY_SEC  = 2.0    # pause between trendspyg network calls
TRENDSPYG_HOURS      = 4      # fallback time window if trend_config missing
TRENDSPYG_MAX_PROCESS = 25    # fallback process cap if trend_config missing
TAVILY_MIN_RESULTS   = 2
TAVILY_MIN_WORDS     = 200    # default; overridden per-channel by trend_config.min_grounding_words
TAVILY_DELAY_SEC     = 1.5
RSS_MAX_PER_FEED     = 15

# ── Trendspyg keyword blocklist ───────────────────────────────────────────────
# Filter out generic/unquizable trending keywords before calling Tavily.
# These waste Tavily credits and produce useless quiz topics.
TRENDSPYG_REJECT_KEYWORDS = [
    'breaking news', 'news today', 'live update', 'latest news',
    'weather today', 'weather forecast', 'horoscope', 'wordle',
    'nyt connections', 'nfl scores', 'nba scores', 'mlb scores',
]
TRENDSPYG_REJECT_MIN_WORDS = 1   # single word keywords are usually too vague

def is_quizable_trend(keyword):
    """Pre-filter trendspyg keywords before calling Tavily."""
    k = keyword.lower().strip()
    if len(k.split()) <= TRENDSPYG_REJECT_MIN_WORDS:
        return False, f'too_short({len(k.split())}w)'
    for bad in TRENDSPYG_REJECT_KEYWORDS:
        if bad in k:
            return False, f'blocklisted("{bad}")'
    return True, 'ok'

# ── Niche classifier ──────────────────────────────────────────────────────────
NICHE_KEYWORDS = {
    'finance':       ['stock','market','nasdaq','dow jones','s&p','ipo','earnings',
                      'revenue','profit','loss','bank','federal reserve','interest rate',
                      'inflation','gdp','economy','economic','crypto','bitcoin','ethereum',
                      'btc','blockchain','dollar','currency','forex','wall street','nyse',
                      'sensex','nifty','rbi','rupee','real estate','housing','mortgage',
                      'tax','budget','deficit','bond','recession','tariff','trade war'],
    'tech':          ['ai ','artificial intelligence','machine learning','chatgpt','openai',
                      'google','apple','microsoft','meta','amazon','nvidia','tesla','spacex',
                      'startup','iphone','android','cyber','hack','data breach','chip',
                      'semiconductor','cloud','robot','automation','drone','electric vehicle'],
    'health':        ['health','hospital','doctor','medicine','drug','fda','vaccine','virus',
                      'covid','cancer','heart disease','treatment','therapy','mental health',
                      'obesity','diabetes','clinical trial','pharma','who ','pandemic',
                      'outbreak','infection','surgery','ebola','hantavirus','mosquito'],
    'sports':        ['nfl','nba','mlb','nhl','ufc','boxing','super bowl','world series',
                      'playoffs','ipl','bcci','cricket','test match','t20','world cup',
                      'football','soccer','fifa','premier league','champions league','tennis',
                      'wimbledon','golf','pga','olympics','formula 1','f1',' vs ','score ',
                      'championship','tournament','transfer','spurs','lakers','celtics'],
    'politics':      ['president','congress','senate','democrat','republican','white house',
                      'election','vote','policy','supreme court','modi','bjp','parliament',
                      'lok sabha','cabinet','minister','government','war','ukraine','russia',
                      'china','taiwan','sanctions','nato','bill signed','executive order',
                      'trump','biden','vance','iran','nuclear'],
    'entertainment': ['movie','film','box office','oscar','emmy','grammy','netflix','disney',
                      'hbo','streaming','bollywood','hollywood','actor','actress','singer',
                      'album','concert','tour','celebrity','taylor swift','beyonce'],
}

def classify_niche(topic):
    t = topic.lower()
    for niche, kws in NICHE_KEYWORDS.items():
        if any(k in t for k in kws):
            return niche
    return 'general'

# ── Google News RSS feeds ─────────────────────────────────────────────────────
# FIX: Using stable named topic paths that 302-redirect to current hash URLs.
# feedparser follows 302 redirects automatically.
# Previous hash-encoded URLs for finance/tech/sports/politics/entertainment
# were stale and returned 0 entries. Named paths are stable long-term.
GOOGLE_NEWS_RSS = {
    'US': {
        'general':       'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',
        'finance':       'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en',
        'tech':          'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en',
        'health':        'https://news.google.com/rss/headlines/section/topic/HEALTH?hl=en-US&gl=US&ceid=US:en',
        'sports':        'https://news.google.com/rss/headlines/section/topic/SPORTS?hl=en-US&gl=US&ceid=US:en',
        'politics':      'https://news.google.com/rss/headlines/section/topic/POLITICS?hl=en-US&gl=US&ceid=US:en',
        'entertainment': 'https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=en-US&gl=US&ceid=US:en',
    },
    'IN': {
        'general':       'https://news.google.com/rss?hl=hi-IN&gl=IN&ceid=IN:hi',
        'finance':       'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=hi-IN&gl=IN&ceid=IN:hi',
        'tech':          'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=hi-IN&gl=IN&ceid=IN:hi',
        'health':        'https://news.google.com/rss/headlines/section/topic/HEALTH?hl=hi-IN&gl=IN&ceid=IN:hi',
        'sports':        'https://news.google.com/rss/headlines/section/topic/SPORTS?hl=hi-IN&gl=IN&ceid=IN:hi',
        'politics':      'https://news.google.com/rss/headlines/section/topic/POLITICS?hl=hi-IN&gl=IN&ceid=IN:hi',
        'entertainment': 'https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=hi-IN&gl=IN&ceid=IN:hi',
        'cricket':       'https://news.google.com/rss/search?q=cricket+india&hl=hi-IN&gl=IN&ceid=IN:hi',
    },
}

# ── Supabase helpers ──────────────────────────────────────────────────────────
def sb_headers():
    return {'apikey': SUPABASE_SERVICE_KEY,
            'Authorization': f'Bearer {SUPABASE_SERVICE_KEY}',
            'Content-Type': 'application/json'}

def db_get(path):
    r = requests.get(f'{SUPABASE_URL}/rest/v1/{path}', headers=sb_headers(), timeout=15)
    r.raise_for_status()
    return r.json() or []

def db_insert(table, data):
    r = requests.post(f'{SUPABASE_URL}/rest/v1/{table}',
                      headers={**sb_headers(), 'Prefer': 'return=minimal'},
                      json=data, timeout=15)
    r.raise_for_status()
    return True

def count_todays_topics(country_code):
    """Count topics already inserted today for this channel using
    Supabase's count=exact header — returns integer directly, no row fetch."""
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    count_headers = {**sb_headers(), 'Prefer': 'count=exact', 'Range-Unit': 'items', 'Range': '0-0'}
    try:
        # With country_code filter (works after channel_setup.sql)
        r = requests.get(
            f'{SUPABASE_URL}/rest/v1/quiz_queue'
            f'?country_code=eq.{country_code}'
            f'&created_at=gte.{today}T00:00:00%2B00:00'
            f'&status=neq.completed'
            f'&select=id',
            headers=count_headers, timeout=15
        )
        if r.status_code in (200, 206):
            content_range = r.headers.get('Content-Range', '')
            # Content-Range: 0-0/42  — the number after / is the total count
            if '/' in content_range:
                total = int(content_range.split('/')[-1])
                log.info(f'  count_todays_topics({country_code}): {total} via Content-Range')
                return total
        # Fallback: count the returned rows
        rows = r.json() or []
        return len(rows)
    except Exception as e:
        log.debug(f'count_todays_topics fallback: {e}')
        return 0

def already_queued(topic, country_code):
    today = datetime.now(timezone.utc).strftime('%Y-%m-%dT00:00:00+00:00')
    safe  = quote(topic[:80].replace("'", "''"))
    try:
        rows = db_get(
            f'quiz_queue?trnding_topic=ilike.%25{safe}%25'
            f'&country_code=eq.{country_code}'
            f'&status=neq.completed'
            f'&created_at=gte.{today}&limit=1&select=id'
        )
        return len(rows) > 0
    except Exception:
        try:
            rows = db_get(
                f'quiz_queue?trnding_topic=ilike.%25{safe}%25'
                f'&status=neq.completed'
                f'&created_at=gte.{today}&limit=1&select=id'
            )
            return len(rows) > 0
        except Exception as e:
            log.debug(f'Dedup check failed (non-fatal): {e}')
            return False

# ── Tavily quality filter ─────────────────────────────────────────────────────
def tavily_search(topic, country_code):
    try:
        country_name = {'US': 'United States', 'IN': 'India'}.get(country_code, country_code)
        result = tavily.search(
            query        = f'{topic} {country_name}',
            search_depth = 'basic',
            max_results  = 8,
        )
        return result
    except Exception as e:
        log.warning(f'Tavily search failed for "{topic[:60]}": {e}')
        return None

def quality_check(topic, tavily_data, min_words=TAVILY_MIN_WORDS):
    if not tavily_data or not tavily_data.get('results'):
        return False, 'no_results', ''
    results    = tavily_data['results']
    if len(results) < TAVILY_MIN_RESULTS:
        return False, f'too_few_results({len(results)})', ''
    combined   = ' '.join((r.get('content') or r.get('snippet') or '') for r in results).strip()
    word_count = len(combined.split())
    if word_count < min_words:
        return False, f'thin({word_count}w<{min_words}w)', ''
    domains = set()
    for r in results:
        m = re.search(r'https?://(?:www\.)?([^/]+)', r.get('url',''))
        if m: domains.add(m.group(1))
    if len(domains) <= 1:
        return False, 'single_domain', ''
    words = topic.strip().split()
    if len(words) <= 2:
        is_name = all(w[0].isupper() for w in words if w) and not any(c.isdigit() for c in topic)
        if is_name and results[0].get('score', 1.0) < 0.4:
            return False, 'unknown_entity', ''
    return True, 'ok', combined

def trim(text, max_words=200):
    w = text.split()
    return ' '.join(w[:max_words]) if len(w) > max_words else text

def volume_to_priority(volume):
    """
    Map real search volume to a quiz_queue priority score.
    Higher volume = higher priority = Worker 8 processes it first = video
    published while the trend is still hot.

    Buckets (after ×1000 normalisation from CSV):
      ≥ 1,000,000  → 100  (mega-viral, publish immediately)
      ≥   500,000  →  80
      ≥   200,000  →  60
      ≥   100,000  →  40
      ≥    50,000  →  30
      ≥    20,000  →  20  (our min_volume threshold)
      anything lower → 10  (still above RSS=5 and fallback=1)

    RSS topics keep priority=5, fallback=1 — always below trendspyg topics.
    """
    if   volume >= 1_000_000: return 100
    elif volume >=   500_000: return 80
    elif volume >=   200_000: return 60
    elif volume >=   100_000: return 40
    elif volume >=    50_000: return 30
    elif volume >=    20_000: return 20
    else:                     return 10

# ── Insert into quiz_queue ────────────────────────────────────────────────────
def insert_topic(topic, niche, grounding, channel, source, priority, volume=0, breakdown=''):
    # Parse breakdown into a clean list of keywords
    # CSV format is typically comma-separated: "lilo and stitch, daveigh chase death, ..."
    breakdown_list = [k.strip() for k in breakdown.split(',') if k.strip()] if breakdown else []

    try:
        db_insert('quiz_queue', {
            'job_type':          'quiz_generation',
            'status':            'pending',
            'priority':          priority,
            'trnding_topic':     topic[:255],
            'niche':             niche,
            'searched_text':     grounding,
            'lang_code':         channel.get('lang_code', 'en'),
            'country_code':      channel.get('country_code', 'US'),
            'channel_name':      channel.get('channel_name', 'USA Trending Challenge'),
            'topic_source':      source,
            'payload': {
                'source':           source,
                'channel':          channel.get('channel_name'),
                'fetched_at':       datetime.now(timezone.utc).isoformat(),
                'priority':         priority,
                'search_volume':    volume,
                # Trend breakdown keywords — use for YouTube tags, blog SEO,
                # video description, quiz prompt context in Worker 8
                'trend_breakdown':  breakdown_list,
                'trend_breakdown_raw': breakdown,
            },
            'created_at': datetime.now(timezone.utc).isoformat(),
        })
        return True
    except Exception as e:
        log.warning(f'Full insert failed, trying minimal: {e}')
        try:
            db_insert('quiz_queue', {
                'job_type':      'quiz_generation',
                'status':        'pending',
                'trnding_topic': topic[:255],
                'niche':         niche,
                'searched_text': grounding,
                'created_at':    datetime.now(timezone.utc).isoformat(),
            })
            log.warning('Minimal insert succeeded — run channel_setup.sql for full functionality')
            return True
        except Exception as e2:
            log.error(f'Insert failed: {e2}')
            return False

# ── Process one topic ─────────────────────────────────────────────────────────
def process_topic(topic, channel, source, priority, niche_hint=None,
                  min_words=TAVILY_MIN_WORDS, volume=0, breakdown=''):
    topic = topic.strip()
    if not topic or len(topic) < 5:
        return False
    country = channel.get('country_code', 'US')
    if already_queued(topic, country):
        log.info(f'  SKIP (dup): {topic[:70]}')
        return False
    time.sleep(TAVILY_DELAY_SEC)
    data = tavily_search(topic, country)
    passes, reason, grounding = quality_check(topic, data, min_words)
    if not passes:
        log.info(f'  REJECT [{reason}]: {topic[:70]}')
        return False
    niche = niche_hint or classify_niche(topic)
    ok = insert_topic(topic, niche, trim(grounding, max_words=max(min_words+50, 250)),
                      channel, source, priority, volume=volume, breakdown=breakdown)
    if ok:
        bd_note = f' bd={len(breakdown.split(","))}kw' if breakdown else ''
        log.info(f'  ✓ INSERTED [src={source} p={priority} vol={volume:,} niche={niche}{bd_note}]: {topic[:70]}')
    return ok

# ── Mode 1: trendspyg ─────────────────────────────────────────────────────────
def _parse_volume(val):
    """Normalize a trendspyg volume value to an int.
    CSV path may return strings like '200K+', '1M+', '5,000+' or ints."""
    if val is None:
        return 0
    if isinstance(val, (int, float)):
        return int(val)
    s = str(val).strip().upper().replace('+', '').replace(',', '').replace('"', '')
    try:
        if s.endswith('M'):
            return int(float(s[:-1]) * 1_000_000)
        if s.endswith('K'):
            return int(float(s[:-1]) * 1_000)
        return int(float(s))
    except (ValueError, TypeError):
        return 0

def _fetch_trends_csv(country, hours):
    """
    CSV path — returns 480+ trends with REAL volume buckets (incl 200K+, 1M+).
    Uses Python's built-in csv module — NO pandas needed.
    trendspyg downloads the file; we read it ourselves.
    Returns list of dicts: [{'keyword':..., 'volume':int}, ...] sorted desc.
    """
    import csv, glob, os, tempfile
    from trendspyg import download_google_trends_csv

    # Ask trendspyg to download the CSV. We use output_format='csv' (not
    # 'dataframe') to avoid the pandas dependency entirely. The function
    # returns the file path where it saved the CSV.
    result = download_google_trends_csv(
        geo=country,
        hours=hours,
        category='all',
        output_format='csv'     # returns file path string, no pandas needed
    )

    # result may be a file path string or a dict with 'path' key
    if isinstance(result, str):
        csv_path = result
    elif isinstance(result, dict):
        csv_path = result.get('path') or result.get('file') or result.get('filename')
    else:
        raise ValueError(f'Unexpected return type from download_google_trends_csv: {type(result)}')

    if not csv_path or not os.path.exists(csv_path):
        # Try to find the most recently downloaded CSV in downloads/
        candidates = sorted(glob.glob('downloads/trends_*.csv'), key=os.path.getmtime, reverse=True)
        if candidates:
            csv_path = candidates[0]
            log.info(f'  Using most recently downloaded CSV: {csv_path}')
        else:
            raise FileNotFoundError(f'CSV file not found; result was: {result}')

    rows = []
    with open(csv_path, newline='', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f)
        col_names = reader.fieldnames or []
        col_lower  = {c.lower().strip(): c for c in col_names}

        # Find keyword and volume columns flexibly
        kw_col  = next((col_lower[c] for c in col_lower
                        if any(x in c for x in ('trend','keyword','query','title','topic'))),
                       col_names[0] if col_names else None)
        vol_col = next((col_lower[c] for c in col_lower
                        if any(x in c for x in ('volume','traffic','search','approx'))),
                       None)
        # Trend breakdown column — related search queries (gold for SEO/tags)
        breakdown_col = next((col_lower[c] for c in col_lower
                              if any(x in c for x in ('breakdown','related','queries'))),
                             None)

        log.info(f'  CSV columns: {col_names}')
        log.info(f'  Using keyword col="{kw_col}", volume col="{vol_col}", breakdown col="{breakdown_col}"')

        for row in reader:
            kw        = row.get(kw_col, '').strip() if kw_col else ''
            vol       = _parse_volume(row.get(vol_col, 0)) if vol_col else 0
            breakdown = row.get(breakdown_col, '').strip() if breakdown_col else ''
            if kw:
                rows.append({'keyword': kw, 'volume': vol, 'breakdown': breakdown})

    rows.sort(key=lambda r: r['volume'], reverse=True)

    # trendspyg CSV "Search volume" values are in THOUSANDS (200 = 200,000 searches,
    # 2000 = 2,000,000 searches). Multiply by 1000 so they match the actual search
    # counts shown on the Google Trends web UI AND so trend_config.min_volume
    # (e.g. 20000 = "only accept topics with 20K+ real searches") works correctly.
    for r in rows:
        r['volume'] = r['volume'] * 1000

    log.info(f'  CSV parsed: {len(rows)} trends')
    return rows

def load_trend_config(country_code):
    """Load per-channel trend settings from trend_config table.
    Returns a dict with safe defaults if no row exists or table is missing."""
    defaults = {
        'max_topics_per_run':  20,
        'time_window_hours':   4,
        'min_volume':          20000,
        'min_grounding_words': 200,
        'max_process_per_run': 80,
    }
    try:
        rows = db_get(f'trend_config?country_code=eq.{country_code}&is_active=eq.true&limit=1')
        if rows:
            cfg = rows[0]
            return {
                'max_topics_per_run':  cfg.get('max_topics_per_run')  or defaults['max_topics_per_run'],
                'time_window_hours':   cfg.get('time_window_hours')   or defaults['time_window_hours'],
                'min_volume':          cfg.get('min_volume')          or defaults['min_volume'],
                'min_grounding_words': cfg.get('min_grounding_words') or defaults['min_grounding_words'],
                'max_process_per_run': cfg.get('max_process_per_run') or defaults['max_process_per_run'],
            }
    except Exception as e:
        log.warning(f'Could not load trend_config for {country_code}, using defaults: {e}')
    return defaults

def run_trendspyg(channels, override_target=None):
    log.info('══ MODE: TRENDSPYG (real Google Trends, priority=10) ══')

    for channel in channels:
        country = channel.get('country_code', 'US')
        cfg     = load_trend_config(country)
        log.info(f'[{channel["channel_name"]}] Settings: want {cfg["max_topics_per_run"]} quiz-ready topics, '
                 f'window={cfg["time_window_hours"]}h, min_vol={cfg["min_volume"]:,}, '
                 f'min_words={cfg["min_grounding_words"]}, max_process={cfg["max_process_per_run"]}')

        trends = []
        source_used = None

        # CSV path: 480+ real trends with genuine volume buckets (200K+, 1M+).
        # Requires Chrome. If it fails for any reason, we do NOT fall back to
        # RSS (which only has ~10 coarse-bucket trends and wastes Tavily credits).
        # Instead we skip and let the --mode fallback job fill any gap.
        try:
            time.sleep(TRENDSPYG_DELAY_SEC)
            trends = _fetch_trends_csv(country, hours=cfg['time_window_hours'])
            source_used = f'CSV (hours={cfg["time_window_hours"]})'
        except Exception as e:
            log.warning(f'  CSV path failed: {e}')
            log.warning(f'  Skipping trendspyg for {channel["channel_name"]} this run.')
            log.warning(f'  Run --mode fallback separately if needed, or check Chrome installation.')
            continue

        log.info(f'  Got {len(trends)} trends via {source_used} (sorted by volume, highest first)')
        if trends:
            log.info(f'  Volume range: {trends[-1]["volume"]:,} – {trends[0]["volume"]:,}')

        # Walk the volume-sorted list from the TOP. Insert quiz-ready topics
        # until we reach max_topics_per_run, or until we've processed
        # max_process_per_run raw trends (Tavily-credit safety cap).
        inserted  = 0
        processed = 0
        target    = override_target if override_target is not None else cfg['max_topics_per_run']
        log.info(f'  Target for this run: {target} quiz-ready topics')
        for t in trends:
            if inserted >= target:
                log.info(f'  Reached target of {target} quiz-ready topics — stopping')
                break
            if processed >= cfg['max_process_per_run']:
                log.info(f'  Hit process cap ({cfg["max_process_per_run"]}) before target — stopping')
                break
            kw  = t['keyword']
            vol = t['volume']
            if not kw:
                continue
            if vol < cfg['min_volume']:
                # list is volume-sorted desc — once below threshold, all rest are too
                log.info(f'  Volume dropped below {cfg["min_volume"]:,} (at {vol:,}) — stopping')
                break
            ok_kw, reason = is_quizable_trend(kw)
            if not ok_kw:
                log.info(f'  SKIP [{reason}]: {kw}'); continue
            priority  = volume_to_priority(vol)
            breakdown = t.get('breakdown', '')
            log.info(f'  Processing ({inserted+1}/{target}, vol={vol:,} p={priority}): {kw}')
            processed += 1
            if process_topic(kw, channel, 'trendspyg', priority,
                             min_words=cfg['min_grounding_words'],
                             volume=vol, breakdown=breakdown):
                inserted += 1

        log.info(f'[{channel["channel_name"]}] trendspyg: {inserted}/{target} quiz-ready topics inserted '
                 f'(processed {processed} raw trends)')

# ── Mode 2: Google News RSS ───────────────────────────────────────────────────
def run_rss(channels, override_target=None):
    log.info('══ MODE: GOOGLE NEWS RSS (daily volume, priority=5) ══')
    for channel in channels:
        country = channel.get('country_code', 'US')
        niches  = channel.get('niches') or ['general']
        feeds   = GOOGLE_NEWS_RSS.get(country, GOOGLE_NEWS_RSS['US'])
        cfg     = load_trend_config(country)
        target  = override_target if override_target is not None else cfg['max_topics_per_run']
        min_w   = cfg['min_grounding_words']
        log.info(f'[{channel["channel_name"]}] RSS: want {target} quiz-ready topics, '
                 f'min_words={min_w}, across {len(niches)} niches')
        inserted = 0
        for niche in niches:
            if inserted >= target:
                log.info(f'  Reached target of {target} — stopping RSS')
                break
            url = feeds.get(niche) or feeds.get('general')
            if not url: continue
            try:
                feed    = feedparser.parse(url)
                entries = feed.entries[:RSS_MAX_PER_FEED]
                status  = feed.get('status', 'N/A')
                log.info(f'  [{niche}] {len(entries)} entries (HTTP {status})')
                if feed.bozo and len(entries) == 0:
                    log.warning(f'  [{niche}] Feed error: {feed.bozo_exception}')
                    continue
            except Exception as e:
                log.warning(f'  RSS failed {niche}: {e}'); continue
            for entry in entries:
                if inserted >= target:
                    break
                title = re.sub(r'\s*[-–]\s*[^-–]+$', '',
                               entry.get('title','').strip()).strip()
                if len(title) < 10: continue
                if process_topic(title, channel, 'rss', 5, niche, min_words=min_w):
                    inserted += 1
        log.info(f'[{channel["channel_name"]}] RSS: {inserted}/{target} quiz-ready topics inserted')

# ── Mode 3: Tavily fallback ───────────────────────────────────────────────────
def run_fallback(channels, target=50):
    log.info('══ MODE: TAVILY FALLBACK (gap filler, priority=1) ══')
    for channel in channels:
        country      = channel.get('country_code', 'US')
        niches       = channel.get('niches') or ['general']
        country_name = {'US': 'United States', 'IN': 'India'}.get(country, country)
        # FIX: use count_todays_topics() which handles missing country_code column
        have = count_todays_topics(country)
        if have >= target:
            log.info(f'[{channel["channel_name"]}] Already at target ({have}), skip fallback')
            continue
        needed = target - have
        log.info(f'[{channel["channel_name"]}] Have {have} today, need {needed} more')
        inserted = 0
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        for niche in niches:
            if inserted >= needed: break
            try:
                time.sleep(TAVILY_DELAY_SEC)
                result  = tavily.search(
                    query        = f'Top trending news in {niche} in {country_name} today {today}',
                    search_depth = 'basic',
                    max_results  = 5,
                )
                results = result.get('results', [])
            except Exception as e:
                log.warning(f'  Fallback search failed {niche}: {e}'); continue
            for res in results:
                title   = re.sub(r'\s*[-–]\s*[^-–]+$', '', (res.get('title') or '').strip()).strip()
                content = (res.get('content') or res.get('snippet') or '').strip()
                if len(title) < 10 or len(content.split()) < 50: continue
                if already_queued(title, country): continue
                ok = insert_topic(title, niche, trim(content), channel, 'tavily_fallback', 1)
                if ok:
                    inserted += 1
                    log.info(f'  ✓ FALLBACK [{niche}]: {title[:70]}')
        log.info(f'[{channel["channel_name"]}] Fallback: {inserted} inserted')

# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', required=True,
                        choices=['trends','rss','fallback','all'])
    args = parser.parse_args()
    log.info(f'fetch_trends.py | mode={args.mode} | {datetime.now(timezone.utc).isoformat()}')

    try:
        channels = db_get('channel_config?active=eq.true&order=created_at.asc')
    except Exception as e:
        log.error(f'Cannot load channel_config: {e}')
        log.error('Have you run channel_setup.sql in Supabase yet?')
        sys.exit(1)

    if not channels:
        log.warning('No active channels found in channel_config.'); sys.exit(0)

    log.info(f'Active channels: {[c["channel_name"] for c in channels]}')

    if args.mode == 'trends':
        run_trendspyg(channels)
    elif args.mode == 'rss':
        run_rss(channels)
    elif args.mode == 'fallback':
        run_fallback(channels)
    elif args.mode == 'all':
        run_waterfall(channels)   # trendspyg → RSS gap → fallback gap

    log.info('Done.')

if __name__ == '__main__':
    main()

# ── Waterfall orchestrator ────────────────────────────────────────────────────
def run_waterfall(channels):
    """
    WATERFALL — the correct daily flow:
      Stage 1: trendspyg → tries to reach full target (highest-volume viral topics)
      Stage 2: RSS        → fills ONLY THE GAP (target minus what trendspyg inserted)
      Stage 3: fallback   → fills any remaining gap

    Each stage only runs if the previous left a shortfall.
    RSS never runs if trendspyg already hit the target.
    Fallback never runs if trendspyg + RSS together hit the target.
    """
    log.info('══ WATERFALL: trendspyg → RSS (gap) → fallback (gap) ══')
    for channel in channels:
        country = channel.get('country_code', 'US')
        cfg     = load_trend_config(country)
        target  = cfg['max_topics_per_run']
        log.info(f'[{channel["channel_name"]}] Daily target: {target} quiz-ready topics')

        # Stage 1: trendspyg
        run_trendspyg([channel])
        have = count_todays_topics(country)
        log.info(f'[{channel["channel_name"]}] After trendspyg: {have}/{target}')
        if have >= target:
            log.info(f'  Target reached by trendspyg — skipping RSS + fallback'); continue

        # Stage 2: RSS fills the gap
        gap = target - have
        log.info(f'  Gap = {gap} → running RSS')
        run_rss([channel], override_target=gap)
        have = count_todays_topics(country)
        log.info(f'[{channel["channel_name"]}] After RSS: {have}/{target}')
        if have >= target:
            log.info(f'  Target reached by RSS — skipping fallback'); continue

        # Stage 3: Tavily fallback
        log.info(f'  Gap = {target - have} → running fallback')
        run_fallback([channel], target=target)

    log.info('Waterfall complete.')
