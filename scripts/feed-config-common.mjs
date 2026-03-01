import fs from 'node:fs/promises';
import path from 'node:path';

export const ROOT = process.cwd();
export const FEEDS_JSON_PATH = path.join(ROOT, 'feeds.json');
export const FEEDS_JS_PATH = path.join(ROOT, 'public', 'feeds.js');

const BLOG_SECTION_MATCHERS = ['blog'];
const NEWS_SECTION_MATCHERS = ['security', 'tech', 'news'];

function includesAny(text, tokens) {
  const value = String(text || '').toLowerCase();
  return tokens.some(token => value.includes(token));
}

function normalizeSectionFeeds(sections, matchers) {
  return (sections || [])
    .filter(section => includesAny(section?.title, matchers))
    .flatMap(section => (section?.feeds || []).map(feed => ({
      name: feed.name,
      url: feed.url,
      limit: Number.isFinite(feed.limit) ? feed.limit : 3
    })));
}

function normalizeYouTubeChannels(youtubeChannels = []) {
  return youtubeChannels.map(channel => ({
    name: channel.name,
    url: `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.channel_id}`,
    limit: Number.isFinite(channel.limit) ? channel.limit : 3
  }));
}

function normalizeSubreddits(subreddits = []) {
  return subreddits.map(sub => {
    const cleaned = String(sub || '').replace(/^r\//i, '');
    return {
      name: `r/${cleaned}`,
      url: `https://www.reddit.com/r/${cleaned}/.rss`,
      limit: 3
    };
  });
}

function normalizeTwitchChannels(twitchChannels = []) {
  return twitchChannels.map(channel => ({
    name: channel,
    url: `https://twitchrss.appspot.com/vod/${channel}`,
    limit: 3
  }));
}

export function buildFrontEndFeedsFromJson(rawConfig) {
  const sections = rawConfig?.sections || [];

  return {
    youtube: normalizeYouTubeChannels(rawConfig?.youtube_channels || []),
    blogs: normalizeSectionFeeds(sections, BLOG_SECTION_MATCHERS),
    news: normalizeSectionFeeds(sections, NEWS_SECTION_MATCHERS),
    subreddits: normalizeSubreddits(rawConfig?.subreddits || []),
    twitch: normalizeTwitchChannels(rawConfig?.twitch_channels || [])
  };
}

export async function readFeedsJson() {
  const raw = await fs.readFile(FEEDS_JSON_PATH, 'utf8');
  return JSON.parse(raw);
}

export function parseFeedsJsObject(sourceText) {
  const marker = 'const FEEDS =';
  const start = sourceText.indexOf(marker);

  if (start < 0) {
    throw new Error('Unable to locate "const FEEDS =" in public/feeds.js');
  }

  const objectStart = sourceText.indexOf('{', start);
  if (objectStart < 0) {
    throw new Error('Unable to locate FEEDS object start in public/feeds.js');
  }

  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  let objectEnd = -1;

  for (let i = objectStart; i < sourceText.length; i++) {
    const ch = sourceText[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        escaped = true;
        continue;
      }

      if (ch === quote) {
        inString = false;
        quote = '';
      }

      continue;
    }

    if (ch === '"' || ch === '\'' || ch === '`') {
      inString = true;
      quote = ch;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        objectEnd = i;
        break;
      }
    }
  }

  if (objectEnd < 0) {
    throw new Error('Unable to parse FEEDS object bounds in public/feeds.js');
  }

  const objectLiteral = sourceText.slice(objectStart, objectEnd + 1);

  // Evaluate object literal in isolation (trusted local file)
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; return (${objectLiteral});`)();
}

export async function readFeedsJsObject() {
  const source = await fs.readFile(FEEDS_JS_PATH, 'utf8');
  return parseFeedsJsObject(source);
}

export function toComparableFeedSet(feedsByCategory = {}) {
  const entries = [];

  for (const [category, feeds] of Object.entries(feedsByCategory)) {
    for (const feed of feeds || []) {
      entries.push({
        category,
        name: String(feed?.name || '').trim(),
        url: String(feed?.url || '').trim().toLowerCase(),
        limit: Number.isFinite(feed?.limit) ? feed.limit : 3
      });
    }
  }

  entries.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if (a.url !== b.url) return a.url.localeCompare(b.url);
    return a.name.localeCompare(b.name);
  });

  return entries;
}

export function printDiffReport({ generated, existing }) {
  const generatedSet = new Set(generated.map(x => `${x.category}|${x.url}`));
  const existingSet = new Set(existing.map(x => `${x.category}|${x.url}`));

  const missingInJs = generated.filter(x => !existingSet.has(`${x.category}|${x.url}`));
  const extraInJs = existing.filter(x => !generatedSet.has(`${x.category}|${x.url}`));

  return {
    missingInJs,
    extraInJs,
    inSync: missingInJs.length === 0 && extraInJs.length === 0
  };
}
