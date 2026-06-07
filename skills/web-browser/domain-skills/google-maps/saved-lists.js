#!/usr/bin/env node

import {
  SAVED_LISTS_URL,
  closeContext,
  collectWhileScrolling,
  evaluate,
  navigate,
  normalizeKey,
  normalizeText,
  openMapsContext,
  parseListLabel,
  pause,
  waitFor,
} from './common.js';

function usage() {
  console.log(`Usage:
  ./saved-lists.js list [-j]
  ./saved-lists.js show "<list name>" [-j]

Examples:
  ./saved-lists.js list
  ./saved-lists.js show "Saved places"
  ./saved-lists.js show "Japan" -j`);
}

function parseArgs(argv) {
  let json = false;
  let newTab = false;
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-j' || arg === '--json') {
      json = true;
    } else if (arg === '--new-tab' || arg === '--fresh') {
      newTab = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  const command = positional[0] || 'list';
  const listName = positional[1] || null;
  return { json, newTab, command, listName };
}

async function openSavedListsRoot(ctx) {
  await navigate(ctx, SAVED_LISTS_URL, { waitMinMs: 6500, waitMaxMs: 9000 });
  await waitFor(
    ctx,
    () => !!document.querySelector('button.CsEnBe'),
    { timeoutMs: 25000, intervalMs: 500, label: 'saved lists root' },
  );
}

async function collectSavedLists(ctx) {
  const lists = new Map();

  await collectWhileScrolling({
    maxSteps: 40,
    stagnantLimit: 3,
    pauseMinMs: 1200,
    pauseMaxMs: 1800,
    getCount: () => lists.size,
    readStep: async () => await evaluate(ctx, () => {
      const main = document.querySelector('[role="main"]');
      const buttons = Array.from(main?.querySelectorAll('button.CsEnBe') || []);
      const items = buttons.map((button) => ({ rawText: norm(button.innerText || button.textContent || '') }));
      const scroller = findBestScroller({
        root: main,
        candidateSelector: 'div, [role="tabpanel"]',
        itemSelector: 'button.CsEnBe',
        fallback: main,
      });

      return {
        items,
        canScroll: scrollForward(scroller, { minStep: 240, ratio: 0.85 }),
      };
    }),
    mergeStep: async (state) => {
      for (const item of state.items || []) {
        const parsed = parseListLabel(item.rawText);
        if (!parsed.name) continue;
        const listKey = normalizeKey(parsed.name);
        if (!lists.has(listKey)) lists.set(listKey, parsed);
      }
    },
  });

  return Array.from(lists.values());
}

async function openList(ctx, targetName) {
  const targetKey = normalizeKey(targetName);

  for (let step = 0; step < 40; step++) {
    const state = await evaluate(ctx, (desiredKey) => {
      const main = document.querySelector('[role="main"]');
      const buttons = Array.from(main?.querySelectorAll('button.CsEnBe') || []);
      const exact = buttons.find((button) => key(parseListLabelParts(button.innerText || button.textContent || '').name) === desiredKey);
      const fuzzy = buttons.find((button) => {
        const buttonKey = key(parseListLabelParts(button.innerText || button.textContent || '').name);
        return buttonKey.includes(desiredKey) || desiredKey.includes(buttonKey);
      });
      const match = exact || fuzzy;
      if (match) {
        match.click();
        return { clicked: true, label: norm(match.innerText || match.textContent || '') };
      }

      const scroller = findBestScroller({
        root: main,
        candidateSelector: 'div, [role="tabpanel"]',
        itemSelector: 'button.CsEnBe',
        fallback: main,
      });

      return {
        clicked: false,
        canScroll: scrollForward(scroller, { minStep: 240, ratio: 0.85 }),
      };
    }, targetKey);

    if (state.clicked) {
      await pause(4500, 6500);
      await waitFor(
        ctx,
        (desiredName) => {
          const title = document.querySelector('h1')?.innerText || document.title || '';
          return title.toLowerCase().includes(String(desiredName || '').toLowerCase());
        },
        { args: [targetName], timeoutMs: 25000, intervalMs: 500, label: `list ${targetName}` },
      ).catch(() => null);
      return;
    }

    if (!state.canScroll) break;
    await pause(1200, 1800);
  }

  throw new Error(`Saved list not found: ${targetName}`);
}

