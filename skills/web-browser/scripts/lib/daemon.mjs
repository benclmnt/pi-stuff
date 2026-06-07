/**
 * daemon — per-tab persistent CDP session daemon.
 *
 * Each tab gets a Unix socket daemon that holds its CDP session open.
 * Chrome's "Allow debugging" modal fires once per daemon (= once per tab),
 * then all subsequent commands go through the socket — no more modals.
 * Daemons auto-exit after 20 minutes of inactivity.
 *
 * Protocol: NDJSON over Unix socket.
 *   Request:  {"id":<number>, "cmd":"<string>", "args":[<any>,...]}
 *   Response: {"id":<number>, "ok":true,  "result":"<string>"}
 *          or {"id":<number>, "ok":false, "error":"<message>"}
 */

import { unlinkSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import net from 'net';
import { CDP, discoverWsUrl, getAutomationProfileKey, normalizeProfileName } from './cdp.mjs';

// ─── Constants ─────────────────────────────────────────────────────────────

const NAVIGATION_TIMEOUT = 30000;
const DEFAULT_CDP_TIMEOUT = 15000;
const IDLE_TIMEOUT = 20 * 60 * 1000;
const DAEMON_CONNECT_RETRIES = 20;
const DAEMON_CONNECT_DELAY = 300;
const IS_WINDOWS = process.platform === 'win32';

export const RUNTIME_DIR = IS_WINDOWS
  ? resolve(process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local'), 'cdp')
  : process.env.XDG_RUNTIME_DIR
    ? resolve(process.env.XDG_RUNTIME_DIR, 'cdp')
    : resolve(homedir(), '.cache', 'cdp');

// Ensure runtime dir exists
try { mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 }); } catch {}

function daemonsFile(profile = process.env.CDP_PROFILE) {
  return resolve(RUNTIME_DIR, `daemons-${getAutomationProfileKey(profile)}.json`);
}

function sockPath(targetId, profile = process.env.CDP_PROFILE) {
  const profileKey = getAutomationProfileKey(profile);
  return IS_WINDOWS
    ? `\\\\.\\pipe\\cdp-${profileKey}-${targetId}`
    : resolve(RUNTIME_DIR, `cdp-${profileKey}-${targetId}.sock`);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Get-or-create a daemon connection for the given targetId.
 * Returns a connected net.Socket ready for sendCommand().
 */
export async function getOrStartDaemon(targetId, options = {}) {
  const profile = normalizeProfileName(options.profile ?? process.env.CDP_PROFILE);
  const sp = sockPath(targetId, profile);

  // Try existing daemon
  try { return await connectToSocket(sp); } catch {}

  // Clean stale socket
  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}

  // Spawn daemon child process
  const child = spawn(process.execPath, [
    // Resolve path to self — works whether invoked via cdp.mjs or directly
    process.argv[1], '_daemon', targetId,
  ], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CDP_PROFILE: profile },
  });
  child.unref();

  // Wait for socket to appear (includes time for "Allow" modal)
  for (let i = 0; i < DAEMON_CONNECT_RETRIES; i++) {
    await sleep(DAEMON_CONNECT_DELAY);
    try { return await connectToSocket(sp); } catch {}
  }
  throw new Error('Daemon failed to start — did you click Allow in Chrome?');
}

/**
 * Send an NDJSON command to a daemon socket and await the response.
 * The socket is closed after receiving the response.
 */
export function sendCommand(conn, req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let settled = false;
    const cleanup = () => { conn.off('data', onData); conn.off('error', onError); conn.off('end', onEnd); conn.off('close', onClose); };
    const onData = (chunk) => {
      buf += chunk.toString();
      const idx = buf.indexOf('\n');
      if (idx === -1) return;
      settled = true; cleanup();
      resolve(JSON.parse(buf.slice(0, idx)));
      conn.end();
    };
    const onError = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };
    const onEnd = () => { if (settled) return; settled = true; cleanup(); reject(new Error('Connection closed before response')); };
    const onClose = () => { if (settled) return; settled = true; cleanup(); reject(new Error('Connection closed before response')); };
    conn.on('data', onData); conn.on('error', onError); conn.on('end', onEnd); conn.on('close', onClose);
    req.id = 1;
    conn.write(JSON.stringify(req) + '\n');
  });
}

