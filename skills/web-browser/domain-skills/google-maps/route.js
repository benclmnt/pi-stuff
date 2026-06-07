#!/usr/bin/env node

import {
  buildDirectionsUrl,
  closeContext,
  navigate,
  normalizeText,
  openMapsContext,
  waitFor,
} from './common.js';

function usage() {
  console.log(`Usage:
  ./route.js "<origin>" "<destination>" [--mode car|transit|walk] [-j]
  ./route.js --from "<origin>" --to "<destination>" [--mode car|transit|walk] [-j]

Examples:
  ./route.js "Marina Bay Sands" "Changi Airport"
  ./route.js --from "A" --to "B" --mode transit
  ./route.js "A" "B" --mode walk -j`);
}

function parseArgs(argv) {
  let json = false;
  let newTab = false;
  let mode = 'car';
  let from = null;
  let to = null;
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-j' || arg === '--json') {
      json = true;
    } else if (arg === '--new-tab' || arg === '--fresh') {
      newTab = true;
    } else if (arg === '--mode' || arg === '-m') {
      mode = argv[++i] || mode;
    } else if (arg === '--from') {
      from = argv[++i] || from;
    } else if (arg === '--to') {
      to = argv[++i] || to;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  if (!from && positional[0]) from = positional[0];
  if (!to && positional[1]) to = positional[1];

  return { json, newTab, mode, from, to };
}

function normalizeMode(input) {
  const value = String(input || 'car').toLowerCase();
  if (['car', 'cars', 'drive', 'driving'].includes(value)) {
    return { mapsMode: 'driving', label: 'car' };
  }
  if (['transit', 'public', 'public-transport', 'public_transport', 'train', 'bus'].includes(value)) {
    return { mapsMode: 'transit', label: 'transit' };
  }
  if (['walk', 'walking', 'foot'].includes(value)) {
    return { mapsMode: 'walking', label: 'walk' };
  }
  throw new Error(`Unsupported mode: ${input}`);
}

function toUserMode(modeName) {
  const value = String(modeName || '').toLowerCase();
  if (value === 'driving') return 'car';
  if (value === 'walking') return 'walk';
  if (value === 'transit') return 'transit';
  return value || null;
}

async function readRoute(ctx) {
  return await ctx.cdp.evaluate(
    ctx.sessionId,
    `(() => {
      const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const selectedMode = (() => {
        const button = Array.from(document.querySelectorAll('button[role="radio"].m6Uuef'))
          .find((el) => el.getAttribute('aria-checked') === 'true');
        return button?.getAttribute('data-tooltip') || null;
      })();

      const domRoutes = Array.from(document.querySelectorAll('[data-trip-index]'))
        .filter((el) => ['link', 'button'].includes(el.getAttribute('role')))
        .map((el) => {
          const tripIndex = Number(el.getAttribute('data-trip-index') || 0);
          const duration = norm(el.querySelector('.Fk3sm')?.textContent || '');
          const secondary = norm(el.querySelector('.ivN21e')?.textContent || '');
          return {
            tripIndex,
            durationText: duration || null,
            summaryText: secondary || null,
            rawText: norm(el.innerText || el.textContent || ''),
          };
        });

      let appRoutes = [];
      try {
        const raw = APP_INITIALIZATION_STATE?.[3]?.Zf?.[4];
        if (typeof raw === 'string' && raw.startsWith(")]}'")) {
          const parsed = JSON.parse(raw.slice(5));
          const routes = parsed?.[0]?.[1] || [];
          appRoutes = routes.map((route, index) => {
            const entry = route?.[0];
            return {
              tripIndex: index,
              distanceText: entry?.[2]?.[1] || null,
              durationText: entry?.[3]?.[1] || null,
              intervalText: typeof entry?.[1] === 'string' ? entry[1] : null,
            };
          });
        }
      } catch {
        // ignore
      }

      const merged = new Map();
      for (const route of appRoutes) {
        merged.set(route.tripIndex, { ...route });
      }
      for (const route of domRoutes) {
        const current = merged.get(route.tripIndex) || {};
        merged.set(route.tripIndex, {
          ...current,
          ...route,
          distanceText: current.distanceText || null,
          durationText: current.durationText || route.durationText || null,
        });
      }

      const routes = Array.from(merged.values())
        .sort((a, b) => a.tripIndex - b.tripIndex)
        .map((route) => ({
          tripIndex: route.tripIndex,
          durationText: route.durationText || null,
          distanceText: route.distanceText || null,
          intervalText: route.intervalText || null,
          summaryText: route.summaryText || null,
          rawText: route.rawText || null,
        }));

      return {
        title: document.title,
        url: location.href,
        selectedMode,
        primary: routes[0] || null,
        alternatives: routes.slice(1),
      };
    })()`,
    60000,
  );
}

async function main() {
  const { json, newTab, mode, from, to } = parseArgs(process.argv.slice(2));
  if (!from || !to) {
    usage();
    process.exit(1);
  }

  const { mapsMode, label } = normalizeMode(mode);
  const ctx = await openMapsContext({ newTab });

  try {
    const url = buildDirectionsUrl(from, to, mapsMode);
    await navigate(ctx, url, { waitMinMs: 6500, waitMaxMs: 9000 });
    await waitFor(
      ctx,
      () => !!document.querySelector('[data-trip-index]') || !!document.querySelector('button[role="radio"].m6Uuef'),
      { timeoutMs: 25000, intervalMs: 500, label: 'route results' },
    );

    const route = await readRoute(ctx);
    if (!route?.primary) {
      throw new Error('No route found');
    }

    const result = {
      from,
      to,
      requestedMode: label,
      selectedMode: toUserMode(route.selectedMode),
      duration: route.primary.durationText || null,
      distance: route.primary.distanceText || null,
      cadence: route.primary.intervalText || null,
      summary: route.primary.summaryText || route.primary.rawText || null,
      url: route.url,
      title: route.title,
      alternatives: route.alternatives,
    };

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const bits = [result.selectedMode || label];
    if (result.duration) bits.push(result.duration);
    if (result.distance) bits.push(result.distance);
    console.log(bits.join(' · '));
    if (result.cadence) console.log(result.cadence);
    if (result.summary) {
      const summary = normalizeText(result.summary);
      if (summary && !summary.includes(result.duration || '') && !summary.includes(result.distance || '')) {
        console.log(summary);
      }
    }
    console.log(result.url);
  } finally {
    await closeContext(ctx);
  }
}

main().catch((error) => {
  console.error('✗', error.message);
  process.exit(1);
});
