#!/usr/bin/env node

import {
  closeContext,
  evaluate,
  normalizeKey,
  openMapsContext,
  parseListLabel,
  pause,
  readPlaceSummary,
  resolvePlaceFromQuery,
  waitFor,
} from './common.js';

function usage() {
  console.log(`Usage:
  ./save-place.js "<place query>" --list "<saved list>" [-j]

Examples:
  ./save-place.js "Singapore Flyer" --list "Want to go"
  ./save-place.js "Starbucks Singapore" --list "food?" -j`);
}

function parseArgs(argv) {
  let json = false;
  let newTab = false;
  let listName = null;
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-j' || arg === '--json') {
      json = true;
    } else if (arg === '--new-tab' || arg === '--fresh') {
      newTab = true;
    } else if (arg === '--list' || arg === '--saved-list') {
      listName = argv[++i] || listName;
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
    query: positional[0] || null,
    listName,
  };
}

function extractPlaceResolutionState(searchQuery) {
  const queryKey = key(searchQuery);

  if (location.pathname.includes('/maps/place/')) {
    const name = norm(document.querySelector('h1')?.innerText || document.title.replace(/ - Google Maps$/, ''));
    const address = norm(
      Array.from(document.querySelectorAll('button, div, span'))
        .find((el) => (el.getAttribute('aria-label') || '').startsWith('Address:'))
        ?.textContent ||
      '',
    );
    return {
      kind: 'place',
      chosen: { name, address, href: location.href, score: 1000 },
      candidates: [],
    };
  }

  const score = (name, index) => {
    const nameKey = key(name);
    let value = 0;
    if (nameKey === queryKey) value += 1000;
    if (nameKey.startsWith(queryKey)) value += 700;
    if (queryKey.startsWith(nameKey)) value += 450;
    if (nameKey.includes(queryKey)) value += 250;
    const queryTokens = queryKey.split(' ').filter(Boolean);
    const nameTokens = new Set(nameKey.split(' ').filter(Boolean));
    const overlap = queryTokens.filter((token) => nameTokens.has(token)).length;
    value += overlap * 40;
    value += Math.max(0, 100 - index);
    return value;
  };

  const candidates = Array.from(document.querySelectorAll('div[role="article"]'))
    .map((article, index) => {
      const link = article.querySelector('a.hfpxzc');
      const name = norm(link?.getAttribute('aria-label') || article.getAttribute('aria-label') || '');
      const href = link?.href || null;
      const summary = norm(article.innerText || article.textContent || '');
      return {
        index,
        name,
        href,
        summary,
        score: score(name, index),
      };
    })
    .filter((candidate) => candidate.name && candidate.href)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  return {
    kind: 'results',
    chosen: candidates[0] || null,
    candidates: candidates.slice(0, 10),
  };
}

async function resolvePlace(ctx, query) {
  const resolution = await resolvePlaceFromQuery(ctx, query, {
    extractState: extractPlaceResolutionState,
    searchWaitLabel: 'search results or place page',
  });

  return {
    ...resolution,
    place: await readPlaceSummary(ctx),
  };
}

async function clickPlaceSaveButton(ctx) {
  const clicked = await evaluate(ctx, () => {
    const candidates = Array.from(document.querySelectorAll('button'));

    const preferred = candidates.find((button) => {
      const aria = strip(button.getAttribute('aria-label') || '');
      return /^Saved\b|^Save\b/i.test(aria);
    });

    const fallback = candidates.find((button) => {
      const text = strip(button.innerText || button.textContent || '');
      return /^Saved\b|^Save\b/i.test(text);
    });

    const target = preferred || fallback;
    if (!target) return false;
    target.click();
    return true;
  });

  if (!clicked) {
    throw new Error('Could not find the place Save button');
  }
}

async function openSaveMenu(ctx, { reset = false } = {}) {
  const menuAlreadyOpen = await evaluate(
    ctx,
    () => !!document.querySelector('[role="menu"][aria-label="Save in your lists"]'),
  );

  if (menuAlreadyOpen && !reset) return;

  if (menuAlreadyOpen && reset) {
    await clickPlaceSaveButton(ctx);
    await pause(1200, 2000);
  }

  await clickPlaceSaveButton(ctx);
  await pause(3500, 5500);
  await waitFor(
    ctx,
    () => !!document.querySelector('[role="menu"][aria-label="Save in your lists"]'),
    { timeoutMs: 20000, intervalMs: 400, label: 'save menu' },
  );
}

