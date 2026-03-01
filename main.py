from flask import Flask, render_template, jsonify
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
import ipaddress
import json
import os
import sys
import traceback

import time
import random

app = Flask(__name__, static_folder='public', static_url_path='')

# Simple in-memory cache for conditional GETs
# Format: { url: { 'etag': '...', 'last_modified': '...', 'data': {...} } }
FEED_CACHE = {}

# Enable debug mode only when explicitly configured
app.config['DEBUG'] = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'


def is_production():
    """Return True when running in production environment."""
    vercel_env = os.environ.get('VERCEL_ENV', '').lower()
    app_env = os.environ.get('APP_ENV', '').lower()
    flask_env = os.environ.get('FLASK_ENV', '').lower()
    return vercel_env == 'production' or app_env == 'production' or flask_env == 'production'

# Parallel fetching configuration
PARALLEL_TIMEOUT = 10  # Overall timeout for parallel operations in seconds
RSS_MAX_WORKERS = 15  # Max concurrent RSS feed fetches
REDDIT_MAX_WORKERS = 6  # Max concurrent Reddit fetches
YOUTUBE_MAX_WORKERS = 10  # Max concurrent YouTube fetches
TWITCH_MAX_WORKERS = 5  # Max concurrent Twitch status checks

# Feed fetching configuration
MAX_FETCH_ITEMS = 25  # Maximum items to fetch per feed for load-more support


def log(message):
    """Helper function for logging"""
    print(f"[LOG] {message}", file=sys.stderr, flush=True)


# Security: Allowed schemes and blocked hosts for SSRF protection
ALLOWED_SCHEMES = {'http', 'https'}
BLOCKED_HOSTS = {'localhost', 'localhost.localdomain',
                 '127.0.0.1', '0.0.0.0', '0', '169.254.169.254', '::1'}


def is_safe_url(url):
    """Validate URL to prevent SSRF attacks"""
    try:
        parsed = urlparse(url)
        # Check scheme
        if parsed.scheme.lower() not in ALLOWED_SCHEMES:
            log(f"Blocked URL with invalid scheme: {url}")
            return False
        # Check for blocked hostnames
        hostname = parsed.hostname
        if hostname is None:
            log(f"Blocked URL with missing hostname: {url}")
            return False
        if hostname.lower() in BLOCKED_HOSTS:
            log(f"Blocked URL with forbidden host: {url}")
            return False
        # Check for private/internal IP addresses
        try:
            ip = ipaddress.ip_address(hostname)
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                log(f"Blocked URL with private/internal IP: {url}")
                return False
        except ValueError:
            pass  # Not an IP address, hostname is fine
        return True
    except Exception as e:
        log(f"Error validating URL {url}: {e}")
        return False


def load_feeds_config():
    """Load feeds configuration"""
    try:
        log("Loading feeds.json configuration")
        config_path = os.path.join(os.path.dirname(__file__), 'feeds.json')
        log(f"Config path: {config_path}")
        log(f"Current directory: {os.getcwd()}")
        log(f"Directory contents: {os.listdir(os.path.dirname(__file__) or '.')}")

        if not os.path.exists(config_path):
            log(f"ERROR: feeds.json not found at {config_path}")
            return {"sections": [], "subreddits": []}

        with open(config_path, 'r') as f:
            config = json.load(f)
            log(
                f"Successfully loaded config with {len(config.get('sections', []))} sections")
            return config
    except Exception as e:
        log(f"ERROR loading feeds.json: {e}")
        log(traceback.format_exc())
        return {"sections": [], "subreddits": []}


