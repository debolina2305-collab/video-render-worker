#!/usr/bin/env python3
"""
fetch_trends.py -- Trending topic fetcher (trendspyg only)
RSS and Tavily gap-filler fallback modes were removed by request --
trendspyg (Google Trends) is now the sole topic source.
Requirements: pip install trendspyg requests tavily-python
Secrets: SUPABASE_URL, SUPABASE_SERVICE_KEY, TAVILY_API_KEY
"""

import os, re, sys, time, json, logging, argparse, unicodedata, hashlib, hmac
from datetime import datetime, timezone, timedelta
from urllib.parse import quote

import requests
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

# ── Cloudflare R2 — hero image uploads ────────────────────────────────────────
# Reuses the same credentials already used by Worker 10 (thumbnail upload).
# Images fetched by Tavily are downloaded then pushed to R2 so they're served
# from your own CDN, not a third-party URL that can expire or be blocked.
# Destination: quiz-sound-music-speech/Hero_image_by_tavily_for_blog/
R2_ACCESS_KEY = os.getenv('R2_ACCESS_KEY', '')
R2_SECRET_KEY = os.getenv('R2_SECRET_KEY', '')
R2_ENDPOINT   = os.getenv('R2_ENDPOINT', '')          # e.g. https://<acct>.r2.cloudflarestorage.com
R2_BUCKET     = os.getenv('R2_BUCKET', 'quiz-sound-music-speech')
R2_PUBLIC_URL = os.getenv('R2_PUBLIC_URL', '')        # e.g. https://pub-xxx.r2.dev
R2_IMG_PREFIX = 'Hero_image_by_tavily_for_blog'
R2_CONFIGURED = bool(R2_ACCESS_KEY and R2_SECRET_KEY and R2_ENDPOINT and R2_PUBLIC_URL)

def _r2_sign(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode('utf-8'), hashlib.sha256).digest()

def upload_image_to_r2(image_url: str, slug: str, idx: int = 0) -> str | None:
    """
    Download an image from `image_url` and upload it to R2.
    Returns the public CDN URL on success, None on any failure.
    Upload path: R2_BUCKET/Hero_image_by_tavily_for_blog/<slug>_<idx>.<ext>
    """
    if not R2_CONFIGURED:
        log.debug('[R2] Not configured — skipping image upload')
        return None
    try:
        resp = requests.get(image_url, timeout=15, stream=True,
                            headers={
                                'User-Agent': 'Mozilla/5.0 (compatible; AutoQuiz/1.0)',
                                'Accept': 'image/webp,image/jpeg,image/png,image/*,*/*'
                            })
        resp.raise_for_status()
        data = resp.content
        ct   = resp.headers.get('Content-Type', 'image/jpeg').split(';')[0].strip().lower()

        # ── CRITICAL: reject HTML responses ──────────────────────────────
        # Social media platforms (Instagram, Facebook, Threads, Twitter/X)
        # return an HTML redirect page instead of the actual image when the
        # URL is fetched by a bot. The HTML page is tiny (~200-500 bytes)
        # and has Content-Type: text/html. Uploading it to R2 creates a
        # fake "image" file that breaks thumbnails and video overlays.
        # Skip any response that is not an image MIME type.
        VALID_IMAGE_TYPES = {'image/jpeg', 'image/png', 'image/webp',
                             'image/gif', 'image/avif', 'image/bmp',
                             'image/tiff', 'image/svg+xml'}
        if ct not in VALID_IMAGE_TYPES and not ct.startswith('image/'):
            log.warning(f'[R2] Skipping {image_url[:80]} — response is {ct} not an image (social media redirect?)')
            return None

        # Also reject suspiciously small responses — real images are >1KB
        # An HTML redirect page is typically 200-500 bytes
        if len(data) < 1024:
            log.warning(f'[R2] Skipping {image_url[:80]} — response too small ({len(data)} bytes), likely a redirect page')
            return None

        ext  = {'image/jpeg':'jpg','image/png':'png','image/webp':'webp',
                'image/gif':'gif','image/avif':'avif','image/bmp':'bmp'}.get(ct, 'jpg')
        safe_slug = re.sub(r'[^a-z0-9\-]', '', slug.lower())[:60]
        key  = f'{R2_IMG_PREFIX}/{safe_slug}_{idx}.{ext}'

        # AWS Signature V4 (Cloudflare R2 is S3-compatible)
        now   = datetime.utcnow()
        date  = now.strftime('%Y%m%d')
        ts    = now.strftime('%Y%m%dT%H%M%SZ')
        host  = R2_ENDPOINT.replace('https://','').replace('http://','').split('/')[0]
        region= 'auto'
        srv   = 's3'

        payload_hash = hashlib.sha256(data).hexdigest()
        canonical = (
            f'PUT\n/{R2_BUCKET}/{key}\n\n'
            f'content-type:{ct}\n'
            f'host:{host}\n'
            f'x-amz-content-sha256:{payload_hash}\n'
            f'x-amz-date:{ts}\n\n'
            f'content-type;host;x-amz-content-sha256;x-amz-date\n'
            f'{payload_hash}'
        )
        cred_scope = f'{date}/{region}/{srv}/aws4_request'
        str_to_sign = f'AWS4-HMAC-SHA256\n{ts}\n{cred_scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}'

        k_date    = _r2_sign(f'AWS4{R2_SECRET_KEY}'.encode(), date)
        k_region  = _r2_sign(k_date, region)
        k_service = _r2_sign(k_region, srv)
        k_signing = _r2_sign(k_service, 'aws4_request')
        sig = hmac.new(k_signing, str_to_sign.encode(), hashlib.sha256).hexdigest()

        auth = (
            f'AWS4-HMAC-SHA256 Credential={R2_ACCESS_KEY}/{cred_scope},'
            f'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date,'
            f'Signature={sig}'
        )
        upload_resp = requests.put(
            f'{R2_ENDPOINT}/{R2_BUCKET}/{key}',
            data=data,
            headers={
                'Host':                 host,
                'Content-Type':         ct,
                'x-amz-date':           ts,
                'x-amz-content-sha256': payload_hash,
                'Authorization':        auth,
                'Cache-Control':        'public, max-age=31536000',
            },
            timeout=30
        )
        upload_resp.raise_for_status()
        public_url = f'{R2_PUBLIC_URL.rstrip("/")}/{key}'
        log.info(f'[R2] Uploaded {image_url[:60]} → {public_url}')
        return public_url
    except Exception as e:
        log.warning(f'[R2] Upload failed for {image_url[:60]}: {e}')
        return None

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

