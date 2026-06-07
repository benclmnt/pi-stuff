#!/usr/bin/env node

/**
 * Extract messages from Substack Chat via CDP.
 *
 * Usage:
 *   messages.js                    # collect top-level chat threads
 *   messages.js -j                 # output JSON
 *   messages.js -d                 # drill down into thread replies
 *   messages.js -d -m 5            # drill into at most 5 threads
 */

import { connect } from "../../scripts/lib/cdp.mjs";

const args = process.argv.slice(2);
const jsonMode = args.includes("-j") || args.includes("--json");
const drillDown = args.includes("-d") || args.includes("--drill-down");
const urlFlag = args.find((_, i) =>
  (args[i - 1] === "-u" || args[i - 1] === "--url")
);
const maxThreadsFlag = args.find((_, i) =>
  (args[i - 1] === "-m" || args[i - 1] === "--max")
);
const maxThreads = maxThreadsFlag ? parseInt(maxThreadsFlag, 10) : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─── Substack extractors ─── */

async function getSubstackPage(cdp, preferredUrl) {
  const pages = await cdp.getPages();
  // Prefer exact match first
  let ss = pages.find((p) => preferredUrl ? p.url === preferredUrl : false);
  // Then prefix match (but only for sub-pages of the exact URL)
  if (!ss) {
    ss = pages.find((p) =>
      preferredUrl ? p.url.startsWith(preferredUrl + "/") : false
    );
  }
  if (!ss) {
    ss = pages.find((p) => p.url.includes("substack.com/chat"));
  }
  if (!ss) throw new Error("Substack Chat tab not found");
  return ss;
}

async function scrollAndCollectSubstackItems(cdp, sessionId, extractFn, direction = "both") {
  const allItems = new Map();
  let stagnantCount = 0;

  const directions = direction === "both" ? [1000, -1000] : [direction];

  for (const scrollDir of directions) {
    stagnantCount = 0;
    for (let i = 0; i < 30; i++) {
      const beforeCount = allItems.size;
      const items = await extractFn(cdp, sessionId);

      for (const item of items) {
        const key = item.id || item.url || item.text;
        allItems.set(key, item);
      }

      console.error(`  scroll ${scrollDir > 0 ? "up" : "down"} ${i}: ${items.length} visible, ${allItems.size} total unique`);

      if (allItems.size === beforeCount) {
        stagnantCount++;
        if (stagnantCount >= 5) break;
      } else {
        stagnantCount = 0;
      }

      try {
        await cdp.send(
          "Input.synthesizeScrollGesture",
          { x: 1200, y: 600, yDistance: scrollDir, speed: 800 },
          sessionId,
          15000
        );
      } catch (e) {
        console.error(`  scroll error: ${e.message}`);
      }

      await sleep(1000);
    }
  }

  return Array.from(allItems.values());
}

async function extractSubstackTopLevel(cdp, sessionId) {
  return await cdp.evaluate(
    sessionId,
    `
    (() => {
      const bubbles = Array.from(document.querySelectorAll(".bubbleStack-umAMnU"));
      if (bubbles.length === 0) return [];

      const firstBubble = bubbles[0];
      let container = firstBubble;
      while (container && container.style.position !== "absolute") {
        container = container.parentElement;
      }
      if (!container) return [];

      const listContainer = container.parentElement;
      const allItems = Array.from(listContainer.children);

      const output = [];
      let currentDate = null;

      for (const item of allItems) {
        const bubble = item.querySelector(".bubbleStack-umAMnU");
        const top = parseFloat(item.style.top) || 0;

        if (!bubble) {
          const text = item.textContent.trim();
          if (/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s+\\d{1,2}:\\d{2}$/.test(text) ||
              /^(Yesterday|Today)\s+\\d{1,2}:\\d{2}$/.test(text) ||
              /^\\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\\d{4}$/.test(text)) {
            currentDate = text;
            output.push({ type: "date", text, top });
          }
          continue;
        }

        const links = Array.from(item.querySelectorAll("a"));
        const senderLink = links.find(a => a.href.includes("/@") && a.textContent.trim().length > 0);
        const sender = senderLink ? senderLink.textContent.trim() : null;

        const text = bubble.textContent.trim();

        const replyLink = links.find(a => a.href.includes("/post/") && a.textContent.includes("replies"));
        const replies = replyLink ? replyLink.textContent.trim() : null;

        const postLink = links.find(a => a.href.includes("/post/"));
        const url = postLink ? postLink.href : null;

        output.push({
          type: "message",
          sender,
          text,
          replies,
          url,
          date: currentDate,
          top
        });
      }

      output.sort((a, b) => a.top - b.top);
      return output;
    })()
  `,
    10000
  );
}