async function collectOpenedListItems(ctx) {
  const items = new Map();
  let header = null;

  const { lastState } = await collectWhileScrolling({
    maxSteps: 50,
    stagnantLimit: 3,
    pauseMinMs: 1200,
    pauseMaxMs: 1800,
    getCount: () => items.size,
    readStep: async () => await evaluate(ctx, () => {
      const main = document.querySelector('[role="main"]');
      const title = norm(document.querySelector('h1')?.innerText || '');
      const subtitle = strip(main?.querySelector('.wuvLZe, h2')?.innerText || '');
      const scroller = findBestScroller({
        root: main,
        candidateSelector: 'div',
        itemSelector: 'button.SMP2wb',
        fallback: main,
      });

      const cards = Array.from((scroller || main)?.querySelectorAll('button.SMP2wb.fHEb6e') || []);
      const places = cards.map((button) => ({
        name: norm(button.querySelector('.fontHeadlineSmall.rZF81c')?.textContent || button.getAttribute('aria-label') || button.textContent || ''),
        details: norm(button.querySelector('.yfRytc.xua1Rc')?.innerText || ''),
        rating: norm(button.querySelector('[role="img"][aria-label*="stars"]')?.getAttribute('aria-label') || ''),
        rawText: norm(button.innerText || button.textContent || ''),
      }));

      return {
        title,
        subtitle,
        places,
        canScroll: scrollForward(scroller, { minStep: 240, ratio: 0.85 }),
      };
    }),
    mergeStep: async (state) => {
      header = { name: state.title, subtitle: state.subtitle };
      for (const place of state.places || []) {
        if (!place.name) continue;
        const itemKey = normalizeText(`${place.name} | ${place.details} | ${place.rating}`);
        if (!items.has(itemKey)) items.set(itemKey, place);
      }
    },
  });

  if (lastState) {
    header = { name: lastState.title, subtitle: lastState.subtitle };
  }

  return { header, items: Array.from(items.values()) };
}

async function main() {
  const { json, newTab, command, listName } = parseArgs(process.argv.slice(2));
  const ctx = await openMapsContext({ newTab });

  try {
    if (!['list', 'show', 'items'].includes(command)) {
      usage();
      process.exit(1);
    }

    await openSavedListsRoot(ctx);

    if (command === 'list') {
      const lists = await collectSavedLists(ctx);
      if (json) {
        console.log(JSON.stringify(lists, null, 2));
        return;
      }

      lists.forEach((list, index) => {
        const bits = [list.visibility].filter(Boolean);
        if (typeof list.count === 'number') bits.push(`${list.count} place${list.count === 1 ? '' : 's'}`);
        console.log(`${index + 1}. ${list.name}`);
        if (bits.length > 0) console.log(`   ${bits.join(' · ')}`);
      });
      return;
    }

    if (!listName) {
      throw new Error('Missing list name. Use: ./saved-lists.js show "<list name>"');
    }

    await openList(ctx, listName);
    const result = await collectOpenedListItems(ctx);

    const output = {
      list: result.header?.name || listName,
      subtitle: result.header?.subtitle || null,
      items: result.items,
    };

    if (json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(output.list);
    if (output.subtitle) console.log(output.subtitle);
    output.items.forEach((item, index) => {
      console.log(`${index + 1}. ${item.name}`);
      const bits = [item.details, item.rating].filter(Boolean);
      if (bits.length > 0) console.log(`   ${bits.join(' · ')}`);
    });
  } finally {
    await closeContext(ctx);
  }
}

main().catch((error) => {
  console.error('✗', error.message);
  process.exit(1);
});