/**
 * Stop daemon(s). If targetPrefix is given, stop only that one.
 * Otherwise stops all known daemons.
 */
export async function stopDaemons(targetPrefix, options = {}) {
  const profile = normalizeProfileName(options.profile ?? process.env.CDP_PROFILE);
  const targets = readDaemonTargets(profile);
  if (targets.length === 0) return 0;

  const selectedTargets = targetPrefix
    ? [resolvePrefix(targetPrefix, targets, 'target')]
    : targets;

  let stopped = 0;

  for (const targetId of selectedTargets) {
    const sp = sockPath(targetId, profile);
    try {
      const conn = await connectToSocket(sp);
      await sendCommand(conn, { cmd: 'stop' });
      stopped += 1;
    } catch {
      if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
      unregisterDaemon(profile, targetId);
    }
  }

  return stopped;
}

// ─── Daemon process ────────────────────────────────────────────────────────

/**
 * Entry point for the daemon child process.
 * Called as: cdp.mjs _daemon <targetId>
 */
export async function runDaemon(targetId, options = {}) {
  const profile = normalizeProfileName(options.profile ?? process.env.CDP_PROFILE);
  const sp = sockPath(targetId, profile);

  // Connect to Chrome
  const cdp = new CDP();
  try {
    const wsUrl = await discoverWsUrl({ profile });
    await cdp.connect(wsUrl);
  } catch (e) {
    process.stderr.write(`Daemon: cannot connect to Chrome: ${e.message}\n`);
    process.exit(1);
  }

  // Attach to target
  let sessionId;
  try {
    const res = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    sessionId = res.sessionId;
  } catch (e) {
    process.stderr.write(`Daemon: attach failed: ${e.message}\n`);
    cdp.close();
    process.exit(1);
  }

  // Shutdown when target disappears or Chrome disconnects
  let alive = true;
  function shutdown() {
    if (!alive) return;
    alive = false;
    server.close();
    unregisterDaemon(profile, targetId);
    if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
    cdp.close();
    process.exit(0);
  }

  cdp.on('Target.targetDestroyed', (params) => {
    if (params.targetId === targetId) shutdown();
  });
  cdp.on('Target.detachedFromTarget', (params) => {
    if (params.sessionId === sessionId) shutdown();
  });
  cdp.onClose(() => shutdown());
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Idle timer — auto-exit after 20 min
  let idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  function resetIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(shutdown, IDLE_TIMEOUT);
  }

  const page = createSessionHelpers(cdp, sessionId);

  // ── Command handlers ──────────────────────────────────────────────────
  // Each returns a string to print, or throws on error.

  const handlers = {
    async eval(args) {
      const expr = args[0];
      if (!expr) throw new Error('Expression required');
      return page.evaluateText(expr);
    },

    async click(args) {
      const selector = args[0];
      if (!selector) throw new Error('CSS selector required');
      const result = await page.evaluateValue(`
        (() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
          el.scrollIntoView({ block: 'center' });
          el.click();
          return { ok: true, tag: el.tagName, text: (el.textContent || '').trim().substring(0, 80) };
        })()
      `);
      if (!result?.ok) throw new Error(result?.error || 'Click failed');
      return `Clicked <${result.tag}> "${result.text}"`;
    },

    async clickxy(args) {
      const cx = parseFloat(args[0]);
      const cy = parseFloat(args[1]);
      if (isNaN(cx) || isNaN(cy)) throw new Error('x and y must be numbers (CSS pixels)');
      const base = { x: cx, y: cy, button: 'left', clickCount: 1, modifiers: 0 };
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' }, sessionId);
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, sessionId);
      await sleep(50);
      await cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' }, sessionId);
      return `Clicked at CSS (${cx}, ${cy})`;
    },

    async shot(args) {
      const filePath = args[0];
      // Get DPR
      let dpr = 1;
      try {
        const { deviceScaleFactor } = await cdp.send('Emulation.getDeviceMetricsOverride', {}, sessionId).catch(() => ({}));
        if (deviceScaleFactor) dpr = deviceScaleFactor;
      } catch {}
      if (dpr === 1) {
        try {
          const parsed = Number(await page.evaluateValue('window.devicePixelRatio'));
          if (parsed > 0) dpr = parsed;
        } catch {}
      }

      const out = filePath || resolve(RUNTIME_DIR, `screenshot-${targetId.slice(0, 8)}.png`);
      writeFileSync(out, await page.screenshot());

      const lines = [out, `Device pixel ratio (DPR): ${dpr}`];
      if (dpr !== 1) {
        lines.push(`Coordinate mapping: CSS px = screenshot px / ${dpr}`);
        lines.push(`  e.g. screenshot (${Math.round(100 * dpr)}, ${Math.round(200 * dpr)}) → CSS (100, 200)`);
      }
      return lines.join('\n');
    },

    async type(args) {
      const text = args.join(' ');
      if (!text) throw new Error('Text required');
      await cdp.send('Input.insertText', { text }, sessionId);
      return `Typed ${text.length} characters`;
    },

    async keypress(args) {
      const combo = args[0];
      if (!combo) throw new Error('Key combo required (e.g. x, Ctrl+Enter, Shift+Tab)');
      const { key, code, modifiers } = resolveKeyCombo(combo);
      const downParams = { type: 'keyDown', key, modifiers };
      const upParams = { type: 'keyUp', key, modifiers };
      if (code) { downParams.code = code; upParams.code = code; }
      await cdp.send('Input.dispatchKeyEvent', downParams, sessionId);
      await sleep(50);
      await cdp.send('Input.dispatchKeyEvent', upParams, sessionId);
      const modNames = [];
      if (modifiers & 2) modNames.push('Ctrl');
      if (modifiers & 1) modNames.push('Alt');
      if (modifiers & 8) modNames.push('Shift');
      if (modifiers & 4) modNames.push('Meta');
      const prefix = modNames.length ? `${modNames.join('+')}+` : '';
      return `Pressed ${prefix}${key}`;
    },

    async html(args) {
      const selector = args[0];
      const expr = selector
        ? `document.querySelector(${JSON.stringify(selector)})?.outerHTML || 'Element not found'`
        : `document.documentElement.outerHTML`;
      return page.evaluateText(expr);
    },

    async net() {
      const entries = await page.evaluateValue(`performance.getEntriesByType('resource').map(e => ({
        name: e.name.substring(0, 120), type: e.initiatorType,
        duration: Math.round(e.duration), size: e.transferSize
      }))`);
      return entries.map(e =>
        `${String(e.duration).padStart(5)}ms  ${String(e.size || '?').padStart(8)}B  ${e.type.padEnd(8)}  ${e.name}`
      ).join('\n');
    },

    async nav(args) {
      const url = args[0];
      if (!url) throw new Error('URL required');
      try {
        const parsed = new URL(url);
        if (!['http:', 'https:'].includes(parsed.protocol))
          throw new Error(`Only http/https URLs allowed`);
      } catch (e) {
        if (e.message.startsWith('Only')) throw e;
        throw new Error(`Invalid URL: ${url}`);
      }
      await page.navigate(url, NAVIGATION_TIMEOUT);
      return `Navigated to ${url}`;
    },

    async loadall(args) {
      const selector = args[0];
      const intervalMs = args[1] ? parseInt(args[1]) : 1500;
      if (!selector) throw new Error('CSS selector required');
      let clicks = 0;
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        const exists = await page.evaluateValue(`!!document.querySelector(${JSON.stringify(selector)})`);
        if (!exists) break;
        const clicked = await page.evaluateValue(`
          (() => { const el = document.querySelector(${JSON.stringify(selector)});
            if (!el) return false;
            el.scrollIntoView({ block: 'center' }); el.click(); return true; })()
        `);
        if (!clicked) break;
        clicks++;
        await sleep(intervalMs);
      }
      return `Clicked "${selector}" ${clicks} time(s) until it disappeared`;
    },

    async wait(args) {
      const params = args[0]; // { selector?, expr?, timeout }
      if (!params) throw new Error('Wait params required');
      const sel = params.selector;
      const expr = params.expr;
      const timeout = params.timeout || 15000;

      const pollJS = sel
        ? `(async () => {
            const sel = ${JSON.stringify(sel)};
            const deadline = Date.now() + ${timeout};
            while (Date.now() < deadline) {
              const el = document.querySelector(sel);
              if (el) return { found: true, text: (el.textContent||'').trim().slice(0,500), tag: el.tagName };
              await new Promise(r => setTimeout(r, 200));
            }
            return { found: false };
          })()`
        : `(async () => {
            const deadline = Date.now() + ${timeout};
            while (Date.now() < deadline) {
              const val = await (() => (${expr}))();
              if (val) return { found: true, value: typeof val === 'string' ? val.slice(0,500) : JSON.stringify(val).slice(0,500) };
              await new Promise(r => setTimeout(r, 200));
            }
            return { found: false };
          })()`;

      const r = await page.evaluateValue(`(${pollJS})`, timeout + 5000);
      if (r?.found) {
        const label = sel ? `Selector "${sel}" found` : 'Expression truthy';
        const extras = [];
        if (r.text) extras.push(`Text: ${r.text}`);
        if (r.tag) extras.push(`Tag: ${r.tag}`);
        if (r.value) extras.push(`Value: ${r.value}`);
        return [label, ...extras].join('\n');
      }
      throw new Error(`Timed out after ${timeout}ms — ${sel ? `selector "${sel}" not found` : 'expression not truthy'}`);
    },

    async cookies(args) {
      const params = args[0] || {};
      const reject = !!params.reject;
      const mode = reject ? 'reject' : 'accept';

      let clicked = await page.evaluateValue(`(${COOKIE_DISMISS_SCRIPT})(${!reject})`, 15000) || [];

      // If nothing found, try iframes
      if (!clicked.length) {
        try {
          const frameTree = await page.getFrameTree();
          const iframeResult = await tryIframes(page, frameTree, reject);
          if (iframeResult.length) clicked = iframeResult;
        } catch {}
      }

      if (clicked.length) {
        return `✓ Dismissed cookie dialog (${mode}): ${clicked.join(', ')}`;
      }
      return `○ No cookie dialog found to ${mode}`;
    },

    async pick(args) {
      // Interactive element picker
      const message = args[0] || 'Pick an element';
      const PICK_SCRIPT = buildPickScript(message);
      const val = await page.evaluateValue(`(${PICK_SCRIPT})`, 300000);
      if (!val) return 'No element selected';
      return formatResultValue(val);
    },

    async batch(args) {
      const expressions = args; // array of expressions
      if (!expressions || !expressions.length) throw new Error('Expressions required');
      const results = [];
      for (let i = 0; i < expressions.length; i++) {
        try {
          const val = await page.evaluateValue(`(async () => (${expressions[i]}))()`);
          results.push({ index: i, status: 'ok', result: val });
        } catch (e) {
          results.push({ index: i, status: 'error', error: e.message });
        }
      }
      return JSON.stringify(results, null, 2);
    },

    async snap() {
      const { nodes } = await cdp.send('Accessibility.getFullAXTree', {}, sessionId);
      return formatAxTree(nodes);
    },

    async evalraw(args) {
      const method = args[0];
      const params = args[1] || {};
      if (!method) throw new Error('CDP method required');
      const result = await cdp.send(method, params, sessionId);
      return JSON.stringify(result, null, 2);
    },

    async list() {
      const pages = await cdp.getPages();
      return JSON.stringify(pages);
    },

    async stop() {
      return { stopAfter: true };
    },
  };

  // ── Unix socket server ─────────────────────────────────────────────────
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); } catch {
          conn.write(JSON.stringify({ ok: false, error: 'Invalid JSON request', id: null }) + '\n');
          continue;
        }
        handleDaemonCommand(handlers, req, conn, shutdown, resetIdle);
      }
    });
  });

  server.on('error', (e) => {
    process.stderr.write(`Daemon server listen failed: ${e.message}\n`);
    process.exit(1);
  });

  if (!IS_WINDOWS) try { unlinkSync(sp); } catch {}
  server.listen(sp, () => registerDaemon(profile, targetId));
}

