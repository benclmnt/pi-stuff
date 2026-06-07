#!/usr/bin/env node

/**
 * Scroll through a WhatsApp chat, zoom out, screenshot each section.
 *
 * Usage:
 *   scroll.js [chat-keyword]          # screenshots of current viewport
 *   scroll.js [chat-keyword] --all    # scroll up to capture full history
 *   scroll.js [chat-keyword] --keep   # don't delete temp files after
 *
 * Outputs temp file paths, one per line.
 */

import { connect } from "../../scripts/lib/cdp.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync, unlinkSync, readdirSync } from "node:fs";

const args = process.argv.slice(2);
const allMode = args.includes("-a") || args.includes("--all");
const keepFiles = args.includes("--keep");
const chatQuery = args.find((a) => !a.startsWith("-"));

const ZOOM = 0.6;
const SCROLL_RATIO = 0.9; // scroll 90% of visible height per step

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWhatsAppPage(cdp) {
  const pages = await cdp.getPages();
  const wa = pages.find((p) => p.url.includes("web.whatsapp"));
  if (!wa) throw new Error("WhatsApp Web tab not found");
  return wa;
}

async function screenshot(sessionId, cdp) {
  const { data } = await cdp.send(
    "Page.captureScreenshot",
    { format: "png" },
    sessionId,
    10000
  );
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `wa-${timestamp}.png`;
  const filepath = join(tmpdir(), filename);
  writeFileSync(filepath, Buffer.from(data, "base64"));
  return filepath;
}

async function openChat(cdp, sessionId, query) {
  const clicked = await cdp.evaluate(
    sessionId,
    `
    (() => {
      const q = "${query.toLowerCase()}";
      const items = document.querySelectorAll('[role="listitem"]');
      for (const item of items) {
        const title = item.querySelector('span[dir="auto"]')?.textContent?.toLowerCase() || "";
        if (title.includes(q)) {
          const row = item.closest('[role="row"]') || item;
          row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return title;
        }
      }
      const allSpans = document.querySelectorAll('span[dir="auto"]');
      for (const span of allSpans) {
        if (span.textContent.toLowerCase().includes(q)) {
          const row = span.closest('[role="row"]') || span.closest('[role="listitem"]') || span.parentElement;
          row.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return span.textContent.trim();
        }
      }
      return null;
    })()
  `,
    5000
  );
  if (clicked) await sleep(1500);
  return clicked;
}

async function applyZoom(cdp, sessionId) {
  await cdp.evaluate(
    sessionId,
    `
    document.documentElement.style.zoom = '${ZOOM}';
    'zoom applied'
  `,
    3000
  );
  await sleep(500);
}

async function resetZoom(cdp, sessionId) {
  await cdp.evaluate(
    sessionId,
    `
    document.documentElement.style.zoom = '1';
    'zoom reset'
  `,
    3000
  );
}

async function scrollChat(cdp, sessionId, direction) {
  await cdp.evaluate(
    sessionId,
    `
    (() => {
      const panel = document.querySelector('[data-testid="conversation-panel-messages"]') ||
                    document.querySelector('[data-testid="conversation-panel"]') ||
                    document.querySelector("main") ||
                    document.body;
      if ("${direction}" === "up") {
        panel.scrollTop = 0;
      } else {
        panel.scrollTop = panel.scrollHeight;
      }
      return { scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight };
    })()
  `,
    3000
  );
}

function cleanupOldFiles() {
  const tmp = tmpdir();
  try {
    const entries = readdirSync(tmp);
    let count = 0;
    for (const entry of entries) {
      if (entry.startsWith("wa-") && entry.endsWith(".png")) {
        try {
          unlinkSync(join(tmp, entry));
          count++;
        } catch {}
      }
    }
    if (count > 0) {
      console.error(`→ Cleaned up ${count} old screenshot(s)`);
    }
  } catch {}
}

async function main() {
  // Clean up previous runs first
  cleanupOldFiles();

  const cdp = await connect(5000);
  const wa = await getWhatsAppPage(cdp);
  const sessionId = await cdp.attachToPage(wa.targetId);
  const files = [];

  try {
    // Open chat if specified
    if (chatQuery) {
      const name = await openChat(cdp, sessionId, chatQuery);
      if (name) console.error(`→ Opened: ${name}`);
    }

    // Zoom out
    await applyZoom(cdp, sessionId);

    // Scroll to bottom first
    await scrollChat(cdp, sessionId, "down");
    await sleep(1000);

    // Screenshot current view (bottom/most recent)
    files.push(await screenshot(sessionId, cdp));

    if (allMode) {
      // Scroll up repeatedly and screenshot
      let prevScrollTop = -1;
      for (let i = 0; i < 20; i++) {
        const scrollInfo = await cdp.evaluate(
          sessionId,
          `
          (() => {
            const panel = document.querySelector('[data-testid="conversation-panel-messages"]') ||
                          document.querySelector('[data-testid="conversation-panel"]') ||
                          document.querySelector("main") || document.body;
            panel.scrollTop = Math.max(0, panel.scrollTop - Math.floor(panel.clientHeight * ${SCROLL_RATIO}));
            return { scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight };
          })()
        `,
          3000
        );

        if (scrollInfo.scrollTop === prevScrollTop) break;
        prevScrollTop = scrollInfo.scrollTop;

        await sleep(800);
        files.push(await screenshot(sessionId, cdp));
      }
    }

    // Print paths
    for (const f of files) console.log(f);
    console.error(`→ ${files.length} screenshot(s) saved. Run again to auto-cleanup.`);
  } finally {
    // Always reset zoom
    try {
      await resetZoom(cdp, sessionId);
    } catch {}

    cdp.close();
  }
}

main().catch((e) => {
  console.error("✗", e.message);
  process.exit(1);
});
