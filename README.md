# The Prawn Feeds

A modern, mobile-first RSS feed aggregator with swipeable navigation and advanced features.

## Features

### 🎯 Swipeable Section Navigation
- **5 Sections**: YouTube, Blogs, Security, Subreddits, Twitch
- **Touch Gestures**: Swipe left/right on mobile devices
- **Keyboard Navigation**: Use arrow keys (←/→) to navigate
- **Tab Buttons**: Click tabs for direct section access
- **Smooth 60fps Animations**: Hardware-accelerated CSS transitions
- **Dynamic Post Counts**: Real-time display of feed counts per section

### 📱 Modal Load More System
- **Initial Display**: Shows first 10 posts per feed
- **Load More Button**: Opens modal overlay for additional posts
- **Infinite Scroll**: Automatically loads 10 posts at a time as you scroll
- **Multiple Close Methods**:
  - ✕ button (top right)
  - ESC key
  - Click outside modal (on backdrop)
- **Smooth Animations**: Fade in/slide up effects
- **Scroll Position Preservation**: Returns to previous position after closing

### 📡 Grouped Offline Feeds
- **Auto-Detection**: Automatically identifies failed feed loads
- **Collapsible Section**: Collapsed by default to reduce clutter
- **Count Badge**: Shows number of offline feeds
- **Visual Distinction**: Red tinted cards for easy identification
- **Keyboard Accessible**: Toggle with Enter or Space key

### 🎨 Modern UI/UX
- **Mobile-First Design**: Optimized for mobile, scales beautifully to desktop
- **Touch-Friendly**: Minimum 44x44px touch targets
- **Skeleton Screens**: Loading states with shimmer animations
- **Error States**: Clear, helpful error messaging
- **Accessible**: Full ARIA labels and keyboard navigation support
- **Minimalist Newspaper Favicon**: Clean, monochrome design

## Usage

### Access Points
- **Modern Reader** (Client-side): Visit `/` for the swipeable, interactive experience (default)
- **Legacy Interface** (Flask): Visit `/flask` for the traditional server-rendered interface

### Keyboard Shortcuts
- `←` / `→` Arrow keys: Navigate between sections
- `ESC`: Close modal
- `Enter` / `Space`: Toggle offline feeds section

### Mobile Gestures
- **Swipe Left**: Next section
- **Swipe Right**: Previous section
- **Tap Load More**: Open modal with additional posts
- **Scroll in Modal**: Auto-load more posts

## Configuration

Edit `feeds.json` to customize your feed sources:
- Add/remove RSS feeds
- Set custom limits per feed (default: 10)
- Organize feeds into sections

Edit `public/feeds.js` for client-side configuration.

### Why both `feeds.json` and `public/feeds.js` exist

The project currently has **two runtime paths**:

- `feeds.json` is used by the Flask/server-rendered path (`/flask`, via `main.py`)
- `public/feeds.js` is used by the modern client-side reader (`/`)

Historically this made it easy to evolve each experience independently, but it can introduce drift.

### Phase-2 config workflow (drift detection + optional sync)

You now have scripts to manage this safely:

- `npm run check:feeds:strict` → validates that `public/feeds.js` matches `feeds.json` and exits non-zero on drift
- `npm run sync:feeds` → intentionally regenerates `public/feeds.js` from `feeds.json`

Recommended flow:

1. Edit `feeds.json`
2. Run `npm run sync:feeds`
3. Run `npm run check:feeds:strict`

### Auto-sync reminders and guards

- **On local commit**: Husky `pre-commit` runs `npm run precommit:feeds`, which refreshes `public/feeds.js` from `feeds.json` and stages the updated file automatically.
- **On GitHub push/PR**: workflow `.github/workflows/feeds-sync-check.yml` runs `npm run ci:feeds` and fails if `public/feeds.js` is out of sync.

After pulling these changes, run `npm install` once to activate Git hooks via `prepare`.

## Technical Details

### Performance
- 60fps animations via hardware acceleration
- Efficient DOM manipulation
- Lazy loading for images
- Client-side caching (60-minute TTL)
- Debounced scroll handlers

### Accessibility
- ARIA labels and roles
- Keyboard navigation throughout
- Screen reader optimized
- Focus management
- Semantic HTML5

### Browser Support
- Modern browsers (Chrome, Firefox, Safari, Edge)
- Mobile browsers (iOS Safari, Chrome Mobile)
- Progressive enhancement approach

## Development

```bash
# Install dependencies
pip install -r requirements.txt
npm install

# Run locally
python main.py

# Enforce sync in CI
npm run check:feeds:strict

# Regenerate client feed config from feeds.json
npm run sync:feeds

# Auto-sync and verify in one command
npm run refresh:feeds

# Deploy to Vercel
vercel deploy
```

## License

See LICENSE file for details.
