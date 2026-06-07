#!/usr/bin/env node

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
  ./hotels.js "<area>" [--check-in YYYY-MM-DD --check-out YYYY-MM-DD] [--guests 2]
               [--min-rating 4.0] [--min-price 100] [--max-price 250]
               [--sort relevance|rating|reviews|price|price-desc] [--limit 10] [-j]

Examples:
  ./hotels.js "Shinjuku Tokyo"
  ./hotels.js "Shinjuku Tokyo" --check-in 2026-06-15 --check-out 2026-06-18 --guests 3
  ./hotels.js "Tokyo" --min-rating 4.2 --max-price 250 --sort price -j`);
}

function parseArgs(argv) {
  let json = false;
  let newTab = false;
  let checkIn = null;
  let checkOut = null;
  let guests = null;
  let minRating = null;
  let minPrice = null;
  let maxPrice = null;
  let sort = 'relevance';
  let limit = 10;
  let query = null;
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-j' || arg === '--json') {
      json = true;
    } else if (arg === '--new-tab' || arg === '--fresh') {
      newTab = true;
    } else if (arg === '--check-in') {
      checkIn = argv[++i] || checkIn;
    } else if (arg === '--check-out') {
      checkOut = argv[++i] || checkOut;
    } else if (arg === '--guests') {
      guests = argv[++i] || guests;
    } else if (arg === '--min-rating') {
      minRating = argv[++i] || minRating;
    } else if (arg === '--min-price') {
      minPrice = argv[++i] || minPrice;
    } else if (arg === '--max-price') {
      maxPrice = argv[++i] || maxPrice;
    } else if (arg === '--sort') {
      sort = argv[++i] || sort;
    } else if (arg === '--limit' || arg === '-n') {
      limit = argv[++i] || limit;
    } else if (arg === '--query') {
      query = argv[++i] || query;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (!query && positional[0]) query = positional[0];

  return {
    json,
    newTab,
    query,
    checkIn,
    checkOut,
    guests,
    minRating,
    minPrice,
    maxPrice,
    sort,
    limit,
  };
}

function parseIsoDate(value, label) {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}. Use YYYY-MM-DD`);
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return date;
}

function diffNights(checkIn, checkOut) {
  const start = parseIsoDate(checkIn, 'check-in');
  const end = parseIsoDate(checkOut, 'check-out');
  const ms = end.getTime() - start.getTime();
  const nights = Math.round(ms / 86400000);
  if (nights <= 0) {
    throw new Error('check-out must be after check-in');
  }
  return nights;
}

function toOptionalNumber(value, label) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return number;
}

function normalizeOptions(raw) {
  const query = normalizeText(raw.query || '');
  if (!query) {
    usage();
    process.exit(1);
  }

  if ((raw.checkIn && !raw.checkOut) || (!raw.checkIn && raw.checkOut)) {
    throw new Error('Use both --check-in and --check-out together');
  }

  if (raw.checkIn) {
    parseIsoDate(raw.checkIn, 'check-in');
    parseIsoDate(raw.checkOut, 'check-out');
  }

  const guests = raw.guests == null ? null : Math.trunc(toOptionalNumber(raw.guests, 'guests'));
  if (guests != null && (guests < 1 || guests > 4)) {
    throw new Error('guests must be between 1 and 4');
  }

  const minRating = toOptionalNumber(raw.minRating, 'min-rating');
  if (minRating != null && (minRating < 0 || minRating > 5)) {
    throw new Error('min-rating must be between 0 and 5');
  }

  const minPrice = toOptionalNumber(raw.minPrice, 'min-price');
  const maxPrice = toOptionalNumber(raw.maxPrice, 'max-price');
  if (minPrice != null && minPrice < 0) throw new Error('min-price must be >= 0');
  if (maxPrice != null && maxPrice < 0) throw new Error('max-price must be >= 0');
  if (minPrice != null && maxPrice != null && minPrice > maxPrice) {
    throw new Error('min-price cannot be greater than max-price');
  }

  const sort = String(raw.sort || 'relevance').toLowerCase();
  if (!['relevance', 'rating', 'reviews', 'price', 'price-desc'].includes(sort)) {
    throw new Error(`Unsupported sort: ${raw.sort}`);
  }

  const limit = Math.trunc(toOptionalNumber(raw.limit, 'limit'));
  if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be between 1 and 100');
  }

  return {
    ...raw,
    query,
    guests,
    minRating,
    minPrice,
    maxPrice,
    sort,
    limit,
    nights: raw.checkIn && raw.checkOut ? diffNights(raw.checkIn, raw.checkOut) : null,
  };
}

