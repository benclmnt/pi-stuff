/**
 * CDP — Chrome DevTools Protocol WebSocket client.
 *
 * Zero dependencies (uses Node 22+ built-in WebSocket).
 * Shared library used by:
 *   - the cdp CLI (scripts/cdp.mjs)
 *   - domain skills (import via ../../scripts/lib/cdp.mjs)
 */

import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

// ─── Auto-discover DevToolsActivePort ──────────────────────────────────────

const HOME = homedir();
const DEFAULT_AUTOMATION_PROFILE = 'Default';
const AUTOMATION_ROOT_DIR = resolve(HOME, '.cache', 'scraping');
const AUTOMATION_PROFILES_DIR = resolve(AUTOMATION_ROOT_DIR, 'profiles');
const IS_WINDOWS = process.platform === 'win32';

export function normalizeProfileName(profile = process.env.CDP_PROFILE || DEFAULT_AUTOMATION_PROFILE) {
  const value = String(profile || DEFAULT_AUTOMATION_PROFILE).trim();
  return !value || value.toLowerCase() === 'default' ? DEFAULT_AUTOMATION_PROFILE : value;
}

export function getAutomationProfileKey(profile = process.env.CDP_PROFILE || DEFAULT_AUTOMATION_PROFILE) {
  const normalized = normalizeProfileName(profile);
  if (normalized === DEFAULT_AUTOMATION_PROFILE) return 'default';
  return normalized.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'unnamed';
}

export function getAutomationProfileDir(profile = process.env.CDP_PROFILE || DEFAULT_AUTOMATION_PROFILE) {
  return resolve(AUTOMATION_PROFILES_DIR, getAutomationProfileKey(profile));
}

export function getAutomationRootDir() {
  return AUTOMATION_ROOT_DIR;
}

export function getAutomationStateFile(profile = process.env.CDP_PROFILE || DEFAULT_AUTOMATION_PROFILE) {
  return resolve(getAutomationProfileDir(profile), 'state.json');
}

export function getAutomationLockFile(profile = process.env.CDP_PROFILE || DEFAULT_AUTOMATION_PROFILE) {
  return resolve(getAutomationProfileDir(profile), 'pid.lock');
}

export function getAutomationLogDir(profile = process.env.CDP_PROFILE || DEFAULT_AUTOMATION_PROFILE) {
  return resolve(getAutomationProfileDir(profile), 'logs');
}

export function getAutomationPortFiles(profile = process.env.CDP_PROFILE || DEFAULT_AUTOMATION_PROFILE) {
  const automationDir = getAutomationProfileDir(profile);
  return [
    resolve(automationDir, 'DevToolsActivePort'),
    resolve(automationDir, 'Default', 'DevToolsActivePort'),
  ];
}

function readWsUrlFromPortFile(portFile) {
  const lines = readFileSync(portFile, 'utf8').trim().split('\n');
  if (lines.length < 2 || !lines[0] || !lines[1])
    throw new Error(`Invalid DevToolsActivePort file: ${portFile}`);
  const host = process.env.CDP_HOST || '127.0.0.1';
  return `ws://${host}:${lines[0]}${lines[1]}`;
}

function findPortFile(candidates) {
  return candidates.find(p => existsSync(p)) || null;
}

function getGenericPortFileCandidates() {
  const macBrowsers = [
    'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome for Testing',
    'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge',
  ];
  const linuxBrowsers = [
    'google-chrome', 'google-chrome-beta', 'chromium',
    'vivaldi', 'vivaldi-snapshot',
    'BraveSoftware/Brave-Browser', 'microsoft-edge',
  ];
  const flatpakBrowsers = [
    ['org.chromium.Chromium', 'chromium'],
    ['com.google.Chrome', 'google-chrome'],
    ['com.brave.Browser', 'BraveSoftware/Brave-Browser'],
    ['com.microsoft.Edge', 'microsoft-edge'],
    ['com.vivaldi.Vivaldi', 'vivaldi'],
  ];

  return [
    ...macBrowsers.flatMap(b => [
      resolve(HOME, 'Library/Application Support', b, 'DevToolsActivePort'),
      resolve(HOME, 'Library/Application Support', b, 'Default/DevToolsActivePort'),
    ]),
    ...linuxBrowsers.flatMap(b => [
      resolve(HOME, '.config', b, 'DevToolsActivePort'),
      resolve(HOME, '.config', b, 'Default/DevToolsActivePort'),
    ]),
    ...flatpakBrowsers.flatMap(([appId, name]) => [
      resolve(HOME, '.var/app', appId, 'config', name, 'DevToolsActivePort'),
      resolve(HOME, '.var/app', appId, 'config', name, 'Default/DevToolsActivePort'),
    ]),
    ...(IS_WINDOWS ? ['Google/Chrome', 'BraveSoftware/Brave-Browser', 'Microsoft/Edge'].flatMap(b => {
      const base = process.env.LOCALAPPDATA || resolve(HOME, 'AppData/Local');
      return [
        resolve(base, b, 'User Data/DevToolsActivePort'),
        resolve(base, b, 'User Data/Default/DevToolsActivePort'),
      ];
    }) : []),
  ].filter(Boolean);
}