def fetch_rss_feed(url, limit=5, enable_load_more=True):
    """Fetch and parse RSS feed

    Args:
        url: Feed URL
        limit: Initial display limit
        enable_load_more: If True, fetch up to MAX_FETCH_ITEMS for load-more; if False, only fetch limit

    Returns:
        dict with 'items' (all items), 'error' flag, and 'total_count'
    """
    # Security: Validate URL before fetching
    if not is_safe_url(url):
        log(f"Skipping unsafe URL: {url}")
        return {'items': [], 'error': True, 'error_msg': 'Unsafe URL', 'total_count': 0}

    try:
        # Add random jitter to prevent thundering herd
        time.sleep(random.uniform(0.5, 1.5))

        log(f"Fetching RSS feed: {url}")
        import feedparser
        import requests
        from datetime import datetime
        from dateutil import parser as date_parser

        headers = {
            'User-Agent': 'Mozilla/5.0 (compatible; PrawnFeeds/1.0; +http://localhost:3000)',
            'Accept': 'application/rss+xml, application/xml, text/xml'
        }

        # Check cache for conditional headers
        cached = FEED_CACHE.get(url)
        if cached:
            if cached.get('etag'):
                headers['If-None-Match'] = cached['etag']
            if cached.get('last_modified'):
                headers['If-Modified-Since'] = cached['last_modified']

        response = requests.get(url, headers=headers, timeout=10)

        # Handle 304 Not Modified
        if response.status_code == 304 and cached:
            log(f"Hit existing cache for {url} (304)")
            return cached['data']

        response.raise_for_status()
        log(f"RSS fetch successful: {url} (status: {response.status_code})")

        feed = feedparser.parse(response.content)
        log(f"Parsed {len(feed.entries)} entries from {url}")

        # Fetch more items if requested (for load-more feature)
        max_items = MAX_FETCH_ITEMS if enable_load_more else limit
        items = []
        site_url = ''
        for entry in feed.entries[:max_items]:
            published = entry.get('published', entry.get('updated', ''))
            try:
                if published:
                    dt = date_parser.parse(published)
                    time_ago = get_time_ago(dt)
                else:
                    time_ago = ''
            except Exception as e:
                log(f"Error parsing date: {e}")
                time_ago = ''

            # Extract thumbnail from various sources
            thumbnail = ''

            # Try media:thumbnail
            if hasattr(entry, 'media_thumbnail') and entry.media_thumbnail and len(entry.media_thumbnail) > 0:
                thumbnail = entry.media_thumbnail[0].get('url', '')

            # Try media:content
            elif hasattr(entry, 'media_content') and entry.media_content and len(entry.media_content) > 0:
                media = entry.media_content[0]
                # Check if it's an image
                if media.get('medium') == 'image' or 'image' in media.get('type', ''):
                    thumbnail = media.get('url', '')

            # Try enclosures (common in podcasts and some feeds)
            if not thumbnail and hasattr(entry, 'enclosures') and entry.enclosures:
                for enclosure in entry.enclosures:
                    if enclosure.get('type', '').startswith('image/'):
                        thumbnail = enclosure.get('href', '')
                        break

            items.append({
                'title': entry.get('title', 'No title')[:150],
                'link': entry.get('link', '#'),
                'published': time_ago,
                'thumbnail': thumbnail
            })

        if hasattr(feed, 'feed') and hasattr(feed.feed, 'link'):
            site_url = feed.feed.link

        result = {
            'items': items,
            'error': False,
            'error_msg': '',
            'total_count': len(items),
            'site_url': site_url
        }

        # Update cache
        FEED_CACHE[url] = {
            'etag': response.headers.get('ETag'),
            'last_modified': response.headers.get('Last-Modified'),
            'data': result
        }

        log(f"Returning {len(items)} items from {url}")
        return result
    except Exception as e:
        error_msg = str(e)
        log(f"ERROR fetching {url}: {error_msg}")
        log(traceback.format_exc())
        return {'items': [], 'error': True, 'error_msg': error_msg, 'total_count': 0}


