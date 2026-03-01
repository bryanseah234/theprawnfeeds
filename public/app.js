/**
 * RSS Dashboard - Main Application Logic
 * Handles swipeable navigation, modal, infinite scroll, and feed loading
 */

// Constants
const CONCURRENCY_LIMIT = 3;
const API_ENDPOINT = '/api/rss';
const EXTENDED_FETCH_LIMIT = 20; // Balanced for reliability on mobile while still supporting modal loading
const MODAL_LOAD_INCREMENT = 10;
const MS_PER_DAY = 1000 * 60 * 60 * 24;
const SAFE_PROTOCOLS = new Set(['http:', 'https:']);

// State
let currentSection = 'youtube';
let loadedFeeds = 0;
let totalFeeds = 0;
const failedFeeds = [];
const feedDataCache = new Map();
const sectionScrollPositions = {};

// View state per section (timeline or cards)
const sectionViewState = {
  youtube: 'timeline',
  blogs: 'timeline',
  news: 'timeline',
  subreddits: 'timeline',
  twitch: 'timeline'
};

// Touch handling state
let touchStartX = 0;
let touchStartY = 0;
let touchCurrentX = 0;
let isSwiping = false;

/**
 * Normalize FEEDS object shape for consistent frontend usage.
 */
function normalizeFeedsShape(rawFeeds = {}) {
  return {
    youtube: Array.isArray(rawFeeds?.youtube) ? rawFeeds.youtube : [],
    blogs: Array.isArray(rawFeeds?.blogs) ? rawFeeds.blogs : [],
    news: Array.isArray(rawFeeds?.news) ? rawFeeds.news : [],
    subreddits: Array.isArray(rawFeeds?.subreddits) ? rawFeeds.subreddits : [],
    twitch: Array.isArray(rawFeeds?.twitch) ? rawFeeds.twitch : []
  };
}

/**
 * Build stable signature for FEEDS object comparison.
 */
function getFeedsSignature(rawFeeds = {}) {
  const normalized = normalizeFeedsShape(rawFeeds);
  const rows = [];

  for (const [category, feeds] of Object.entries(normalized)) {
    for (const feed of feeds) {
      rows.push({
        category,
        name: String(feed?.name || '').trim(),
        url: String(feed?.url || '').trim().toLowerCase(),
        limit: Number.isFinite(feed?.limit) ? feed.limit : 3
      });
    }
  }

  rows.sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    if (a.url !== b.url) return a.url.localeCompare(b.url);
    return a.name.localeCompare(b.name);
  });

  return JSON.stringify(rows);
}

/**
 * Load canonical feed config from API, with fallback to bundled feeds.js.
 */
