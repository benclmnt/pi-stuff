#!/usr/bin/env node

import { writeFileSync } from 'fs';
import {
  buildSearchUrl,
  closeContext,
  collectWhileScrolling,
  evaluate,
  navigate,
  normalizeText,
  openMapsContext,
  pause,
  waitFor,
} from './common.js';

function usage() {
  console.log(`Usage:
  ./reviews.js "<place query>" [--sort relevant|newest|highest|lowest]
                [--max-reviews 80]
                [--place-url "https://www.google.com/maps/place/..."]
                [--out report.md] [--new-tab] [-j]

Examples:
  ./reviews.js "Singapore Flyer"
  ./reviews.js --place-url "https://www.google.com/maps/place/..."
  ./reviews.js "best ramen shinjuku"
  ./reviews.js "Eiffel Tower Paris" --sort newest --max-reviews 120 --out eiffel.md
  ./reviews.js "Gardens by the Bay" -j`);
}

function parseArgs(argv) {
  let json = false;
  let newTab = false;
  let sort = 'relevant';
  let maxReviews = 80;
  let placeUrl = null;
  let out = null;
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-j' || arg === '--json') {
      json = true;
    } else if (arg === '--new-tab' || arg === '--fresh') {
      newTab = true;
    } else if (arg === '--sort') {
      sort = argv[++i] || sort;
    } else if (arg === '--max-reviews' || arg === '--limit' || arg === '-n') {
      maxReviews = argv[++i] || maxReviews;
    } else if (arg === '--place-url' || arg === '--url') {
      placeUrl = argv[++i] || placeUrl;
    } else if (arg === '--out' || arg === '-o') {
      out = argv[++i] || out;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  return {
    json,
    newTab,
    sort,
    maxReviews,
    placeUrl,
    out,
    query: positional.join(' ').trim() || null,
  };
}

function toInteger(value, label, { min = 1, max = 1000 } = {}) {
  const number = Math.trunc(Number(value));
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return number;
}

function normalizeSort(input) {
  const value = String(input || 'relevant').toLowerCase();
  if (['relevant', 'most-relevant', 'most_relevant'].includes(value)) {
    return { key: 'relevant', label: 'Most relevant' };
  }
  if (['newest', 'recent', 'latest'].includes(value)) {
    return { key: 'newest', label: 'Newest' };
  }
  if (['highest', 'highest-rating', 'highest_rating', 'top'].includes(value)) {
    return { key: 'highest', label: 'Highest rating' };
  }
  if (['lowest', 'lowest-rating', 'lowest_rating'].includes(value)) {
    return { key: 'lowest', label: 'Lowest rating' };
  }
  throw new Error(`Unsupported sort: ${input}`);
}

function normalizeOptions(raw) {
  const query = normalizeText(raw.query || '');
  const placeUrl = normalizeMaybeUrl(raw.placeUrl || '');
  if (!query && !placeUrl) {
    usage();
    process.exit(1);
  }

  return {
    ...raw,
    query: query || null,
    placeUrl,
    maxReviews: toInteger(raw.maxReviews, 'max-reviews', { min: 5, max: 300 }),
    sort: normalizeSort(raw.sort),
  };
}

function parseNumber(value) {
  const match = normalizeText(value).match(/([\d][\d,]*)(?:\.(\d+))?/);
  if (!match) return null;
  const whole = match[1].replace(/,/g, '');
  const fraction = match[2] ? `.${match[2]}` : '';
  const number = Number(`${whole}${fraction}`);
  return Number.isFinite(number) ? number : null;
}

function parseRatingValue(value) {
  const number = parseNumber(value);
  return number != null ? Math.max(0, Math.min(5, number)) : null;
}

function normalizeMaybeUrl(value) {
  const url = normalizeText(value);
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/')) return `https://www.google.com${url}`;
  return url;
}

function approximateDateFromRelativeText(value, referenceDate = new Date()) {
  const match = normalizeText(value).toLowerCase().match(/(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago/);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2];
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const date = new Date(referenceDate);
  if (unit === 'minute') date.setMinutes(date.getMinutes() - amount);
  else if (unit === 'hour') date.setHours(date.getHours() - amount);
  else if (unit === 'day') date.setDate(date.getDate() - amount);
  else if (unit === 'week') date.setDate(date.getDate() - amount * 7);
  else if (unit === 'month') date.setMonth(date.getMonth() - amount);
  else if (unit === 'year') date.setFullYear(date.getFullYear() - amount);
  return date;
}