function buildHotelQuery(query) {
  if (/\bhotels?\b/i.test(query)) return query;
  return `hotels in ${query}`;
}

function replaceDataSegment(url, dataSegment) {
  const [base, query = ''] = String(url).split('?');
  const nextBase = base.includes('/data=')
    ? base.replace(/\/data=.*$/, `/data=${dataSegment}`)
    : `${base.replace(/\/$/, '')}/data=${dataSegment}`;
  return query ? `${nextBase}?${query}` : nextBase;
}

function buildHotelDataSegment({ checkIn, checkOut, guests, nights }) {
  if (checkIn && checkOut) {
    const effectiveGuests = guests ?? 2;
    return `!3m1!4b1!4m8!2m7!5m5!5m4!1s${checkIn}!2i${nights}!4m1!1i${effectiveGuests}!6e3`;
  }

  if (guests != null) {
    return `!3m1!4b1!4m6!2m5!5m3!5m2!4m1!1i${guests}!6e3`;
  }

  return null;
}

function normalizeHotelUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return rawUrl || null;
  }
}

function parsePriceValue(priceText) {
  const raw = normalizeText(priceText || '');
  if (!raw) return null;
  const match = raw.match(/([\d][\d,.]*)/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function parseRatingValue(ratingText) {
  const raw = normalizeText(ratingText || '');
  const match = raw.match(/([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseReviewCount(reviewText) {
  const raw = normalizeText(reviewText || '');
  const match = raw.match(/([\d,]+)/);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function parseHotelClass(hotelClassText) {
  const raw = normalizeText(hotelClassText || '');
  const match = raw.match(/([1-5])\s*-?\s*star hotel/i);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function enrichHotel(card, rank) {
  const priceValue = parsePriceValue(card.priceText);
  const ratingValue = parseRatingValue(card.ratingText);
  const reviewCount = parseReviewCount(card.reviewText);
  const hotelClass = parseHotelClass(card.hotelClassText);
  return {
    rank,
    ...card,
    canonicalUrl: normalizeHotelUrl(card.url),
    priceValue,
    ratingValue,
    reviewCount,
    hotelClass,
  };
}

async function openHotelResults(ctx, options) {
  const hotelQuery = buildHotelQuery(options.query);
  await navigate(ctx, buildSearchUrl(hotelQuery), { waitMinMs: 7000, waitMaxMs: 9500 });
  await waitFor(
    ctx,
    () => !!document.querySelector('div[role="article"]'),
    { timeoutMs: 30000, intervalMs: 500, label: 'hotel results' },
  );

  const dataSegment = buildHotelDataSegment(options);
  if (!dataSegment) {
    return { hotelQuery, sourceUrl: await evaluate(ctx, () => location.href) };
  }

  const currentUrl = await evaluate(ctx, () => location.href);
  const nextUrl = replaceDataSegment(currentUrl, dataSegment);
  await navigate(ctx, nextUrl, { waitMinMs: 7000, waitMaxMs: 9500 });
  await waitFor(
    ctx,
    () => !!document.querySelector('div[role="article"]'),
    { timeoutMs: 30000, intervalMs: 500, label: 'dated hotel results' },
  );

  return { hotelQuery, sourceUrl: await evaluate(ctx, () => location.href) };
}

async function collectHotelCards(ctx, { maxSteps = 40 } = {}) {
  const cards = new Map();
  let meta = { title: null, url: null };

  await collectWhileScrolling({
    maxSteps,
    stagnantLimit: 3,
    pauseMinMs: 1300,
    pauseMaxMs: 1900,
    getCount: () => cards.size,
    readStep: async () => await evaluate(ctx, () => {
      const main = document.querySelector('[role="main"]');
      const scroller = findBestScroller({
        root: main,
        candidateSelector: 'div',
        itemSelector: 'div[role="article"]',
        fallback: main,
      });

      const entries = Array.from((scroller || main)?.querySelectorAll('div[role="article"]') || []).map((article, index) => {
        const link = article.querySelector('a.hfpxzc');
        const rawName = norm(
          article.querySelector('.qBF1Pd, .fontHeadlineSmall')?.textContent ||
          link?.getAttribute('aria-label') ||
          article.getAttribute('aria-label') ||
          '',
        );
        const ratingNode = article.querySelector('[role="img"][aria-label*="stars"]');
        const ratingText = norm(ratingNode?.querySelector('.MW4etd')?.textContent || '');
        const reviewText = norm(ratingNode?.querySelector('.UY7F9')?.textContent || '');
        const detailGroups = Array.from(article.querySelectorAll('.W4Efsd'))
          .map((el) => norm(el.innerText || el.textContent || ''))
          .filter(Boolean);
        const hotelClassText = detailGroups.find((text) => /^\d\s*-?\s*star hotel$/i.test(text))
          || detailGroups.find((text) => /\bstar hotel\b/i.test(text))
          || null;
        const ratingLinePattern = /^[0-9]+(?:\.[0-9]+)?\s*\([\d,]+\)$/;
        let descriptionText = detailGroups.find((text) => {
          if (ratingLinePattern.test(text)) return false;
          if (hotelClassText && text === hotelClassText) return false;
          return true;
        }) || null;
        if (descriptionText && hotelClassText && descriptionText.startsWith(hotelClassText)) {
          descriptionText = norm(descriptionText.slice(hotelClassText.length));
        }
        const priceText = norm(article.querySelector('.wcldff, .FhDxwe')?.textContent || '');
        const amenities = Array.from(article.querySelectorAll('[role="img"].Yfjtfe'))
          .map((el) => norm(
            el.querySelector('.gSamH')?.textContent ||
            (el.getAttribute('aria-label') || '').replace(/\s+available$/i, ''),
          ))
          .filter(Boolean);
        const dealBadge = norm(article.querySelector('.TV2e7')?.textContent || '');
        const dealText = norm(article.querySelector('.QRP6q')?.textContent || '');
        const sponsored = !!article.querySelector('.jHLihd');
        const rawText = norm(article.innerText || article.textContent || '');

        return {
          index,
          name: rawName || null,
          url: link?.href || null,
          ratingText: ratingText || null,
          reviewText: reviewText || null,
          hotelClassText,
          descriptionText,
          priceText: priceText || null,
          amenities,
          dealBadge: dealBadge || null,
          dealText: dealText || null,
          sponsored,
          rawText: rawText || null,
        };
      }).filter((entry) => entry.name);

      return {
        title: document.title,
        url: location.href,
        entries,
        canScroll: scrollForward(scroller, { minStep: 280, ratio: 0.85 }),
      };
    }),
    mergeStep: async (state) => {
      meta = { title: state.title, url: state.url };
      for (const entry of state.entries || []) {
        const key = normalizeHotelUrl(entry.url) || entry.name;
        if (!key || cards.has(key)) continue;
        cards.set(key, entry);
      }
    },
  });

  const enriched = Array.from(cards.values()).map((card, index) => enrichHotel(card, index + 1));
  return { ...meta, hotels: enriched };
}

function applyFilters(hotels, options) {
  return hotels.filter((hotel) => {
    if (options.minRating != null && (hotel.ratingValue == null || hotel.ratingValue < options.minRating)) {
      return false;
    }
    if (options.minPrice != null && (hotel.priceValue == null || hotel.priceValue < options.minPrice)) {
      return false;
    }
    if (options.maxPrice != null && (hotel.priceValue == null || hotel.priceValue > options.maxPrice)) {
      return false;
    }
    return true;
  });
}

function sortHotels(hotels, sort) {
  const list = [...hotels];
  const withHighNulls = (value, fallback = Number.NEGATIVE_INFINITY) => value == null ? fallback : value;
  const withLowNulls = (value, fallback = Number.POSITIVE_INFINITY) => value == null ? fallback : value;

  list.sort((a, b) => {
    if (sort === 'rating') {
      return (
        withHighNulls(b.ratingValue) - withHighNulls(a.ratingValue) ||
        withHighNulls(b.reviewCount) - withHighNulls(a.reviewCount) ||
        withLowNulls(a.priceValue) - withLowNulls(b.priceValue) ||
        a.rank - b.rank
      );
    }

    if (sort === 'reviews') {
      return (
        withHighNulls(b.reviewCount) - withHighNulls(a.reviewCount) ||
        withHighNulls(b.ratingValue) - withHighNulls(a.ratingValue) ||
        a.rank - b.rank
      );
    }

    if (sort === 'price') {
      return (
        withLowNulls(a.priceValue) - withLowNulls(b.priceValue) ||
        withHighNulls(b.ratingValue) - withHighNulls(a.ratingValue) ||
        a.rank - b.rank
      );
    }

    if (sort === 'price-desc') {
      return (
        withHighNulls(b.priceValue) - withHighNulls(a.priceValue) ||
        withHighNulls(b.ratingValue) - withHighNulls(a.ratingValue) ||
        a.rank - b.rank
      );
    }

    return a.rank - b.rank;
  });

  return list;
}

function summarizeFilters(options) {
  const filters = [];
  if (options.checkIn && options.checkOut) {
    filters.push(`${options.checkIn} → ${options.checkOut} (${options.nights} night${options.nights === 1 ? '' : 's'})`);
  }
  if (options.guests != null) filters.push(`${options.guests} guest${options.guests === 1 ? '' : 's'}`);
  if (options.minRating != null) filters.push(`rating ≥ ${options.minRating}`);
  if (options.minPrice != null || options.maxPrice != null) {
    const min = options.minPrice != null ? options.minPrice : 'any';
    const max = options.maxPrice != null ? options.maxPrice : 'any';
    filters.push(`price ${min}–${max}`);
  }
  if (options.sort !== 'relevance') filters.push(`sort ${options.sort}`);
  return filters;
}

function pickOutputHotels(hotels, limit) {
  return hotels.slice(0, limit).map((hotel) => ({
    rank: hotel.rank,
    name: hotel.name,
    rating: hotel.ratingValue,
    ratingText: hotel.ratingText,
    reviewCount: hotel.reviewCount,
    hotelClass: hotel.hotelClass,
    hotelClassText: hotel.hotelClassText,
    description: hotel.descriptionText,
    price: hotel.priceValue,
    priceText: hotel.priceText,
    amenities: hotel.amenities,
    sponsored: hotel.sponsored,
    dealBadge: hotel.dealBadge,
    dealText: hotel.dealText,
    url: hotel.url,
    canonicalUrl: hotel.canonicalUrl,
  }));
}

async function main() {
  const options = normalizeOptions(parseArgs(process.argv.slice(2)));
  const ctx = await openMapsContext({ newTab: options.newTab });

  try {
    const opened = await openHotelResults(ctx, options);
    const collected = await collectHotelCards(ctx);
    const filtered = applyFilters(collected.hotels, options);
    const sorted = sortHotels(filtered, options.sort);
    const outputHotels = pickOutputHotels(sorted, options.limit);
    const filters = summarizeFilters(options);

    const result = {
      query: options.query,
      hotelQuery: opened.hotelQuery,
      dates: options.checkIn && options.checkOut ? {
        checkIn: options.checkIn,
        checkOut: options.checkOut,
        nights: options.nights,
      } : null,
      guests: options.guests,
      filters,
      sort: options.sort,
      sourceUrl: opened.sourceUrl,
      pageUrl: collected.url || opened.sourceUrl,
      title: collected.title,
      collectedCount: collected.hotels.length,
      matchingCount: sorted.length,
      returnedCount: outputHotels.length,
      hotels: outputHotels,
    };

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(result.hotelQuery);
    if (filters.length > 0) console.log(filters.join(' · '));
    console.log(`${result.matchingCount} match${result.matchingCount === 1 ? '' : 'es'} (${result.returnedCount} shown)`);
    console.log(result.sourceUrl);

    if (outputHotels.length === 0) {
      return;
    }

    for (const [index, hotel] of outputHotels.entries()) {
      const headerBits = [hotel.ratingText ? `${hotel.ratingText}★` : null];
      if (typeof hotel.reviewCount === 'number') headerBits.push(`${hotel.reviewCount.toLocaleString()} reviews`);
      if (hotel.hotelClassText) headerBits.push(hotel.hotelClassText);
      if (hotel.priceText) headerBits.push(hotel.priceText);
      if (hotel.dealBadge) headerBits.push(hotel.dealBadge);

      console.log(`\n${index + 1}. ${hotel.name}`);
      if (headerBits.length > 0) console.log(`   ${headerBits.filter(Boolean).join(' · ')}`);
      if (hotel.description) console.log(`   ${hotel.description}`);
      const amenityLine = hotel.amenities?.slice(0, 5)?.join(' · ');
      if (amenityLine) console.log(`   ${amenityLine}`);
      if (hotel.dealText) console.log(`   ${hotel.dealText}`);
      console.log(`   ${hotel.url}`);
    }
  } finally {
    await closeContext(ctx);
  }
}

main().catch((error) => {
  console.error('✗', error.message);
  process.exit(1);
});