async function loadFeedsConfig() {
  const fallbackFeeds = normalizeFeedsShape(window.FEEDS || {});

  try {
    const response = await fetch('/api/feeds', {
      headers: { 'Accept': 'application/json' }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const canonicalFeeds = normalizeFeedsShape(data);
    window.FEEDS = canonicalFeeds;

    // Reminder: if fallback feeds.js diverges from canonical feeds.json mapping,
    // surface an actionable warning for local maintenance.
    const fallbackCount = Object.values(fallbackFeeds).reduce((sum, items) => sum + items.length, 0);
    if (fallbackCount > 0) {
      const canonicalSig = getFeedsSignature(canonicalFeeds);
      const fallbackSig = getFeedsSignature(fallbackFeeds);

      if (canonicalSig !== fallbackSig) {
        console.warn('[RSS Dashboard] feeds.js safety-net is out of sync with canonical feeds.json. Run: npm run sync:feeds');
      }
    }

    console.log('[RSS Dashboard] Loaded canonical feed config from /api/feeds');
    return;
  } catch (error) {
    const fallbackCount = Object.values(fallbackFeeds).reduce((sum, items) => sum + items.length, 0);

    if (fallbackCount > 0) {
      window.FEEDS = fallbackFeeds;
      console.warn('[RSS Dashboard] Falling back to bundled feeds.js config:', error?.message || error);
      return;
    }

    console.error('[RSS Dashboard] Failed to load feed config from API and fallback config is empty');
    window.FEEDS = normalizeFeedsShape({});
  }
}

/**
 * Initialize the application
 */
async function init() {
  // Set current year
  document.getElementById('year').textContent = new Date().getFullYear();

  // Load feed configuration (canonical API with safe fallback)
  await loadFeedsConfig();

  // Setup theme toggle
  setupThemeToggle();

  // Setup sections and load feeds
  await setupSections();

  // Setup event listeners
  setupTabNavigation();
  setupMobileMenu();
  setupTouchNavigation();
  setupKeyboardNavigation();
  setupViewFab();
  setupModal();

  // Load initial section (YouTube) in timeline view
  switchSection('youtube');

  console.log(`[RSS Dashboard] Initialized with ${totalFeeds} feeds`);
}

/**
 * Setup floating view mode toggle FAB.
 */
function setupViewFab() {
  const fab = document.getElementById('view-fab');
  if (!fab) return;

  fab.addEventListener('click', () => {
    sectionViewState[currentSection] =
      sectionViewState[currentSection] === 'timeline' ? 'cards' : 'timeline';

    renderSectionView(currentSection);
    updateTabIndicator(currentSection);
    updateViewFabIcon();
  });

  updateViewFabIcon();
}

/**
 * Keep floating view FAB icon/label in sync with current section mode.
 */
function updateViewFabIcon() {
  const fab = document.getElementById('view-fab');
  if (!fab) return;

  const isTimeline = sectionViewState[currentSection] === 'timeline';
  // Icon shows the mode users can switch to
  fab.textContent = isTimeline ? '📇' : '📜';
  fab.setAttribute('aria-label', isTimeline ? 'Switch to card view' : 'Switch to timeline view');
  fab.setAttribute('title', isTimeline ? 'Cards view' : 'Timeline view');
}

/**
 * Setup all sections and create feed cards
 */
async function setupSections() {
  const feedConfigs = [];

  // YouTube section
  if (window.FEEDS?.youtube) {
    const grid = document.getElementById('youtube-grid');
    window.FEEDS.youtube.forEach(feed => {
      const card = createFeedCard(feed.name, 'youtube', feed.url);
      grid.appendChild(card);
      feedConfigs.push({ feed, card, grid, section: 'youtube' });
    });
  }

  // Blogs section
  if (window.FEEDS?.blogs) {
    const grid = document.getElementById('blogs-grid');
    window.FEEDS.blogs.forEach(feed => {
      const card = createFeedCard(feed.name, 'blogs', feed.url);
      grid.appendChild(card);
      feedConfigs.push({ feed, card, grid, section: 'blogs' });
    });
  }

  // News section
  if (window.FEEDS?.news) {
    const grid = document.getElementById('news-grid');
    window.FEEDS.news.forEach(feed => {
      const card = createFeedCard(feed.name, 'news', feed.url);
      grid.appendChild(card);
      feedConfigs.push({ feed, card, grid, section: 'news' });
    });
  }

  // Subreddits section
  if (window.FEEDS?.subreddits) {
    const grid = document.getElementById('subreddits-grid');
    window.FEEDS.subreddits.forEach(feed => {
      const card = createFeedCard(feed.name, 'subreddits', feed.url);
      grid.appendChild(card);
      feedConfigs.push({ feed, card, grid, section: 'subreddits' });
    });
  }

  // Twitch section
  if (window.FEEDS?.twitch) {
    const grid = document.getElementById('twitch-grid');
    window.FEEDS.twitch.forEach(feed => {
      const card = createFeedCard(feed.name, 'twitch', feed.url);
      grid.appendChild(card);
      feedConfigs.push({ feed, card, grid, section: 'twitch' });
    });
  }

  totalFeeds = feedConfigs.length;

  // Fetch all feeds with concurrency limit
  await fetchFeedsWithConcurrency(feedConfigs, CONCURRENCY_LIMIT);

  // Hide global loader when done
  const loader = document.getElementById('global-loader');
  if (loader) {
    loader.style.opacity = '0';
    setTimeout(() => {
      loader.style.display = 'none';
    }, 300); // Wait for transition
  }

  // Sort feeds by recency within each section
  sortFeedsByRecency();

  // Display offline feeds section if any (initial check)
  if (failedFeeds.length > 0) {
    displayOfflineFeeds();
  }
}

/**
 * Create a feed card element
 */
function createFeedCard(name, category, url = '') {
  const card = document.createElement('div');
  card.className = 'feed-card loading';
  card.dataset.name = name.toLowerCase();
  card.dataset.category = category;
  card.dataset.url = url;
  card.dataset.feedKey = getFeedCacheKey({ name, url });
  const siteUrl = getSiteUrl(name, category, url);
  card.innerHTML = `
    <div class="feed-card-header">
      <div class="feed-card-header-left">
        <a href="${escapeHtml(sanitizeUrl(siteUrl))}" class="feed-card-title-link" target="_blank" rel="noopener noreferrer">
          <span class="feed-card-title">${escapeHtml(name)}</span>
        </a>
        <span class="feed-card-count">...</span>
      </div>
    </div>
    <ul class="feed-items">
      <li class="loading-skeleton">
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
        <div class="skeleton-line"></div>
      </li>
    </ul>
  `;
  return card;
}

/**
 * Fetch a single feed
 */
async function fetchFeed(feed, card) {
  try {
    const url = `${API_ENDPOINT}?feedUrl=${encodeURIComponent(feed.url)}&limit=${EXTENDED_FETCH_LIMIT}`;
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();

    // Cache the feed data
    feedDataCache.set(getFeedCacheKey(feed), data);

    updateFeedCard(card, data, feed.limit);
  } catch (error) {
    showFeedError(card, error.message, feed);
  } finally {
    loadedFeeds++;
  }
}

/**
 * Fetch feeds with concurrency limit
 */
async function fetchFeedsWithConcurrency(feedConfigs, limit) {
  const queue = [...feedConfigs];
  const executing = [];

  while (queue.length > 0 || executing.length > 0) {
    while (executing.length < limit && queue.length > 0) {
      const { feed, card } = queue.shift();
      const promise = fetchFeed(feed, card).then(() => {
        executing.splice(executing.indexOf(promise), 1);
      });
      executing.push(promise);
    }

    if (executing.length > 0) {
      await Promise.race(executing);
    }
  }
}

/**
 * Filter out Reddit pinned posts from items array
 * Pinned posts appear first in Reddit feeds but have older dates than subsequent posts
 */
function filterPinnedPosts(items, feedUrl, feedName) {
  const isRedditFeed = feedUrl?.includes('reddit.com') || feedName?.toLowerCase().startsWith('r/');

  if (!isRedditFeed || items.length <= 2) {
    return items;
  }

  // Find how many items at the start are "out of order" (older than later items)
  let pinnedCount = 0;
  for (let i = 0; i < Math.min(5, items.length - 1); i++) {
    const currentDate = new Date(items[i]?.pubDate);
    const nextDate = new Date(items[i + 1]?.pubDate);

    // If this item is older than the next, it's likely pinned
    if (!isNaN(currentDate) && !isNaN(nextDate) && currentDate < nextDate) {
      pinnedCount = i + 1;
    } else {
      break; // Once we find chronological order, stop
    }
  }

  // Return items without the pinned ones
  return items.slice(pinnedCount);
}

/**
 * Update feed card with data
 */
function updateFeedCard(card, data, initialLimit = 3) {
  card.classList.remove('loading');

  const headerEl = card.querySelector('.feed-card-header');
  const category = card.dataset.category;

  // Update title link based on category
  const titleLink = card.querySelector('.feed-card-title-link');
  if (titleLink) {
    // For blogs/news, prefer site_url from backend if available
    let siteUrl = getSiteUrl(card.dataset.name, category, card.dataset.url);

    if ((category === 'blogs' || category === 'news') && data.site_url) {
      siteUrl = data.site_url;
    }

    titleLink.href = sanitizeUrl(siteUrl);
  }

  // Update count
  const countEl = card.querySelector('.feed-card-count');
  const itemsEl = card.querySelector('.feed-items');

  // Filter out Reddit pinned posts
  const feedName = card.dataset.name;
  const feedUrl = card.dataset.url || '';
  const filteredItems = filterPinnedPosts(data.items, feedUrl, feedName);
  const itemsByDate = sortItemsByDateDesc(filteredItems);

  // Use date-sorted items for display to keep feeds fresh and consistent
  const items = itemsByDate;

  if (items.length === 0) {
    // Treat as offline feed - mark as error for offline section
    card.classList.add('error');
    itemsEl.innerHTML = '<li class="error-message">No items available</li>';
    countEl.textContent = '0 items';

    // Track as failed feed for offline section
    const feedName = card.dataset.name || 'Unknown Feed';
    const failure = {
      key: card.dataset.feedKey || getFeedCacheKey({ name: feedName, url: feedUrl }),
      name: feedName,
      url: feedUrl,
      category: card.dataset.category,
      error: 'No items available'
    };

    const alreadyTracked = failedFeeds.some(f => f.key === failure.key);
    if (!alreadyTracked) {
      failedFeeds.push(failure);
    }

    // Treat as offline feed - hide immediately from main grid
    card.classList.add('error');
    card.style.display = 'none'; // Immediate hide

    // Update offline section immediately
    displayOfflineFeeds();

    return;
  }

  // Store the most recent article date for sorting
  if (items[0]?.pubDate) {
    card.dataset.latestDate = items[0].pubDate;

    // Apply recency-based color class
    const recencyClass = getRecencyClass(items[0].pubDate);
    card.classList.add(recencyClass);
  }

  // Store all items in dataset (filtered)
  card.dataset.allItems = JSON.stringify(items);
  card.dataset.visibleCount = Math.min(initialLimit, items.length);

  // Show initial items
  const initialItems = items.slice(0, initialLimit);
  itemsEl.innerHTML = initialItems.map((item, index) => {
    const articleRecencyClass = getRecencyClass(item.pubDate);
    return `
    <li class="feed-item ${articleRecencyClass}" data-index="${index}">
      <a href="${escapeHtml(sanitizeUrl(item.link))}" class="feed-item-link" target="_blank" rel="noopener noreferrer">
        ${item.thumbnail ? `<img src="${escapeHtml(sanitizeUrl(item.thumbnail))}" alt="" class="feed-item-thumbnail" loading="lazy">` : ''}
        <div class="feed-item-content">
          <div class="feed-item-title">${escapeHtml(item.title)}</div>
          ${item.text ? `<div class="feed-item-text">${escapeHtml(truncateText(item.text))}</div>` : ''}
          <div class="feed-item-meta">${formatRelativeTime(item.pubDate)}</div>
        </div>
      </a>
    </li>
  `;
  }).join('');

  // Add load more button to header if needed
  if (items.length > initialLimit) {
    // Remove existing load more button if any
    const existingBtn = headerEl.querySelector('.load-more-btn');
    if (existingBtn) existingBtn.remove();

    const loadMoreBtn = document.createElement('button');
    loadMoreBtn.className = 'load-more-btn';
    loadMoreBtn.textContent = `Load More (${items.length - initialLimit})`;
    loadMoreBtn.dataset.feedName = card.dataset.name;

    // Add click handler
    loadMoreBtn.addEventListener('click', (e) => {
      e.preventDefault();
      // Pass filtered items to modal
      openModal(card.dataset.name, { items: items });
    });

    headerEl.appendChild(loadMoreBtn);
  }

  countEl.textContent = `${initialItems.length} of ${items.length}`;
}

/**
 * Sort feed items by publication date, newest first.
 * Invalid dates are pushed to the end while preserving relative order.
 */
function sortItemsByDateDesc(items = []) {
  return [...items].sort((a, b) => {
    const dateA = new Date(a?.pubDate || '').getTime();
    const dateB = new Date(b?.pubDate || '').getTime();
    const validA = !isNaN(dateA);
    const validB = !isNaN(dateB);

    if (validA && validB) return dateB - dateA;
    if (validA) return -1;
    if (validB) return 1;
    return 0;
  });
}

/**
 * Show error state on feed card
 */
function showFeedError(card, error, feed) {
  card.classList.remove('loading');
  card.classList.add('error');

  const countEl = card.querySelector('.feed-card-count');
  const itemsEl = card.querySelector('.feed-items');

  countEl.textContent = 'Error';
  itemsEl.innerHTML = '<li class="error-message">Failed to load feed</li>';

  // Track failed feed for grouping
  const failure = {
    key: card.dataset.feedKey || getFeedCacheKey(feed),
    name: feed.name,
    url: feed.url,
    category: card.dataset.category,
    error: error
  };

  // Avoid duplicate entries for the same feed
  const alreadyTracked = failedFeeds.some(f => f.key === failure.key);
  if (!alreadyTracked) {
    failedFeeds.push(failure);
  }

  console.error(`[Feed Error] ${card.dataset.name}:`, error);

  // Immediate hide from main grid
  card.style.display = 'none';

  // Update offline section immediately
  displayOfflineFeeds();
}

/**
 * Display offline feeds section
 */
function displayOfflineFeeds() {
  // Filter based on current section
  filterOfflineFeeds(currentSection);
}

/**
 * Toggle offline feeds section
 */
function toggleOfflineSection() {
  const content = document.getElementById('offline-content');
  const header = document.querySelector('.offline-header');
  const indicator = document.querySelector('.offline-header .collapse-indicator');

  if (content.classList.contains('expanded')) {
    content.classList.remove('expanded');
    header.classList.remove('expanded');
    header.setAttribute('aria-expanded', 'false');
    indicator.textContent = '▼';
  } else {
    content.classList.add('expanded');
    header.classList.add('expanded');
    header.setAttribute('aria-expanded', 'true');
    indicator.textContent = '▲';
  }
}

// Make it globally accessible for onclick
window.toggleOfflineSection = toggleOfflineSection;

/**
 * Setup tab navigation with view toggle
 */
function setupTabNavigation() {
  const tabs = document.querySelectorAll('.header-tab');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const section = tab.dataset.section;
      handleTabClick(section);
    });
  });
}