function formatApproximateMonth(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(date);
}

function seasonForDate(date, latitude) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime()) || latitude == null) return null;
  if (Math.abs(latitude) < 23.5) return 'tropical';

  const month = date.getMonth() + 1;
  const north = latitude >= 0;
  const northernSeason = month <= 2 || month === 12
    ? 'winter'
    : month <= 5
      ? 'spring'
      : month <= 8
        ? 'summer'
        : 'fall';

  if (north) return northernSeason;
  if (northernSeason === 'winter') return 'summer';
  if (northernSeason === 'spring') return 'fall';
  if (northernSeason === 'summer') return 'winter';
  return 'spring';
}

function formatReviewTimeContext(review, latitude) {
  const bits = [];
  if (review.dateText) bits.push(review.dateText);
  if (review.approxMonth) bits.push(`~${review.approxMonth}`);
  const season = seasonForDate(review.approxDate, latitude);
  if (season === 'tropical') bits.push('tropical seasonality');
  else if (season) bits.push(season);
  return bits;
}

function extractStyleUrl(style = '') {
  const match = String(style).match(/url\((?:"|')?([^"')]+)(?:"|')?\)/i);
  return normalizeMaybeUrl(match?.[1] || null);
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function extractPlaceResolutionState() {
  const parseRatingText = (article) => norm(
    article.querySelector('[role="img"][aria-label*="stars"] .MW4etd')?.textContent
    || article.querySelector('[role="img"][aria-label*="stars"]')?.getAttribute('aria-label')
    || '',
  );
  const parseReviewText = (article) => norm(
    article.querySelector('[role="img"][aria-label*="stars"] .UY7F9')?.textContent
    || '',
  );

  if (location.pathname.includes('/maps/place/')) {
    return {
      kind: 'place',
      chosen: {
        name: norm(document.querySelector('h1')?.innerText || document.title.replace(/ - Google Maps$/, '')),
        href: location.href,
        summary: null,
        index: 0,
        ratingText: null,
        reviewText: null,
      },
      candidates: [],
    };
  }

  const candidates = Array.from(document.querySelectorAll('div[role="article"]'))
    .map((article, index) => {
      const link = article.querySelector('a.hfpxzc');
      const name = norm(
        article.querySelector('.qBF1Pd, .fontHeadlineSmall')?.textContent
        || link?.getAttribute('aria-label')
        || article.getAttribute('aria-label')
        || '',
      );
      const summary = norm(article.innerText || article.textContent || '');
      return {
        index,
        name,
        href: link?.href || null,
        summary,
        ratingText: parseRatingText(article),
        reviewText: parseReviewText(article),
      };
    })
    .filter((candidate) => candidate.name && candidate.href);

  return {
    kind: 'results',
    chosen: null,
    candidates,
  };
}

async function waitForPlacePage(ctx, label = 'place page') {
  await waitFor(
    ctx,
    () => location.pathname.includes('/maps/place/') && !!document.querySelector('h1'),
    { timeoutMs: 30000, intervalMs: 500, label },
  );
}

async function openPlaceByUrl(ctx, placeUrl) {
  await navigate(ctx, placeUrl, { waitMinMs: 7000, waitMaxMs: 9500 });
  await waitForPlacePage(ctx, 'place page from URL');
}

async function resolvePlace(ctx, options) {
  if (options.placeUrl) {
    await openPlaceByUrl(ctx, options.placeUrl);
    return {
      status: 'resolved',
      resolvedFrom: 'place-url',
      chosenCandidate: {
        name: null,
        href: options.placeUrl,
        summary: null,
        index: 0,
        ratingText: null,
        reviewText: null,
      },
      candidates: [],
    };
  }

  await navigate(ctx, buildSearchUrl(options.query), { waitMinMs: 7000, waitMaxMs: 9500 });
  await waitFor(
    ctx,
    () => location.pathname.includes('/maps/place/') || !!document.querySelector('div[role="article"] a.hfpxzc'),
    { timeoutMs: 30000, intervalMs: 500, label: 'place page or search results' },
  );

  const state = await evaluate(ctx, extractPlaceResolutionState);
  if (state?.kind === 'place' && state?.chosen?.href) {
    return {
      status: 'resolved',
      resolvedFrom: 'place',
      chosenCandidate: state.chosen,
      candidates: [],
    };
  }

  const candidates = Array.isArray(state?.candidates) ? state.candidates : [];
  if (candidates.length === 0) {
    throw new Error(`No place found for: ${options.query}`);
  }

  if (candidates.length === 1) {
    await openPlaceByUrl(ctx, candidates[0].href);
    return {
      status: 'resolved',
      resolvedFrom: 'single-result',
      chosenCandidate: candidates[0],
      candidates,
    };
  }

  return {
    status: 'needs_place_selection',
    resolvedFrom: 'results',
    chosenCandidate: null,
    candidates,
  };
}

async function readPlaceProfile(ctx) {
  return await evaluate(ctx, () => {
    const category = norm(document.querySelector('button[jsaction*="category"], button.DkEaL')?.innerText || '');
    const description = norm(
      document.querySelector('[aria-label^="About "] .PYvSYb')?.textContent
      || document.querySelector('button.XJ8h0e .PYvSYb')?.textContent
      || document.querySelector('button.XJ8h0e')?.innerText
      || ''
    ).replace(/\s*$/, '');

    const addressButton = Array.from(document.querySelectorAll('button')).find((el) => (el.getAttribute('aria-label') || '').startsWith('Address:'));
    const websiteCopyButton = Array.from(document.querySelectorAll('button')).find((el) => /copy website/i.test(el.getAttribute('aria-label') || ''));
    const websiteText = norm(
      websiteCopyButton?.parentElement?.innerText
      || websiteCopyButton?.closest('div')?.innerText
      || ''
    ).replace(/^[^\p{L}\p{N}]+/u, '');

    const imageCandidates = Array.from(document.querySelectorAll('img'))
      .map((img) => ({
        alt: norm(img.alt || ''),
        src: img.src || null,
        width: img.naturalWidth || 0,
        height: img.naturalHeight || 0,
        className: norm(img.className || ''),
      }))
      .filter((image) => image.src && /googleusercontent|gstatic/i.test(image.src))
      .filter((image) => image.width >= 140 && image.height >= 140)
      .filter((image) => !/favicon|logo/i.test(image.src))
      .filter((image) => !/\bNBa7we\b/.test(image.className));

    const coordMatch = location.href.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);

    return {
      name: norm(document.querySelector('h1')?.innerText || document.title.replace(/ - Google Maps$/, '')),
      category: category || null,
      description: description || null,
      address: norm(addressButton?.innerText || addressButton?.textContent || '').replace(/^[^\p{L}\p{N}]+/u, '') || null,
      websiteText: websiteText || null,
      mapsUrl: location.href,
      latitude: coordMatch ? Number(coordMatch[1]) : null,
      longitude: coordMatch ? Number(coordMatch[2]) : null,
      images: imageCandidates.slice(0, 20),
      tabs: Array.from(document.querySelectorAll('button, a'))
        .map((el) => norm(el.innerText || el.textContent || ''))
        .filter((text) => /^(Overview|Reviews|About|Menu|Photos|Updates|Services|Posts|Tickets)$/i.test(text))
        .slice(0, 10),
    };
  });
}