async function handleDaemonCommand(handlers, req, conn, shutdown, resetIdle) {
  resetIdle();
  try {
    const handler = handlers[req.cmd];
    if (!handler) throw new Error(`Unknown command: ${req.cmd}`);
    const result = await handler(req.args || []);
    if (result?.stopAfter) {
      conn.end(JSON.stringify({ ok: true, result: '', id: req.id }) + '\n', shutdown);
    } else {
      conn.write(JSON.stringify({ ok: true, result: result ?? '', id: req.id }) + '\n');
    }
  } catch (e) {
    conn.write(JSON.stringify({ ok: false, error: e.message, id: req.id }) + '\n');
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function createSessionHelpers(cdp, sessionId) {
  const enabledDomains = new Set();

  async function enable(domains, timeout = DEFAULT_CDP_TIMEOUT) {
    const list = Array.isArray(domains) ? domains : [domains];
    const missing = list.filter(domain => domain && !enabledDomains.has(domain));
    if (missing.length === 0) return;
    await cdp.enableDomains(sessionId, missing, timeout);
    missing.forEach(domain => enabledDomains.add(domain));
  }

  const helpers = {
    async enable(domains, timeout = DEFAULT_CDP_TIMEOUT) {
      await enable(domains, timeout);
    },
    async evaluateValue(expression, timeout = 30000) {
      await enable('Runtime', timeout);
      return cdp.evaluate(sessionId, expression, timeout);
    },
    async evaluateText(expression, timeout = 30000) {
      return formatResultValue(await helpers.evaluateValue(expression, timeout));
    },
    async screenshot(timeout = 10000) {
      await enable('Page', timeout);
      return cdp.screenshot(sessionId, timeout);
    },
    async navigate(url, timeout = NAVIGATION_TIMEOUT) {
      await enable('Page', timeout);
      const loadEvent = cdp.waitForEvent('Page.loadEventFired', timeout);
      const result = await cdp.navigate(sessionId, url, timeout);
      if (result?.errorText) {
        loadEvent.cancel();
        throw new Error(result.errorText);
      }
      if (result?.loaderId) await loadEvent.promise;
      else loadEvent.cancel();
      await waitForDocumentReady(helpers, 5000);
      return result;
    },
    async getFrameTree() {
      await enable('Page');
      return cdp.getFrameTree(sessionId);
    },
    async evaluateInFrame(frameId, expression, timeout = 30000) {
      await enable('Page', timeout);
      return cdp.evaluateInFrame(sessionId, frameId, expression, timeout);
    },
  };

  return helpers;
}

function formatResultValue(value) {
  if (value == null) return '';
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function readDaemonTargets(profile) {
  const file = daemonsFile(profile);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function writeDaemonTargets(profile, targetIds) {
  const file = daemonsFile(profile);
  const unique = [...new Set(targetIds.filter(Boolean))].sort();
  if (unique.length === 0) {
    try { unlinkSync(file); } catch {}
    return;
  }
  writeFileSync(file, JSON.stringify(unique, null, 2));
}

function registerDaemon(profile, targetId) {
  const targets = readDaemonTargets(profile);
  if (!targets.includes(targetId)) writeDaemonTargets(profile, [...targets, targetId]);
}

function unregisterDaemon(profile, targetId) {
  writeDaemonTargets(profile, readDaemonTargets(profile).filter(id => id !== targetId));
}

function resolvePrefix(prefix, values, label = 'value') {
  const matches = values.filter(v => v.toUpperCase().startsWith(prefix.toUpperCase()));
  if (matches.length === 0) throw new Error(`No ${label} matching prefix \"${prefix}\"`);
  if (matches.length > 1) throw new Error(`Ambiguous ${label} prefix \"${prefix}\" — matches ${matches.length} entries`);
  return matches[0];
}

function connectToSocket(sp) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(sp);
    conn.on('connect', () => resolve(conn));
    conn.on('error', reject);
  });
}

async function waitForDocumentReady(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await page.evaluateValue('document.readyState') === 'complete') return;
    } catch {}
    await sleep(200);
  }
}

