#!/usr/bin/env python3
"""
fetch_trends.py -- Multi-source trending topic fetcher
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
TRENDSPYG_MIN_VOLUME = 1000   # fallback min volume -- correct scale: 50K+ is top 4h trend
TRENDSPYG_DELAY_SEC  = 2.0    # pause between trendspyg network calls
TRENDSPYG_HOURS      = 4      # fallback time window if trend_config missing
TRENDSPYG_MAX_PROCESS = 25    # fallback process cap if trend_config missing
TAVILY_MIN_RESULTS   = 2
TAVILY_MIN_WORDS     = 200    # default; overridden per-channel by trend_config.min_grounding_words
TAVILY_DELAY_SEC     = 1.5
RSS_MAX_PER_FEED     = 15

# -- Trendspyg keyword blocklist -----------------------------------------------
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

# -- Niche classifier ----------------------------------------------------------
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

# -- Google News RSS feeds -----------------------------------------------------
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

# -- Supabase helpers ----------------------------------------------------------
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
    Supabase's count=exact header -- returns integer directly, no row fetch."""
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
            # Content-Range: 0-0/42  -- the number after / is the total count
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
    """
    Check if this topic was already inserted into quiz_queue today.
    Uses the first 50 chars of the topic as the search key — robust against
    long RSS titles with special characters that break URL encoding.
    Falls back to no country_code filter if the column doesn't exist.
    """
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    # Use first 50 chars — enough to be unique, short enough to be URL-safe
    # Strip special chars that break ILIKE URL encoding
    key = re.sub(r"['\";:%&+?#]", '', topic[:50]).strip()
    if len(key) < 5:
        key = re.sub(r'[^a-zA-Z0-9 ]', '', topic[:50]).strip()
    safe = quote(key)
    try:
        rows = db_get(
            f'quiz_queue?trnding_topic=ilike.%25{safe}%25'
            f'&country_code=eq.{country_code}'
            f'&created_at=gte.{today}'
            f'&limit=1&select=id'
        )
        if len(rows) > 0:
            log.debug(f'  Dedup hit: "{topic[:60]}"')
            return True
        return False
    except Exception:
        try:
            rows = db_get(
                f'quiz_queue?trnding_topic=ilike.%25{safe}%25'
                f'&created_at=gte.{today}'
                f'&limit=1&select=id'
            )
            return len(rows) > 0
        except Exception as e:
            log.debug(f'Dedup check failed (non-fatal): {e}')
            return False

# -- Tavily quality filter -----------------------------------------------------
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

# -- Wikipedia image lookup ----------------------------------------------------
# Free, CC-licensed images. No API key needed. No cost. Zero copyright risk.
# Used as blurred thumbnail background in Worker 10.

# Known abbreviation expansions -> better Wikipedia article titles
WIKI_EXPANSIONS = {
    'gta 6': 'Grand Theft Auto VI',
    'gta vi': 'Grand Theft Auto VI',
    'mstr': 'Strategy Inc',
    'mstr stock': 'Strategy Inc',
    'mu stock': 'Micron Technology',
    'dram stock': 'DRAM',
    'uber stock': 'Uber',
    'aapl': 'Apple Inc',
    'tsla': 'Tesla Inc',
    'nba draft': 'NBA draft',
    'nfl schedule': 'National Football League',
    'nfl draft': 'NFL draft',
}

# Well-known brands/entities — if found in topic, use them directly as the Wiki term.
# These are reliably in Wikipedia and always produce good thumbnail images.
WIKI_KNOWN_ENTITIES = {
    'tesla': 'Tesla Inc',
    'spacex': 'SpaceX',
    'apple': 'Apple Inc',
    'google': 'Google',
    'meta': 'Meta Platforms',
    'facebook': 'Facebook',
    'amazon': 'Amazon',
    'microsoft': 'Microsoft',
    'nvidia': 'Nvidia',
    'micron': 'Micron Technology',
    'sk hynix': 'SK Hynix',
    'samsung': 'Samsung',
    'anthropic': 'Anthropic',
    'alibaba': 'Alibaba Group',
    'openai': 'OpenAI',
    'netflix': 'Netflix',
    'disney': 'Walt Disney Company',
    'twitter': 'Twitter',
    'tiktok': 'TikTok',
    'uber': 'Uber',
    'lyft': 'Lyft',
    'airbnb': 'Airbnb',
    'live nation': 'Live Nation Entertainment',
    'ticketmaster': 'Ticketmaster',
    'federal reserve': 'Federal Reserve',
    'air canada': 'Air Canada',
    'fortnite': 'Fortnite',
    'rockstar games': 'Rockstar Games',
    'walmart': 'Walmart',
    'darden': 'Darden Restaurants',
    'olive garden': 'Olive Garden',
    'wendy': 'Wendy\'s',
    'elon musk': 'Elon Musk',
    'mark zuckerberg': 'Mark Zuckerberg',
    'jeff bezos': 'Jeff Bezos',
    'donald trump': 'Donald Trump',
    'iran': 'Iran',
    'israel': 'Israel',
    'ukraine': 'Ukraine',
    'russia': 'Russia',
    'china': 'China',
    'nato': 'NATO',
    'iphone': 'iPhone',
    'android': 'Android',
    'gold price': 'Gold',
    'oil price': 'Petroleum',
    'bitcoin': 'Bitcoin',
    'nasdaq': 'Nasdaq',
}