async function openReviewsPane(ctx) {
  const state = await evaluate(ctx, () => {
    const buttons = Array.from(document.querySelectorAll('button'));
    const moreReviewsButton = buttons.find((button) => /More reviews/i.test(`${button.getAttribute('aria-label') || ''} ${button.innerText || button.textContent || ''}`));
    const reviewPaneOpen = !moreReviewsButton
      && !!document.querySelector('.jftiEf')
      && buttons.some((button) => /sort reviews|\bsort\b/i.test(`${button.getAttribute('aria-label') || ''} ${button.innerText || button.textContent || ''}`));

    if (reviewPaneOpen) {
      return { alreadyOpen: true, clicked: false, targetLabel: null };
    }

    const target = moreReviewsButton
      || buttons.find((button) => /^Reviews for /i.test(button.getAttribute('aria-label') || ''))
      || buttons.find((button) => /^Reviews$/i.test(norm(button.innerText || button.textContent || '')));

    if (!target) {
      return { alreadyOpen: false, clicked: false, targetLabel: null };
    }

    target.click();
    return {
      alreadyOpen: false,
      clicked: true,
      targetLabel: norm(target.getAttribute('aria-label') || target.innerText || target.textContent || ''),
    };
  });

  if (!state?.alreadyOpen && !state?.clicked) {
    throw new Error('Could not find a Reviews button on the place page');
  }

  if (state?.clicked) {
    await pause(4000, 6500);
  }

  await waitFor(
    ctx,
    () => !!document.querySelector('.jftiEf')
      && Array.from(document.querySelectorAll('button')).some((button) => /sort reviews|\bsort\b/i.test(`${button.getAttribute('aria-label') || ''} ${button.innerText || button.textContent || ''}`)),
    { timeoutMs: 30000, intervalMs: 500, label: 'reviews pane' },
  );

  return state;
}

