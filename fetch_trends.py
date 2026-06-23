#!/usr/bin/env python3
"""
fetch_trends.py
===============
Fetches trending topics and inserts them into quiz_queue.

Three modes (--mode flag):

  trends   Every 3 hours. trendspyg (Google Trends RSS) with real
           search volume numbers. Priority=10 (published first).

  rss      Once daily 6am UTC. Google News RSS per niche.
           Fills daily volume target. Priority=5.

  fallback Gap filler if rss didn't reach 50 topics/channel.
           Tavily direct search per niche. Priority=1.

Requirements: pip install trendspyg feedparser requests
Secrets:      SUPABASE_URL, SUPABASE_SERVICE_KEY, TAVILY_API_KEY
"""

import os, re, sys, time, json, logging, argparse
from datetime import datetime, timezone
from urllib.parse import quote

import requests
import feedparser

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s', datefmt='%H:%M:%S')
log = logging.getLogger('fetch_trends')

SUPABASE_URL         = os.environ['SUPABASE_URL'].rstrip('/')
SUPABASE_SERVICE_KEY = os.environ['SUPABASE_SERVICE_KEY']
TAVILY_API_KEY       = os.environ['TAVILY_API_KEY']

TAVILY_MIN_RESULTS   = 2
TAVILY_MIN_WORDS     = 150
TRENDSPYG_MIN_VOLUME = 20000
TAVILY_DELAY_SEC     = 1.5
TRENDSPYG_DELAY_SEC  = 2.0
RSS_MAX_PER_FEED     = 15

# ── Niche classifier ──────────────────────────────────────────────────────────
NICHE_KEYWORDS = {
    'finance':       ['stock','market','nasdaq','dow jones','s&p','ipo','earnings','revenue',
                      'profit','loss','bank','federal reserve','interest rate','inflation','gdp',
                      'economy','economic','crypto','bitcoin','ethereum','btc','blockchain',
                      'dollar','currency','forex','wall street','nyse','sensex','nifty','rbi',
                      'rupee','real estate','housing','mortgage','tax','budget','deficit','bond',
                      'recession','tariff','trade war'],
    'tech':          ['ai ','artificial intelligence','machine learning','chatgpt','openai',
                      'google','apple','microsoft','meta','amazon','nvidia','tesla','spacex',
                      'startup','iphone','android','cyber','hack','data breach','chip',
                      'semiconductor','cloud','robot','automation','drone','electric vehicle'],
    'health':        ['health','hospital','doctor','medicine','drug','fda','vaccine','virus',
                      'covid','cancer','heart disease','treatment','therapy','mental health',
                      'obesity','diabetes','clinical trial','pharma','who ','pandemic','outbreak'],
    'sports':        ['nfl','nba','mlb','nhl','ufc','boxing','super bowl','world series',
                      'playoffs','ipl','bcci','cricket','test match','t20','world cup',
                      'football','soccer','fifa','premier league','champions league','tennis',
                      'wimbledon','golf','pga','olympics','formula 1','f1',' vs ','score ',
                      'championship','tournament','transfer'],
    'politics':      ['president','congress','senate','democrat','republican','white house',
                      'election','vote','policy','supreme court','modi','bjp','parliament',
                      'lok sabha','cabinet','minister','government','war','ukraine','russia',
                      'china','taiwan','sanctions','nato','bill signed','executive order'],
    'entertainment': ['movie','film','box office','oscar','emmy','grammy','netflix','disney',
                      'hbo','streaming','bollywood','hollywood','actor','actress','singer',
                      'album','concert','tour','celebrity'],
}

def classify_niche(topic):
    t = topic.lower()
    for niche, kws in NICHE_KEYWORDS.items():
        if any(k in t for k in kws):
            return niche
    return 'general'

# ── Google News RSS feed URLs ─────────────────────────────────────────────────
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

# ── Dedup ─────────────────────────────────────────────────────────────────────
def already_queued(topic, country_code):
    today = datetime.now(timezone.utc).strftime('%Y-%m-%dT00:00:00+00:00')
    safe  = quote(topic[:80].replace("'", "''"))
    try:
        rows = db_get(f'quiz_queue?trnding_topic=ilike.%25{safe}%25'
                      f'&country_code=eq.{country_code}&status=neq.completed'
                      f'&created_at=gte.{today}&limit=1&select=id')
        return len(rows) > 0
    except Exception as e:
        log.warning(f'Dedup check failed: {e}')
        return False

# ── Tavily quality filter ─────────────────────────────────────────────────────
def tavily_search(topic, country_code):
    try:
        r = requests.post('https://api.tavily.com/search',
            headers={'Content-Type': 'application/json',
                     'Authorization': f'Bearer {TAVILY_API_KEY}'},
            json={'query': topic, 'search_depth': 'advanced', 'max_results': 8,
                  'include_answer': False, 'include_raw_content': False,
                  'country': country_code},
            timeout=20)
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.warning(f'Tavily error: {e}')
        return None

def quality_check(topic, tavily_data):
    """Returns (passes, reason, grounding_text)."""
    if not tavily_data or not tavily_data.get('results'):
        return False, 'no_results', ''
    results = tavily_data['results']
    if len(results) < TAVILY_MIN_RESULTS:
        return False, f'too_few_results({len(results)})', ''
    combined  = ' '.join((r.get('content') or r.get('snippet') or '') for r in results).strip()
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
            return False, f'unknown_entity', ''
    return True, 'ok', combined

def trim(text, max_words=200):
    w = text.split()
    return ' '.join(w[:max_words]) if len(w) > max_words else text

