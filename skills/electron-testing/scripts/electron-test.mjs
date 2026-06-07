#!/usr/bin/env node
/**
 * electron-test.mjs — Launch, inspect, and test Electron apps via CDP
 *
 * Opens a fresh WebSocket per command (no daemon). Stateless — each command
 * reads the CDP port from ELECTRON_TEST_PORT.
 *
 * Requires Node.js 22+ (built-in WebSocket and fetch).
 */

import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { homedir, platform } from 'os';
import { resolve } from 'path';
import { spawn } from 'child_process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const IS_WINDOWS = platform() === 'win32';
if (!IS_WINDOWS) process.umask(0o077);

const USERDATA_DIR = resolve(
  IS_WINDOWS
    ? process.env.LOCALAPPDATA || resolve(homedir(), 'AppData', 'Local')
    : process.env.XDG_RUNTIME_DIR
      ? resolve(process.env.XDG_RUNTIME_DIR, 'electron-test')
      : resolve(homedir(), '.cache', 'electron-test'),
  'userdata',
);

const CDP_TIMEOUT = 15000;
const MIN_TARGET_PREFIX = 8;

// ---------------------------------------------------------------------------
// Port: required from ELECTRON_TEST_PORT env var
// ---------------------------------------------------------------------------
function resolvePort() {
  const val = process.env.ELECTRON_TEST_PORT;
  if (!val) {
    throw new Error(
      'ELECTRON_TEST_PORT must be set.\n' +
      '  Run:  export ELECTRON_TEST_PORT=9223\n' +
      '  Then rerun your electron-test.mjs command.'
    );
  }
  const n = parseInt(val, 10);
  if (isNaN(n) || n <= 0 || n > 65535) throw new Error(`Invalid ELECTRON_TEST_PORT: ${val}`);
  return n;
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------
function openWs(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(`WebSocket timeout: ${url}`)); }, 5000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(ws); });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WebSocket connection failed')); });
  });
}

let _cdpId = 0;

function cdpSend(ws, method, params = {}, sessionId) {
  const id = ++_cdpId;
  return new Promise((resolve, reject) => {
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    let settled = false;
    let timer;

    function cleanup() {
      settled = true;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('close', onClose);
    }

    function settle(err, val) {
      if (settled) return;
      cleanup();
      if (err) reject(err);
      else resolve(val);
    }

    function onMessage(event) {
      let m;
      try { m = JSON.parse(event.data); } catch { return; }
      if (m.id === id) {
        if (m.error) settle(new Error(m.error.message));
        else settle(null, m.result);
      }
    }

    function onClose() {
      settle(new Error('WebSocket closed'));
    }

    ws.addEventListener('message', onMessage);
    ws.addEventListener('close', onClose);
    ws.send(JSON.stringify(msg));
    timer = setTimeout(() => settle(new Error(`Timeout: ${method}`)), CDP_TIMEOUT);
  });
}