# Words/phrases stripped from topic to get the core entity
WIKI_STRIP_SUFFIXES = [
    ' arrested', ' dies', ' dead', ' death', ' married', ' divorce',
    ' net worth', ' age', ' salary', ' news', ' update', ' updates',
    ' weather', ' forecast', ' near me', ' today', ' 2026',
    ' stock', ' price', ' stock price', ' shares', ' etf',
    ' schedule', ' score', ' scores', ' game', ' match', ' results',
    ' rumors', ' rumours', ' leaked', ' leak',
    ' bill', ' act', ' law', ' policy',
]
WIKI_STRIP_PREFIXES = [
    'what is ', 'what are ', 'what was ', 'what were ',
    'who is ', 'who are ', 'who was ',
    'why is ', 'why did ', 'why does ',
    'how is ', 'how did ', 'how to ',
    'when is ', 'when did ', 'when does ',
    'where is ', 'where did ',
    'is ', 'are ', 'can ',
    'latest ', 'new ', 'best ', 'top ',
]

def extract_wiki_term(topic):
    """
    Extract the best Wikipedia search term from a raw trending topic.
    Returns a list of candidate terms to try in order (best first).

    Improvements from diagnostic:
    - vs-split: clean each part individually (strip suffixes from each side)
    - Trailing noise words removed after preposition-stripping ("south korea out" -> "south korea")
    - News-verb detection: "Elon Musk loses trillionaire status" -> ["Elon Musk", "Elon Musk Loses Trillionaire Status"]
    - Removed ' elections' from suffixes -- "Primary Elections" is a valid Wikipedia article
    """
    t = topic.strip().lower()

    # -- 0. Known expansions (highest confidence) -----------------------------
    if t in WIKI_EXPANSIONS:
        return [WIKI_EXPANSIONS[t]]

    # -- 0.5. Known brand/entity scan (catches long RSS headlines) ------------
    # "Texas family sues Tesla over fatal crash" -> finds "tesla" -> "Tesla Inc"
    # "Anthropic Accuses Alibaba of Illicitly Accessing AI" -> finds "anthropic"
    # Sorted longest-first so "elon musk" matches before "elon"
    for entity_key in sorted(WIKI_KNOWN_ENTITIES.keys(), key=len, reverse=True):
        if entity_key in t:
            return [WIKI_KNOWN_ENTITIES[entity_key]]
    if ' vs ' in t or ' vs. ' in t:
        parts = re.split(r'\s+vs\.?\s+', t)
        candidates = []
        for p in parts:
            p = p.strip()
            if len(p) < 3:
                continue
            # Strip all known suffixes from each vs-part
            for suffix in WIKI_STRIP_SUFFIXES:
                if p.endswith(suffix):
                    p = p[:-len(suffix)].strip()
            # Strip trailing noise words from each part
            p_words = p.split()
            TRAILING_NOISE_LOCAL = {'out', 'up', 'down', 'back', 'off', 'on', 'standings', 'results', 'score', 'scores', 'table'}
            while p_words and p_words[-1].lower() in TRAILING_NOISE_LOCAL:
                p_words.pop()
            p = ' '.join(p_words)
            if p:
                candidates.append(p.title())
        if candidates:
            return candidates

    # -- 2. Strip question-word prefixes --------------------------------------
    for prefix in WIKI_STRIP_PREFIXES:
        if t.startswith(prefix):
            t = t[len(prefix):]
            break

    # -- 3. News-verb detection: "Name Verb Event" -> extract just the Name ---
    # Pattern: 2-word proper name followed by a common news verb
    # "elon musk loses trillionaire status" -> first try "Elon Musk" as candidate
    # Keep full term as second candidate in case name alone has no image
    NEWS_VERBS = [
        'loses', 'gains', 'wins', 'dies', 'dead', 'arrested', 'charged',
        'accused', 'sues', 'files', 'signs', 'announces', 'reveals',
        'says', 'calls', 'named', 'elected', 'resigns', 'retires',
        'joins', 'leaves', 'fired', 'hired', 'married', 'divorces',
        'surge', 'surges', 'falls', 'drops', 'rises', 'hits', 'soars',
        'plunges', 'crashes', 'rebounds', 'climbs', 'tumbles', 'sinks',
        'beats', 'misses', 'reports', 'posts', 'cuts', 'raises',
    ]
    words = t.split()
    if len(words) >= 3:
        for i, w in enumerate(words[1:], start=1):  # check from 2nd word
            if w in NEWS_VERBS and i >= 2:
                # First i words = likely the entity name
                name_candidate = ' '.join(words[:i]).title()
                full_candidate = t.title()
                return [name_candidate, full_candidate]

    # -- 4. Strip trailing news qualifiers ------------------------------------
    for suffix in WIKI_STRIP_SUFFIXES:
        if t.endswith(suffix):
            t = t[:-len(suffix)].strip()
            break

    # -- 5. Extract entity before prepositions --------------------------------
    for prep in [' in ', ' at ', ' for ', ' from ', ' by ', ' on ', ' of ', ' near ']:
        if prep in t:
            t = t[:t.index(prep)].strip()
            break

    # -- 6. Remove trailing noise single-words (out, up, down, back, off) -----
    TRAILING_NOISE = {'out', 'up', 'down', 'back', 'off', 'on', 'away', 'over'}
    t_words = t.split()
    while t_words and t_words[-1].lower() in TRAILING_NOISE:
        t_words.pop()
    t = ' '.join(t_words)

    if not t.strip():
        return [topic.strip().title()]

    result = t.strip().title()
    # Also return the original topic.title() as a fallback candidate
    original = topic.strip().title()
    if result != original:
        return [result, original]
    return [result]