async function applyReviewSort(ctx, sortLabel) {
  if (!sortLabel) return;

  const opened = await evaluate(ctx, () => {
    const button = Array.from(document.querySelectorAll('button')).find((el) => /sort reviews|\bsort\b/i.test(`${el.getAttribute('aria-label') || ''} ${norm(el.innerText || el.textContent || '')}`));
    if (!button) return false;
    button.click();
    return true;
  });

  if (!opened) return;
  await pause(1200, 2000);

  await waitFor(
    ctx,
    () => !!document.querySelector('[role="menuitemradio"]'),
    { timeoutMs: 10000, intervalMs: 300, label: 'sort menu' },
  );

  const selected = await evaluate(ctx, (desiredLabel) => {
    const items = Array.from(document.querySelectorAll('[role="menuitemradio"]'));
    const match = items.find((item) => norm(item.innerText || item.textContent || '') === desiredLabel)
      || items.find((item) => norm(item.innerText || item.textContent || '').toLowerCase().includes(String(desiredLabel || '').toLowerCase()));

    if (!match) {
      return {
        ok: false,
        available: items.map((item) => norm(item.innerText || item.textContent || '')).filter(Boolean),
      };
    }

    match.click();
    return { ok: true };
  }, sortLabel);

  if (!selected?.ok) {
    throw new Error(`Could not select review sort: ${sortLabel}`);
  }

  await pause(3000, 4500);
}

async function scrollReviewPaneToTop(ctx) {
  await evaluate(ctx, () => {
    const scroller = findBestScroller({
      root: document,
      candidateSelector: 'div, [role="main"], [role="feed"]',
      itemSelector: '.jftiEf',
      minOverflow: 50,
      fallback: null,
    });
    if (scroller) scrollToTop(scroller);
    return true;
  }).catch(() => null);
  await pause(800, 1400);
}

function buildSortPlan(primarySort, totalReviews) {
  const requested = [
    primarySort,
    { key: 'newest', label: 'Newest' },
    { key: 'lowest', label: 'Lowest rating' },
    { key: 'highest', label: 'Highest rating' },
  ];
  const ratios = {
    relevant: 0.35,
    newest: 0.2,
    lowest: 0.25,
    highest: 0.2,
  };

  const seen = new Set();
  const unique = requested.filter((sort) => {
    if (!sort?.key || seen.has(sort.key)) return false;
    seen.add(sort.key);
    return true;
  });

  if (unique.length === 0) return [];

  const minPerBucket = totalReviews >= unique.length * 5 ? 5 : 1;
  let remaining = Math.max(0, totalReviews - unique.length * minPerBucket);
  const totalWeight = unique.reduce((sum, sort) => sum + (ratios[sort.key] || 0.15), 0);

  const plan = unique.map((sort) => ({
    ...sort,
    limit: minPerBucket + Math.floor(remaining * ((ratios[sort.key] || 0.15) / totalWeight)),
  }));

  let assigned = plan.reduce((sum, item) => sum + item.limit, 0);
  const priority = [...plan].sort((a, b) => (ratios[b.key] || 0.15) - (ratios[a.key] || 0.15));
  let cursor = 0;
  while (assigned < totalReviews && priority.length > 0) {
    priority[cursor % priority.length].limit += 1;
    assigned += 1;
    cursor += 1;
  }

  return plan.filter((item) => item.limit > 0);
}

