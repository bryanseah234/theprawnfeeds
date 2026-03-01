import {
  buildFrontEndFeedsFromJson,
  printDiffReport,
  readFeedsJsObject,
  readFeedsJson,
  toComparableFeedSet
} from './feed-config-common.mjs';

function formatDiffList(title, rows) {
  const lines = [title];

  if (!rows.length) {
    lines.push('  (none)');
    return lines.join('\n');
  }

  rows.slice(0, 25).forEach(row => {
    lines.push(`  - [${row.category}] ${row.name} :: ${row.url}`);
  });

  if (rows.length > 25) {
    lines.push(`  ... and ${rows.length - 25} more`);
  }

  return lines.join('\n');
}

async function main() {
  const strict = process.argv.includes('--strict');

  const jsonConfig = await readFeedsJson();
  const generatedFeeds = buildFrontEndFeedsFromJson(jsonConfig);
  const currentFeeds = await readFeedsJsObject();

  const generatedComparable = toComparableFeedSet(generatedFeeds);
  const currentComparable = toComparableFeedSet(currentFeeds);
  const diff = printDiffReport({
    generated: generatedComparable,
    existing: currentComparable
  });

  if (diff.inSync) {
    console.log('✅ Feed config check: public/feeds.js is in sync with feeds.json mapping.');
    process.exit(0);
  }

  console.warn('⚠️ Feed config check: drift detected between feeds.json and public/feeds.js.');
  console.warn(formatDiffList('Missing in public/feeds.js (present in feeds.json-derived config):', diff.missingInJs));
  console.warn(formatDiffList('Extra in public/feeds.js (not in feeds.json-derived config):', diff.extraInJs));
  console.warn('\nTip: run "npm run sync:feeds" to regenerate public/feeds.js from feeds.json.');

  if (strict) {
    process.exit(1);
  }

  process.exit(0);
}

main().catch(error => {
  console.error('❌ Feed config validation failed:', error?.message || error);
  process.exit(1);
});