export function getWsUrl(profile = process.env.CDP_PROFILE || DEFAULT_AUTOMATION_PROFILE, options = {}) {
  const { includeAutomation = true, includeGeneric = true } = options;

  const candidates = [
    process.env.CDP_PORT_FILE,
    ...(includeAutomation ? getAutomationPortFiles(profile) : []),
    ...(includeGeneric ? getGenericPortFileCandidates() : []),
  ].filter(Boolean);

  const portFile = findPortFile(candidates);
  if (!portFile) {
    // Fallback: caller may try an HTTP debug endpoint next
    return null;
  }
  return readWsUrlFromPortFile(portFile);
}

function getAutomationWsUrl(profile = process.env.CDP_PROFILE || DEFAULT_AUTOMATION_PROFILE) {
  const portFile = findPortFile(getAutomationPortFiles(profile));
  return portFile ? readWsUrlFromPortFile(portFile) : null;
}

async function canReachWsUrl(wsUrl, timeout) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const { host } = new URL(wsUrl);
    const resp = await fetch(`http://${host}/json/version`, { signal: controller.signal });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(id);
  }
}

function resolveConnectionOptions(timeoutOrOptions = 5000, maybeOptions = {}) {
  if (typeof timeoutOrOptions === 'object' && timeoutOrOptions !== null) {
    return {
      timeout: timeoutOrOptions.timeout ?? 5000,
      profile: normalizeProfileName(timeoutOrOptions.profile ?? process.env.CDP_PROFILE),
    };
  }

  return {
    timeout: timeoutOrOptions ?? 5000,
    profile: normalizeProfileName(maybeOptions.profile ?? process.env.CDP_PROFILE),
  };
}

export async function getDebugUrl(timeoutOrOptions = 5000, maybeOptions = {}) {
  const { timeout, profile } = resolveConnectionOptions(timeoutOrOptions, maybeOptions);
  const wsUrl = await discoverWsUrl({ timeout, profile });
  const { host } = new URL(wsUrl);
  return `http://${host}`;
}

// ─── Connect ───────────────────────────────────────────────────────────────

/**
 * Try to discover the browser's WebSocket debug URL.
 * For the default automation profile, fallback remains:
 *   CDP_PORT_FILE > isolated automation browser > HTTP :9222 > generic DevToolsActivePort files.
 * For non-default automation profiles, discovery is scoped to that profile's isolated browser.
 */
export async function discoverWsUrl(timeoutOrOptions = 5000, maybeOptions = {}) {
  const { timeout, profile } = resolveConnectionOptions(timeoutOrOptions, maybeOptions);

  // 1. CDP_PORT_FILE env var
  if (process.env.CDP_PORT_FILE) {
    const fromFile = getWsUrl(profile, { includeAutomation: false, includeGeneric: false });
    if (fromFile && await canReachWsUrl(fromFile, timeout)) return fromFile;
  }

  // 2. Isolated automation browser (preferred over user Chrome)
  const automationWsUrl = getAutomationWsUrl(profile);
  if (automationWsUrl && await canReachWsUrl(automationWsUrl, timeout)) {
    return automationWsUrl;
  }

  if (normalizeProfileName(profile) === DEFAULT_AUTOMATION_PROFILE) {
    // 3. HTTP discovery on :9222 (common manual setup)
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
      const resp = await fetch('http://localhost:9222/json/version', { signal: controller.signal });
      const data = await resp.json();
      if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
    } catch {} finally {
      clearTimeout(id);
    }

    // 4. Generic DevToolsActivePort file discovery
    const fromFile = getWsUrl(profile, { includeAutomation: false, includeGeneric: true });
    if (fromFile && await canReachWsUrl(fromFile, timeout)) return fromFile;
  }

  throw new Error(
    normalizeProfileName(profile) === DEFAULT_AUTOMATION_PROFILE
      ? 'No Chrome debug endpoint found. Run cdp start for an isolated browser, or enable remote debugging manually.'
      : `No Chrome debug endpoint found for automation profile "${profile}". Run cdp start --profile ${JSON.stringify(profile)}.`
  );
}