def get_time_ago(dt):
    """Convert datetime to relative time"""
    try:
        from datetime import datetime
        now = datetime.now(dt.tzinfo) if dt.tzinfo else datetime.now()
        diff = now - dt
        seconds = diff.total_seconds()

        if seconds < 60:
            return 'just now'
        elif seconds < 3600:
            return f'{int(seconds / 60)}m ago'
        elif seconds < 86400:
            return f'{int(seconds / 3600)}h ago'
        elif seconds < 604800:
            return f'{int(seconds / 86400)}d ago'
        else:
            return f'{int(seconds / 604800)}w ago'
    except Exception as e:
        log(f"ERROR calculating time ago: {e}")
        return ''


def fetch_reddit(subreddit, limit=5):
    """Fetch Reddit posts with retry logic and RSS fallback"""
    import requests
    import time
    import feedparser

    # Realistic browser-like User-Agent
    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
    }

    log(f"Fetching Reddit: r/{subreddit}")

    # Try JSON endpoint first with retry logic
    json_url = f'https://www.reddit.com/r/{subreddit}/top.json?limit={limit}&t=day'
    max_retries = 3

    for attempt in range(max_retries):
        try:
            response = requests.get(json_url, headers=headers, timeout=10)

            # Check for retryable status codes (429 or 5xx)
            if response.status_code == 429 or response.status_code >= 500:
                response_preview = response.text[:500] if response.text else ''
                log(f"Reddit JSON attempt {attempt + 1}/{max_retries} failed for r/{subreddit}: "
                    f"HTTP {response.status_code}, response: {response_preview}")
                if attempt < max_retries - 1:
                    # Exponential backoff: 1s, 2s, 4s, ...
                    sleep_time = 2 ** attempt
                    log(f"Retrying r/{subreddit} in {sleep_time}s...")
                    time.sleep(sleep_time)
                    continue
                else:
                    log(f"All {max_retries} JSON attempts failed for r/{subreddit}, trying RSS fallback")
                    break

            # Log non-200 status codes with response preview
            if response.status_code != 200:
                response_preview = response.text[:500] if response.text else ''
                log(f"Reddit JSON non-200 status for r/{subreddit}: "
                    f"HTTP {response.status_code}, response: {response_preview}")
                break

            # Parse JSON response
            data = response.json()
            log(f"Reddit JSON fetch successful: r/{subreddit}")

            posts = []
            for post in data['data']['children'][:limit]:
                p = post['data']

                # Extract thumbnail
                thumbnail = ''
                if p.get('thumbnail') and p.get('thumbnail') not in ['self', 'default', 'nsfw', 'spoiler']:
                    thumbnail = p.get('thumbnail')
                elif p.get('preview') and p.get('preview', {}).get('images'):
                    # Get the first preview image
                    images = p['preview']['images']
                    if images and len(images) > 0:
                        image = images[0]
                        if 'source' in image:
                            thumbnail = image['source'].get(
                                'url', '').replace('&amp;', '&')

                posts.append({
                    'title': p.get('title', '')[:150],
                    'link': f"https://reddit.com{p.get('permalink', '')}",
                    'score': p.get('score', 0),
                    'comments': p.get('num_comments', 0),
                    'thumbnail': thumbnail
                })

            log(f"Returning {len(posts)} posts from r/{subreddit}")
            return posts

        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            log(f"Reddit JSON attempt {attempt + 1}/{max_retries} failed for r/{subreddit}: {type(e).__name__}: {e}")
            if attempt < max_retries - 1:
                # Exponential backoff: 1s, 2s, 4s, ...
                sleep_time = 2 ** attempt
                log(f"Retrying r/{subreddit} in {sleep_time}s...")
                time.sleep(sleep_time)
            else:
                log(f"All {max_retries} JSON attempts failed for r/{subreddit}, trying RSS fallback")
        except Exception as e:
            log(f"Reddit JSON error for r/{subreddit}: {type(e).__name__}: {e}")
            log(traceback.format_exc())
            break

    # RSS fallback
    rss_url = f'https://www.reddit.com/r/{subreddit}/.rss'
    log(f"Trying RSS fallback for r/{subreddit}: {rss_url}")

    try:
        response = requests.get(rss_url, headers=headers, timeout=10)

        if response.status_code != 200:
            response_preview = response.text[:500] if response.text else ''
            log(f"Reddit RSS non-200 status for r/{subreddit}: "
                f"HTTP {response.status_code}, response: {response_preview}")
            return []

        feed = feedparser.parse(response.content)
        log(
            f"Reddit RSS fetch successful: r/{subreddit}, {len(feed.entries)} entries")

        posts = []
        for entry in feed.entries[:limit]:
            # Try to extract thumbnail from media elements
            thumbnail = ''
            if hasattr(entry, 'media_thumbnail') and entry.media_thumbnail and len(entry.media_thumbnail) > 0:
                thumbnail = entry.media_thumbnail[0].get('url', '')
            elif hasattr(entry, 'media_content') and entry.media_content and len(entry.media_content) > 0:
                media = entry.media_content[0]
                if media.get('medium') == 'image' or 'image' in media.get('type', ''):
                    thumbnail = media.get('url', '')

            posts.append({
                'title': entry.get('title', 'No title')[:150],
                'link': entry.get('link', '#'),
                'score': 0,  # RSS doesn't provide score
                'comments': 0,  # RSS doesn't provide comment count
                'thumbnail': thumbnail
            })

        log(f"Returning {len(posts)} posts from r/{subreddit} via RSS")
        return posts

    except Exception as e:
        log(
            f"Reddit RSS fallback error for r/{subreddit}: {type(e).__name__}: {e}")
        log(traceback.format_exc())
        return []