function checkResult(result) {
  if (result.exceptionDetails) {
    const desc = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Unknown error';
    throw new Error(desc);
  }
  return result.result;
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------
async function fetchPages(port) {
  let resp;
  try {
    resp = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) });
  } catch (e) {
    throw new Error(
      `Cannot connect to Electron on port ${port}. Ensure the app is running with --remote-debugging-port=${port}.\n` +
      `  Tip: set ELECTRON_TEST_PORT to the correct port.\n` +
      `  ${e.message}`
    );
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from /json/list`);
  const all = await resp.json();
  return all.filter(t =>
    t.type === 'page' &&
    !t.url.startsWith('chrome://') &&
    !t.url.startsWith('devtools://')
  );
}

function resolveTargetPrefix(prefix, pages) {
  const upper = prefix.toUpperCase();
  const matches = pages.filter(p => p.id.toUpperCase().startsWith(upper));
  if (matches.length === 0)
    throw new Error(`No target matching "${prefix}". Run "list" to see available targets.`);
  if (matches.length > 1)
    throw new Error(`Ambiguous prefix "${prefix}" matches ${matches.length} targets. Use more characters.`);
  return matches[0];
}

function displayPrefixLen(ids) {
  if (ids.length <= 1) return MIN_TARGET_PREFIX;
  const max = Math.max(...ids.map(i => i.length));
  for (let len = MIN_TARGET_PREFIX; len <= max; len++) {
    if (new Set(ids.map(i => i.slice(0, len).toUpperCase())).size === ids.length) return len;
  }
  return max;
}

async function connectToTarget(prefix, port) {
  const pages = await fetchPages(port);
  if (pages.length === 0) throw new Error('No page targets found');
  if (prefix === '-') {
    if (pages.length !== 1) {
      throw new Error(
        `Target "-" requires exactly one page target, found ${pages.length}. ` +
        'Run "list" and use an explicit target prefix.'
      );
    }
    prefix = pages[0].id;
  }
  const page = resolveTargetPrefix(prefix, pages);
  if (!page.webSocketDebuggerUrl) throw new Error(`Target ${page.id} has no WebSocket URL`);
  const ws = await openWs(page.webSocketDebuggerUrl);
  return { ws, target: page };
}

function resolveElectronBinary(appPath) {
  const candidates = IS_WINDOWS
    ? [
        resolve(appPath, 'node_modules', 'electron', 'dist', 'electron.exe'),
        resolve(appPath, 'node_modules', '.bin', 'electron.cmd'),
        resolve(appPath, 'node_modules', '.bin', 'electron'),
      ]
    : process.platform === 'darwin'
      ? [
          resolve(appPath, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
          resolve(appPath, 'node_modules', '.bin', 'electron'),
        ]
      : [
          resolve(appPath, 'node_modules', 'electron', 'dist', 'electron'),
          resolve(appPath, 'node_modules', '.bin', 'electron'),
        ];

  const electronBin = candidates.find(candidate => existsSync(candidate));
  if (!electronBin) {
    throw new Error(
      'Electron binary not found. Tried:\n' +
      candidates.map(candidate => `  ${candidate}`).join('\n') +
      "\nRun 'npm install' in the project first."
    );
  }

  return electronBin;
}

// ---------------------------------------------------------------------------
// Key map
// ---------------------------------------------------------------------------
function resolveKey(combo) {
  if (!combo) throw new Error('key combo required (e.g. x, Ctrl+Enter, Shift+Tab)');
  const parts = combo.split('+');
  let key = parts.pop().trim();
  const rawMods = parts.map(m => m.trim().toLowerCase());
  if (key === '') key = '+';

  let modifiers = 0;
  for (const m of rawMods) {
    if (m === 'ctrl' || m === 'control') modifiers |= 2;
    else if (m === 'alt' || m === 'option') modifiers |= 1;
    else if (m === 'shift') modifiers |= 8;
    else if (m === 'meta' || m === 'cmd' || m === 'command') modifiers |= 4;
    else throw new Error(`Unknown modifier: ${m}`);
  }

  const special = {
    'enter': 'Enter', 'tab': 'Tab', 'escape': 'Escape', 'esc': 'Escape',
    'backspace': 'Backspace', 'delete': 'Delete', 'space': 'Space',
    'arrowup': 'ArrowUp', 'arrowdown': 'ArrowDown', 'arrowleft': 'ArrowLeft', 'arrowright': 'ArrowRight',
    'home': 'Home', 'end': 'End', 'pageup': 'PageUp', 'pagedown': 'PageDown', 'insert': 'Insert',
  };
  for (let i = 1; i <= 12; i++) special[`f${i}`] = `F${i}`;

  let code;
  const lowerKey = key.toLowerCase();
  if (special[lowerKey]) {
    code = special[lowerKey];
    key = lowerKey === 'space' ? ' ' : special[lowerKey];
  } else if (key.length === 1) {
    const ch = key;
    if (ch >= 'a' && ch <= 'z') code = `Key${ch.toUpperCase()}`;
    else if (ch >= 'A' && ch <= 'Z') code = `Key${ch}`;
    else if (ch >= '0' && ch <= '9') code = `Digit${ch}`;
    else if (ch === '+' || ch === '=') code = 'Equal';
    else if (ch === '-' || ch === '_') code = 'Minus';
    else if (ch === '[') code = 'BracketLeft';
    else if (ch === ']') code = 'BracketRight';
    else if (ch === '\\') code = 'Backslash';
    else if (ch === ';') code = 'Semicolon';
    else if (ch === "'") code = 'Quote';
    else if (ch === ',') code = 'Comma';
    else if (ch === '.') code = 'Period';
    else if (ch === '/') code = 'Slash';
    else if (ch === '`') code = 'Backquote';
  }
  return { key, code, modifiers };
}

// ---------------------------------------------------------------------------
// CLI flag parsing
// ---------------------------------------------------------------------------
function parseFlags(args) {
  const result = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { result.push(...args.slice(i + 1)); break; }
    if (args[i].startsWith('--')) {
      const f = args[i].slice(2);
      const eqIdx = f.indexOf('=');
      if (eqIdx >= 0) {
        flags[f.slice(0, eqIdx)] = f.slice(eqIdx + 1);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[f] = args[i + 1];
        i++;
      } else {
        flags[f] = true;
      }
    } else {
      result.push(args[i]);
    }
  }
  return { args: result, flags };
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