# -- Trendspyg keyword blocklist -----------------------------------------------
# Filter out generic/unquizable trending keywords before calling Tavily.
# These waste Tavily credits and produce useless quiz topics.
TRENDSPYG_REJECT_KEYWORDS = [
    'breaking news', 'news today', 'live update', 'latest news',
    'weather today', 'weather forecast', 'horoscope', 'wordle',
    'nyt connections', 'nfl scores', 'nba scores', 'mlb scores',
    # Pure score/status queries -- not trivia topics
    ' score', ' scores', ' standings', ' standings today',
    ' server status', ' down right now', ' is down',
    ' live score', ' live update', ' live updates',
    # Generic search patterns
    'how to watch', 'where to watch', 'what channel',
    'what time is', 'when is the',
]

# Question-starting words — topics that START with these are search queries, not trivia
QUESTION_PREFIXES = (
    'is ', 'are ', 'was ', 'were ', 'will ', 'can ', 'does ', 'did ',
    'how ', 'why ', 'what ', 'when ', 'where ', 'who ', 'which ',
    'has ', 'have ', 'had ',
)
TRENDSPYG_REJECT_MIN_WORDS = 1   # single word keywords are usually too vague

def is_quizable_trend(keyword):
    """Pre-filter trendspyg keywords before calling Tavily."""
    k = keyword.lower().strip()
    if len(k.split()) <= TRENDSPYG_REJECT_MIN_WORDS:
        return False, f'too_short({len(k.split())}w)'
    # Reject question-form topics — these are search queries, not trivia subjects.
    # "is usa out of the world cup" can't be turned into a quiz question by W8.
    if k.startswith(QUESTION_PREFIXES):
        return False, f'question_form'
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

def ascii_normalize(s):
    """
    Normalize a Unicode string to ASCII by decomposing accented chars.
    'arda guler' -> 'arda guler', 'turkiye' stays 'turkiye'.
    This ensures dedup keys match even when topics have umlauts/accents.
    """
    return unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode('ascii')