function resolveKeyCombo(combo) {
  const parts = combo.split('+');
  let key = parts[parts.length - 1];
  const modifiers = [];
  if (key === '') {
    key = '+';
    for (let i = 0; i < parts.length - 1; i++) if (parts[i]) modifiers.push(parts[i].trim());
  } else {
    for (let i = 0; i < parts.length - 1; i++) if (parts[i]) modifiers.push(parts[i].trim());
  }

  let modMask = 0;
  for (const mod of modifiers) {
    const lower = mod.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') modMask |= 2;
    else if (lower === 'alt') modMask |= 1;
    else if (lower === 'shift') modMask |= 8;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'command') modMask |= 4;
    else throw new Error(`Unknown modifier: ${mod}`);
  }

  const specialCodeMap = {
    'Enter': 'Enter', 'Tab': 'Tab', 'Escape': 'Escape', 'Backspace': 'Backspace',
    'Delete': 'Delete', 'Space': 'Space',
    'ArrowUp': 'ArrowUp', 'ArrowDown': 'ArrowDown', 'ArrowLeft': 'ArrowLeft', 'ArrowRight': 'ArrowRight',
    'Home': 'Home', 'End': 'End', 'PageUp': 'PageUp', 'PageDown': 'PageDown',
  };
  for (let i = 1; i <= 12; i++) specialCodeMap[`F${i}`] = `F${i}`;

  let code;
  if (key.length === 1) {
    const ch = key;
    if (ch >= 'a' && ch <= 'z') code = `Key${ch.toUpperCase()}`;
    else if (ch >= 'A' && ch <= 'Z') code = `Key${ch}`;
    else if (ch >= '0' && ch <= '9') code = `Digit${ch}`;
    else if (ch === '+' || ch === '=') code = 'Equal';
    else if (ch === '-') code = 'Minus';
    else if (ch === '[') code = 'BracketLeft';
    else if (ch === ']') code = 'BracketRight';
    else if (ch === '\\') code = 'Backslash';
    else if (ch === ';') code = 'Semicolon';
    else if (ch === "'") code = 'Quote';
    else if (ch === ',') code = 'Comma';
    else if (ch === '.') code = 'Period';
    else if (ch === '/') code = 'Slash';
    else if (ch === '`') code = 'Backquote';
  } else if (specialCodeMap[key]) {
    code = specialCodeMap[key];
  }

  return { key, code, modifiers: modMask };
}