// --- launch ---
async function cmdLaunch(pos, flags) {
  const appPath = resolve(pos[0] || process.cwd());
  const port = resolvePort();

  // Find Electron binary
  const electronBin = resolveElectronBinary(appPath);

  try {
    const existing = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (existing.ok) {
      console.log(`Electron is already running on port ${port}.`);
      return;
    }
  } catch { /* fetch failed — port is free, proceed */ }

  // Create a user data directory for this project (deterministic path, reused on re-launch)
  const sanitized = appPath.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dataDir = resolve(USERDATA_DIR, sanitized);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const proc = spawn(electronBin, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dataDir}`,
    '.',
  ], {
    cwd: appPath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.unref(); // Don't keep parent alive for child's pipes

  // Collect stderr (bounded at 64 KB) for diagnostics on failure
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
    if (stderr.length > 65536) stderr = stderr.slice(-65536);
  });
  proc.stderr.unref(); // Data listener shouldn't keep event loop alive

  // Wait for debugger endpoint
  const deadline = Date.now() + 15000;
  let wsUrl = null;

  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      if (resp.ok) {
        const data = await resp.json();
        wsUrl = data.webSocketDebuggerUrl;
        break;
      }
    } catch {}
    await sleep(200);
  }

  if (proc.exitCode !== null) {
    throw new Error(
      `Electron exited with code ${proc.exitCode} before debugger was ready.` +
      (stderr ? `\nStderr:\n${stderr}` : '')
    );
  }
  if (!wsUrl) {
    throw new Error(
      `Timed out waiting for Electron debugger on port ${port} (15s).` +
      (stderr ? `\nStderr:\n${stderr}` : '')
    );
  }

  console.log(`Launched Electron (pid ${proc.pid}) on port ${port}`);

  // Detach from child's pipes so Node's event loop can drain
  proc.stderr.destroy();
  proc.stdout.destroy();
}

// --- close ---
async function cmdClose(pos, flags) {
  const port = resolvePort();

  // Connect to browser endpoint and issue Browser.close
  let resp;
  try {
    resp = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
  } catch (e) {
    console.log(`No Electron instance found on port ${port} (${e.message})`);
    return;
  }

  if (!resp.ok) {
    console.log(`No Electron instance found on port ${port}`);
    return;
  }

  const data = await resp.json();
  if (!data.webSocketDebuggerUrl) {
    console.log(`No debugger WebSocket on port ${port}`);
    return;
  }

  const ws = await openWs(data.webSocketDebuggerUrl);
  // Browser.close shuts down Electron immediately — the CDP response never
  // arrives because the WebSocket dies. That's expected; ignore the timeout.
  await cdpSend(ws, 'Browser.close').catch(() => {});
  ws.close();
  console.log(`Sent close signal to Electron on port ${port}`);
  await sleep(1000);
}

// --- list ---
async function cmdList(pos, flags) {
  const port = resolvePort();
  const pages = await fetchPages(port);
  if (pages.length === 0) { console.log('No page targets found.'); return; }

  const plen = displayPrefixLen(pages.map(p => p.id));
  for (const p of pages) {
    const id = p.id.slice(0, plen).padEnd(plen);
    const title = (p.title || '').substring(0, 50).padEnd(50);
    console.log(`${id}  ${title}  ${p.url}`);
  }
}

// --- eval ---
async function cmdEval(pos, flags) {
  const prefix = pos[0];
  const expr = pos.slice(1).join(' ');
  if (!prefix) throw new Error('Usage: eval <target> <expression>');
  if (!expr) throw new Error('Expression required');
  const port = resolvePort();

  const { ws } = await connectToTarget(prefix, port);
  try {
    const result = await cdpSend(ws, 'Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    const val = checkResult(result).value;
    console.log(typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val ?? ''));
  } finally { ws.close(); }
}

// --- html ---
async function cmdHtml(pos, flags) {
  const prefix = pos[0];
  const selector = pos.slice(1).join(' ') || null;
  if (!prefix) throw new Error('Usage: html <target> [selector]');
  const port = resolvePort();

  const { ws } = await connectToTarget(prefix, port);
  try {
    const expr = selector
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el instanceof HTMLElement ? el.outerHTML : 'Element not found: ' + ${JSON.stringify(selector)}; })()`
      : 'document.body.outerHTML';
    const result = await cdpSend(ws, 'Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    console.log(checkResult(result).value);
  } finally { ws.close(); }
}

