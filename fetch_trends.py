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
from tavily import TavilyClient   # official SDK — fixes the 400 error

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('fetch_trends')

SUPABASE_URL         = os.environ['SUPABASE_URL'].rstrip('/')
SUPABASE_SERVICE_KEY = os.environ['SUPABASE_SERVICE_KEY']
TAVILY_API_KEY       = os.environ['TAVILY_API_KEY']

# FIX 1: trendspyg volume threshold lowered to 0
# trendspyg RSS returns relative/scaled values (200-5000 is normal).
# Volume filter was incorrectly set to 20000 — everything was skipped.
# Let the Tavily quality filter decide topic quality instead.
TRENDSPYG_MIN_VOLUME = 0

TAVILY_MIN_RESULTS   = 2
TAVILY_MIN_WORDS     = 150
TAVILY_DELAY_SEC     = 1.5
TRENDSPYG_DELAY_SEC  = 2.0
RSS_MAX_PER_FEED     = 15

# FIX 2: Use official Tavily Python SDK
# Raw HTTP calls with Authorization header were failing with 400 Bad Request.
# The official SDK handles auth correctly.
tavily = TavilyClient(api_key=TAVILY_API_KEY)

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
GOOGLE_NEWS_RSS = {
    'US': {
        'general':       'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en',
        'finance':       'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlBQQ?hl=en-US&gl=US&ceid=US:en',
        'tech':          'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlBQQ?hl=en-US&gl=US&ceid=US:en',
        'health':        'https://news.google.com/rss/topics/CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtVnVLQUFQAQ?hl=en-US&gl=US&ceid=US:en',
        'sports':        'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtVnVHZ0pWVXlBQQ?hl=en-US&gl=US&ceid=US:en',
        'politics':      'https://news.google.com/rss/topics/CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3d3TWpFU0FtVnVLQUFQAQ?hl=en-US&gl=US&ceid=US:en',
        'entertainment': 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtVnVHZ0pWVXlBQQ?hl=en-US&gl=US&ceid=US:en',
    },
    'IN': {
        'general':       'https://news.google.com/rss?hl=hi-IN&gl=IN&ceid=IN:hi',
        'finance':       'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtaHBHZ0pKVGlBQQ?hl=hi-IN&gl=IN&ceid=IN:hi',
        'tech':          'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtaHBHZ0pKVGlBQQ?hl=hi-IN&gl=IN&ceid=IN:hi',
        'health':        'https://news.google.com/rss/topics/CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3QwTlRFU0FtaHBLQUFQAQ?hl=hi-IN&gl=IN&ceid=IN:hi',
        'sports':        'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRFp1ZEdvU0FtaHBHZ0pKVGlBQQ?hl=hi-IN&gl=IN&ceid=IN:hi',
        'politics':      'https://news.google.com/rss/topics/CAAqIQgKIhtDQkFTRGdvSUwyMHZNR3d3TWpFU0FtaHBLQUFQAQ?hl=hi-IN&gl=IN&ceid=IN:hi',
        'entertainment': 'https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNREpxYW5RU0FtaHBHZ0pKVGlBQQ?hl=hi-IN&gl=IN&ceid=IN:hi',
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

# FIX 3: Dedup query simplified
# The previous query filtered on country_code which doesn't exist in quiz_queue
# until channel_setup.sql is run. Use only trnding_topic + status (always exist).
# After running channel_setup.sql, the query remains correct — these columns exist.
def already_queued(topic, country_code):
    today = datetime.now(timezone.utc).strftime('%Y-%m-%dT00:00:00+00:00')
    safe  = quote(topic[:80].replace("'", "''"))
    try:
        # Try full query with country_code first (works after channel_setup.sql)
        rows = db_get(
            f'quiz_queue'
            f'?trnding_topic=ilike.%25{safe}%25'
            f'&country_code=eq.{country_code}'
            f'&status=neq.completed'
            f'&created_at=gte.{today}'
            f'&limit=1&select=id'
        )
        return len(rows) > 0
    except Exception:
        try:
            # Fallback: simpler query without country_code (works before migration)
            rows = db_get(
                f'quiz_queue'
                f'?trnding_topic=ilike.%25{safe}%25'
                f'&status=neq.completed'
                f'&created_at=gte.{today}'
                f'&limit=1&select=id'
            )
            return len(rows) > 0
        except Exception as e:
            log.debug(f'Dedup check failed (non-fatal): {e}')
            return False  # safe to proceed — worst case we get a harmless duplicate

# ── Tavily quality filter (using official SDK) ────────────────────────────────
def tavily_search(topic, country_code):
    """
    Uses official tavily-python SDK (pip install tavily-python).
    This fixes the 400 Bad Request errors caused by incorrect raw HTTP auth.
    search_depth='basic' uses 1 credit vs 2 for 'advanced' — same results.
    """
    try:
        # Include country in the query text as a fallback for geo-targeting
        # (country param requires specific Tavily plan tier)
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

def quality_check(topic, tavily_data):
    """Returns (passes, reason, grounding_text)."""
    if not tavily_data or not tavily_data.get('results'):
        return False, 'no_results', ''
    results = tavily_data['results']
    if len(results) < TAVILY_MIN_RESULTS:
        return False, f'too_few_results({len(results)})', ''
    combined   = ' '.join((r.get('content') or r.get('snippet') or '') for r in results).strip()
    word_count = len(combined.split())
    if word_count < TAVILY_MIN_WORDS:
        return False, f'thin({word_count}w)', ''
    domains = set()
    for r in results:
        m = re.search(r'https?://(?:www\.)?([^/]+)', r.get('url',''))
        if m: domains.add(m.group(1))
    if len(domains) <= 1:
        return False, 'single_domain', ''
    # Unknown personal name filter
    words = topic.strip().split()
    if len(words) <= 2:
        is_name = all(w[0].isupper() for w in words if w) and not any(c.isdigit() for c in topic)
        if is_name and results[0].get('score', 1.0) < 0.4:
            return False, 'unknown_entity', ''
    return True, 'ok', combined

def trim(text, max_words=200):
    w = text.split()
    return ' '.join(w[:max_words]) if len(w) > max_words else text

# ── Insert into quiz_queue ────────────────────────────────────────────────────
def insert_topic(topic, niche, grounding, channel, source, priority):
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
            'thinking_time_sec': 10,
            'payload':           json.dumps({
                'source':      source,
                'channel':     channel.get('channel_name'),
                'fetched_at':  datetime.now(timezone.utc).isoformat(),
                'priority':    priority,
            }),
            'created_at': datetime.now(timezone.utc).isoformat(),
        })
        return True
    except Exception as e:
        # If column doesn't exist (migration not run), try minimal insert
        log.warning(f'Full insert failed, trying minimal: {e}')
        try:
            db_insert('quiz_queue', {
                'job_type':    'quiz_generation',
                'status':      'pending',
                'trnding_topic': topic[:255],
                'niche':       niche,
                'searched_text': grounding,
                'created_at':  datetime.now(timezone.utc).isoformat(),
            })
            log.warning('Minimal insert succeeded — run channel_setup.sql for full functionality')
            return True
        except Exception as e2:
            log.error(f'Insert failed: {e2}')
            return False

