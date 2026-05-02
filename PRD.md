# PRD: theprawnfeeds

## Overview
A Python Flask web app that aggregates content from multiple feed sources (RSS feeds, Reddit, YouTube channels, Twitch streams) into a single dashboard. Uses parallel fetching with a thread pool for speed, in-memory caching with ETag/Last-Modified support, and SSRF protection for security. Deployed to Vercel as a serverless Python app.

## Goals
- Aggregate RSS, Reddit, YouTube, and Twitch feeds from a configurable `feeds.json`
- Fetch all feeds in parallel using ThreadPoolExecutor
- Cache feed responses in memory using ETag/Last-Modified conditional GETs
- Serve a clean HTML dashboard with feed items
- Protect against SSRF via URL validation
- Deploy serverlessly on Vercel

## Non-Goals
- User authentication or personalization
- Feed subscription management (feeds are hardcoded in `feeds.json`)
- Persistent database (in-memory cache only)
- Push notifications

## User Stories
- As Bryan, I want a single page that shows me the latest content from all my followed feeds.
- As a visitor, I want to browse aggregated content without signing in.

## Tech Stack
- **Language**: Python 3.x
- **Framework**: Flask
- **Libraries**: `feedparser` (RSS), `requests`, `concurrent.futures` (stdlib)
- **Data**: `feeds.json` (configurable feed list)
- **Deployment**: Vercel (Python serverless via `vercel.json`)

## Architecture
```
theprawnfeeds/
├── main.py              # Flask app + all feed fetching logic
├── feeds.json           # Configured feed sources
├── vercel.json          # Vercel routing config
├── requirements.txt
├── public/              # Static assets
├── static/              # Additional static files
├── scripts/             # Helper scripts
└── api/                 # Vercel serverless API handlers
```

**Parallel fetch workers:**
- RSS: `RSS_MAX_WORKERS = 15`
- Reddit: `REDDIT_MAX_WORKERS = 6`
- YouTube: `YOUTUBE_MAX_WORKERS = 10`
- Twitch: `TWITCH_MAX_WORKERS = 5`
- Overall timeout: `PARALLEL_TIMEOUT = 10s`

## Features (detailed)

### Feed Types
| Type | Source | Method |
|------|--------|--------|
| RSS | Any RSS/Atom URL | `feedparser.parse()` |
| Reddit | Subreddit JSON API | `requests.get()` with Reddit headers |
| YouTube | Channel RSS feed or API | `feedparser` or YouTube Data API |
| Twitch | Twitch Helix API | `requests.get()` with OAuth |

### Parallel Fetching
- `ThreadPoolExecutor` with type-specific worker counts
- `as_completed()` for first-available result collection
- `PARALLEL_TIMEOUT` global timeout prevents long hangs

### In-Memory Caching
- `FEED_CACHE` dict: `{url: {etag, last_modified, data}}`
- Sends `If-None-Match` + `If-Modified-Since` headers on re-fetches
- Returns cached data on HTTP 304 responses

### SSRF Protection
```python
ALLOWED_SCHEMES = {'http', 'https'}
BLOCKED_HOSTS = {'localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', '::1', ...}
```
- Validates URL scheme before any outbound request
- Blocks private IP ranges and metadata endpoints

### Items Per Feed
- `MAX_FETCH_ITEMS = 25` per feed source
- Supports "load more" pagination pattern

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Render feed dashboard HTML |
| `GET` | `/api/feeds` | Return all feed items as JSON |
| `GET` | `/api/feeds/{type}` | Return items for a specific feed type |

## Data / Config
| File | Description |
|------|-------------|
| `feeds.json` | List of feed configs: `{name, url, type, ...}` |

## Environment Variables
| Var | Purpose |
|-----|---------|
| `FLASK_DEBUG` | Enable debug mode (`'true'` / `'false'`) |
| `VERCEL_ENV` / `APP_ENV` / `FLASK_ENV` | Production detection |
| YouTube/Twitch API keys | Required for those feed types |

## Deployment / Run
```bash
pip install -r requirements.txt
python main.py  # local
```
Vercel: auto-detected Python runtime from `vercel.json`.

## Constraints & Notes
- **In-memory cache**: resets on every serverless cold start (Vercel functions are ephemeral)
- **Parallel timeout**: 10s global; slow feeds silently time out and return empty
- **SSRF protection**: blocks IMDS (169.254.169.254) and localhost — important for serverless environments
- **feeds.json**: must be updated manually to add/remove sources; no UI for subscription management