def fetch_wikipedia_image(topic):
    """
    Fetch a Wikipedia thumbnail image URL for the given topic.
    Uses the Wikipedia REST API (free, no key, CC-licensed images).
    Returns image URL string or None if not found.

    Tries each candidate term from extract_wiki_term() in order.
    Falls back silently -- missing image means the animated CSS background
    is used on the thumbnail instead.
    """
    candidates = extract_wiki_term(topic)
    for term in candidates:
        try:
            # Wikipedia page summary API -- returns thumbnail if the article has one
            encoded = requests.utils.quote(term.replace(' ', '_'))
            r = requests.get(
                f'https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}',
                headers={'User-Agent': 'AutoQuiz/1.0 (quiz thumbnail image fetcher)'},
                timeout=8
            )
            if r.status_code == 200:
                data = r.json()
                img = data.get('thumbnail', {}).get('source')
                if img:
                    # Upgrade to larger size (Wikipedia thumbnails support ?width= param)
                    img = re.sub(r'/\d+px-', '/800px-', img)
                    log.info(f'  Wikipedia image for "{term}": {img[:80]}')
                    return img
        except Exception as e:
            log.debug(f'  Wikipedia API error for "{term}": {e}')
            continue
    log.debug(f'  No Wikipedia image found for topic: "{topic}"')
    return None

def quality_check(topic, tavily_data, min_words=TAVILY_MIN_WORDS):
    if not tavily_data or not tavily_data.get('results'):
        return False, 'no_results', '', [], 0.0
    results    = tavily_data['results']
    if len(results) < TAVILY_MIN_RESULTS:
        return False, f'too_few_results({len(results)})', '', [], 0.0
    combined   = ' '.join((r.get('content') or r.get('snippet') or '') for r in results).strip()
    word_count = len(combined.split())
    if word_count < min_words:
        return False, f'thin({word_count}w<{min_words}w)', '', [], 0.0
    domains = set()
    for r in results:
        m = re.search(r'https?://(?:www\.)?([^/]+)', r.get('url',''))
        if m: domains.add(m.group(1))
    if len(domains) <= 1:
        return False, 'single_domain', '', [], 0.0
    words = topic.strip().split()
    if len(words) <= 2:
        is_name = all(w[0].isupper() for w in words if w) and not any(c.isdigit() for c in topic)
        if is_name and results[0].get('score', 1.0) < 0.4:
            return False, 'unknown_entity', '', [], 0.0
    tavily_titles = [r.get('title','').strip() for r in results if r.get('title','').strip()]
    # Average Tavily relevance score (0.0-1.0) -- used as RSS priority proxy
    scores = [r.get('score', 0.0) for r in results if r.get('score') is not None]
    avg_score = sum(scores) / len(scores) if scores else 0.0
    return True, 'ok', combined, tavily_titles, avg_score