def fetch_youtube(channel_id, channel_name, limit=3):
    """Fetch YouTube channel videos via RSS feed with thumbnail support"""
    try:
        log(f"Fetching YouTube: {channel_name} ({channel_id})")
        import feedparser
        import requests
        from datetime import datetime
        from dateutil import parser as date_parser
        import re

        url = f'https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}'
        headers = {
            'User-Agent': 'Mozilla/5.0 (compatible; RSS Reader/1.0)',
            'Accept': 'application/xml, text/xml'
        }
        response = requests.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        log(f"YouTube fetch successful: {channel_name}")

        feed = feedparser.parse(response.content)
        log(f"Parsed {len(feed.entries)} entries from YouTube channel {channel_name}")

        videos = []
        for entry in feed.entries[:limit]:
            published = entry.get('published', entry.get('updated', ''))
            try:
                if published:
                    dt = date_parser.parse(published)
                    time_ago = get_time_ago(dt)
                else:
                    time_ago = ''
            except Exception as e:
                log(f"Error parsing date: {e}")
                time_ago = ''

            # Extract thumbnail from media:thumbnail or construct from video ID
            thumbnail = ''
            if hasattr(entry, 'media_thumbnail') and entry.media_thumbnail and len(entry.media_thumbnail) > 0:
                thumbnail = entry.media_thumbnail[0].get('url', '')
            elif hasattr(entry, 'media_content') and entry.media_content and len(entry.media_content) > 0:
                thumbnail = entry.media_content[0].get('url', '')

            # If no thumbnail found, try to extract video ID from link and construct thumbnail URL
            if not thumbnail:
                video_link = entry.get('link', '')
                video_id_match = re.search(
                    r'(?:v=|/videos/|/embed/|youtu\.be/)([a-zA-Z0-9_-]{11})', video_link)
                if video_id_match:
                    video_id = video_id_match.group(1)
                    thumbnail = f'https://img.youtube.com/vi/{video_id}/mqdefault.jpg'
                    log(f"Constructed thumbnail URL from video ID: {video_id}")

            videos.append({
                'title': entry.get('title', 'No title')[:150],
                'link': entry.get('link', '#'),
                'published': time_ago,
                'thumbnail': thumbnail
            })

        log(f"Returning {len(videos)} videos from {channel_name}")
        return videos
    except Exception as e:
        log(f"ERROR fetching YouTube {channel_name}: {e}")
        log(traceback.format_exc())
        return []