def already_queued(topic, country_code):
    """
    Check if this topic was already inserted into quiz_queue today.

    ROOT CAUSE OF DUPLICATES (now fixed):
    The old approach stripped punctuation from the search key but NOT from
    the stored value. So "argentina - cabo verde" became key "argentina  cabo
    verde" (double space) and never matched the DB row's "argentina - cabo verde"
    via ILIKE %argentina  cabo verde%. Topics with dashes, parens, colons, etc.
    all silently bypassed dedup and were inserted twice.

    FIX — match on NORMALISED WORD TOKENS on both sides:
      1. Build a short, lowercase, letters-and-digits-only word list from the
         incoming topic ("argentina cabo verde" from "argentina - cabo verde").
      2. Search the DB with created_at window (today) and country_code.
      3. Normalize BOTH sides the same way: PostgreSQL regexp_replace on the
         DB column so "argentina - cabo verde" and "argentina (cabo verde)"
         and "argentina cabo verde" all produce the same token string for
         comparison.

    We do this in pure Python: fetch today's rows for the country, normalize
    every stored topic the same way we normalize the incoming topic, then
    compare word-token sets. This avoids any ILIKE substring tricks that
    break on punctuation differences.

    Performance: today's batch is typically <30 rows — not a large fetch.
    We cache the set within a single process run so we only hit Supabase once
    per (country_code, date) pair.
    """
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    cache_key = f'{country_code}:{today}'
    if not hasattr(already_queued, '_cache'):
        already_queued._cache = {}

    if cache_key not in already_queued._cache:
        # Fetch all topic strings inserted today for this country
        try:
            rows = db_get(
                f'quiz_queue?country_code=eq.{country_code}'
                f'&created_at=gte.{today}T00%3A00%3A00Z'
                f'&select=trnding_topic&limit=500'
            )
        except Exception:
            rows = []
        # Also try with lowercase country code (some rows stored differently)
        if not rows:
            try:
                rows = db_get(
                    f'quiz_queue?country_code=eq.{country_code.lower()}'
                    f'&created_at=gte.{today}T00%3A00%3A00Z'
                    f'&select=trnding_topic&limit=500'
                )
            except Exception:
                rows = []
        already_queued._cache[cache_key] = set(
            _topic_tokens(r['trnding_topic']) for r in rows if r.get('trnding_topic')
        )
        log.debug(f'  Dedup cache loaded: {len(already_queued._cache[cache_key])} topics for {cache_key}')

    incoming_tokens = _topic_tokens(topic)
    if len(incoming_tokens) < 4:
        # Very short token string -- do a word-overlap check instead
        # (all words of incoming must appear in a stored topic, or vice versa)
        incoming_words = set(incoming_tokens.split())
        for stored_tokens in already_queued._cache[cache_key]:
            stored_words = set(stored_tokens.split())
            if incoming_words and incoming_words <= stored_words:
                log.debug(f'  Dedup hit (word-subset): "{topic[:60]}"')
                return True
        return False

    if incoming_tokens in already_queued._cache[cache_key]:
        log.debug(f'  Dedup hit (exact tokens): "{topic[:60]}"')
        return True

    # Fuzzy: also flag if ≥80% of words overlap with any stored topic —
    # catches "argentina vs cabo verde" vs "argentina - cabo verde"
    incoming_words = set(w for w in incoming_tokens.split() if len(w) > 2)
    if incoming_words:
        for stored_tokens in already_queued._cache[cache_key]:
            stored_words = set(w for w in stored_tokens.split() if len(w) > 2)
            if not stored_words:
                continue
            overlap = len(incoming_words & stored_words)
            union   = len(incoming_words | stored_words)
            if union > 0 and overlap / union >= 0.80:
                log.debug(f'  Dedup hit (fuzzy {overlap}/{union} words): "{topic[:60]}"')
                return True

    return False

def _topic_tokens(text):
    """
    Normalise a topic string to a compact, punctuation-free, lowercase word
    sequence for dedup comparison.

    "Argentina - Cabo Verde"   -> "argentina cabo verde"
    "argentina vs. cabo verde" -> "argentina vs cabo verde"
    "World Cup (2026)"         -> "world cup 2026"
    Identical regardless of dashes, parens, colons, spacing.
    """
    if not text:
        return ''
    s = ascii_normalize(text)                          # ü->u, é->e etc.
    s = s.lower()
    s = re.sub(r'[^a-z0-9 ]', ' ', s)                # strip all punctuation
    s = re.sub(r'\s+', ' ', s).strip()               # collapse whitespace
    return s