async function readReviewSummary(ctx) {
  return await evaluate(ctx, () => {
    const topics = Array.from(document.querySelectorAll('button.e2moi, [role="radio"], button'))
      .map((button) => {
        const aria = norm(button.getAttribute('aria-label') || '');
        const text = norm(button.innerText || button.textContent || '');
        const match = aria.match(/^(.*?), mentioned in ([\d,]+) reviews?$/i);
        if (!match) return null;
        return {
          label: norm(match[1]),
          count: Number(match[2].replace(/,/g, '')),
          text,
        };
      })
      .filter(Boolean);

    const totalReviewsNode = Array.from(document.querySelectorAll('button, div, span'))
      .find((el) => /^[\d,]+ reviews?$/i.test(norm(el.innerText || el.textContent || '')));

    const histogram = Array.from(document.querySelectorAll('.BHOKXe[aria-label*="reviews"], .BHOKXe'))
      .map((node) => {
        const aria = norm(node.getAttribute('aria-label') || '');
        const match = aria.match(/^(\d) stars?, ([\d,]+) reviews?$/i);
        if (!match) return null;
        return {
          stars: Number(match[1]),
          count: Number(match[2].replace(/,/g, '')),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.stars - a.stars);

    const overallRatingText = norm(
      document.querySelector('.YTkVxc[aria-label$="stars"]')?.getAttribute('aria-label')
      || document.querySelector('[role="img"][aria-label$="stars"]')?.getAttribute('aria-label')
      || ''
    );

    return {
      overallRatingText,
      totalReviewsText: norm(totalReviewsNode?.innerText || totalReviewsNode?.textContent || ''),
      histogram,
      topics,
      reviewPaneUrl: location.href,
    };
  });
}

async function expandVisibleReviews(ctx) {
  return await evaluate(ctx, () => {
    const buttons = Array.from(document.querySelectorAll('.jftiEf button.w8nwRe')).filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });

    let expanded = 0;
    for (const button of buttons.slice(0, 15)) {
      try {
        button.click();
        expanded += 1;
      } catch {
        // ignore
      }
    }

    return expanded;
  });
}

async function extractReviewState(ctx) {
  return await evaluate(ctx, () => {
    const reviews = Array.from(document.querySelectorAll('.jftiEf')).map((card) => {
      const reviewId = card.getAttribute('data-review-id')
        || card.querySelector('[data-review-id]')?.getAttribute('data-review-id')
        || null;
      const reviewerButton = card.querySelector('.al6Kxe, .WEBjve');
      const likeButton = Array.from(card.querySelectorAll('button')).find((button) => /like/i.test(button.getAttribute('aria-label') || ''));
      const photos = Array.from(card.querySelectorAll('button.Tya61d')).map((button) => ({
        label: norm(button.getAttribute('aria-label') || button.getAttribute('data-tooltip') || ''),
        url: extractStyleUrl(button.getAttribute('style') || ''),
      })).filter((photo) => photo.url);

      const dateText = norm(
        card.querySelector('.rsqaWe')?.textContent
        || Array.from(card.querySelectorAll('span, div')).find((el) => /\b(?:minute|hour|day|week|month|year)s? ago\b/i.test(norm(el.textContent || '')))?.textContent
        || ''
      );

      return {
        reviewId,
        author: norm(card.querySelector('.d4r55')?.textContent || card.getAttribute('aria-label') || ''),
        reviewerMeta: norm(card.querySelector('.RfnDt')?.textContent || ''),
        reviewerUrl: reviewerButton?.getAttribute('data-href') || null,
        ratingText: norm(card.querySelector('.kvMYJc, [role="img"][aria-label*="star"]')?.getAttribute('aria-label') || ''),
        dateText,
        text: norm(card.querySelector('.wiI7pd')?.textContent || ''),
        likeText: norm(likeButton?.getAttribute('aria-label') || likeButton?.innerText || likeButton?.textContent || ''),
        photos,
        rawText: norm(card.innerText || card.textContent || ''),
      };
    });

    const scroller = findBestScroller({
      root: document,
      candidateSelector: 'div, [role="main"], [role="feed"]',
      itemSelector: '.jftiEf',
      minOverflow: 50,
      fallback: null,
    });

    return {
      reviews,
      canScroll: scrollForward(scroller, { minStep: 420, ratio: 0.82 }),
      visibleCount: reviews.length,
    };
  });
}