# ── Process one topic ─────────────────────────────────────────────────────────
def process_topic(topic, channel, source, priority, niche_hint=None):
    topic = topic.strip()
    if not topic or len(topic) < 5:
        return False
    country = channel.get('country_code', 'US')
    if already_queued(topic, country):
        log.info(f'  SKIP (dup): {topic[:70]}')
        return False
    time.sleep(TAVILY_DELAY_SEC)
    data = tavily_search(topic, country)
    passes, reason, grounding = quality_check(topic, data)
    if not passes:
        log.info(f'  REJECT [{reason}]: {topic[:70]}')
        return False
    niche = niche_hint or classify_niche(topic)
    ok = insert_topic(topic, niche, trim(grounding), channel, source, priority)
    if ok:
        log.info(f'  ✓ INSERTED [src={source} p={priority} niche={niche}]: {topic[:70]}')
    return ok

# ── Mode 1: trendspyg ─────────────────────────────────────────────────────────
def run_trendspyg(channels):
    log.info('══ MODE: TRENDSPYG (real Google Trends, priority=10) ══')
    try:
        from trendspyg import download_google_trends_rss
    except ImportError:
        log.error('trendspyg not installed: pip install trendspyg'); return

    for channel in channels:
        country = channel.get('country_code', 'US')
        log.info(f'[{channel["channel_name"]}] Fetching Google Trends geo={country}')
        try:
            time.sleep(TRENDSPYG_DELAY_SEC)
            env    = download_google_trends_rss(geo=country, normalize=True)
            # Sort by volume descending so highest-volume topics processed first
            trends = sorted(env.get('trends', []),
                            key=lambda t: t.get('volume_min', 0), reverse=True)
            log.info(f'  trendspyg returned {len(trends)} trends')
            if trends:
                log.info(f'  Volume range: {trends[-1].get("volume_min",0):,} – {trends[0].get("volume_min",0):,}')
        except Exception as e:
            log.warning(f'  trendspyg failed: {e}'); continue

        inserted = 0
        for t in trends:
            kw  = t.get('keyword', '').strip()
            vol = t.get('volume_min', 0)
            if not kw: continue
            # TRENDSPYG_MIN_VOLUME = 0 means ALL topics pass volume check
            # (threshold lowered from 20000 which was incorrectly blocking everything)
            if vol < TRENDSPYG_MIN_VOLUME:
                log.info(f'  SKIP low-vol ({vol:,}): {kw}'); continue
            log.info(f'  Processing (vol={vol:,}): {kw}')
            if process_topic(kw, channel, 'trendspyg', 10):
                inserted += 1

        log.info(f'[{channel["channel_name"]}] trendspyg: {inserted} inserted')