function formatAxTree(nodes) {
  const nodesById = new Map(nodes.map(n => [n.nodeId, n]));
  const childrenByParent = new Map();
  for (const node of nodes) {
    if (!node.parentId) continue;
    if (!childrenByParent.has(node.parentId)) childrenByParent.set(node.parentId, []);
    childrenByParent.get(node.parentId).push(node);
  }

  function shouldShow(node) {
    const role = node.role?.value || '';
    const name = node.name?.value ?? '';
    const value = node.value?.value;
    if (role === 'InlineTextBox') return false;
    return role !== 'none' && role !== 'generic' && !(name === '' && (value === '' || value == null));
  }

  function formatNode(node, depth) {
    const role = node.role?.value || '';
    const name = node.name?.value ?? '';
    const value = node.value?.value;
    const indent = '  '.repeat(Math.min(depth, 10));
    let line = `${indent}[${role}]`;
    if (name) line += ` ${name}`;
    if (!(value === '' || value == null)) line += ` = ${JSON.stringify(value)}`;
    return line;
  }

  function orderedChildren(node) {
    const children = [];
    const seen = new Set();
    for (const childId of node.childIds || []) {
      const child = nodesById.get(childId);
      if (child && !seen.has(child.nodeId)) { seen.add(child.nodeId); children.push(child); }
    }
    for (const child of childrenByParent.get(node.nodeId) || []) {
      if (!seen.has(child.nodeId)) { seen.add(child.nodeId); children.push(child); }
    }
    return children;
  }

  const lines = [];
  const visited = new Set();
  function visit(node, depth) {
    if (!node || visited.has(node.nodeId)) return;
    visited.add(node.nodeId);
    if (shouldShow(node)) lines.push(formatNode(node, depth));
    for (const child of orderedChildren(node)) visit(child, depth + 1);
  }

  const roots = nodes.filter(n => !n.parentId || !nodesById.has(n.parentId));
  for (const root of roots) visit(root, 0);
  for (const node of nodes) visit(node, 0);

  return lines.join('\n');
}