function normalizeReview(raw = {}) {
  const text = normalizeText(raw.text || '');
  const author = normalizeText(raw.author || 'Anonymous');
  const reviewId = normalizeText(raw.reviewId || '') || null;
  const rating = parseRatingValue(raw.ratingText);
  const reviewerUrl = normalizeMaybeUrl(raw.reviewerUrl);
  const approxDate = approximateDateFromRelativeText(raw.dateText || '');
  const images = dedupeBy(
    (raw.photos || []).map((photo) => ({
      label: normalizeText(photo.label || ''),
      url: normalizeMaybeUrl(photo.url),
    })).filter((photo) => photo.url),
    (photo) => photo.url,
  );

  return {
    reviewId,
    author,
    reviewerMeta: normalizeText(raw.reviewerMeta || ''),
    reviewerUrl,
    ratingText: normalizeText(raw.ratingText || ''),
    rating,
    dateText: normalizeText(raw.dateText || ''),
    approxDate,
    approxMonth: formatApproximateMonth(approxDate),
    text,
    likeText: normalizeText(raw.likeText || ''),
    images,
    rawText: normalizeText(raw.rawText || ''),
    sampleSortKey: raw.sampleSortKey || null,
    sampleSortLabel: raw.sampleSortLabel || null,
  };
}

async function collectReviews(ctx, { maxReviews = 80, sampleSort = null } = {}) {
  const reviews = new Map();

  await collectWhileScrolling({
    maxSteps: 80,
    stagnantLimit: 4,
    pauseMinMs: 1200,
    pauseMaxMs: 1800,
    getCount: () => reviews.size,
    beforeStep: async () => {
      const expanded = await expandVisibleReviews(ctx);
      if (expanded > 0) {
        await pause(900, 1500);
      }
    },
    readStep: async () => await extractReviewState(ctx),
    mergeStep: async (state) => {
      for (const raw of state.reviews || []) {
        const review = normalizeReview({
          ...raw,
          sampleSortKey: sampleSort?.key || null,
          sampleSortLabel: sampleSort?.label || null,
        });
        const key = review.reviewId || normalizeText(`${review.author}|${review.dateText}|${review.text || review.rawText}`);
        if (!key || reviews.has(key)) continue;
        reviews.set(key, review);
        if (reviews.size >= maxReviews) break;
      }
    },
    shouldStop: () => reviews.size >= maxReviews,
  });

  return Array.from(reviews.values());
}

async function collectReviewMix(ctx, options) {
  const plan = buildSortPlan(options.sort, options.maxReviews);
  const combined = new Map();
  const buckets = [];

  for (const bucket of plan) {
    await applyReviewSort(ctx, bucket.label);
    await scrollReviewPaneToTop(ctx);
    const collected = await collectReviews(ctx, { maxReviews: bucket.limit, sampleSort: bucket });
    buckets.push({ sort: bucket, requested: bucket.limit, collected: collected.length });

    for (const review of collected) {
      const key = review.reviewId || normalizeText(`${review.author}|${review.dateText}|${review.text || review.rawText}`);
      if (!key || combined.has(key)) continue;
      combined.set(key, review);
    }
  }

  return {
    reviews: Array.from(combined.values()),
    buckets,
  };
}

function buildSampleRatingSummary(reviews) {
  const counts = new Map();
  for (const review of reviews) {
    const key = review.rating != null ? String(review.rating) : 'unrated';
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([rating, count]) => ({
      rating: rating === 'unrated' ? null : Number(rating),
      count,
    }))
    .sort((a, b) => {
      if (a.rating == null) return 1;
      if (b.rating == null) return -1;
      return b.rating - a.rating;
    });
}

function buildTimingSummary(reviews, latitude) {
  const monthBuckets = new Map();
  const seasonBuckets = new Map();

  for (const review of reviews) {
    if (review.approxMonth) {
      monthBuckets.set(review.approxMonth, (monthBuckets.get(review.approxMonth) || 0) + 1);
    }
    const season = seasonForDate(review.approxDate, latitude);
    if (season) {
      seasonBuckets.set(season, (seasonBuckets.get(season) || 0) + 1);
    }
  }

  return {
    months: Array.from(monthBuckets.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
    seasons: Array.from(seasonBuckets.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)),
  };
}