async function toggleExistingMenuList(ctx, targetName) {
  const targetKey = normalizeKey(targetName);
  let availableLists = [];

  for (let step = 0; step < 50; step++) {
    const state = await evaluate(ctx, (desiredKey) => {
      const menu = document.querySelector('[role="menu"][aria-label="Save in your lists"]');
      if (!menu) return { menuPresent: false, items: [] };

      const entries = Array.from(menu.querySelectorAll('[role="menuitemradio"]')).map((item) => ({
        el: item,
        rawText: norm(item.innerText || item.textContent || ''),
        name: parseListLabelParts(item.innerText || item.textContent || '').name,
        checked: item.getAttribute('aria-checked') === 'true',
      }));

      const items = entries.map((entry) => ({ rawText: entry.rawText, checked: entry.checked }));
      const exact = entries.find((entry) => key(entry.name) === desiredKey);
      const fuzzy = entries.find((entry) => {
        const entryKey = key(entry.name);
        return entryKey.includes(desiredKey) || desiredKey.includes(entryKey);
      });
      const match = exact || fuzzy;
      if (match) {
        if (!match.checked) match.el.click();
        return {
          menuPresent: true,
          found: true,
          alreadyChecked: match.checked,
          clicked: !match.checked,
          matchedName: match.name,
          items,
        };
      }

      return {
        menuPresent: true,
        found: false,
        canScroll: scrollForward(menu, { minStep: 220, ratio: 0.85 }),
        items,
      };
    }, targetKey);

    availableLists = availableLists.concat(state.items || []);

    if (!state.menuPresent) {
      throw new Error('Save menu disappeared');
    }

    if (state.found) {
      if (state.clicked) await pause(3500, 5500);
      return {
        found: true,
        created: false,
        alreadySaved: state.alreadyChecked,
        matchedName: state.matchedName,
        availableLists,
      };
    }

    if (!state.canScroll) {
      return {
        found: false,
        created: false,
        alreadySaved: false,
        matchedName: null,
        availableLists,
      };
    }

    await pause(1200, 1800);
  }

  return {
    found: false,
    created: false,
    alreadySaved: false,
    matchedName: null,
    availableLists,
  };
}

function dedupeAvailableLists(rawItems = []) {
  const deduped = new Map();
  for (const item of rawItems) {
    const parsed = { ...parseListLabel(item.rawText), checked: item.checked };
    if (!parsed.name) continue;
    const key = normalizeKey(parsed.name);
    const current = deduped.get(key);
    deduped.set(key, current ? { ...current, checked: current.checked || parsed.checked } : parsed);
  }
  return Array.from(deduped.values());
}

async function createNewList(ctx, listName) {
  const opened = await evaluate(ctx, () => {
    const menu = document.querySelector('[role="menu"][aria-label="Save in your lists"]');
    if (!menu) return false;
    const button = Array.from(menu.querySelectorAll('button')).find((entry) => {
      const text = norm(entry.innerText || entry.textContent || '');
      return text === 'New list' || text === 'New list';
    });
    if (!button) return false;
    button.click();
    return true;
  });

  if (!opened) {
    throw new Error('Could not open the New list dialog');
  }

  await pause(3500, 5500);
  await waitFor(
    ctx,
    () => !!document.querySelector('[role="dialog"][aria-label="New list"] input'),
    { timeoutMs: 20000, intervalMs: 400, label: 'new list dialog' },
  );

  const submitted = await evaluate(ctx, (desiredName) => {
    const dialog = document.querySelector('[role="dialog"][aria-label="New list"]');
    if (!dialog) return false;
    const input = dialog.querySelector('input');
    if (!input) return false;

    input.focus();
    if (typeof input.select === 'function') input.select();
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.value = desiredName;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const createButton = Array.from(dialog.querySelectorAll('button')).find((button) => norm(button.innerText || button.textContent || '') === 'Create');
    if (!createButton) return false;
    createButton.click();
    return true;
  }, listName);

  if (!submitted) {
    throw new Error('Could not submit the New list dialog');
  }

  await pause(5000, 7000);
}

async function ensureSavedToList(ctx, listName) {
  await openSaveMenu(ctx, { reset: true });
  const existing = await toggleExistingMenuList(ctx, listName);
  if (existing.found) {
    return {
      action: existing.alreadySaved ? 'already-saved' : 'saved',
      createdList: false,
      matchedListName: existing.matchedName || listName,
      availableLists: dedupeAvailableLists(existing.availableLists),
    };
  }

  await createNewList(ctx, listName);

  await openSaveMenu(ctx, { reset: true });
  const verification = await toggleExistingMenuList(ctx, listName);
  if (!verification.found) {
    throw new Error(`List was created but could not be verified: ${listName}`);
  }

  return {
    action: 'saved',
    createdList: true,
    matchedListName: verification.matchedName || listName,
    availableLists: dedupeAvailableLists(existing.availableLists),
  };
}

async function main() {
  const { json, newTab, query, listName } = parseArgs(process.argv.slice(2));
  if (!query || !listName) {
    usage();
    process.exit(1);
  }

  const ctx = await openMapsContext({ newTab });

  try {
    const resolution = await resolvePlace(ctx, query);
    const saveResult = await ensureSavedToList(ctx, listName);

    const output = {
      query,
      targetList: listName,
      matchedList: saveResult.matchedListName,
      createdList: saveResult.createdList,
      action: saveResult.action,
      resolvedFrom: resolution.resolvedFrom,
      chosenCandidate: resolution.chosenCandidate,
      place: resolution.place,
      availableLists: saveResult.availableLists,
    };

    if (json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    const createdText = saveResult.createdList ? ' (created list)' : '';
    console.log(`${output.action}: ${output.place.name} → ${output.matchedList}${createdText}`);
    console.log(output.place.url);
  } finally {
    await closeContext(ctx);
  }
}

main().catch((error) => {
  console.error('✗', error.message);
  process.exit(1);
});
