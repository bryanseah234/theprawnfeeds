const fs = require('node:fs/promises');
const path = require('node:path');

const FEEDS_JSON_PATH = path.join(process.cwd(), 'feeds.json');
const CACHE_TTL_MS = 5 * 60 * 1000;

let cached = {
  at: 0,
  data: null
};

function normalizeLimit(value, fallback = 3) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSectionFeeds(sections, titleMatchers) {
  return (sections || [])
    .filter(section => {
      const title = String(section?.title || '').toLowerCase();
      return titleMatchers.some(matcher => title.includes(matcher));
    })
    .flatMap(section => (section?.feeds || []).map(feed => ({
      name: feed.name,
      url: feed.url,
      limit: normalizeLimit(feed.limit, 3)
    })));
}

function mapFeedsConfig(rawConfig) {
  const sections = rawConfig?.sections || [];

  const youtube = (rawConfig?.youtube_channels || []).map(channel => ({
    name: channel.name,
    url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channel_id}`,
    limit: normalizeLimit(channel.limit, 3)
  }));

  const blogs = normalizeSectionFeeds(sections, ['blog']);
  const security = normalizeSectionFeeds(sections, ['security', 'tech']);

  const subreddits = (rawConfig?.subreddits || []).map(sub => {
    const cleaned = String(sub || '').replace(/^r\//i, '');
    return {
      name: `r/${cleaned}`,
      url: `https://www.reddit.com/r/${cleaned}/.rss`,
      limit: 3
    };
  });

  const twitch = (rawConfig?.twitch_channels || []).map(channel => ({
    name: channel,
    url: `https://twitchrss.appspot.com/vod/${channel}`,
    limit: 3
  }));

  return { youtube, blogs, security, subreddits, twitch };
}

async function loadFeeds() {
  if (cached.data && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }

  const raw = await fs.readFile(FEEDS_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  const mapped = mapFeedsConfig(parsed);

  cached = {
    at: Date.now(),
    data: mapped
  };

  return mapped;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const feeds = await loadFeeds();
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    return res.status(200).json(feeds);
  } catch (error) {
    console.error('[feeds API] Failed to load canonical feeds:', error?.message || error);
    return res.status(500).json({ error: 'Failed to load feeds config' });
  }
};