# ── Insert ────────────────────────────────────────────────────────────────────
def insert_topic(topic, niche, grounding, channel, source, priority):
    try:
        db_insert('quiz_queue', {
            'job_type': 'quiz_generation', 'status': 'pending',
            'priority': priority, 'trnding_topic': topic[:255],
            'niche': niche, 'searched_text': grounding,
            'lang_code': channel['lang_code'],
            'country_code': channel['country_code'],
            'channel_name': channel['channel_name'],
            'topic_source': source, 'thinking_time_sec': 10,
            'payload': json.dumps({'source': source, 'channel': channel['channel_name'],
                                   'fetched_at': datetime.now(timezone.utc).isoformat()}),
            'created_at': datetime.now(timezone.utc).isoformat(),
        })
        return True
    except Exception as e:
        log.error(f'Insert failed: {e}')
        return False

# ── Shared: process one topic ─────────────────────────────────────────────────
def process_topic(topic, channel, source, priority, niche_hint=None):
    topic = topic.strip()
    if not topic or len(topic) < 5:
        return False
    if already_queued(topic, channel['country_code']):
        log.info(f'  SKIP (dup): {topic[:70]}')
        return False
    time.sleep(TAVILY_DELAY_SEC)
    data = tavily_search(topic, channel['country_code'])
    passes, reason, grounding = quality_check(topic, data)
    if not passes:
        log.info(f'  REJECT [{reason}]: {topic[:70]}')
        return False
    niche = niche_hint or classify_niche(topic)
    ok = insert_topic(topic, niche, trim(grounding), channel, source, priority)
    if ok: log.info(f'  ✓ [{source} p={priority} {niche}]: {topic[:70]}')
    return ok

# ── Mode 1: trendspyg ─────────────────────────────────────────────────────────
def run_trendspyg(channels):
    log.info('══ TRENDSPYG — real Google Trends (priority=10) ══')
    try:
        from trendspyg import download_google_trends_rss
    except ImportError:
        log.error('trendspyg not installed: pip install trendspyg'); return

    for channel in channels:
        country = channel['country_code']
        log.info(f'[{channel["channel_name"]}] geo={country}')
        try:
            time.sleep(TRENDSPYG_DELAY_SEC)
            env    = download_google_trends_rss(geo=country, normalize=True)
            trends = sorted(env.get('trends', []),
                           key=lambda t: t.get('volume_min', 0), reverse=True)
            log.info(f'  Got {len(trends)} trends from trendspyg')
        except Exception as e:
            log.warning(f'  trendspyg failed: {e}'); continue

        inserted = 0
        for t in trends:
            kw  = t.get('keyword', '').strip()
            vol = t.get('volume_min', 0)
            if not kw: continue
            if vol < TRENDSPYG_MIN_VOLUME:
                log.info(f'  SKIP low-vol ({vol:,}): {kw}'); continue
            log.info(f'  Processing (vol={vol:,}): {kw}')
            if process_topic(kw, channel, 'trendspyg', 10): inserted += 1

        log.info(f'[{channel["channel_name"]}] trendspyg done: {inserted} inserted')

# ── Mode 2: Google News RSS ───────────────────────────────────────────────────
def run_rss(channels):
    log.info('══ GOOGLE NEWS RSS — daily volume (priority=5) ══')

    for channel in channels:
        country = channel['country_code']
        niches  = channel.get('niches') or ['general']
        feeds   = GOOGLE_NEWS_RSS.get(country, {})
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
                title = re.sub(r'\s*[-–]\s*[^-–]+$', '', entry.get('title','').strip()).strip()
                if len(title) < 10: continue
                if process_topic(title, channel, 'rss', 5, niche): inserted += 1

        log.info(f'[{channel["channel_name"]}] RSS done: {inserted} inserted')

# ── Mode 3: Tavily fallback ───────────────────────────────────────────────────
def run_fallback(channels, target=50):
    log.info('══ TAVILY FALLBACK — gap filler (priority=1) ══')
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')

    for channel in channels:
        country = channel['country_code']
        niches  = channel.get('niches') or ['general']
        try:
            existing = db_get(f'quiz_queue?country_code=eq.{country}'
                               f'&created_at=gte.{today}T00:00:00+00:00'
                               f'&status=neq.completed&select=id')
            have = len(existing)
        except Exception: have = 0

        if have >= target:
            log.info(f'[{channel["channel_name"]}] Already at target ({have}), skip fallback')
            continue

        needed   = target - have
        country_name = {'US':'United States','IN':'India'}.get(country, country)
        log.info(f'[{channel["channel_name"]}] Need {needed} more topics')

        inserted = 0
        for niche in niches:
            if inserted >= needed: break
            query = (f'Top trending news in {niche} in {country_name} today {today}. '
                     f'Include specific facts, numbers, names, events.')
            try:
                time.sleep(TAVILY_DELAY_SEC)
                r = requests.post('https://api.tavily.com/search',
                    headers={'Content-Type':'application/json',
                             'Authorization':f'Bearer {TAVILY_API_KEY}'},
                    json={'query':query,'search_depth':'advanced','max_results':5,
                          'include_answer':False,'include_raw_content':False,
                          'country':country},
                    timeout=20)
                r.raise_for_status()
                results = r.json().get('results', [])
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

        log.info(f'[{channel["channel_name"]}] Fallback done: {inserted} inserted')

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
        log.error(f'Cannot load channel_config: {e}'); sys.exit(1)

    if not channels:
        log.warning('No active channels found.'); sys.exit(0)

    log.info(f'Active: {[c["channel_name"] for c in channels]}')

    if args.mode in ('trends',  'all'): run_trendspyg(channels)
    if args.mode in ('rss',     'all'): run_rss(channels)
    if args.mode in ('fallback','all'): run_fallback(channels)

    log.info('Done.')

if __name__ == '__main__':
    main()
