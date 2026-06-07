import { connect, getDebugUrl } from '../../scripts/lib/cdp.mjs';

export const BASE_MAPS_URL = 'https://www.google.com/maps';
export const SAVED_LISTS_URL = 'https://www.google.com/maps/@1.3172736,103.8778368,13z/data=!4m2!10m1!1e1?entry=ttu';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function randomInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

export async function pause(min = 900, max = 1800) {
  await sleep(randomInt(min, max));
}

export function normalizeText(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

export function stripLeadingSymbols(value = '') {
  return normalizeText(value).replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

export function normalizeKey(value = '') {
  return stripLeadingSymbols(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function parseListLabel(rawText = '') {
  const raw = normalizeText(rawText);
  const cleaned = stripLeadingSymbols(raw);
  const match = cleaned.match(/^(.*?)(Private|Shared|By .*?)(?: · (\d+) place(?:s)?)?$/);
  if (!match) {
    return {
      name: cleaned,
      visibility: null,
      count: null,
      rawText: raw,
    };
  }

  return {
    name: match[1].trim(),
    visibility: match[2].trim(),
    count: match[3] ? Number(match[3]) : null,
    rawText: raw,
  };
}

export function scoreCandidate(query, name, index = 0) {
  const queryKey = normalizeKey(query);
  const nameKey = normalizeKey(name);
  if (!queryKey || !nameKey) return -index;

  let score = 0;
  if (nameKey === queryKey) score += 1000;
  if (nameKey.startsWith(queryKey)) score += 700;
  if (queryKey.startsWith(nameKey)) score += 450;
  if (nameKey.includes(queryKey)) score += 250;

  const queryTokens = queryKey.split(' ').filter(Boolean);
  const nameTokens = new Set(nameKey.split(' ').filter(Boolean));
  const overlap = queryTokens.filter((token) => nameTokens.has(token)).length;
  score += overlap * 40;

  score += Math.max(0, 100 - index);
  return score;
}

function buildPageHelpers() {
  const normalizeText = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
  const stripLeadingSymbols = (value = '') => normalizeText(value).replace(/^[^\p{L}\p{N}]+/u, '').trim();
  const normalizeKey = (value = '') => stripLeadingSymbols(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const parseListLabelParts = (rawText = '') => {
    const raw = normalizeText(rawText);
    const cleaned = stripLeadingSymbols(raw);
    const match = cleaned.match(/^(.*?)(Private|Shared|By .*?)(?: · (\d+) place(?:s)?)?$/);
    return {
      name: match ? match[1].trim() : cleaned,
      visibility: match ? match[2].trim() : null,
      count: match?.[3] ? Number(match[3]) : null,
      rawText: raw,
    };
  };
  const extractStyleUrl = (style = '') => {
    const match = String(style || '').match(/url\((?:"|')?([^"')]+)(?:"|')?\)/i);
    return match ? match[1] : null;
  };
  const findBestScroller = ({
    root = document,
    candidateSelector = 'div',
    itemSelector = null,
    minOverflow = 20,
    fallback = root,
  } = {}) => {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    const candidates = Array.from(scope.querySelectorAll(candidateSelector || 'div'))
      .filter((el) => el.scrollHeight > el.clientHeight + minOverflow)
      .filter((el) => !itemSelector || el.querySelector(itemSelector))
      .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));

    if (candidates[0]) return candidates[0];
    if (fallback && fallback.scrollHeight > fallback.clientHeight + minOverflow) return fallback;
    return null;
  };
  const scrollForward = (el, { minStep = 240, ratio = 0.85 } = {}) => {
    if (!el) return false;
    const before = el.scrollTop;
    el.scrollTop = Math.min(
      el.scrollTop + Math.max(minStep, Math.floor(el.clientHeight * ratio)),
      el.scrollHeight,
    );
    return el.scrollTop > before;
  };
  const scrollToTop = (el) => {
    if (!el) return false;
    const before = el.scrollTop;
    el.scrollTop = 0;
    return before > 0;
  };

  return {
    normalizeText,
    stripLeadingSymbols,
    normalizeKey,
    parseListLabelParts,
    extractStyleUrl,
    findBestScroller,
    scrollForward,
    scrollToTop,
  };
}

async function getOrderedPageList() {
  const debugUrl = await getDebugUrl(5000);
  const response = await fetch(`${debugUrl}/json/list`);
  const tabs = await response.json();
  return tabs.filter((tab) => tab.type === 'page');
}

export async function openMapsContext({
  newTab = false,
  createIfMissing = true,
  initialUrl = BASE_MAPS_URL,
  focus = false,
} = {}) {
  const cdp = await connect(5000);
  let targetId = null;
  let created = false;

  if (newTab) {
    const createdTarget = await cdp.send('Target.createTarget', { url: 'about:blank' });
    targetId = createdTarget.targetId;
    created = true;
  } else {
    const orderedPages = await getOrderedPageList().catch(() => []);
    const frontmostMapsTab = orderedPages.find((tab) => String(tab.url || '').includes('google.com/maps'));
    if (frontmostMapsTab?.id) {
      targetId = frontmostMapsTab.id;
    }

    if (!targetId) {
      const pages = await cdp.getPages();
      const fallbackMapsTab = pages.find((page) => String(page.url || '').includes('google.com/maps'));
      targetId = fallbackMapsTab?.targetId || null;
    }

    if (!targetId && createIfMissing) {
      const createdTarget = await cdp.send('Target.createTarget', { url: initialUrl });
      targetId = createdTarget.targetId;
      created = true;
    }
  }

  if (!targetId) {
    cdp.close();
    throw new Error('No Google Maps tab found');
  }

  const sessionId = await cdp.attachToPage(targetId);
  await cdp.send('Page.enable', {}, sessionId, 5000).catch(() => {});
  await cdp.send('Runtime.enable', {}, sessionId, 5000).catch(() => {});
  if (focus) {
    await cdp.send('Page.bringToFront', {}, sessionId, 5000).catch(() => {});
  }
  await pause(900, 1500);

  return { cdp, sessionId, targetId, created, focus };
}

export async function closeContext(ctx) {
  try {
    ctx?.cdp?.close();
  } catch {
    // ignore
  }
}

export async function evaluate(ctx, fn, ...args) {
  const helperSource = `(${buildPageHelpers.toString()})()`;
  const expression = `
    (() => {
      const helpers = ${helperSource};
      const norm = helpers.normalizeText;
      const strip = helpers.stripLeadingSymbols;
      const key = helpers.normalizeKey;
      const parseListLabelParts = helpers.parseListLabelParts;
      const extractStyleUrl = helpers.extractStyleUrl;
      const findBestScroller = helpers.findBestScroller;
      const scrollForward = helpers.scrollForward;
      const scrollToTop = helpers.scrollToTop;
      return (${fn.toString()}).apply(null, ${JSON.stringify(args)});
    })()
  `;
  return await ctx.cdp.evaluate(ctx.sessionId, expression, 60000);
}

export async function waitFor(ctx, fn, {
  args = [],
  timeoutMs = 30000,
  intervalMs = 500,
  label = 'condition',
} = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await evaluate(ctx, fn, ...args);
      if (result) return result;
    } catch {
      // ignore transient page errors while SPA is settling
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

export async function navigate(ctx, url, {
  waitMinMs = 5000,
  waitMaxMs = 8000,
  readyTimeoutMs = 20000,
  focus = ctx?.focus || false,
} = {}) {
  if (focus) {
    await ctx.cdp.send('Page.bringToFront', {}, ctx.sessionId, 5000).catch(() => {});
  }
  await ctx.cdp.send('Page.navigate', { url }, ctx.sessionId, 60000);
  await waitFor(
    ctx,
    () => document.readyState === 'interactive' || document.readyState === 'complete',
    { timeoutMs: readyTimeoutMs, intervalMs: 400, label: 'document ready state' },
  ).catch(() => null);
  await pause(waitMinMs, waitMaxMs);
  return url;
}

export async function setLocation(ctx, url, {
  waitMinMs = 5000,
  waitMaxMs = 8000,
} = {}) {
  await evaluate(ctx, (nextUrl) => {
    location.href = nextUrl;
    return true;
  }, url);
  await pause(waitMinMs, waitMaxMs);
  return url;
}

export async function collectWhileScrolling({
  maxSteps = 40,
  stagnantLimit = 3,
  pauseMinMs = 1200,
  pauseMaxMs = 1800,
  beforeStep = null,
  readStep,
  mergeStep,
  getCount,
  shouldStop = null,
} = {}) {
  if (typeof readStep !== 'function') throw new Error('collectWhileScrolling: readStep is required');
  if (typeof mergeStep !== 'function') throw new Error('collectWhileScrolling: mergeStep is required');
  if (typeof getCount !== 'function') throw new Error('collectWhileScrolling: getCount is required');

  let stagnant = 0;
  let lastState = null;

  for (let step = 0; step < maxSteps; step++) {
    if (typeof beforeStep === 'function') {
      await beforeStep({ step, stagnant, lastState });
    }

    const beforeCount = getCount();
    lastState = await readStep({ step, stagnant, lastState });
    await mergeStep(lastState, { step, stagnant, beforeCount });
    const afterCount = getCount();
    stagnant = afterCount === beforeCount ? stagnant + 1 : 0;

    if (typeof shouldStop === 'function' && shouldStop({ step, stagnant, beforeCount, afterCount, state: lastState })) {
      break;
    }
    if (!lastState?.canScroll || stagnant >= stagnantLimit) {
      break;
    }

    await pause(pauseMinMs, pauseMaxMs);
  }

  return { lastState, stagnant };
}

export function buildSearchUrl(query) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function buildDirectionsUrl(origin, destination, mode) {
  return `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&travelmode=${encodeURIComponent(mode)}`;
}

export async function resolvePlaceFromQuery(ctx, query, {
  extractState,
  selectCandidate = null,
  searchWaitLabel = 'place page or search results',
  placeWaitLabel = 'place page',
  candidateLimit = 10,
} = {}) {
  if (typeof extractState !== 'function') {
    throw new Error('resolvePlaceFromQuery requires an extractState function');
  }

  await navigate(ctx, buildSearchUrl(query), { waitMinMs: 7000, waitMaxMs: 9500 });
  await waitFor(
    ctx,
    () => location.pathname.includes('/maps/place/') || !!document.querySelector('div[role="article"] a.hfpxzc'),
    { timeoutMs: 30000, intervalMs: 500, label: searchWaitLabel },
  );

  const state = await evaluate(ctx, extractState, query);
  let chosen = state?.chosen || null;
  let candidates = Array.isArray(state?.candidates) ? [...state.candidates] : [];

  if (!chosen && typeof selectCandidate === 'function') {
    const selection = await selectCandidate({ query, state, candidates });
    if (selection && typeof selection === 'object' && ('chosen' in selection || 'candidates' in selection)) {
      chosen = selection.chosen || null;
      candidates = Array.isArray(selection.candidates) ? selection.candidates : candidates;
    } else if (selection) {
      chosen = selection;
    }
  }

  if (!chosen?.href) {
    throw new Error(`No place found for: ${query}`);
  }

  if (state?.kind === 'results') {
    await navigate(ctx, chosen.href, { waitMinMs: 7000, waitMaxMs: 9500 });
    await waitFor(
      ctx,
      () => location.pathname.includes('/maps/place/') && !!document.querySelector('h1'),
      { timeoutMs: 30000, intervalMs: 500, label: placeWaitLabel },
    );
  }

  return {
    resolvedFrom: state?.kind === 'place' ? 'place' : 'results',
    chosenCandidate: chosen,
    candidates: candidates.slice(0, candidateLimit),
  };
}

export async function readPlaceSummary(ctx) {
  return await evaluate(ctx, () => {
    const name = norm(document.querySelector('h1')?.innerText || document.title.replace(/ - Google Maps$/, ''));
    const addressButton = Array.from(document.querySelectorAll('button, div, span'))
      .find((el) => (el.getAttribute('aria-label') || '').startsWith('Address:'));
    const address = norm(addressButton?.textContent || '');
    return { name, address, url: location.href, title: document.title };
  });
}
