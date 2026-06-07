/**
 * resolve-target — find a page tab by keyword or target ID prefix.
 *
 * Two strategies, tried in order:
 *   1. Keyword substring match on title or URL ("maps", "whatsapp")
 *   2. Target ID prefix match ("6BE8" → "6BE827FA...")
 *   3. Default to most recent page
 */

import { getDebugUrl } from './cdp.mjs';

/**
 * Resolve a raw target string to a full targetId.
 * If raw is falsy, returns the most recent page's targetId.
 */
export async function resolveTarget(raw, options = {}) {
  const pages = await getPages(options);

  if (pages.length === 0) throw new Error('No pages open');

  if (!raw) {
    return pages[0].targetId;
  }

  // Step 1: keyword match on title/URL
  const q = raw.toLowerCase();
  const keywordMatches = pages.filter(p =>
    (p.title && p.title.toLowerCase().includes(q)) ||
    (p.url && p.url.toLowerCase().includes(q))
  );

  if (keywordMatches.length === 1) {
    return keywordMatches[0].targetId;
  }

  // Step 2: prefix match on target ID
  const upper = raw.toUpperCase();
  const prefixMatches = pages.filter(p => p.targetId.toUpperCase().startsWith(upper));

  if (prefixMatches.length === 1) {
    return prefixMatches[0].targetId;
  }
  if (prefixMatches.length > 1) {
    throw new Error(`Ambiguous prefix "${raw}" — matches ${prefixMatches.length} pages. Use more characters.`);
  }

  if (keywordMatches.length > 1) {
    throw new Error([
      `Multiple pages match "${raw}":`,
      ...keywordMatches.map(p => `  ${p.targetId.slice(0, 8)}  ${p.title || '(no title)'}  ${p.url}`),
      'Be more specific or use a target ID prefix.',
    ].join('\n'));
  }

  throw new Error(`No page matching "${raw}" (tried keyword, tried prefix)`);
}

/**
 * List pages with formatted output, showing unique prefixes and titles.
 */
export async function listPages(options = {}) {
  const pages = await getPages(options);

  const prefixLen = getDisplayPrefixLength(pages.map(p => p.targetId));

  return pages.map(p => {
    const id = p.targetId.slice(0, prefixLen).padEnd(prefixLen);
    const title = (p.title || '(no title)').substring(0, 54).padEnd(54);
    return `${id}  ${title}  ${p.url}`;
  }).join('\n');
}

async function getPages(options = {}) {
  const debugUrl = await getDebugUrl({ timeout: 5000, profile: options.profile });
  const resp = await fetch(`${debugUrl}/json/list`);
  if (!resp.ok) throw new Error(`Failed to list pages from ${debugUrl}`);
  const pages = await resp.json();
  return pages
    .filter(p => p.type === 'page' && !String(p.url || '').startsWith('chrome://'))
    .map(p => ({ targetId: p.id, title: p.title || '', url: p.url || '' }));
}

function getDisplayPrefixLength(targetIds) {
  if (targetIds.length === 0) return 8;
  const maxLen = Math.max(...targetIds.map(id => id.length));
  for (let len = 8; len <= maxLen; len++) {
    const prefixes = new Set(targetIds.map(id => id.slice(0, len).toUpperCase()));
    if (prefixes.size === targetIds.length) return len;
  }
  return maxLen;
}