/**
 * Handle tab click - switch section or toggle view
 */
function handleTabClick(section) {
  if (section !== currentSection) {
    // Different tab clicked - switch section
    switchSection(section);
  }

  // Update mobile nav active state
  updateMobileNavActive(section);
}

/**
 * Setup mobile menu interactions
 */
function setupMobileMenu() {
  const hamburgerBtn = document.getElementById('hamburger-btn');
  const mobileNavDropdown = document.getElementById('mobile-nav-dropdown');
  const mobileThemeBtn = document.getElementById('mobile-theme-btn');
  const mobileThemeDropdown = document.getElementById('mobile-theme-dropdown');

  // Hamburger menu toggle
  if (hamburgerBtn && mobileNavDropdown) {
    hamburgerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = hamburgerBtn.classList.toggle('active');
      mobileNavDropdown.classList.toggle('active', isOpen);
      hamburgerBtn.setAttribute('aria-expanded', isOpen);
      mobileNavDropdown.setAttribute('aria-hidden', !isOpen);

      // Close theme dropdown if open
      if (mobileThemeDropdown) {
        mobileThemeDropdown.classList.remove('active');
        mobileThemeBtn?.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Mobile nav item clicks
  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const section = item.dataset.section;
      handleTabClick(section);

      // Close dropdown
      hamburgerBtn?.classList.remove('active');
      mobileNavDropdown?.classList.remove('active');
      hamburgerBtn?.setAttribute('aria-expanded', 'false');
      mobileNavDropdown?.setAttribute('aria-hidden', 'true');
    });
  });

  // Mobile theme button toggle
  if (mobileThemeBtn && mobileThemeDropdown) {
    mobileThemeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = mobileThemeDropdown.classList.toggle('active');
      mobileThemeBtn.setAttribute('aria-expanded', isOpen);

      // Close nav dropdown if open
      if (mobileNavDropdown) {
        mobileNavDropdown.classList.remove('active');
        hamburgerBtn?.classList.remove('active');
        hamburgerBtn?.setAttribute('aria-expanded', 'false');
      }
    });
  }

  // Mobile theme option clicks
  document.querySelectorAll('.mobile-theme-option').forEach(option => {
    option.addEventListener('click', () => {
      const theme = option.dataset.theme;

      // Apply theme using existing theme logic
      localStorage.setItem('prawnfeeds-theme', theme);
      applyThemeFromStorage();

      // Update active state
      document.querySelectorAll('.mobile-theme-option').forEach(opt =>
        opt.classList.toggle('active', opt.dataset.theme === theme)
      );

      // Close dropdown
      mobileThemeDropdown?.classList.remove('active');
      mobileThemeBtn?.setAttribute('aria-expanded', 'false');
    });
  });

  // Close dropdowns when clicking outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.mobile-nav-dropdown') &&
      !e.target.closest('.hamburger-btn')) {
      mobileNavDropdown?.classList.remove('active');
      hamburgerBtn?.classList.remove('active');
      hamburgerBtn?.setAttribute('aria-expanded', 'false');
      mobileNavDropdown?.setAttribute('aria-hidden', 'true');
    }

    if (!e.target.closest('.mobile-theme-dropdown') &&
      !e.target.closest('.mobile-theme-btn')) {
      mobileThemeDropdown?.classList.remove('active');
      mobileThemeBtn?.setAttribute('aria-expanded', 'false');
    }
  });
}