const COOKIE_DISMISS_SCRIPT = String.raw`
  (acceptCookies = true) => {
    const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const rejectWords = [
      'reject', 'reject all', 'decline', 'decline all', 'deny', 'deny all', 'disagree', 'refuse',
      'only necessary', 'necessary only', 'essential only', 'continue without accepting',
      'ablehnen', 'alles ablehnen', 'refuser', 'tout refuser', 'rifiuta', 'rechazar'
    ];
    const acceptWords = [
      'accept', 'accept all', 'agree', 'allow', 'allow all', 'ok', 'okay', 'got it', 'continue',
      'i agree', 'akzeptieren', 'accepter', 'accetta', 'aceptar'
    ];
    const preferredSelectors = acceptCookies
      ? [
          '#onetrust-accept-btn-handler',
          '#CybotCookiebotDialogBodyButtonAccept',
          '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
          '#didomi-notice-agree-button',
          '[data-testid="uc-accept-all-button"]',
          'button[aria-label*="Accept" i]',
          'button[title*="Accept" i]'
        ]
      : [
          '#onetrust-reject-all-handler',
          '#CybotCookiebotDialogBodyButtonDecline',
          '#CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
          '#didomi-notice-disagree-button',
          '[data-testid="uc-deny-all-button"]',
          'button[aria-label*="Reject" i]',
          'button[title*="Reject" i]'
        ];

    const roots = [];
    const addRoot = (root) => {
      if (!root || roots.includes(root)) return;
      roots.push(root);
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.shadowRoot) addRoot(node.shadowRoot);
      }
    };
    addRoot(document);

    const isVisible = (el) => {
      try {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled && rect.width > 0 && rect.height > 0;
      } catch {
        return false;
      }
    };

    const labelOf = (el) => norm(el.getAttribute('aria-label') || el.value || el.innerText || el.textContent || '');
    const matchesWord = (text, words) => words.some(word => text === word || text.startsWith(word + ' ') || text.includes(' ' + word) || text.includes(word));
    const isReject = (text) => matchesWord(text, rejectWords);
    const isAccept = (text) => matchesWord(text, acceptWords) && !isReject(text);
    const scored = [];
    const seen = new Set();

    const push = (el, bonus = 0) => {
      if (!el || seen.has(el) || !isVisible(el)) return;
      seen.add(el);
      const label = labelOf(el);
      const score = (acceptCookies ? (isAccept(label) ? 1000 : 0) : (isReject(label) ? 1000 : 0)) + bonus;
      if (score > 0) scored.push({ el, label: label || 'button', score });
    };

    for (const root of roots) {
      for (const selector of preferredSelectors) {
        root.querySelectorAll(selector).forEach(el => push(el, 500));
      }
      root.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a[role="button"]').forEach(el => push(el));
    }

    scored.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
    const clicked = [];
    for (const { el, label } of scored) {
      try {
        el.click();
        clicked.push(label.slice(0, 80));
      } catch {}
      if (clicked.length >= 3) break;
    }

    return [...new Set(clicked)];
  }
`;