def trim(text, max_words=200):
    w = text.split()
    return ' '.join(w[:max_words]) if len(w) > max_words else text

def volume_to_priority(volume):
    """
    priority = volume directly (no bucketing, no capping).
    Higher search volume = higher priority = Worker 8 processes it first.

    quiz_queue.priority is now INTEGER (max 2,147,483,647) -- safe for any
    Google Trends volume including 7-day windows with 10M+ searches.

    Examples:
      50K  window (4h)  ->  50,000   priority
      2M   window (7d)  ->  2,000,000 priority
      10M  window (7d)  -> 10,000,000 priority
      RSS topics        ->          5 priority (always below trendspyg)
      fallback topics   ->          1 priority
    """
    return max(int(volume), 0)

# -- Insert into quiz_queue ----------------------------------------------------
def insert_topic(topic, niche, grounding, channel, source, priority, volume=0, breakdown='', tavily_score=0.0, topic_image_url=None):
    # Parse breakdown into clean keyword list using flexible separator detection
    breakdown_list = _parse_breakdown(breakdown)
    # Canonical string: comma-separated, clean, ready for YouTube tags / blog meta
    keywords_str = ', '.join(breakdown_list) if breakdown_list else ''

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
            # Wikipedia thumbnail image -- blurred background for video thumbnail
            'topic_image_url':   topic_image_url,
            'topic_source':      source,
            # Dedicated column -- visible in Supabase UI, queryable, flows to
            # Worker 8 -> quiz table -> YouTube tags, blog SEO, video description
            'trend_keywords':    keywords_str,
            'payload': {
                'source':               source,
                'channel':              channel.get('channel_name'),
                'fetched_at':           datetime.now(timezone.utc).isoformat(),
                'priority':             priority,
                'search_volume':        volume,
                'tavily_score':         round(avg_score, 3) if (avg_score := tavily_score) else 0,
                'trend_breakdown':      breakdown_list,   # parsed list
                'trend_breakdown_raw':  breakdown,        # original CSV string
            },
            'created_at': datetime.now(timezone.utc).isoformat(),
        })
        if keywords_str:
            log.info(f'    trend_keywords ({len(breakdown_list)}): {keywords_str[:100]}')
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
            log.warning('Minimal insert succeeded -- run trend_keywords_migration.sql')
            return True
        except Exception as e2:
            log.error(f'Insert failed: {e2}')
            return False

# -- Process one topic ---------------------------------------------------------
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
    passes, reason, grounding, tavily_titles, avg_score = quality_check(topic, data, min_words)
    if not passes:
        log.info(f'  REJECT [{reason}]: {topic[:70]}')
        return False
    niche = niche_hint or classify_niche(topic)
    # For RSS/fallback: use Tavily avg_score x 100 as priority proxy (5-100 range,
    # always far below trendspyg thousands). trendspyg topics already have real volume.
    effective_priority = priority
    if volume == 0 and avg_score > 0:
        effective_priority = max(priority, round(avg_score * 100))
    # Fetch Wikipedia image for the thumbnail background (free, CC-licensed).
    topic_image_url = fetch_wikipedia_image(topic)
    effective_breakdown = breakdown if breakdown and breakdown.lower() != topic.lower() else ', '.join(tavily_titles[:8])
    ok = insert_topic(topic, niche, trim(grounding, max_words=max(min_words+50, 250)),
                      channel, source, effective_priority, volume=volume,
                      breakdown=effective_breakdown, tavily_score=avg_score,
                      topic_image_url=topic_image_url)
    if ok:
        bd_count = len(_parse_breakdown(effective_breakdown))
        bd_src   = 'google' if (breakdown and breakdown.lower() != topic.lower()) else 'tavily'
        log.info(f'  OK INSERTED [src={source} p={effective_priority} vol={volume:,} '
                 f'score={avg_score:.2f} niche={niche} bd={bd_count}kw/{bd_src}]: {topic[:70]}')
    return ok