def fetch_twitch_status(channel_name):
    """Fetch Twitch live status using GraphQL API (no OAuth required)"""
    try:
        log(f"Fetching Twitch status: {channel_name}")
        import requests

        # Public Client-ID used by Twitch web (same method as Glance)
        client_id = 'kimne78kx3ncx6brgo4mv6wki5h1ko'

        query = """
        query GetStreamInfo($login: String!) {
            user(login: $login) {
                displayName
                login
                stream {
                    title
                    viewersCount
                    game {
                        name
                    }
                }
            }
        }
        """

        headers = {
            'Client-ID': client_id,
            'Content-Type': 'application/json',
        }

        payload = {
            'query': query,
            'variables': {'login': channel_name.lower()}
        }

        response = requests.post(
            'https://gql.twitch.tv/gql',
            headers=headers,
            json=payload,
            timeout=5
        )
        response.raise_for_status()
        data = response.json()

        log(f"Twitch fetch successful: {channel_name}")

        user_data = data.get('data', {}).get('user')
        if not user_data:
            log(f"Twitch user not found: {channel_name}")
            return {
                'name': channel_name,
                'display_name': channel_name,
                'is_live': False,
                'game': '',
                'viewers': 0,
                'title': ''
            }

        stream = user_data.get('stream')
        if stream:
            game = stream.get('game', {}) or {}
            return {
                'name': user_data.get('login', channel_name),
                'display_name': user_data.get('displayName', channel_name),
                'is_live': True,
                'game': game.get('name', ''),
                'viewers': stream.get('viewersCount', 0),
                'title': stream.get('title', '')[:100]
            }
        return {
            'name': user_data.get('login', channel_name),
            'display_name': user_data.get('displayName', channel_name),
            'is_live': False,
            'game': '',
            'viewers': 0,
            'title': ''
        }
    except Exception as e:
        log(f"ERROR fetching Twitch {channel_name}: {e}")
        log(traceback.format_exc())
        return {
            'name': channel_name,
            'display_name': channel_name,
            'is_live': False,
            'game': '',
            'viewers': 0,
            'title': '',
            'error': True
        }


@app.after_request
def add_header(response):
    response.headers["Cache-Control"] = "public, max-age=300"
    return response