export async function connect(timeoutOrOptions = 5000, maybeOptions = {}) {
  const { timeout, profile } = resolveConnectionOptions(timeoutOrOptions, maybeOptions);
  const wsUrl = await discoverWsUrl({ timeout, profile });
  const cdp = new CDP();
  await cdp.connect(wsUrl, timeout);
  return cdp;
}

// ─── CDP class ─────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT = 15000;

export class CDP {
  #ws;
  #id = 0;
  #pending = new Map();
  #eventHandlers = new Map();
  #closeHandlers = [];

  async connect(wsUrl, timeout = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`WebSocket connect timeout (${timeout}ms)`));
      }, timeout);

      this.#ws = new WebSocket(wsUrl);
      this.#ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.#ws.onerror = (e) => { clearTimeout(timer); reject(new Error('WebSocket error: ' + (e.message || e.type))); };
      this.#ws.onclose = () => this.#closeHandlers.forEach(h => h());
      this.#ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.#pending.has(msg.id)) {
          const { resolve, reject } = this.#pending.get(msg.id);
          this.#pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result);
        } else if (msg.method && this.#eventHandlers.has(msg.method)) {
          for (const handler of [...this.#eventHandlers.get(msg.method)]) {
            handler(msg.params || {}, msg.sessionId || null);
          }
        }
      };
    });
  }

  send(method, params = {}, sessionId = null, timeout = DEFAULT_TIMEOUT) {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.#ws.send(JSON.stringify(msg));
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`Timeout: ${method} (${timeout}ms)`));
        }
      }, timeout);
    });
  }

  // ── Events ──────────────────────────────────────────────────────────────

  on(method, handler) {
    if (!this.#eventHandlers.has(method))
      this.#eventHandlers.set(method, new Set());
    this.#eventHandlers.get(method).add(handler);
    return () => this.off(method, handler);
  }

  off(method, handler) {
    const handlers = this.#eventHandlers.get(method);
    if (!handlers) return;
    handlers.delete(handler);
    if (handlers.size === 0) this.#eventHandlers.delete(method);
  }

  onEvent(method, handler) {
    return this.on(method, handler);
  }

  waitForEvent(method, timeout = DEFAULT_TIMEOUT) {
    let settled = false;
    let off;
    let timer;
    const promise = new Promise((resolve, reject) => {
      off = this.on(method, (params) => {
        if (settled) return;
        settled = true; clearTimeout(timer); off();
        resolve(params);
      });
      timer = setTimeout(() => {
        if (settled) return;
        settled = true; off();
        reject(new Error(`Timeout waiting for event: ${method}`));
      }, timeout);
    });
    return {
      promise,
      cancel() { if (!settled) { settled = true; clearTimeout(timer); off?.(); } },
    };
  }

  onClose(handler) { this.#closeHandlers.push(handler); }

  // ── High-level helpers ──────────────────────────────────────────────────

  async enableDomains(sessionId, domains, timeout = DEFAULT_TIMEOUT) {
    const list = Array.isArray(domains) ? domains : [domains];
    for (const domain of list.filter(Boolean)) {
      await this.send(`${domain}.enable`, {}, sessionId, timeout);
    }
  }

  async getPages() {
    const { targetInfos } = await this.send('Target.getTargets');
    return targetInfos.filter(t => t.type === 'page' && !t.url.startsWith('chrome://'));
  }

  async attachToPage(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  async evaluate(sessionId, expression, timeout = 30000) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId, timeout);

    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text
      );
    }
    return result.result?.value;
  }

  async screenshot(sessionId, timeout = 10000) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' }, sessionId, timeout);
    return Buffer.from(data, 'base64');
  }

  async navigate(sessionId, url, timeout = 30000) {
    return await this.send('Page.navigate', { url }, sessionId, timeout);
  }

  async getFrameTree(sessionId) {
    const { frameTree } = await this.send('Page.getFrameTree', {}, sessionId);
    return frameTree;
  }

  async evaluateInFrame(sessionId, frameId, expression, timeout = 30000) {
    const { executionContextId } = await this.send(
      'Page.createIsolatedWorld',
      { frameId, worldName: 'cdp-eval' },
      sessionId,
    );
    const result = await this.send('Runtime.evaluate', {
      expression,
      contextId: executionContextId,
      returnByValue: true,
      awaitPromise: true,
    }, sessionId, timeout);

    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description || result.exceptionDetails.text
      );
    }
    return result.result?.value;
  }

  close() {
    this.#ws?.close();
  }
}
