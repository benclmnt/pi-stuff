#!/usr/bin/env node

/**
 * Extract messages from WhatsApp Web via CDP.
 *
 * Usage:
 *   messages.js                # list chats
 *   messages.js <keyword>      # extract messages from matching chat
 *   messages.js <keyword> -a   # scroll up to load more history
 *   messages.js <keyword> -j   # output JSON
 */

import { connect } from "../../scripts/lib/cdp.mjs";

const args = process.argv.slice(2);
const jsonMode = args.includes("-j") || args.includes("--json");
const allMode = args.includes("-a") || args.includes("--all");
const chatQuery = args.find((a) => !a.startsWith("-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWhatsAppPage(cdp) {
  const pages = await cdp.getPages();
  const wa = pages.find((p) => p.url.includes("web.whatsapp"));
  if (!wa) throw new Error("WhatsApp Web tab not found");
  return wa;
}

async function listChats(cdp, sessionId) {
  const chats = await cdp.evaluate(
    sessionId,
    `
    (() => {
      const rows = document.querySelectorAll('[role="listitem"]');
      const chats = [];
      rows.forEach((row) => {
        const spans = row.querySelectorAll('span[dir="auto"]');
        const title = spans[0]?.textContent?.trim();
        if (!title) return;
        const preview = spans[1]?.textContent?.trim()?.substring(0, 60) || "";
        const timeEl = row.querySelector("span[dir=auto]")?.closest("div")?.parentElement?.querySelector("div:last-child span");
        const time = timeEl?.textContent?.trim() || "";
        const hasUnread = !!row.querySelector('[aria-label*="unread"]') ||
                          !!row.querySelector('[data-testid="status-dblcheck"]')?.closest("div")?.querySelector("span[aria-label]");
        chats.push({ title, preview, time, unread: hasUnread });
      });
      return chats;
    })()
  `,
    5000
  );
  return chats;
}

async function openChat(cdp, sessionId, query) {
  // Go back to list if inside a chat
  await cdp.evaluate(
    sessionId,
    `
    (() => {
      const back = document.querySelector('[data-testid="back"]') ||
                   document.querySelector('[data-icon="back"]') ||
                   document.querySelector('button[aria-label="Back"]');
      if (back) {
        back.click();
        return true;
      }
      return false;
    })()
  `,
    5000
  );
  await sleep(800);

  const clicked = await cdp.evaluate(
    sessionId,
    `
    (() => {
      const q = "${query.toLowerCase()}";
      const rows = document.querySelectorAll('[role="listitem"]');
      for (const row of rows) {
        const titleSpan = row.querySelector('span[dir="auto"]');
        const title = titleSpan?.textContent?.toLowerCase() || "";
        const preview = row.textContent?.toLowerCase() || "";
        if (title.includes(q) || preview.includes(q)) {
          // Dispatch click on the row ancestor
          let target = titleSpan;
          while (target && target.getAttribute("role") !== "row") {
            target = target.parentElement;
          }
          if (!target) target = row;
          const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
          target.dispatchEvent(evt);
          return titleSpan?.textContent?.trim();
        }
      }
      return null;
    })()
  `,
    5000
  );

  if (!clicked) throw new Error(`No chat matches "${query}"`);
  await sleep(1500);
  return clicked;
}

async function scrollToTopAndCollect(cdp, sessionId) {
  const collected = new Map(); // dedupe by data-pre-plain-text

  // First, scroll to bottom
  await cdp.evaluate(
    sessionId,
    `
    (() => {
      const c = document.querySelector('[data-testid="conversation-panel-messages"]') ||
                document.querySelector("main") || document.body;
      c.scrollTop = c.scrollHeight;
    })()
  `,
    3000
  );
  await sleep(1000);

  // Collect current messages
  const msgs = await extractCurrentMessages(cdp, sessionId);
  msgs.forEach((m) => collected.set(m._key, m));

  if (allMode) {
    // Scroll up repeatedly to load older messages
    for (let i = 0; i < 15; i++) {
      const beforeCount = collected.size;
      await cdp.evaluate(
        sessionId,
        `
        (() => {
          const c = document.querySelector('[data-testid="conversation-panel-messages"]') ||
                    document.querySelector("main") || document.body;
          c.scrollTop = 0;
        })()
      `,
        3000
      );
      await sleep(1200);

      const newMsgs = await extractCurrentMessages(cdp, sessionId);
      newMsgs.forEach((m) => collected.set(m._key, m));

      if (collected.size === beforeCount) break; // nothing new loaded
    }
  }

  // Convert map to array and sort by timestamp
  const arr = Array.from(collected.values());
  arr.sort((a, b) => a._ts - b._ts);
  return arr.map(({ _key, _ts, ...rest }) => rest);
}

async function extractCurrentMessages(cdp, sessionId) {
  return await cdp.evaluate(
    sessionId,
    `
    (() => {
      const els = document.querySelectorAll('[data-pre-plain-text]');
      return Array.from(els).map((el) => {
        const pre = el.getAttribute('data-pre-plain-text') || '';
        const match = pre.match(/^\\[(.+?),\\s*(\\d{1,2}\\/\\d{1,2}\\/\\d{4})\\]\\s*(.+?):\\s*$/);
        if (!match) return null;

        const time = match[1].trim();
        const date = match[2].trim();
        const sender = match[3].trim();

        // Try to get clean text without quoted replies
        let text = '';
        const selectable = el.querySelector('span.selectable-text');
        if (selectable) {
          text = selectable.textContent?.trim() || '';
        } else {
          // Fallback: full textContent minus trailing timestamp
          text = el.textContent?.trim() || '';
          text = text.replace(/\\d{1,2}:\\d{2}\\s*(AM|PM)$/i, '').trim();
        }

        // Build a sortable timestamp
        const [m, d, y] = date.split('/').map(Number);
        const [t, ap] = time.split(' ');
        let [h, min] = t.split(':').map(Number);
        if (ap === 'PM' && h !== 12) h += 12;
        if (ap === 'AM' && h === 12) h = 0;
        const ts = new Date(y, m - 1, d, h, min).getTime();

        return { _key: pre + text, _ts: ts, time, date, sender, text };
      }).filter((m) => m);
    })()
  `,
    10000
  );
}

async function main() {
  const cdp = await connect(5000);
  const wa = await getWhatsAppPage(cdp);
  const sessionId = await cdp.attachToPage(wa.targetId);

  try {
    if (!chatQuery) {
      // List mode
      const chats = await listChats(cdp, sessionId);
      if (jsonMode) {
        console.log(JSON.stringify(chats, null, 2));
      } else {
        chats.forEach((c, i) => {
          const unread = c.unread ? " [UNREAD]" : "";
          console.log(`${i + 1}. ${c.title}${unread}`);
          if (c.preview) console.log(`   ${c.preview}`);
        });
      }
    } else {
      // Extract mode
      const chatName = await openChat(cdp, sessionId, chatQuery);
      console.error(`→ Opened: ${chatName}`);
      const messages = await scrollToTopAndCollect(cdp, sessionId);

      if (jsonMode) {
        console.log(JSON.stringify(messages, null, 2));
      } else {
        messages.forEach((m) => {
          console.log(`[${m.time}, ${m.date}] ${m.sender}:`);
          console.log(`  ${m.text}`);
          console.log();
        });
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