/**
 * Update mobile nav active state
 */
function updateMobileNavActive(section) {
  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.section === section);
  });
}

/**
 * Apply theme from storage (helper for mobile theme)
 */
function applyThemeFromStorage() {
  const theme = localStorage.getItem('prawnfeeds-theme') || 'system';
  let actualTheme = theme;
  if (theme === 'system') {
    actualTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', actualTheme);

  // Update desktop theme buttons
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.theme === theme);
  });
}

/**
 * Setup theme toggle
 */
function setupThemeToggle() {
  const STORAGE_KEY = 'prawnfeeds-theme';
  const DEFAULT_THEME = 'system';

  function getSystemTheme() {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function getSavedTheme() {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_THEME;
  }

  function applyTheme(theme) {
    let actualTheme = theme;
    if (theme === 'system') {
      actualTheme = getSystemTheme();
    }
    document.documentElement.setAttribute('data-theme', actualTheme);

    // Update active button
    document.querySelectorAll('.theme-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === theme);
    });
  }

  function setTheme(theme) {
    localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
  }

  // Apply theme immediately
  applyTheme(getSavedTheme());

  // Add click handlers
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', function () {
      setTheme(this.dataset.theme);
    });
  });

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (getSavedTheme() === 'system') {
      applyTheme('system');
    }
  });
}