# -- Mode 1: trendspyg ---------------------------------------------------------
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

def _parse_breakdown(raw):
    """
    Parse trend breakdown string into a clean list of keywords.
    Google Trends CSV uses different separators depending on locale/version:
      comma:       "lilo and stitch, daveigh chase death, meningitis"
      semicolon:   "lilo and stitch; daveigh chase death; meningitis"
      pipe:        "lilo and stitch | daveigh chase death | meningitis"
      double-space:"lilo and stitch  daveigh chase death  meningitis"
    Try each in order and pick the one that gives the most splits.
    """
    if not raw or not raw.strip():
        return []
    raw = raw.strip()
    best = [raw]  # fallback: whole string as one keyword
    for sep in [', ', ',', '; ', ';', ' | ', '|', '  ']:
        parts = [p.strip() for p in raw.split(sep) if p.strip()]
        if len(parts) > len(best):
            best = parts
    # Remove any trailing "+ N more" artifact from Google's UI
    best = [p for p in best if not p.startswith('+') and not p.startswith('...')]
    return best

def _fetch_trends_rss_enrichment(country):
    """
    Fetch trendspyg RSS to get related_queries for each trend.
    RSS has coarse volumes but DOES include related_queries (the breakdown
    keywords visible in Google Trends web UI).
    Returns dict: {keyword_lower: [related_query, ...]}
    No Chrome needed -- pure HTTP.
    """
    from trendspyg import download_google_trends_rss
    try:
        env = download_google_trends_rss(geo=country, normalize=True)
        enrichment = {}
        for t in env.get('trends', []):
            kw = (t.get('keyword') or '').strip().lower()
            rq = t.get('related_queries') or []
            if kw and rq:
                enrichment[kw] = [q.strip() for q in rq if q.strip()]
        log.info(f'  RSS enrichment: got related_queries for {len(enrichment)} trends')
        return enrichment
    except Exception as e:
        log.warning(f'  RSS enrichment failed (non-fatal): {e}')
        return {}