@app.route('/')
def root():
    try:
        log("=== Starting request to root route ===")

        # Load configuration
        config = load_feeds_config()
        log(f"Config loaded. Sections: {len(config.get('sections', []))}")

        sections = config.get('sections', [])
        log(f"Processing {len(sections)} sections")

        # Collect all feeds with section and index info for parallel fetching
        all_feeds = []
        for section_idx, section in enumerate(sections):
            feeds = section.get('feeds', [])
            for feed_idx, feed in enumerate(feeds):
                # Initialize feed data structure
                feed['items'] = []
                feed['all_items'] = []
                feed['error'] = False
                feed['error_msg'] = ''
                feed['initial_limit'] = feed.get('limit', 3)
                all_feeds.append({
                    'section_idx': section_idx,
                    'feed_idx': feed_idx,
                    'feed': feed
                })

        log(f"Total feeds to fetch: {len(all_feeds)}")

        # Fetch all RSS feeds in parallel
        with ThreadPoolExecutor(max_workers=RSS_MAX_WORKERS) as executor:
            future_to_feed = {
                executor.submit(
                    fetch_rss_feed,
                    f['feed']['url'],
                    f['feed'].get('limit', 3),
                    True  # fetch_all=True for load-more support
                ): f for f in all_feeds
            }

            try:
                for future in as_completed(future_to_feed, timeout=PARALLEL_TIMEOUT):
                    feed_info = future_to_feed[future]
                    try:
                        result = future.result()
                        feed_data = sections[feed_info['section_idx']
                                             ]['feeds'][feed_info['feed_idx']]
                        feed_data['all_items'] = result['items']
                        feed_data['items'] = result['items'][:feed_data['initial_limit']]
                        feed_data['error'] = result['error']
                        feed_data['error_msg'] = result['error_msg']
                        feed_data['total_count'] = result['total_count']
                    except Exception as e:
                        log(f"Error fetching {feed_info['feed']['url']}: {e}")
                        feed_data = sections[feed_info['section_idx']
                                             ]['feeds'][feed_info['feed_idx']]
                        feed_data['items'] = []
                        feed_data['all_items'] = []
                        feed_data['error'] = True
                        feed_data['error_msg'] = str(e)
            except TimeoutError:
                log(
                    f"RSS fetching timed out after {PARALLEL_TIMEOUT} seconds. Some feeds may not be loaded.")
                # Cancel pending futures and ensure data is set for timed-out feeds
                for future, feed_info in future_to_feed.items():
                    future.cancel()
                    # Ensure data is set even for timed-out feeds
                    feed_data = sections[feed_info['section_idx']
                                         ]['feeds'][feed_info['feed_idx']]
                    if 'items' not in feed_data:
                        feed_data['items'] = []
                        feed_data['all_items'] = []
                        feed_data['error'] = True
                        feed_data['error_msg'] = 'Timeout'

        log(f"Processed {len(all_feeds)} feeds total")

        # Fetch all subreddits in parallel
        reddit_data = []
        subreddits = config.get('subreddits', [])
        log(f"Processing {len(subreddits)} subreddits")

        with ThreadPoolExecutor(max_workers=REDDIT_MAX_WORKERS) as executor:
            future_to_subreddit = {
                executor.submit(fetch_reddit, sub, 5): sub
                for sub in subreddits
            }

            try:
                for future in as_completed(future_to_subreddit, timeout=PARALLEL_TIMEOUT):
                    subreddit = future_to_subreddit[future]
                    try:
                        posts = future.result()
                        if posts:
                            reddit_data.append({
                                'name': f'r/{subreddit}',
                                'posts': posts
                            })
                    except Exception as e:
                        log(f"Error fetching r/{subreddit}: {e}")
            except TimeoutError:
                log(
                    f"Reddit fetching timed out after {PARALLEL_TIMEOUT} seconds")
                # Cancel pending futures to prevent resource leaks
                for future in future_to_subreddit:
                    future.cancel()

        log(f"Fetched data from {len(reddit_data)} subreddits")

        # Fetch all YouTube channels in parallel
        youtube_data = []
        youtube_channels = config.get('youtube_channels', [])
        log(f"Processing {len(youtube_channels)} YouTube channels")

        with ThreadPoolExecutor(max_workers=YOUTUBE_MAX_WORKERS) as executor:
            future_to_channel = {
                executor.submit(
                    fetch_youtube,
                    channel.get('channel_id'),
                    channel.get('name'),
                    channel.get('limit', 3)
                ): channel for channel in youtube_channels
            }

            try:
                for future in as_completed(future_to_channel, timeout=PARALLEL_TIMEOUT):
                    channel = future_to_channel[future]
                    try:
                        videos = future.result()
                        youtube_data.append({
                            'name': channel.get('name'),
                            'category': channel.get('category', 'General'),
                            'videos': videos,
                            'error': len(videos) == 0
                        })
                    except Exception as e:
                        log(f"Error fetching YouTube {channel.get('name')}: {e}")
                        youtube_data.append({
                            'name': channel.get('name'),
                            'category': channel.get('category', 'General'),
                            'videos': [],
                            'error': True
                        })
            except TimeoutError:
                log(
                    f"YouTube fetching timed out after {PARALLEL_TIMEOUT} seconds")
                # Cancel pending futures to prevent resource leaks
                for future in future_to_channel:
                    future.cancel()

        log(f"Fetched data from {len(youtube_data)} YouTube channels")

        # Fetch all Twitch channels in parallel
        twitch_data = []
        twitch_channels = config.get('twitch_channels', [])
        log(f"Processing {len(twitch_channels)} Twitch channels")

        with ThreadPoolExecutor(max_workers=TWITCH_MAX_WORKERS) as executor:
            future_to_channel = {
                executor.submit(fetch_twitch_status, channel): channel
                for channel in twitch_channels
            }

            try:
                for future in as_completed(future_to_channel, timeout=PARALLEL_TIMEOUT):
                    channel = future_to_channel[future]
                    try:
                        status = future.result()
                        twitch_data.append(status)
                    except Exception as e:
                        log(f"Error fetching Twitch {channel}: {e}")
                        twitch_data.append({
                            'name': channel,
                            'display_name': channel,
                            'is_live': False,
                            'game': '',
                            'viewers': 0,
                            'title': '',
                            'error': True
                        })
            except TimeoutError:
                log(
                    f"Twitch fetching timed out after {PARALLEL_TIMEOUT} seconds")
                # Cancel pending futures to prevent resource leaks
                for future in future_to_channel:
                    future.cancel()

        log(f"Fetched status from {len(twitch_data)} Twitch channels")

        # Sort Twitch data: live channels first, then offline
        twitch_data.sort(key=lambda x: (
            not x.get('is_live', False), x.get('display_name', '').lower()))
        log(f"Sorted Twitch data: live channels first")

        log("=== Rendering template ===")

        return render_template(
            'index.html',
            config=config,
            reddit_data=reddit_data,
            youtube_data=youtube_data,
            twitch_data=twitch_data
        )

    except Exception as e:
        log(f"CRITICAL ERROR in root route: {e}")
        log(traceback.format_exc())

        if is_production():
            return "Internal Server Error", 500

        # Return detailed error page
        error_html = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <title>Error</title>
            <style>
                body {{ font-family: monospace; padding: 20px; background: #1a1a1a; color: #fff; }}
                .error {{ background: #ff4444; padding: 20px; border-radius: 8px; margin: 20px 0; }}
                .trace {{ background: #2a2a2a; padding: 20px; border-radius: 8px; overflow-x: auto; }}
                pre {{ white-space: pre-wrap; word-wrap: break-word; }}
            </style>
        </head>
        <body>
            <h1>Application Error</h1>
            <div class="error">
                <h2>Error: {type(e).__name__}</h2>
                <p>{str(e)}</p>
            </div>
            <div class="trace">
                <h3>Traceback:</h3>
                <pre>{traceback.format_exc()}</pre>
            </div>
        </body>
        </html>
        """
        return error_html, 500


@app.route('/health')
def health():
    log("Health check endpoint called")
    payload: dict[str, object] = {
        "status": "ok",
        "python_version": sys.version,
    }

    # Keep verbose diagnostics out of production responses
    if not is_production():
        payload["cwd"] = os.getcwd()
        payload["files"] = os.listdir('.')

    return jsonify(payload), 200


@app.route('/debug')
def debug():
    """Debug endpoint to check configuration"""
    if is_production():
        return jsonify({"status": "not_available"}), 404

    try:
        config = load_feeds_config()
        return jsonify({
            "status": "ok",
            "config_loaded": True,
            "sections_count": len(config.get('sections', [])),
            "subreddits_count": len(config.get('subreddits', [])),
            "config": config
        }), 200
    except Exception as e:
        return jsonify({
            "status": "error",
            "error": str(e),
            "traceback": traceback.format_exc()
        }), 500


# For Vercel
app = app

if __name__ == '__main__':
    # Only run in debug mode if explicitly set in environment
    debug_mode = os.environ.get('FLASK_DEBUG', 'false').lower() == 'true'
    app.run(host='0.0.0.0', port=5000, debug=debug_mode)