// --- snaplabels ---
async function cmdSnaplabels(pos, flags) {
  const prefix = pos[0];
  if (!prefix) throw new Error('Usage: snaplabels <target>');
  const port = resolvePort();

  const { ws } = await connectToTarget(prefix, port);
  try {
    const result = await cdpSend(ws, 'Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll('[aria-label]')).map(el => ({ tag: el.tagName, label: el.getAttribute('aria-label') }))`,
      returnByValue: true, awaitPromise: true,
    });
    const labels = checkResult(result).value;
    if (!labels || labels.length === 0) {
      console.log('No elements with aria-label found.');
      return;
    }
    const maxTag = Math.max(...labels.map(l => l.tag.length));
    for (const l of labels) console.log(`${l.tag.padEnd(maxTag)}  ${l.label}`);
  } finally { ws.close(); }
}

// --- shot ---
async function cmdShot(pos, flags) {
  const prefix = pos[0];
  let file = pos[1];
  if (!prefix) throw new Error('Usage: shot <target> [file]');
  const port = resolvePort();

  const { ws, target } = await connectToTarget(prefix, port);
  try {
    const metrics = await cdpSend(ws, 'Page.getLayoutMetrics');
    const dpr = metrics.devicePixelRatio || 1;
    const result = await cdpSend(ws, 'Page.captureScreenshot', { format: 'png' });
    if (!file) file = `screenshot-${target.id.slice(0, 8)}.png`;
    writeFileSync(file, Buffer.from(result.data, 'base64'));
    console.log(`Screenshot saved: ${file} (DPR=${dpr})`);
  } finally { ws.close(); }
}

// --- click ---
async function cmdClick(pos, flags) {
  const prefix = pos[0];
  const selector = pos.slice(1).join(' ');
  if (!prefix) throw new Error('Usage: click <target> <css-selector>');
  if (!selector) throw new Error('CSS selector required');
  const port = resolvePort();

  const { ws } = await connectToTarget(prefix, port);
  try {
    const result = await cdpSend(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!(el instanceof HTMLElement)) return { ok: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return { ok: true, tag: el.tagName, text: (el.textContent || '').trim().substring(0, 80) };
      })()`,
      returnByValue: true, awaitPromise: true,
    });
    const r = checkResult(result).value;
    if (!r.ok) throw new Error(r.error);
    console.log(`Clicked <${r.tag}> "${r.text}"`);
  } finally { ws.close(); }
}

// --- clicktext ---
async function cmdClicktext(pos, flags) {
  const prefix = pos[0];
  const text = pos.slice(1).join(' ');
  if (!prefix) throw new Error('Usage: clicktext <target> <text>');
  if (!text) throw new Error('Text required');
  const port = resolvePort();

  const { ws } = await connectToTarget(prefix, port);
  try {
    const result = await cdpSend(ws, 'Runtime.evaluate', {
      expression: `(() => {
        const targetText = ${JSON.stringify(text)};
        const candidates = document.querySelectorAll(
          'button, a[href], input[type="submit"], input[type="button"], input[type="reset"], ' +
          '[role="button"], [role="link"], [role="menuitem"], [role="tab"], ' +
          '[role="option"], [role="checkbox"], [role="radio"], [role="switch"], summary'
        );
        for (const el of candidates) {
          if (el.textContent && el.textContent.trim() === targetText) {
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            el.click();
            return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80) };
          }
        }
        for (const el of candidates) {
          if (el.textContent && el.textContent.trim().includes(targetText)) {
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            el.click();
            return { ok: true, tag: el.tagName, text: el.textContent.trim().substring(0, 80), partial: true };
          }
        }
        return { ok: false, error: 'No clickable element with text matching: ' + targetText };
      })()`,
      returnByValue: true, awaitPromise: true,
    });
    const r = checkResult(result).value;
    if (!r.ok) throw new Error(r.error);
    console.log(`Clicked <${r.tag}> "${r.text}"${r.partial ? ' (partial match)' : ''}`);
  } finally { ws.close(); }
}

// --- keypress ---
async function cmdKeypress(pos, flags) {
  const prefix = pos[0];
  const keyArg = pos.slice(1).join('+');
  if (!prefix || !keyArg) throw new Error('Usage: keypress <target> <key>');
  const port = resolvePort();

  const { ws } = await connectToTarget(prefix, port);
  try {
    const { key, code, modifiers } = resolveKey(keyArg);
    const base = { key, modifiers };
    if (code) base.code = code;

    await cdpSend(ws, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await sleep(20);
    await cdpSend(ws, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });

    const modNames = [];
    if (modifiers & 2) modNames.push('Ctrl');
    if (modifiers & 1) modNames.push('Alt');
    if (modifiers & 8) modNames.push('Shift');
    if (modifiers & 4) modNames.push('Meta');
    const prefixStr = modNames.length ? `${modNames.join('+')}+` : '';
    console.log(`Sent key: ${prefixStr}${key}`);
  } finally { ws.close(); }
}

// --- type ---
async function cmdType(pos, flags) {
  const prefix = pos[0];
  const text = pos.slice(1).join(' ');
  if (!prefix) throw new Error('Usage: type <target> <text>');
  if (!text) throw new Error('Text required');
  const port = resolvePort();

  const { ws } = await connectToTarget(prefix, port);
  try {
    await cdpSend(ws, 'Input.insertText', { text });
    console.log(`Typed: ${JSON.stringify(text)}`);
  } finally { ws.close(); }
}

// --- waitfor ---
async function cmdWaitfor(pos, flags) {
  const prefix = pos[0];
  const expr = pos.slice(1).join(' ');
  if (!prefix) throw new Error('Usage: waitfor <target> <expression> [--timeout <ms>]');
  if (!expr) throw new Error('Expression required');
  const port = resolvePort();
  const timeout = parseInt(flags.timeout, 10) || 10000;
  const start = Date.now();

  let { ws } = await connectToTarget(prefix, port);
  try {
    while (Date.now() - start < timeout) {
      try {
        const result = await cdpSend(ws, 'Runtime.evaluate', {
          expression: `Boolean(${expr})`,
          returnByValue: true, awaitPromise: true,
        });
        if (!result.exceptionDetails && result.result?.value) {
          console.log('Condition met');
          return;
        }
      } catch {
        try { ws.close(); } catch {}
        try { ws = (await connectToTarget(prefix, port)).ws; } catch {}
      }
      await sleep(100);
    }
  } finally { try { ws.close(); } catch {} }

  throw new Error(`Timed out after ${timeout}ms waiting for: ${expr}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------