async function extractSubstackThreadReplies(cdp, sessionId) {
  return await cdp.evaluate(
    sessionId,
    `
    (() => {
      const comments = Array.from(document.querySelectorAll('[id^="comment-"]'));

      return comments.map(c => {
        // Find the row container
        let row = c;
        while (row && row.tagName !== "BODY") {
          const cls = String(row.className || "");
          if (cls.includes("gap-12") && cls.includes("alignItems")) break;
          row = row.parentElement;
        }

        const links = row ? Array.from(row.querySelectorAll("a")) : [];
        const senderLink = links.find(a => a.href.includes("/@") && a.textContent.trim().length > 0);
        let sender = senderLink ? senderLink.textContent.trim() : null;

        // Fallback: find text node outside the comment bubble
        if (!sender && row) {
          const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT, null, false);
          let node;
          while (node = walker.nextNode()) {
            const text = node.textContent.trim();
            const inComment = node.parentElement?.closest('[id^="comment-"]');
            if (text.length > 0 && text.length < 30 && !inComment) {
              sender = text;
              break;
            }
          }
        }

        return {
          id: c.id,
          sender,
          text: c.textContent.trim()
        };
      });
    })()
  `,
    10000
  );
}

async function drillDownSubstack(cdp, sessionId, messages, chatUrl) {
  const results = [];
  for (const msg of messages) {
    if (msg.type !== "message" || !msg.url) {
      results.push(msg);
      continue;
    }

    console.error(`→ Drilling into: ${msg.text} (${msg.replies || "no reply count"})`);

    // Navigate to thread URL
    await cdp.navigate(sessionId, msg.url, 15000);
    await sleep(2500);

    const replies = await scrollAndCollectSubstackItems(
      cdp,
      sessionId,
      extractSubstackThreadReplies
    );
    results.push({ ...msg, thread: replies });

    // Go back to main chat
    if (chatUrl) {
      await cdp.navigate(sessionId, chatUrl, 15000);
      await sleep(2000);
    } else {
      await cdp.evaluate(sessionId, `history.back()`, 5000);
      await sleep(2000);
    }

    // Wait for the chat to reload
    let retries = 0;
    while (retries < 10) {
      const onChat = await cdp.evaluate(
        sessionId,
        `document.querySelectorAll(".bubbleStack-umAMnU").length > 0`,
        3000
      );
      if (onChat) break;
      await sleep(500);
      retries++;
    }
  }
  return results;
}

async function scrollAndCollectTopLevel(cdp, sessionId) {
  return await scrollAndCollectSubstackItems(cdp, sessionId, extractSubstackTopLevel);
}

/* ─── Main ─── */

async function main() {
  const cdp = await connect(5000);

  try {
    const ss = await getSubstackPage(cdp, urlFlag);
    const sessionId = await cdp.attachToPage(ss.targetId);

    // Ensure tab is focused so virtual scroller renders.
    await cdp.send("Page.bringToFront", {}, sessionId, 5000);
    await sleep(500);

    console.error("→ Scrolling main chat to collect threads...");
    let messages = await scrollAndCollectTopLevel(cdp, sessionId);

    console.error(`→ Found ${messages.filter(m => m.type === "message").length} top-level thread(s)`);

    if (drillDown && messages.some(m => m.type === "message" && m.url)) {
      const threadsToDrill = maxThreads
        ? messages.filter(m => m.type === "message" && m.url).slice(0, maxThreads)
        : messages.filter(m => m.type === "message" && m.url);
      const drilled = await drillDownSubstack(cdp, sessionId, threadsToDrill, ss.url);
      // Merge drilled threads back into full message list.
      const drilledUrls = new Set(drilled.map(d => d.url));
      messages = messages.map(m => {
        if (m.type === "message" && m.url && drilledUrls.has(m.url)) {
          return drilled.find(d => d.url === m.url);
        }
        return m;
      });
    }

    if (jsonMode) {
      console.log(JSON.stringify(messages, null, 2));
    } else {
      for (const m of messages) {
        if (m.type === "date") {
          console.log(`\n─── ${m.text} ───\n`);
        } else {
          const dateStr = m.date ? `[${m.date}] ` : "";
          console.log(`${dateStr}${m.sender || "Unknown"}:`);
          console.log(`  ${m.text}`);
          if (m.replies) console.log(`  ↳ ${m.replies}`);
          if (m.url) console.log(`  ${m.url}`);
          if (m.thread) {
            console.log(`  Thread (${m.thread.length} replies):`);
            for (const t of m.thread) {
              const prefix = t.sender || "?";
              console.log(`    ${prefix}: ${t.text}`);
            }
          }
          console.log();
        }
      }
    }
  } finally {
    cdp.close();
  }
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