/**
 * Setup touch navigation for swipe gestures
 */
function setupTouchNavigation() {
  const wrapper = document.getElementById('sections-wrapper');
  const container = document.querySelector('.sections-container');

  container.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    isSwiping = false;
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!touchStartX) return;

    touchCurrentX = e.touches[0].clientX;
    const touchCurrentY = e.touches[0].clientY;

    const diffX = touchCurrentX - touchStartX;
    const diffY = touchCurrentY - touchStartY;

    // Detect horizontal swipe (more horizontal than vertical)
    if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 10) {
      isSwiping = true;
      container.classList.add('swiping');
    }
  }, { passive: true });

  container.addEventListener('touchend', (e) => {
    if (!isSwiping) {
      touchStartX = 0;
      touchStartY = 0;
      container.classList.remove('swiping');
      return;
    }

    const diffX = touchCurrentX - touchStartX;
    const threshold = 50; // Minimum swipe distance

    if (Math.abs(diffX) > threshold) {
      if (diffX > 0) {
        // Swipe right - previous section
        navigateToPreviousSection();
      } else {
        // Swipe left - next section
        navigateToNextSection();
      }
    }

    touchStartX = 0;
    touchStartY = 0;
    touchCurrentX = 0;
    isSwiping = false;
    container.classList.remove('swiping');
  }, { passive: true });
}

/**
 * Setup keyboard navigation
 */
function setupKeyboardNavigation() {
  document.addEventListener('keydown', (e) => {
    // Only handle arrow keys when modal is not open
    if (document.getElementById('modal-overlay').classList.contains('active')) {
      return;
    }

    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      navigateToPreviousSection();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      navigateToNextSection();
    }
  });
}

/**
 * Navigate to previous section
 */
function navigateToPreviousSection() {
  const sections = ['youtube', 'blogs', 'news', 'subreddits', 'twitch'];
  const currentIndex = sections.indexOf(currentSection);

  if (currentIndex > 0) {
    switchSection(sections[currentIndex - 1]);
  }
}

/**
 * Navigate to next section
 */
function navigateToNextSection() {
  const sections = ['youtube', 'blogs', 'news', 'subreddits', 'twitch'];
  const currentIndex = sections.indexOf(currentSection);

  if (currentIndex < sections.length - 1) {
    switchSection(sections[currentIndex + 1]);
  }
}

/**
 * Switch to a different section
 */
function switchSection(sectionName) {
  // Save scroll position of current section
  const currentSectionEl = document.querySelector(`#${currentSection}-section`);
  if (currentSectionEl) {
    sectionScrollPositions[currentSection] = window.scrollY;
  }

  // Update active states and ARIA attributes
  document.querySelectorAll('.section').forEach(s => {
    s.classList.remove('active');
    s.setAttribute('aria-hidden', 'true');
  });
  document.querySelectorAll('.header-tab').forEach(t => {
    t.classList.remove('active');
    t.setAttribute('aria-selected', 'false');
  });

  const newSection = document.getElementById(`${sectionName}-section`);
  const newTab = document.querySelector(`.header-tab[data-section="${sectionName}"]`);

  if (newSection && newTab) {
    newSection.classList.add('active');
    newSection.setAttribute('aria-hidden', 'false');
    newTab.classList.add('active');
    newTab.setAttribute('aria-selected', 'true');
    currentSection = sectionName;

    // Render section in its saved view mode
    renderSectionView(sectionName);
    updateTabIndicator(sectionName);

    // Restore scroll position
    setTimeout(() => {
      const savedPosition = sectionScrollPositions[sectionName] || 0;
      window.scrollTo(0, savedPosition);
    }, 50);
  }

  // Filter offline feeds by current section
  filterOfflineFeeds(sectionName);
  updateViewFabIcon();
}

/**
 * Update tab indicator to show current view mode
 */
function updateTabIndicator(section) {
  const tab = document.querySelector(`.header-tab[data-section="${section}"]`);
  if (!tab) return;

  const viewMode = sectionViewState[section];
  if (viewMode === 'timeline') {
    tab.classList.add('timeline-view');
  } else {
    tab.classList.remove('timeline-view');
  }
}

/**
 * Render section in current view mode (timeline or cards)
 */
function renderSectionView(section) {
  const grid = document.getElementById(`${section}-grid`);
  if (!grid) return;

  const viewMode = sectionViewState[section];

  if (viewMode === 'timeline') {
    renderTimelineView(section, grid);
  } else {
    renderCardView(section, grid);
  }
}

/**
 * Render timeline view - chronological list of all articles from last 30 days, grouped by day
 */