const HELP = `
Usage: electron-test.mjs <command> [args...] [flags]

Required:
  Set ELECTRON_TEST_PORT in your environment (e.g. export ELECTRON_TEST_PORT=9223)

Commands:

  Lifecycle:
    launch    [appPath]        Launch Electron with remote debugging
    close                      Gracefully shut down Electron via CDP Browser.close
    list                       List page targets

  Inspect:
    eval     <target> <expr>   Evaluate JavaScript in the page
    html     <target> [sel]    Page HTML (default: body). CSS selector for element.
    snaplabels <target>        List all elements with aria-label
    shot     <target> [file]   Viewport screenshot (PNG)

  Interact:
    click    <target> <sel>    Click element by CSS selector
    clicktext <target> <text>  Click element by visible text content
    keypress <target> <key>    Press a key or modifier combo
    type     <target> <text>   Type text at current focus (Input.insertText)

  Assert:
    waitfor  <target> <expr>   Poll expression every 100ms until truthy
              [--timeout <ms>] Max wait (default: 10000)

Flags (can appear anywhere after the command):
    --timeout <n>  Override timeout for waitfor (in milliseconds)

Target:
    The <target> is a unique prefix of a page target ID. Run "list" to see
    available targets. Prefixes are case-insensitive.
    Use "-" to auto-select the only page when exactly one page target exists.

Quoting:
    For eval and waitfor expressions, single-quote JS strings and use
    \\" for CSS attribute values:
      eval <t> "document.querySelector('button[aria-label=\\"Close\\"]')"

Environment:
    ELECTRON_TEST_PORT   Required. The CDP port for Electron (e.g. 9223)
`;

function help() {
  console.log(HELP.trim());
}

const COMMANDS = {
  launch: cmdLaunch, close: cmdClose, list: cmdList,
  eval: cmdEval, html: cmdHtml, snaplabels: cmdSnaplabels, shot: cmdShot,
  click: cmdClick, clicktext: cmdClicktext, keypress: cmdKeypress, type: cmdType,
  waitfor: cmdWaitfor,
};

async function main() {
  const cmd = process.argv[2];
  const { args: pos, flags } = parseFlags(process.argv.slice(3));

  if (!cmd || cmd === 'help' || !COMMANDS[cmd]) {
    help();
    process.exit(cmd && cmd !== 'help' ? 1 : 0);
  }

  await COMMANDS[cmd](pos, flags);
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