function reviewBody(review) {
  return normalizeText(review.text || review.rawText || '') || '(no written review text)';
}

function formatSampleRatingEntry(entry) {
  return entry.rating != null
    ? `${entry.rating}★ (${entry.count})`
    : `unrated (${entry.count})`;
}

function formatResolutionLabel(resolution) {
  if (resolution?.resolvedFrom === 'place-url') return 'explicit Google Maps URL';
  if (resolution?.resolvedFrom === 'place') return 'direct place match';
  if (resolution?.resolvedFrom === 'single-result') return 'single search result';
  return 'search results';
}

function buildPlaceSelectionMarkdown(options, resolution) {
  const lines = [];
  lines.push('# Google Maps place selection required');
  lines.push('');
  if (options.query) lines.push(`- Query: ${options.query}`);
  lines.push(`- Candidate places: ${resolution.candidates.length}`);
  lines.push('- Google Maps returned multiple place candidates, so no place was auto-selected.');
  lines.push('- Next step: choose one Google Maps URL below and rerun with `--place-url`.');
  lines.push('');
  lines.push('## Candidates');
  lines.push('');

  resolution.candidates.forEach((candidate, index) => {
    lines.push(`### ${index + 1}. ${candidate.name}`);
    lines.push('');
    lines.push(`- Maps: ${candidate.href}`);
    if (candidate.ratingText) lines.push(`- Rating: ${candidate.ratingText}`);
    if (candidate.reviewText) lines.push(`- Reviews: ${candidate.reviewText}`);
    if (candidate.summary) lines.push(`- Summary: ${candidate.summary}`);
    lines.push('');
  });

  const exampleUrl = resolution.candidates[0]?.href || 'https://www.google.com/maps/place/...';
  lines.push('## Rerun example');
  lines.push('');
  lines.push('```bash');
  lines.push(`./reviews.js --place-url "${exampleUrl}" --sort ${options.sort.key} --max-reviews ${options.maxReviews}${options.json ? ' -j' : ''}`);
  lines.push('```');
  lines.push('');

  return lines.join('\n').trim() + '\n';
}