function renderTimelineView(section, grid) {
  // Get all feeds for this section
  const feeds = getSectionFeeds(section);
  if (!feeds || feeds.length === 0) {
    grid.innerHTML = '<div class="timeline-empty"><div class="timeline-empty-icon">📭</div><h3>No feeds available</h3><p>Check back later for updates</p></div>';
    return;
  }

  // FORCE FULL WIDTH: Add class to grid container to override 2-column layout
  grid.classList.add('timeline-mode');

  // Get timeline articles (last 30 days, sorted chronologically)
  const allArticles = getTimelineArticles(feeds);
  const articles = allArticles;

  if (articles.length === 0) {
    grid.innerHTML = '<div class="timeline-empty"><div class="timeline-empty-icon">📭</div><h3>No recent articles</h3><p>No articles from the last 30 days</p></div>';
    return;
  }

  // Group articles by day
  const dayGroups = groupArticlesByDay(articles);

  // Render timeline with day groups
  const timelineHTML = `
    <div class="timeline-container">
      ${dayGroups.map(group => `
        <div class="timeline-day-group ${group.recencyClass}">
          <div class="timeline-day-header">
            <span class="timeline-day-label">${group.label}</span>
            <span class="timeline-day-count">${group.articles.length} ${group.articles.length === 1 ? 'article' : 'articles'}</span>
          </div>
          <div class="timeline-day-articles">
            ${group.articles.map(article => {
    const recencyClass = getRecencyClass(article.pubDate);
    return `
                <article class="timeline-item ${recencyClass}">
                  <a href="${escapeHtml(sanitizeUrl(article.link))}" class="timeline-item-link" target="_blank" rel="noopener noreferrer">
                    ${article.thumbnail ? `<img src="${escapeHtml(sanitizeUrl(article.thumbnail))}" alt="" class="timeline-item-thumbnail" loading="lazy">` : ''}
                    <div class="timeline-item-content">
                      <div class="timeline-item-title">${escapeHtml(article.title)}</div>
                      ${article.text ? `<div class="timeline-item-text">${escapeHtml(truncateText(article.text))}</div>` : ''}
                      <div class="timeline-item-meta">${escapeHtml(article.sourceName)} · ${formatRelativeTime(article.pubDate)}</div>
                    </div>
                  </a>
                </article>
              `;
  }).join('')}
          </div>
        </div>
      `).join('')}
    </div>
  `;

  grid.innerHTML = timelineHTML;
}

/**
 * Group articles by publication day
 */
function groupArticlesByDay(articles) {
  const groups = new Map();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  articles.forEach(article => {
    const articleDate = new Date(article.pubDate);
    articleDate.setHours(0, 0, 0, 0);
    const dateKey = articleDate.toISOString().split('T')[0];

    if (!groups.has(dateKey)) {
      groups.set(dateKey, {
        date: articleDate,
        label: formatDayLabel(articleDate, today, yesterday),
        recencyClass: getRecencyClass(article.pubDate),
        articles: []
      });
    }
    groups.get(dateKey).articles.push(article);
  });

  // Convert to array and sort by date (newest first)
  return Array.from(groups.values()).sort((a, b) => b.date - a.date);
}

/**
 * Format day label (Today, Yesterday, weekday, or date)
 */