# -- Tavily quality filter -----------------------------------------------------
def extract_domain(url):
    m = re.search(r'https?://(?:www\.)?([^/]+)', url or '')
    return m.group(1) if m else ''

def tavily_search(topic, country_code):
    try:
        country_name = {'US': 'United States', 'IN': 'India'}.get(country_code, country_code)
        result = tavily.search(
            query                       = f'{topic} {country_name}',
            search_depth                = 'advanced',   # was 'basic' -- richer per-source content
            max_results                 = 8,
            include_images              = True,         # was missing entirely -- no images were ever requested
            include_image_descriptions  = True,
            # Exclude social media domains from image results.
            # These platforms detect bot requests and return HTML redirect pages
            # instead of actual images, producing corrupt files when uploaded to R2.
            # News sites, Wikipedia, official sources are preferred instead.
            exclude_domains             = [
                'instagram.com',
                'facebook.com',
                'twitter.com',
                'x.com',
                'threads.net',
                'tiktok.com',
                'pinterest.com',
                'linkedin.com',
                'reddit.com',
                'snapchat.com',
                'youtube.com',    # video platform, no still images useful
                'youtu.be',
            ],
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
    'star fox': 'Star Fox',
    'ios 27': 'Apple Inc',
    'ios 26': 'Apple Inc',
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
    'amazon': 'Amazon (company)',
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
    'star fox': 'Star Fox',
    'nintendo': 'Nintendo',
    'homekit': 'Apple Inc',
    'ios 27': 'Apple Inc',
    'ios 26': 'Apple Inc',
    'ios 25': 'Apple Inc',
    'macos': 'MacOS',
    'gta vi': 'Grand Theft Auto VI',
    'gta 6': 'Grand Theft Auto VI',
    'grand theft auto': 'Grand Theft Auto VI',
    'live nation': 'Live Nation Entertainment',
    'ticketmaster': 'Ticketmaster',
    'federal reserve': 'Federal Reserve',
    'air canada': 'Air Canada',
    'fortnite': 'Fortnite',
    'rockstar games': 'Rockstar Games',
    'usmnt': "United States men's national soccer team",
    'us soccer': "United States men's national soccer team",
    'usa soccer': "United States men's national soccer team",
    'united states soccer': "United States men's national soccer team",
    'christian pulisic': 'Christian Pulisic',
    'pulisic': 'Christian Pulisic',
    'arda guler': 'Arda Guler',
    'world cup 2026': '2026 FIFA World Cup',
    'fifa world cup': '2026 FIFA World Cup',
    'turkey soccer': 'Turkey national football team',
    'turkiye': 'Turkey',
    'walmart': 'Walmart',
    'darden': 'Darden Restaurants',
    'olive garden': 'Olive Garden',
    'chevron': 'Chevron Corporation',
    'opec': 'OPEC',
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
    'oil slump': 'Petroleum',
    'oil market': 'Petroleum',
    'crude oil': 'Petroleum',
    'bitcoin': 'Bitcoin',
    'nasdaq': 'Nasdaq',
    'passkeys': 'Passkey',
    'penn station': 'Pennsylvania Station (New York City)',
    'quantum computing': 'Quantum computing',
    'seismic': 'Seismic wave',
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
            if len(p) < 2:
                continue
            # Normalize non-ASCII country names before lookup
            p = p.replace('turkiye', 'turkey').replace('turkiye', 'turkey')
            # Strip all known suffixes from each vs-part
            for suffix in WIKI_STRIP_SUFFIXES:
                if p.endswith(suffix):
                    p = p[:-len(suffix)].strip()
            # Strip trailing tournament noise words
            p_words = p.split()
            TRAILING_NOISE_LOCAL = {'out', 'up', 'down', 'back', 'off', 'on',
                                    'standings', 'results', 'score', 'scores',
                                    'table', 'cup', 'world', '2026', '2025', '2024'}
            while p_words and p_words[-1].lower() in TRAILING_NOISE_LOCAL:
                p_words.pop()
            p = ' '.join(p_words)
            if p and len(p) >= 2:
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

    Notes:
    - Flag images (Flag_of_*.svg) are skipped — they look bad as blurred backgrounds.
    - SVG files use 320px (always valid on Wikimedia, not 800px).
    - For JPG/PNG: we use the ORIGINAL width from the API if it's already >= 400px,
      otherwise request 640px. We never request 800px because the original image
      might be smaller than 800px which causes a Wikimedia 400 error.
    - Direct Commons URLs (no /thumb/ path) are returned as-is.
    """
    candidates = extract_wiki_term(topic)
    for term in candidates:
        try:
            encoded = requests.utils.quote(term.replace(' ', '_'))
            r = requests.get(
                f'https://en.wikipedia.org/api/rest_v1/page/summary/{encoded}',
                headers={'User-Agent': 'AutoQuiz/1.0 (quiz thumbnail image fetcher)'},
                timeout=8
            )
            if r.status_code == 200:
                data = r.json()
                thumb = data.get('thumbnail', {})
                img = thumb.get('source')
                if not img:
                    continue

                # Skip flag images — poor thumbnail background
                if 'Flag_of_' in img or 'flag_of_' in img:
                    log.debug(f'  Skipping flag image for "{term}"')
                    continue

                # If no /thumb/ path — it's a direct image URL, use as-is
                if '/thumb/' not in img:
                    log.info(f'  Wikipedia image for "{term}": {img[:80]}')
                    return img

                # SVG files: use 320px (Wikimedia SVG restriction)
                if img.lower().endswith('.svg.png') or '.svg/' in img.lower():
                    img = re.sub(r'/\d+px-', '/320px-', img)
                    log.info(f'  Wikipedia image for "{term}" (svg): {img[:80]}')
                    return img

                # JPG/PNG: use original width from API if >= 400px, else try 640px
                # NEVER request larger than the original — causes Wikimedia 400 error
                orig_width = thumb.get('width', 0)
                if orig_width >= 640:
                    img = re.sub(r'/\d+px-', '/640px-', img)
                elif orig_width >= 400:
                    # Use the size as returned by API (don't upscale)
                    pass  # img already has the correct size from API
                else:
                    # Image too small to be useful, skip
                    log.debug(f'  Skipping small image ({orig_width}px) for "{term}"')
                    continue

                log.info(f'  Wikipedia image for "{term}": {img[:80]}')
                return img

        except Exception as e:
            log.debug(f'  Wikipedia API error for "{term}": {e}')
            continue

    log.debug(f'  No Wikipedia image found for topic: "{topic}"')
    return None

def quality_check(topic, tavily_data, min_words=TAVILY_MIN_WORDS):
    EMPTY = ([], [])  # (tavily_sources, tavily_images) placeholder for early-reject paths
    if not tavily_data or not tavily_data.get('results'):
        return False, 'no_results', '', [], 0.0, *EMPTY
    results    = tavily_data['results']
    if len(results) < TAVILY_MIN_RESULTS:
        return False, f'too_few_results({len(results)})', '', [], 0.0, *EMPTY
    combined   = ' '.join((r.get('content') or r.get('snippet') or '') for r in results).strip()
    word_count = len(combined.split())
    if word_count < min_words:
        return False, f'thin({word_count}w<{min_words}w)', '', [], 0.0, *EMPTY
    domains = set()
    for r in results:
        d = extract_domain(r.get('url', ''))
        if d: domains.add(d)
    if len(domains) <= 1:
        return False, 'single_domain', '', [], 0.0, *EMPTY
    words = topic.strip().split()
    if len(words) <= 2:
        is_name = all(w[0].isupper() for w in words if w) and not any(c.isdigit() for c in topic)
        if is_name and results[0].get('score', 1.0) < 0.4:
            return False, 'unknown_entity', '', [], 0.0, *EMPTY
    tavily_titles = [r.get('title','').strip() for r in results if r.get('title','').strip()]
    # Average Tavily relevance score (0.0-1.0) -- used as RSS priority proxy
    scores = [r.get('score', 0.0) for r in results if r.get('score') is not None]
    avg_score = sum(scores) / len(scores) if scores else 0.0

    # -- Sources, for Worker 12's citation/data_sources column --------------
    tavily_sources = [
        {
            'title':  r.get('title', '').strip() or extract_domain(r.get('url', '')),
            'url':    r.get('url', ''),
            'domain': extract_domain(r.get('url', '')),
        }
        for r in results if r.get('url')
    ][:6]

    # -- Images: uploaded to Cloudflare R2 and replaced with CDN URLs ----------
    # Tavily image URLs are ephemeral third-party URLs that can expire or be
    # blocked. Download and re-host on R2 so blog hero/inline images are served
    # from our own CDN permanently.
    raw_images = tavily_data.get('images') or []
    tavily_images = []
    safe_key_slug = re.sub(r'[^a-z0-9\-]', '-', topic.lower())[:50]
    # Social media domains that redirect bots instead of serving images directly.
    # These platforms detect non-browser requests and return HTML redirect pages.
    # Uploading such pages to R2 creates corrupt "image" files (text/html, ~284B).
    BLOCKED_IMAGE_DOMAINS = {
        'instagram.com', 'www.instagram.com',
        'facebook.com', 'www.facebook.com', 'fb.com', 'fbcdn.net',
        'twitter.com', 'www.twitter.com', 'x.com', 'www.x.com',
        'threads.net', 'www.threads.net',
        'tiktok.com', 'www.tiktok.com',
        'pinterest.com', 'www.pinterest.com',
        'linkedin.com', 'www.linkedin.com',
        'reddit.com', 'www.reddit.com', 'i.redd.it', 'preview.redd.it',
        'snapchat.com', 'www.snapchat.com',
        'lookaside.instagram.com',  # Instagram CDN — also blocks bots
        'lookaside.fbsbx.com',
    }

    for img_idx, img in enumerate(raw_images[:6]):
        raw_url = img['url'] if isinstance(img, dict) else (img if isinstance(img, str) else None)
        desc    = img.get('description', topic) if isinstance(img, dict) else topic
        if not raw_url:
            continue

        # Skip social media URLs — they serve HTML redirects not images to bots
        try:
            img_domain = raw_url.split('/')[2].lower().lstrip('www.')
            img_domain_full = raw_url.split('/')[2].lower()
        except Exception:
            img_domain = img_domain_full = ''
        if img_domain_full in BLOCKED_IMAGE_DOMAINS or img_domain in BLOCKED_IMAGE_DOMAINS:
            log.info(f'[IMG] Skipping social media URL (bot-redirect risk): {raw_url[:80]}')
            continue

        # Try to upload to R2; fall back to original URL if R2 not configured
        cdn_url = upload_image_to_r2(raw_url, safe_key_slug, img_idx) or raw_url
        tavily_images.append({'url': cdn_url, 'description': desc})

    return True, 'ok', combined, tavily_titles, avg_score, tavily_sources, tavily_images

def trim(text, max_words=1500):
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
def insert_topic(topic, niche, grounding, channel, source, priority, volume=0, breakdown='', tavily_score=0.0, topic_image_url=None, tavily_sources=None, tavily_images=None):
    # Normalize topic to ASCII — prevents dedup failures with accented chars.
    # 'arda guler' -> 'arda guler', 'türkiye vs usa' -> 'turkiye vs usa'.
    # The meaning is preserved; accents only matter for display, not quiz content.
    topic = ascii_normalize(topic)

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
                # Consumed by Worker 12 for blog data_sources / hero+inline images.
                # Previously never populated here -- tavily.search() wasn't even
                # asked for images, and sources were never carried past quality_check().
                'tavily_sources':       tavily_sources or [],
                'tavily_images':        tavily_images or [],
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
    passes, reason, grounding, tavily_titles, avg_score, tavily_sources, tavily_images = quality_check(topic, data, min_words)
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
    ok = insert_topic(topic, niche, trim(grounding, max_words=max(min_words+50, 1500)),
                      channel, source, effective_priority, volume=volume,
                      breakdown=effective_breakdown, tavily_score=avg_score,
                      topic_image_url=topic_image_url,
                      tavily_sources=tavily_sources, tavily_images=tavily_images)
    if ok:
        bd_count = len(_parse_breakdown(effective_breakdown))
        bd_src   = 'google' if (breakdown and breakdown.lower() != topic.lower()) else 'tavily'
        log.info(f'  OK INSERTED [src={source} p={effective_priority} vol={volume:,} '
                 f'score={avg_score:.2f} niche={niche} bd={bd_count}kw/{bd_src}]: {topic[:70]}')
        # Update the in-memory dedup cache immediately so subsequent topics
        # in the same run don't try to re-insert this one before the next
        # cold-start fetch from Supabase.
        today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        cache_key = f'{country}:{today}'
        if hasattr(already_queued, '_cache') and cache_key in already_queued._cache:
            already_queued._cache[cache_key].add(_topic_tokens(topic))
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
        # Normalize to lowercase — trend_config stores 'us', channel may have 'US'
        cc = (country_code or 'us').lower()
        rows = db_get(f'trend_config?country_code=eq.{cc}&is_active=eq.true&limit=1')
        if not rows:
            # Try uppercase fallback
            rows = db_get(f'trend_config?country_code=eq.{cc.upper()}&is_active=eq.true&limit=1')
        if rows:
            cfg = rows[0]
            log.debug(f'  trend_config loaded for {cc}: {cfg}')
            return {
                'max_topics_per_run':  cfg.get('max_topics_per_run')  or defaults['max_topics_per_run'],
                'time_window_hours':   cfg.get('time_window_hours')   or defaults['time_window_hours'],
                'min_volume':          cfg.get('min_volume')          or defaults['min_volume'],
                'min_grounding_words': cfg.get('min_grounding_words') or defaults['min_grounding_words'],
                'max_process_per_run': cfg.get('max_process_per_run') or defaults['max_process_per_run'],
            }
        log.warning(f'  No trend_config row found for country_code={cc} — using defaults')
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
        # Requires Chrome. If it fails for any reason, we skip this channel
        # for this run rather than falling back to another source — trendspyg
        # is now the only topic source by design.
        try:
            time.sleep(TRENDSPYG_DELAY_SEC)
            trends = _fetch_trends_csv(country, hours=cfg['time_window_hours'])
            source_used = f'CSV (hours={cfg["time_window_hours"]})'
        except Exception as e:
            log.warning(f'  CSV path failed: {e}')
            log.warning(f'  Skipping trendspyg for {channel["channel_name"]} this run.')
            log.warning(f'  Check Chrome installation on the runner.')
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
        #
        # BUG FIX: `processed` used to be incremented for EVERY candidate,
        # including ones skipped for being an exact duplicate of something
        # already queued today. When one viral story (e.g. "argentina match")
        # dominates the top of the volume-sorted list across many near-identical
        # entries, ALL of them got counted against max_process_per_run before
        # the loop ever reached a genuinely new, still-unqueued topic further
        # down — even with hundreds of fresh trends available. Duplicate-skips
        # are now checked BEFORE incrementing `processed` and don't count
        # against the cap at all (they cost zero Tavily credits, since
        # already_queued() runs before any Tavily call), so the loop can walk
        # arbitrarily deep past duplicates to find real, fresh candidates.
        inserted   = 0
        processed  = 0   # counts only REAL attempts (post-dedup, pre-Tavily)
        skipped_dup = 0
        target     = override_target if override_target is not None else cfg['max_topics_per_run']
        log.info(f'  Target for this run: {target} quiz-ready topics')
        for t in trends:
            if inserted >= target:
                log.info(f'  Reached target of {target} quiz-ready topics -- stopping')
                break
            if processed >= cfg['max_process_per_run']:
                log.info(f'  Hit process cap ({cfg["max_process_per_run"]}) before target -- stopping '
                         f'(also skipped {skipped_dup} duplicates along the way, uncounted)')
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
            # Dedup check happens here, BEFORE the process cap counts it and
            # BEFORE any Tavily call -- an unlimited number of same-story
            # duplicates can be skipped for free without ever starving the
            # loop of a chance to reach fresh topics further down the list.
            if already_queued(kw, country):
                log.info(f'  SKIP (dup, free -- not counted against process cap): {kw}')
                skipped_dup += 1
                continue
            priority  = volume_to_priority(vol)
            breakdown = t.get('breakdown', '')
            log.info(f'  Processing ({inserted+1}/{target}, vol={vol:,} p={priority}): {kw}')
            processed += 1
            if process_topic(kw, channel, 'trendspyg', priority,
                             min_words=cfg['min_grounding_words'],
                             volume=vol, breakdown=breakdown):
                inserted += 1

        log.info(f'[{channel["channel_name"]}] trendspyg: {inserted}/{target} quiz-ready topics inserted '
                 f'(processed {processed} real attempts, skipped {skipped_dup} duplicates for free)')
        return inserted

    return 0

# -- Main ----------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser()
    # RSS ('rss') and Tavily-gap-filler ('fallback') modes, plus the
    # 'all'/waterfall orchestrator that chained trendspyg -> RSS -> fallback,
    # have been removed by request. trendspyg is now the only topic source.
    # --mode is kept (rather than dropped) so existing workflow_dispatch
    # calls / cron invocations that pass --mode trends keep working unchanged.
    parser.add_argument('--mode', required=False, default='trends',
                        choices=['trends'])
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

    run_trendspyg(channels)

    log.info('Done.')

if __name__ == '__main__':
    main()