# ── Mode 2: Google News RSS ───────────────────────────────────────────────────
def run_rss(channels):
    log.info('══ MODE: GOOGLE NEWS RSS (daily volume, priority=5) ══')
    for channel in channels:
        country = channel.get('country_code', 'US')
        niches  = channel.get('niches') or ['general']
        feeds   = GOOGLE_NEWS_RSS.get(country, GOOGLE_NEWS_RSS['US'])
        log.info(f'[{channel["channel_name"]}] {len(niches)} niches')
        inserted = 0
        for niche in niches:
            url = feeds.get(niche) or feeds.get('general')
            if not url: continue
            try:
                feed    = feedparser.parse(url)
                entries = feed.entries[:RSS_MAX_PER_FEED]
                log.info(f'  [{niche}] {len(entries)} entries')
            except Exception as e:
                log.warning(f'  RSS failed {niche}: {e}'); continue
            for entry in entries:
                title = re.sub(r'\s*[-–]\s*[^-–]+$', '',
                               entry.get('title','').strip()).strip()
                if len(title) < 10: continue
                if process_topic(title, channel, 'rss', 5, niche):
                    inserted += 1
        log.info(f'[{channel["channel_name"]}] RSS: {inserted} inserted')

# ── Mode 3: Tavily fallback ───────────────────────────────────────────────────
def run_fallback(channels, target=50):
    log.info('══ MODE: TAVILY FALLBACK (gap filler, priority=1) ══')
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    for channel in channels:
        country      = channel.get('country_code', 'US')
        niches       = channel.get('niches') or ['general']
        country_name = {'US': 'United States', 'IN': 'India'}.get(country, country)
        try:
            existing = db_get(
                f'quiz_queue?country_code=eq.{country}'
                f'&created_at=gte.{today}T00:00:00+00:00'
                f'&status=neq.completed&select=id'
            )
            have = len(existing)
        except Exception:
            have = 0
        if have >= target:
            log.info(f'[{channel["channel_name"]}] Already at target ({have}), skip fallback')
            continue
        needed = target - have
        log.info(f'[{channel["channel_name"]}] Need {needed} more topics')
        inserted = 0
        for niche in niches:
            if inserted >= needed: break
            try:
                time.sleep(TAVILY_DELAY_SEC)
                result = tavily.search(
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
        log.warning('No active channels in channel_config.'); sys.exit(0)

    log.info(f'Active channels: {[c["channel_name"] for c in channels]}')

    if args.mode in ('trends',   'all'): run_trendspyg(channels)
    if args.mode in ('rss',      'all'): run_rss(channels)
    if args.mode in ('fallback', 'all'): run_fallback(channels)

    log.info('Done.')

if __name__ == '__main__':
    main()