function formatDayLabel(date, today, yesterday) {
  if (date.getTime() === today.getTime()) {
    return 'Today';
  }
  if (date.getTime() === yesterday.getTime()) {
    return 'Yesterday';
  }

  // Check if within this week (last 7 days)
  const daysAgo = Math.floor((today - date) / (1000 * 60 * 60 * 24));
  if (daysAgo < 7) {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return weekdays[date.getDay()];
  }

  // Format as "Dec 19" for older dates
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getDate()}`;
}

/**
 * Render card view - feeds grouped by source
 */
function renderCardView(section, grid) {
  // Restore original card view by re-showing all feed cards
  // Remove timeline mode class to restore standard grid layout
  grid.classList.remove('timeline-mode');

  // Clear grid to rebuild (simplest way to ensure correct order and state)
  grid.innerHTML = '';

  const feeds = getSectionFeeds(section);
  if (!feeds) return;
  let renderedCount = 0;

  feeds.forEach(feed => {
    // Check if this feed has failed
    const feedKey = getFeedCacheKey(feed);
    const isFailed = failedFeeds.some(f => f.key === feedKey);
    if (isFailed) {
      // Do not render in main grid, it belongs in offline section
      return;
    }

    // Create card
    const card = createFeedCard(feed.name, section, feed.url);
    grid.appendChild(card);

    // Populate with cached data if available
    const cachedData = feedDataCache.get(feedKey);

    if (cachedData) {
      updateFeedCard(card, cachedData, feed.limit);
    }

    renderedCount += 1;
  });

  // Sort cards by recency
  sortFeedsByRecencyInGrid(grid);

  if (renderedCount === 0) {
    grid.innerHTML = '<div class="timeline-empty"><div class="timeline-empty-icon">📭</div><h3>No feeds available</h3><p>Check back later for updates</p></div>';
  }
}

/**
 * Get feeds for a section
 */
function getSectionFeeds(section) {
  if (!window.FEEDS) return null;

  const sectionMap = {
    'youtube': window.FEEDS.youtube,
    'blogs': window.FEEDS.blogs,
    'news': window.FEEDS.news,
    'subreddits': window.FEEDS.subreddits,
    'twitch': window.FEEDS.twitch
  };

  return sectionMap[section];
}

/**
 * Get timeline articles - merge all feeds, filter last 30 days, sort chronologically
 */
function getTimelineArticles(feeds) {
  const oneMonthAgo = new Date();
  oneMonthAgo.setDate(oneMonthAgo.getDate() - 30);

  const allArticles = [];

  feeds.forEach(feed => {
    const cachedData = feedDataCache.get(getFeedCacheKey(feed));
    if (cachedData && cachedData.items) {
      // For Reddit feeds, detect pinned posts by checking if early items have older dates
      const items = cachedData.items;
      const isRedditFeed = feed.url?.includes('reddit.com') || feed.name?.toLowerCase().startsWith('r/');

      let pinnedCount = 0;
      if (isRedditFeed && items.length > 2) {
        // Find how many items at the start are "out of order" (older than later items)
        // Pinned posts typically appear first but have older dates
        for (let i = 0; i < Math.min(5, items.length - 1); i++) {
          const currentDate = new Date(items[i]?.pubDate);
          const nextDate = new Date(items[i + 1]?.pubDate);

          // If this item is older than the next, it's likely pinned
          if (!isNaN(currentDate) && !isNaN(nextDate) && currentDate < nextDate) {
            pinnedCount = i + 1;
          } else {
            break; // Once we find chronological order, stop
          }
        }
      }

      items.forEach((item, index) => {
        // Skip pinned posts (first N items that are out of chronological order)
        if (isRedditFeed && index < pinnedCount) {
          return; // Skip this pinned post
        }

        allArticles.push({
          ...item,
          sourceName: feed.name,
          sourceUrl: feed.url
        });
      });
    }
  });

  // Filter to last 30 days and sort by date (newest first)
  return allArticles
    .filter(article => {
      const articleDate = new Date(article.pubDate);
      return !isNaN(articleDate.getTime()) && articleDate >= oneMonthAgo;
    })
    .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
}

/**
 * Setup modal functionality
 */
function setupModal() {
  const overlay = document.getElementById('modal-overlay');
  const closeBtn = document.getElementById('modal-close');

  // Close on button click
  closeBtn.addEventListener('click', closeModal);

  // Close on overlay click (outside modal)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      closeModal();
    }
  });

  // Close on ESC key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.classList.contains('active')) {
      closeModal();
    }
  });

  // Setup infinite scroll
  const modalBody = document.getElementById('modal-body');
  modalBody.addEventListener('scroll', handleModalScroll);
}

let modalLoadOffset = 0;
let modalTotalItems = 0;
let modalIsLoading = false;
let modalItems = [];

/**
 * Open modal with feed data
 */
function openModal(feedName, feedData) {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');

  // Find feed name in cache
  const cacheKey = Object.keys(window.FEEDS).find(category =>
    window.FEEDS[category].some(f => f.name.toLowerCase() === feedName.toLowerCase())
  );

  if (cacheKey) {
    const feed = window.FEEDS[cacheKey].find(f => f.name.toLowerCase() === feedName.toLowerCase());
    title.textContent = feed.name;
  } else {
    title.textContent = feedName;
  }

  // Reset modal state
  modalLoadOffset = 15; // Show 15 total: skip 3 shown in card, display next 12 in modal
  modalItems = feedData.items;
  modalTotalItems = feedData.items.length;
  modalIsLoading = false;

  // Load initial items (skip first 3 that are already shown in card, show up to 15 total)
  const initialItems = modalItems.slice(3, modalLoadOffset);
  body.innerHTML = '<ul class="feed-items">' +
    initialItems.map((item, index) => {
      const recencyClass = getRecencyClass(item.pubDate);
      return `<li class="feed-item ${recencyClass}" data-index="${index + 3}">${createFeedItemHTML(item, index + 3)}</li>`;
    }).join('') +
    '</ul>';

  // Show modal
  overlay.classList.add('active');
  document.body.classList.add('modal-open');

  // Reset scroll position
  body.scrollTop = 0;
}

/**
 * Close modal
 */
function closeModal() {
  const overlay = document.getElementById('modal-overlay');
  overlay.classList.remove('active');
  document.body.classList.remove('modal-open');
}

/**
 * Handle modal scroll for infinite loading
 */
function handleModalScroll() {
  const body = document.getElementById('modal-body');
  const loading = document.getElementById('modal-loading');

  // Check if near bottom (within 200px)
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 200;

  if (nearBottom && !modalIsLoading && modalLoadOffset < modalTotalItems) {
    modalIsLoading = true;
    loading.style.display = 'block';
    loading.setAttribute('aria-busy', 'true');

    // Simulate loading delay (can be adjusted)
    setTimeout(() => {
      loadMoreModalItems();
      loading.style.display = 'none';
      loading.setAttribute('aria-busy', 'false');
      modalIsLoading = false;
    }, 300);
  }
}

/**
 * Load more items in modal
 */
function loadMoreModalItems() {
  const body = document.getElementById('modal-body');
  const ul = body.querySelector('.feed-items');

  const nextOffset = Math.min(modalLoadOffset + MODAL_LOAD_INCREMENT, modalTotalItems);
  const newItems = modalItems.slice(modalLoadOffset, nextOffset);

  newItems.forEach((item, index) => {
    const li = document.createElement('li');
    const recencyClass = getRecencyClass(item.pubDate);
    li.className = `feed-item ${recencyClass}`;
    li.dataset.index = modalLoadOffset + index;
    li.innerHTML = createFeedItemHTML(item, modalLoadOffset + index);
    ul.appendChild(li);
  });

  modalLoadOffset = nextOffset;
}

/**
 * Create feed item HTML (inner content only, without <li> wrapper)
 */
function createFeedItemHTML(item, index) {
  return `
    <a href="${escapeHtml(sanitizeUrl(item.link))}" class="feed-item-link" target="_blank" rel="noopener noreferrer">
      ${item.thumbnail ? `<img src="${escapeHtml(sanitizeUrl(item.thumbnail))}" alt="" class="feed-item-thumbnail" loading="lazy">` : ''}
      <div class="feed-item-content">
        <div class="feed-item-title">${escapeHtml(item.title)}</div>
        ${item.text ? `<div class="feed-item-text">${escapeHtml(truncateText(item.text))}</div>` : ''}
        <div class="feed-item-meta">${formatRelativeTime(item.pubDate)}</div>
      </div>
    </a>
  `;
}

/**
 * Filter offline feeds to show only those relevant to current section
 */
function filterOfflineFeeds(sectionName) {
  const offlineGrid = document.getElementById('offline-grid');
  if (!offlineGrid) return;

  // Map section names to categories
  const sectionCategories = {
    'youtube': ['youtube'],
    'blogs': ['blogs'],
    'news': ['news'],
    'subreddits': ['subreddits'],
    'twitch': ['twitch']
  };

  const relevantCategories = sectionCategories[sectionName] || [];

  // Filter and display only relevant offline feeds
  const relevantFeeds = failedFeeds.filter(feed =>
    relevantCategories.includes(feed.category)
  );

  const offlineSection = document.getElementById('offline-section');
  const offlineCount = document.getElementById('offline-count');

  if (relevantFeeds.length === 0) {
    offlineSection.style.display = 'none';
    return;
  }

  offlineCount.textContent = relevantFeeds.length;

  offlineGrid.innerHTML = relevantFeeds.map(feed => `
    <div class="feed-card error offline-card">
      <div class="feed-card-header">
        <span class="feed-card-title">${escapeHtml(feed.name)}</span>
        <span class="feed-card-count">Error</span>
      </div>
      <ul class="feed-items">
        <li class="error-message">Failed to load feed</li>
        <li class="error-message" style="font-size: 11px; color: var(--text-muted);">Category: ${feed.category}</li>
        <li class="error-message" style="font-size: 11px; color: var(--text-tertiary);">${escapeHtml(feed.error)}</li>
      </ul>
    </div>
  `).join('');

  offlineSection.style.display = 'block';
}

/**
 * Format date to relative time
 */
function formatRelativeTime(dateStr) {
  if (!dateStr) return '';
  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;

    const now = new Date();
    const diffMs = now - date;
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);
    const diffWeeks = Math.floor(diffDays / 7);

    if (diffSecs < 60) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffWeeks < 4) return `${diffWeeks}w ago`;

    return date.toLocaleDateString();
  } catch {
    return dateStr;
  }
}

/**
 * Truncate text to max words (default 10 words for subtitles)
 */
function truncateText(text, maxWords = 10) {
  if (!text) return text;
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return text;
  return words.slice(0, maxWords).join(' ') + '...';
}

/**
 * Decode HTML entities from RSS feeds (e.g., &amp; -> &)
 */
function decodeHtmlEntities(text) {
  if (!text) return text;
  const textarea = document.createElement('textarea');
  textarea.innerHTML = text;
  return textarea.value;
}

/**
 * Escape HTML to prevent XSS (also decodes RSS entities first)
 */
function escapeHtml(text) {
  if (!text) return '';
  // First decode any HTML entities from the RSS feed
  const decoded = decodeHtmlEntities(text);
  // Then safely escape for display
  const div = document.createElement('div');
  div.textContent = decoded;
  return div.innerHTML;
}

/**
 * Ensure URL uses safe protocols for href/src attributes
 */
function sanitizeUrl(url) {
  if (!url || typeof url !== 'string') return '#';

  try {
    const parsed = new URL(url, window.location.origin);
    if (!SAFE_PROTOCOLS.has(parsed.protocol)) {
      return '#';
    }
    return parsed.toString();
  } catch {
    return '#';
  }
}

/**
 * Build a stable cache key for feeds.
 * Prefer URL to avoid collisions between similarly named feeds.
 */
function getFeedCacheKey(feed) {
  const normalizedUrl = (feed?.url || '').trim().toLowerCase();
  if (normalizedUrl) return normalizedUrl;
  return (feed?.name || '').trim().toLowerCase();
}

/**
 * Get recency class based on article age
 */
function getRecencyClass(dateStr) {
  if (!dateStr) return 'recency-old';

  try {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return 'recency-old';

    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / MS_PER_DAY);

    if (diffDays === 0) return 'recency-today';
    if (diffDays <= 7) return 'recency-week';
    if (diffDays <= 30) return 'recency-month';
    return 'recency-old';
  } catch {
    return 'recency-old';
  }
}

/**
 * Helper to generate site URL from feed info
 */
function getSiteUrl(name, category, feedUrl) {
  let siteUrl = '#'; // Default fallback

  if (category === 'youtube') {
    // Extract channel ID from feed URL: ...?channel_id=UC...
    // Handle case where channel_id might be the last param or followed by others
    const match = feedUrl && feedUrl.match(/[?&]channel_id=([^&]+)/);
    if (match && match[1]) {
      siteUrl = `https://www.youtube.com/channel/${match[1]}`;
    }
  } else if (category === 'subreddits') {
    // Name is "r/subreddit"
    const subName = name.replace(/^r\//i, '');
    siteUrl = `https://www.reddit.com/r/${subName}`;
  } else if (category === 'twitch') {
    // Name is username
    siteUrl = `https://www.twitch.tv/${name}`;
  } else if (category === 'blogs' || category === 'news') {
    // Fallback to feed URL if no better link is available yet
    siteUrl = feedUrl || '#';
  }

  return siteUrl;
}

/**
 * Sort feed cards by recency within each section
 */
function sortFeedsByRecency() {
  const sections = ['youtube', 'blogs', 'news', 'subreddits', 'twitch'];

  sections.forEach(section => {
    const grid = document.getElementById(`${section}-grid`);
    if (!grid) return;
    sortFeedsByRecencyInGrid(grid);
  });
}

/**
 * Sort feed cards by recency in a specific grid
 */
function sortFeedsByRecencyInGrid(grid) {
  // Get all feed cards in this grid (excluding error cards)
  const cards = Array.from(grid.querySelectorAll('.feed-card:not(.error)'));

  // Sort by latest date (most recent first)
  cards.sort((a, b) => {
    const dateA = a.dataset.latestDate ? new Date(a.dataset.latestDate).getTime() : 0;
    const dateB = b.dataset.latestDate ? new Date(b.dataset.latestDate).getTime() : 0;

    // Handle NaN values (invalid dates) by treating them as 0
    return (isNaN(dateB) ? 0 : dateB) - (isNaN(dateA) ? 0 : dateA);
  });

  // Re-append cards in sorted order
  cards.forEach(card => {
    grid.appendChild(card);
  });
}

// Start the app when DOM is ready
document.addEventListener('DOMContentLoaded', init);