def _fetch_trends_csv(country, hours):
    """
    CSV path -- returns 480+ trends with REAL volume buckets (incl 200K+, 1M+).
    Uses Python's built-in csv module -- NO pandas needed.
    trendspyg downloads the file; we read it ourselves.
    Returns list of dicts: [{'keyword':..., 'volume':int, 'breakdown':str}, ...] sorted desc.
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
        # Trend breakdown column -- related search queries (gold for SEO/tags)
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
                # Log first row's breakdown so we can see raw format
                if not rows:
                    log.info(f'  Sample breakdown raw value: "{breakdown[:120]}"')
                rows.append({'keyword': kw, 'volume': vol, 'breakdown': breakdown})

    rows.sort(key=lambda r: r['volume'], reverse=True)

    # NOTE: _parse_volume already handles K/M suffixes correctly:
    # "50K+" -> 50,000, "2M+" -> 2,000,000, "200K+" -> 200,000
    # No further multiplication needed.

    log.info(f'  CSV parsed: {len(rows)} trends')
    return rows

def load_trend_config(country_code):
    """Load per-channel trend settings from trend_config table.
    Returns a dict with safe defaults if no row exists or table is missing."""
    defaults = {
        'max_topics_per_run':  20,
        'time_window_hours':   4,
        'min_volume':          1000,
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
    log.info('== MODE: TRENDSPYG (real Google Trends, priority=10) ==')

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

        # Enrich with related_queries from RSS (no Chrome, fast).
        # RSS has the breakdown keywords the web UI shows -- CSV doesn't.
        # We cross-reference by lowercased keyword to merge them.
        enrichment = _fetch_trends_rss_enrichment(country)
        enriched_count = 0
        for t in trends:
            kw_lower = t['keyword'].lower()
            if kw_lower in enrichment and enrichment[kw_lower]:
                t['breakdown'] = ', '.join(enrichment[kw_lower])
                enriched_count += 1
        if enriched_count:
            log.info(f'  Enriched {enriched_count}/{len(trends)} trends with related_queries from RSS')

        log.info(f'  Got {len(trends)} trends via {source_used} (sorted by volume, highest first)')
        if trends:
            log.info(f'  Volume range: {trends[-1]["volume"]:,} - {trends[0]["volume"]:,}')

        # Walk the volume-sorted list from the TOP. Insert quiz-ready topics
        # until we reach max_topics_per_run, or until we've processed
        # max_process_per_run raw trends (Tavily-credit safety cap).
        inserted  = 0
        processed = 0
        target    = override_target if override_target is not None else cfg['max_topics_per_run']
        log.info(f'  Target for this run: {target} quiz-ready topics')
        for t in trends:
            if inserted >= target:
                log.info(f'  Reached target of {target} quiz-ready topics -- stopping')
                break
            if processed >= cfg['max_process_per_run']:
                log.info(f'  Hit process cap ({cfg["max_process_per_run"]}) before target -- stopping')
                break
            kw  = t['keyword']
            vol = t['volume']
            if not kw:
                continue
            if vol < cfg['min_volume']:
                # list is volume-sorted desc -- once below threshold, all rest are too
                log.info(f'  Volume dropped below {cfg["min_volume"]:,} (at {vol:,}) -- stopping')
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
        return inserted  # waterfall uses this to decide if RSS is needed

    return 0

# -- Mode 2: Google News RSS ---------------------------------------------------
def run_rss(channels, override_target=None):
    log.info('== MODE: GOOGLE NEWS RSS (daily volume, priority=5) ==')
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
                log.info(f'  Reached target of {target} -- stopping RSS')
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
                title = re.sub(r'\s*[--]\s*[^--]+$', '',
                               entry.get('title','').strip()).strip()
                if len(title) < 10: continue
                if process_topic(title, channel, 'rss', 5, niche, min_words=min_w):
                    inserted += 1
        log.info(f'[{channel["channel_name"]}] RSS: {inserted}/{target} quiz-ready topics inserted')
        return inserted

    return 0

# -- Mode 3: Tavily fallback ---------------------------------------------------
def run_fallback(channels, target=50):
    log.info('== MODE: TAVILY FALLBACK (gap filler, priority=1) ==')
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
                title   = re.sub(r'\s*[--]\s*[^--]+$', '', (res.get('title') or '').strip()).strip()
                content = (res.get('content') or res.get('snippet') or '').strip()
                if len(title) < 10 or len(content.split()) < 50: continue
                if already_queued(title, country): continue
                ok = insert_topic(title, niche, trim(content), channel, 'tavily_fallback', 1)
                if ok:
                    inserted += 1
                    log.info(f'  OK FALLBACK [{niche}]: {title[:70]}')
        log.info(f'[{channel["channel_name"]}] Fallback: {inserted} inserted')

# -- Waterfall orchestrator ----------------------------------------------------
def run_waterfall(channels):
    """
    WATERFALL -- the correct daily flow:
      Stage 1: trendspyg -> tries to reach full target (highest-volume viral topics)
      Stage 2: RSS        -> fills ONLY THE GAP (target minus what trendspyg inserted)
      Stage 3: fallback   -> fills any remaining gap

    Uses INSERTION COUNTS returned by each stage (not DB re-queries which
    would include rows from previous runs and trigger false "target reached").
    """
    log.info('== WATERFALL: trendspyg -> RSS (gap) -> fallback (gap) ==')
    for channel in channels:
        country = channel.get('country_code', 'US')
        cfg     = load_trend_config(country)
        target  = cfg['max_topics_per_run']
        log.info(f'[{channel["channel_name"]}] Target this run: {target} new quiz-ready topics')

        # Stage 1: trendspyg
        inserted_trends = run_trendspyg([channel], override_target=target)
        log.info(f'[{channel["channel_name"]}] Stage 1 result: {inserted_trends}/{target}')

        if inserted_trends >= target:
            log.info(f'  Target reached by trendspyg -- skipping RSS + fallback')
            continue

        # Stage 2: RSS fills the gap
        gap = target - inserted_trends
        log.info(f'  Gap = {gap} -> running RSS to fill')
        inserted_rss = run_rss([channel], override_target=gap)
        total = inserted_trends + inserted_rss
        log.info(f'[{channel["channel_name"]}] Stage 2 result: {total}/{target} (trendspyg={inserted_trends} + rss={inserted_rss})')

        if total >= target:
            log.info(f'  Target reached by trendspyg + RSS -- skipping fallback')
            continue

        # Stage 3: Tavily fallback fills remaining gap
        remaining = target - total
        log.info(f'  Still need {remaining} more -> running fallback')
        run_fallback([channel], target=remaining)

    log.info('Waterfall complete.')

# -- Main ----------------------------------------------------------------------
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
        run_waterfall(channels)   # trendspyg -> RSS gap -> fallback gap

    log.info('Done.')

if __name__ == '__main__':
    main()
