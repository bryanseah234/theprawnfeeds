const { XMLParser } = require('fast-xml-parser');
const sanitizeHtml = require('sanitize-html');
const dns = require('node:dns').promises;
const net = require('node:net');

// In-memory cache with 60-minute TTL
const cache = new Map();
const CACHE_TTL = 60 * 60 * 1000; // 60 minutes in milliseconds
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  '0',
  '127.0.0.1',
  '::1',
  '169.254.169.254',
  'metadata.google.internal'
]);

/**
 * Check if an IPv4 address is private/internal/reserved.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIpv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) return true;

  const [a, b] = parts;

  // RFC1918 + loopback + link-local + special-use blocks
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true; // multicast/reserved

  return false;
}

/**
 * Check if an IPv6 address is private/internal/reserved.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase();

  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local
  if (normalized.startsWith('fe80')) return true; // link-local

  return false;
}

/**
 * Check whether IP is private/internal.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
  const type = net.isIP(ip);
  if (type === 4) return isPrivateIpv4(ip);
  if (type === 6) return isPrivateIpv6(ip);
  return true;
}

/**
 * Validate outbound feed URL for SSRF safety.
 * @param {string} rawUrl
 * @returns {Promise<URL>}
 */
async function validateFeedUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new Error('Missing feedUrl parameter');
  }

  if (rawUrl.length > 2048) {
    throw new Error('feedUrl is too long');
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid feedUrl format');
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('Only http/https feed URLs are allowed');
  }

  const hostname = parsed.hostname?.toLowerCase();
  if (!hostname) {
    throw new Error('feedUrl must include a hostname');
  }

  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error('Blocked feed host');
  }

  // If hostname is already an IP literal, validate directly.
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error('Blocked private/internal IP');
    }
    return parsed;
  }

  // Resolve DNS and ensure no private/internal targets are returned.
  const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!resolved || resolved.length === 0) {
    throw new Error('Unable to resolve feed host');
  }

  const hasPrivateTarget = resolved.some(record => isPrivateIp(record.address));
  if (hasPrivateTarget) {
    throw new Error('Blocked private/internal feed host resolution');
  }

  return parsed;
}

/**
 * Sanitize text by stripping all HTML tags, images, scripts
 * @param {string} html - Input HTML string
 * @returns {string} - Plain text output
 */
function stripHtml(html) {
  if (!html) return '';
  
  // Use sanitize-html to strip all tags
  const text = sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    textFilter: (text) => text.replace(/\s+/g, ' ')
  });
  
  return text.trim();
}

/**
 * Parse date string to ISO format
 * @param {string} dateStr - Input date string
 * @returns {string} - ISO date string or original string
 */
function parseDate(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    return date.toISOString();
  } catch {
    return dateStr;
  }
}

/**
 * Extract thumbnail URL from RSS item
 * 
 * Extraction priority order:
 * 1. media:thumbnail - Direct thumbnail reference (YouTube, Reddit)
 * 2. media:content with image type - Content with image medium (Reddit, Twitch)
 * 3. enclosure with image type - Attached image files (podcasts, blogs)
 * 4. Constructed YouTube thumbnail - Built from video ID in URL
 * 
 * @param {object} item - RSS item object from parsed feed
 * @returns {string} - Thumbnail URL or empty string if none found
 * 
 * @example
 * // YouTube with media:thumbnail
 * extractThumbnail({ 'media:thumbnail': { '@_url': 'https://i.ytimg.com/vi/abc/hqdefault.jpg' } })
 * // Returns: 'https://i.ytimg.com/vi/abc/hqdefault.jpg'
 * 
 * @example
 * // YouTube without thumbnail, construct from link
 * extractThumbnail({ link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
 * // Returns: 'https://img.youtube.com/vi/dQw4w9WgXcQ/mqdefault.jpg'
 */