function buildMarkdown(report) {
  const lines = [];
  const title = report.place.name || report.query || 'Google Maps place';
  const overallRating = report.reviewSummary.overallRatingText || null;
  const totalReviews = report.reviewSummary.totalReviewsText || null;

  lines.push(`# Google Maps review report: ${title}`);
  lines.push('');
  if (report.query) lines.push(`- Query: ${report.query}`);
  lines.push(`- Matched place: ${report.place.name}${report.place.category ? ` (${report.place.category})` : ''}`);
  lines.push(`- Match mode: ${formatResolutionLabel(report.resolution)}`);
  if (overallRating || totalReviews) {
    lines.push(`- Rating: ${[overallRating, totalReviews].filter(Boolean).join(' · ')}`);
  }
  lines.push(`- Sampled reviews: ${report.reviews.length} total`);
  if (report.reviewBuckets.length > 0) {
    lines.push(`- Mix: ${report.reviewBuckets.map((bucket) => `${bucket.sort.label} ${bucket.collected}/${bucket.requested}`).join(' · ')}`);
  }
  if (report.sampleRatingSummary.length > 0) {
    lines.push(`- Sample rating mix: ${report.sampleRatingSummary.map(formatSampleRatingEntry).join(' · ')}`);
  }
  if (report.place.address) lines.push(`- Address: ${report.place.address}`);
  if (report.place.websiteText) lines.push(`- Website: ${report.place.websiteText}`);
  lines.push(`- Maps: ${report.reviewSummary.reviewPaneUrl || report.place.mapsUrl}`);
  if (report.place.description) lines.push(`- Description: ${report.place.description}`);
  lines.push('');

  if (report.reviewSummary.histogram.length > 0) {
    lines.push('## Rating distribution');
    lines.push('');
    for (const row of report.reviewSummary.histogram) {
      lines.push(`- ${row.stars}★: ${row.count.toLocaleString()} reviews`);
    }
    lines.push('');
  }

  if (report.timingSummary.months.length > 0 || report.timingSummary.seasons.length > 0) {
    lines.push('## Timing in the sampled reviews');
    lines.push('');
    if (report.timingSummary.months.length > 0) {
      lines.push(`- Approx months: ${report.timingSummary.months.map((entry) => `${entry.label} (${entry.count})`).join(', ')}`);
    }
    if (report.timingSummary.seasons.length > 0) {
      lines.push(`- Seasons / seasonal context: ${report.timingSummary.seasons.map((entry) => `${entry.label} (${entry.count})`).join(', ')}`);
    }
    lines.push('');
  }

  if (report.reviewSummary.topics.length > 0) {
    lines.push('## Google review topics (raw)');
    lines.push('');
    for (const topic of report.reviewSummary.topics) {
      lines.push(`- ${topic.label}: ${topic.count.toLocaleString()} mentions`);
    }
    lines.push('');
  }

  if (report.sampleRatingSummary.length > 0) {
    lines.push('## Rating mix in sampled reviews');
    lines.push('');
    for (const entry of report.sampleRatingSummary) {
      lines.push(`- ${formatSampleRatingEntry(entry)}`);
    }
    lines.push('');
  }

  if (report.reviews.length > 0) {
    lines.push('## Sampled reviews');
    lines.push('');
    for (const [index, review] of report.reviews.entries()) {
      lines.push(`### ${index + 1}. ${review.author || 'Anonymous'}`);
      lines.push('');

      const meta = [
        review.rating != null ? `${review.rating}★` : review.ratingText || null,
        ...formatReviewTimeContext(review, report.place.latitude),
        review.sampleSortLabel || null,
      ].filter(Boolean);
      if (meta.length > 0) lines.push(`- Meta: ${meta.join(' · ')}`);
      if (review.reviewerMeta) lines.push(`- Reviewer details: ${review.reviewerMeta}`);
      if (review.likeText) lines.push(`- Likes: ${review.likeText}`);
      if (review.reviewerUrl) lines.push(`- Reviewer profile: ${review.reviewerUrl}`);
      lines.push(`- Text: ${reviewBody(review)}`);

      if (review.images.length > 0) {
        lines.push('- Photos:');
        for (const [photoIndex, image] of review.images.entries()) {
          lines.push(`  - [${image.label || `Review photo ${photoIndex + 1}`}](${image.url})`);
        }
      }

      lines.push('');
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

async function main() {
  const options = normalizeOptions(parseArgs(process.argv.slice(2)));
  const ctx = await openMapsContext({ newTab: options.newTab });

  try {
    const resolution = await resolvePlace(ctx, options);
    if (resolution.status === 'needs_place_selection') {
      const markdown = buildPlaceSelectionMarkdown(options, resolution);
      const result = {
        status: resolution.status,
        query: options.query,
        placeUrl: options.placeUrl,
        sort: options.sort,
        maxReviews: options.maxReviews,
        resolution,
        candidates: resolution.candidates,
        markdown,
      };

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      if (options.out) {
        writeFileSync(options.out, markdown, 'utf8');
        console.log(`Wrote ${options.out}`);
        return;
      }

      process.stdout.write(markdown);
      return;
    }

    const place = await readPlaceProfile(ctx);
    await openReviewsPane(ctx);
    const reviewSummary = await readReviewSummary(ctx);
    const mix = await collectReviewMix(ctx, options);
    const reviews = mix.reviews;
    const sampleRatingSummary = buildSampleRatingSummary(reviews);
    const timingSummary = buildTimingSummary(reviews, place.latitude);

    const result = {
      status: 'ok',
      query: options.query,
      placeUrl: options.placeUrl,
      sort: options.sort,
      resolution,
      place,
      reviewSummary,
      reviewBuckets: mix.buckets,
      sampleRatingSummary,
      timingSummary,
      reviews,
      markdown: '',
    };

    const markdown = buildMarkdown(result);
    result.markdown = markdown;

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (options.out) {
      writeFileSync(options.out, markdown, 'utf8');
      console.log(`Wrote ${options.out}`);
      return;
    }

    process.stdout.write(markdown);
  } finally {
    await closeContext(ctx);
  }
}

main().catch((error) => {
  console.error('✗', error.message);
  process.exit(1);
});