async function tryIframes(page, frameTree, reject) {
  const collected = [];
  function collectFrames(node) {
    collected.push({ id: node.frame.id, url: node.frame.url });
    if (node.childFrames) node.childFrames.forEach(collectFrames);
  }
  collectFrames(frameTree);

  for (const frame of collected) {
    if (frame.url === 'about:blank' || frame.url.startsWith('javascript:')) continue;
    if (/sp_message|consent|privacy|cmp|sourcepoint|cookie|privacy-mgmt/i.test(frame.url)) {
      try {
        const result = await page.evaluateInFrame(frame.id, `(${COOKIE_DISMISS_SCRIPT})(${!reject})`, 10000);
        if (result?.length) return result;
      } catch {}
    }
  }
  return [];
}

function buildPickScript(message) {
  return `(function() {
    return new Promise((resolve) => {
      const selections = [];
      const selectedElements = new Set();
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647;pointer-events:none';
      const highlight = document.createElement('div');
      highlight.style.cssText = 'position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);transition:all 0.1s';
      overlay.appendChild(highlight);
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#1f2937;color:white;padding:12px 24px;border-radius:8px;font:14px sans-serif;box-shadow:0 4px 12px rgba(0,0,0,0.3);pointer-events:auto;z-index:2147483647';
      banner.textContent = ${JSON.stringify(message)} + ' (Cmd/Ctrl+click to add, Enter to finish, ESC to cancel)';
      document.body.append(banner, overlay);
      const cleanup = () => { document.removeEventListener('mousemove', onMove, true); document.removeEventListener('click', onClick, true); document.removeEventListener('keydown', onKey, true); overlay.remove(); banner.remove(); selectedElements.forEach(el => el.style.outline = ''); };
      const onMove = (e) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || overlay.contains(el) || banner.contains(el)) return;
        const r = el.getBoundingClientRect();
        highlight.style.cssText = 'position:absolute;border:2px solid #3b82f6;background:rgba(59,130,246,0.1);top:' + r.top + 'px;left:' + r.left + 'px;width:' + r.width + 'px;height:' + r.height + 'px';
      };
      const buildInfo = (el) => {
        const parents = []; let cur = el.parentElement;
        while (cur && cur !== document.body) { parents.push(cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : '') + (cur.className ? '.' + cur.className.trim().split(/\\s+/).join('.') : '')); cur = cur.parentElement; }
        return { tag: el.tagName.toLowerCase(), id: el.id || null, class: el.className || null, text: (el.textContent || '').trim().slice(0,200) || null, html: el.outerHTML.slice(0,500), parents: parents.join(' > ') };
      };
      const onClick = (e) => {
        if (banner.contains(e.target)) return; e.preventDefault(); e.stopPropagation();
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || overlay.contains(el) || banner.contains(el)) return;
        if (e.metaKey || e.ctrlKey) {
          if (!selectedElements.has(el)) { selectedElements.add(el); el.style.outline = '3px solid #10b981'; selections.push(buildInfo(el)); banner.textContent = ${JSON.stringify(message)} + ' (' + selections.length + ' selected, Cmd/Ctrl+click to add, Enter to finish, ESC to cancel)'; }
        } else { cleanup(); resolve(selections.length > 0 ? selections : buildInfo(el)); }
      };
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(null); }
        else if (e.key === 'Enter' && selections.length > 0) { e.preventDefault(); cleanup(); resolve(selections); }
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
    });
  })()`;
}