function extractThumbnail(item) {
  // Try media:thumbnail (YouTube, Reddit)
  if (item['media:thumbnail'] && item['media:thumbnail']['@_url']) {
    return item['media:thumbnail']['@_url'];
  }
  
  // Try array of media:thumbnail
  if (Array.isArray(item['media:thumbnail']) && item['media:thumbnail'].length > 0) {
    return item['media:thumbnail'][0]['@_url'] || '';
  }
  
  // Try media:content (Reddit, Twitch)
  if (item['media:content']) {
    const mediaContent = Array.isArray(item['media:content']) 
      ? item['media:content'][0] 
      : item['media:content'];
    
    if (mediaContent && (
      mediaContent['@_medium'] === 'image' || 
      (mediaContent['@_type'] && mediaContent['@_type'].includes('image'))
    )) {
      return mediaContent['@_url'] || '';
    }
  }
  
  // Try enclosure (podcasts and some feeds)
  if (item.enclosure && item.enclosure['@_type'] && item.enclosure['@_type'].startsWith('image/')) {
    return item.enclosure['@_url'] || item.enclosure['@_href'] || '';
  }
  
  // Try to construct YouTube thumbnail from video ID in link
  const link = item.link || item.guid || '';
  // YouTube video IDs are always 11 characters (alphanumeric, hyphen, underscore)
  const YOUTUBE_VIDEO_ID_LENGTH = 11;
  const youtubePattern = /(?:youtube\.com|youtu\.be)/i;
  
  if (youtubePattern.test(link)) {
    const videoIdMatch = link.match(/(?:v=|\/videos\/|\/embed\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (videoIdMatch) {
      return `https://img.youtube.com/vi/${videoIdMatch[1]}/mqdefault.jpg`;
    }
  }
  
  return '';
}

/**
 * Extract items from RSS 2.0 feed
 * @param {object} feed - Parsed feed object
 * @param {number} limit - Maximum number of items
 * @returns {Array} - Array of feed items
 */
function parseRss2(feed, limit) {
  const channel = feed.rss?.channel;
  if (!channel) return { title: 'Unknown Feed', items: [] };
  
  const title = channel.title || 'Unknown Feed';
  let items = channel.item || [];
  
  // Ensure items is an array
  if (!Array.isArray(items)) {
    items = [items];
  }
  
  const parsedItems = items.slice(0, limit).map(item => ({
    title: stripHtml(item.title || 'No title'),
    link: item.link || '',
    pubDate: parseDate(item.pubDate),
    text: stripHtml(item.description || item['content:encoded'] || ''),
    thumbnail: extractThumbnail(item)
  }));
  
  return { title, items: parsedItems };
}

/**
 * Extract items from Atom feed
 * @param {object} feed - Parsed feed object
 * @param {number} limit - Maximum number of items
 * @returns {object} - Object with title and items
 */
function parseAtom(feed, limit) {
  const atomFeed = feed.feed;
  if (!atomFeed) return { title: 'Unknown Feed', items: [] };
  
  const title = atomFeed.title || 'Unknown Feed';
  let entries = atomFeed.entry || [];
  
  // Ensure entries is an array
  if (!Array.isArray(entries)) {
    entries = [entries];
  }
  
  const parsedItems = entries.slice(0, limit).map(entry => {
    // Handle different link formats in Atom
    let link = '';
    if (entry.link) {
      if (typeof entry.link === 'string') {
        link = entry.link;
      } else if (Array.isArray(entry.link)) {
        // Find alternate link or first available link
        const alternate = entry.link.find(l => l['@_rel'] === 'alternate' || !l['@_rel']);
        if (alternate) {
          link = alternate['@_href'] || alternate;
        } else if (entry.link[0]) {
          link = entry.link[0]['@_href'] || entry.link[0];
        }
      } else if (entry.link['@_href']) {
        link = entry.link['@_href'];
      }
    }
    
    // Handle different content formats
    let text = '';
    if (entry.content) {
      text = typeof entry.content === 'string' ? entry.content : (entry.content['#text'] || '');
    } else if (entry.summary) {
      text = typeof entry.summary === 'string' ? entry.summary : (entry.summary['#text'] || '');
    }
    
    return {
      title: stripHtml(typeof entry.title === 'string' ? entry.title : (entry.title?.['#text'] || 'No title')),
      link: link,
      pubDate: parseDate(entry.updated || entry.published),
      text: stripHtml(text),
      thumbnail: extractThumbnail(entry)
    };
  });
  
  return { title, items: parsedItems };
}

/**
 * Fetch and parse RSS/Atom feed
 * @param {string} feedUrl - URL of the feed
 * @param {number} limit - Maximum number of items
 * @returns {Promise<object>} - Parsed feed data
 */
async function fetchFeed(feedUrl, limit) {
  // Check cache
  const cacheKey = `${feedUrl}:${limit}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[Cache Hit] ${feedUrl}`);
    return cached.data;
  }
  
  console.log(`[Fetching] ${feedUrl}`);
  
  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  
  try {
    const response = await fetch(feedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; RSS Reader/1.0)',
        'Accept': 'application/rss+xml, application/xml, application/atom+xml, text/xml, */*'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
  
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
  
    const xml = await response.text();
  
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_'
    });
  
    const feed = parser.parse(xml);
  
    let result;
  
    // Detect feed type and parse accordingly
    if (feed.rss) {
      result = parseRss2(feed, limit);
    } else if (feed.feed) {
      result = parseAtom(feed, limit);
    } else if (feed['rdf:RDF']) {
      // RSS 1.0 / RDF format
      const rdf = feed['rdf:RDF'];
      const title = rdf.channel?.title || 'Unknown Feed';
      let items = rdf.item || [];
      if (!Array.isArray(items)) items = [items];
    
      result = {
        title,
        items: items.slice(0, limit).map(item => ({
          title: stripHtml(item.title || 'No title'),
          link: item.link || '',
          pubDate: parseDate(item['dc:date'] || item.pubDate),
          text: stripHtml(item.description || ''),
          thumbnail: extractThumbnail(item)
        }))
      };
    } else {
      throw new Error('Unknown feed format');
    }
  
    // Update cache
    cache.set(cacheKey, {
      timestamp: Date.now(),
      data: result
    });
  
    console.log(`[Parsed] ${feedUrl} - ${result.items.length} items`);
    return result;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Vercel serverless function handler
 */
module.exports = async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Only allow GET requests
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  
  const { feedUrl, limit = '5' } = req.query;
  
  // Validate feedUrl parameter + SSRF safety
  let validatedUrl;
  try {
    const parsed = await validateFeedUrl(feedUrl);
    validatedUrl = parsed.toString();
  } catch (error) {
    return res.status(400).json({ error: error.message || 'Invalid feedUrl' });
  }
  
  // Parse and validate limit (increased to 50 for modal infinite scroll support)
  const parsedLimit = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 50);
  
  try {
    const data = await fetchFeed(validatedUrl, parsedLimit);
    
    // Set cache headers
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=600');
    
    return res.status(200).json(data);
  } catch (error) {
    console.error(`[Error] ${validatedUrl}:`, error.message);
    
    // Return appropriate error status
    if (error.message.includes('HTTP 404')) {
      return res.status(404).json({ error: 'Feed not found' });
    } else if (error.message.includes('timeout') || error.name === 'AbortError') {
      return res.status(504).json({ error: 'Feed request timed out' });
    } else if (error.message.includes('Unknown feed format')) {
      return res.status(422).json({ error: 'Unable to parse feed format' });
    }
    
    return res.status(500).json({ error: 'Failed to fetch feed' });
  }
};
