/**
 * start — launch an isolated Chrome automation session.
 *
 * - separate user-data-dir from your main Chrome
 * - prefers staying in the background on macOS
 * - optionally seeds that isolated profile from your default Chrome profile
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getAutomationProfileDir,
  getAutomationLockFile,
  getAutomationStateFile,
  normalizeProfileName,
} from '../lib/cdp.mjs';
import {
  isProcessAlive,
  listAutomationBrowserProcesses,
  removeChromeRuntimeArtifacts,
  sleep,
  writeTimestampedJson,
} from '../lib/automation-session.mjs';

const HOME = process.env.HOME || '';
const DEFAULT_CHROME_PROFILE = join(HOME, 'Library', 'Application Support', 'Google', 'Chrome');
const START_LOCK_TIMEOUT = 30000;
const START_LOCK_STALE_MS = 2 * 60 * 1000;

export async function run({ args, profile }) {
  const sourceProfile = normalizeProfileName(profile || parseProfileArg(args));
  const automationDir = getAutomationProfileDir(sourceProfile);
  const portFile = join(automationDir, 'DevToolsActivePort');
  const pidLockFile = getAutomationLockFile(sourceProfile);
  const startLockFile = join(automationDir, '.start.lock');
  const stateFile = getAutomationStateFile(sourceProfile);
  const releaseStartLock = await acquireStartLock({ sourceProfile, startLockFile });

  try {
    const existing = await detectExistingAutomationSession({ sourceProfile, automationDir, portFile });
    if (existing?.kind === 'conflict') {
      console.error('✗ Multiple isolated Chrome processes are using the same automation profile');
      console.error(`  Profile: ${sourceProfile}`);
      console.error(`  Profile dir: ${automationDir}`);
      console.error(`  Running Chrome PID(s): ${formatProcessList(existing.processes)}`);
      console.error('  Close all isolated Chrome windows for this automation profile and run cdp start again.');
      process.exit(1);
    }

    if (existing?.kind === 'debuggable') {
      const browserPid = existing.processes?.[0]?.pid || null;
      writeTimestampedJson(pidLockFile, {
        pid: browserPid,
        profile: sourceProfile,
        userDataDir: automationDir,
        debugUrl: existing.debugUrl,
      });
      writeTimestampedJson(stateFile, {
        browserPid,
        profile: sourceProfile,
        userDataDir: automationDir,
        debugUrl: existing.debugUrl,
        status: 'running',
      });
      console.log(`✓ Isolated Chrome automation session already running using profile ${sourceProfile}`);
      return;
    }

    if (existing?.kind === 'in-use') {
      console.error('✗ Isolated Chrome automation profile is already in use');
      console.error(`  Profile: ${sourceProfile}`);
      console.error(`  Profile dir: ${automationDir}`);
      console.error(`  Running Chrome PID(s): ${formatProcessList(existing.processes)}`);
      console.error('  Refusing to launch a second Chrome instance against the same automation profile.');
      console.error('  Close that browser (or kill those PIDs) and retry.');
      process.exit(1);
    }

    mkdirSync(automationDir, { recursive: true });

    syncChromeUserData(automationDir);
    removeChromeRuntimeArtifacts(automationDir);

    const chromeBinary = resolveChromeBinary();
    if (!chromeBinary) {
      console.error('✗ Could not find Chrome/Chromium binary');
      console.error('  Set BROWSER_BIN=/path/to/chrome and retry');
      process.exit(1);
    }

    const chromeArgs = [
      '--remote-debugging-port=0',
      `--user-data-dir=${automationDir}`,
      `--profile-directory=${sourceProfile}`,
      '--disable-search-engine-choice-screen',
      '--no-first-run',
      '--disable-features=ProfilePicker',
      '--disable-backgrounding-occluded-windows',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ];

    launchChrome(chromeBinary, chromeArgs);

    const debugUrl = await waitForAutomationDebugUrl(portFile, 15000);
    if (!debugUrl) {
      console.error('✗ Failed to connect to isolated Chrome automation session');
      console.error(`  Attempted binary: ${chromeBinary}`);
      console.error(`  Profile: ${sourceProfile}`);
      console.error(`  Profile dir: ${automationDir}`);
      process.exit(1);
    }

    startWatcherIfPresent(sourceProfile);
    const browserPid = listAutomationBrowserProcesses(automationDir)[0]?.pid || null;
    writeTimestampedJson(pidLockFile, {
      pid: browserPid,
      profile: sourceProfile,
      userDataDir: automationDir,
      debugUrl,
    });
    writeTimestampedJson(stateFile, {
      browserPid,
      profile: sourceProfile,
      userDataDir: automationDir,
      debugUrl,
      status: 'running',
    });

    console.log(`✓ Isolated Chrome automation session started (${debugUrl}) using profile ${sourceProfile}`);
  } finally {
    releaseStartLock();
  }
}

function parseProfileArg(args) {
  const inline = args.find(arg => arg.startsWith('--profile='));
  if (inline) return inline.slice('--profile='.length) || 'Default';
  const idx = args.indexOf('--profile');
  if (idx === -1) return 'Default';
  const value = args[idx + 1];
  if (!value || value.startsWith('--')) return 'Default';
  return value;
}

function syncChromeUserData(automationDir) {
  if (!existsSync(DEFAULT_CHROME_PROFILE)) return;
  try {
    execSync(
      `rsync -a --delete --exclude 'Singleton*' --exclude 'DevToolsActivePort*' --exclude 'logs' --exclude 'state.json' --exclude 'pid.lock' --exclude '.start.lock' --exclude 'watch.pid' "${DEFAULT_CHROME_PROFILE}/" "${automationDir}/"`,
      { stdio: 'pipe' },
    );
  } catch (error) {
    if (error?.status !== 24) throw error;
  }
}

function launchChrome(chromeBinary, chromeArgs) {
  if (process.platform === 'darwin') {
    const appBundle = toAppBundlePath(chromeBinary);
    if (appBundle) {
      spawn('open', ['-g', '-j', '-n', '-a', appBundle, '--args', ...chromeArgs], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return;
    }
  }

  spawn(chromeBinary, chromeArgs, { detached: true, stdio: 'ignore' }).unref();
}

function toAppBundlePath(chromeBinary) {
  const marker = '.app/';
  const idx = chromeBinary.indexOf(marker);
  if (idx === -1) return null;
  return chromeBinary.slice(0, idx + 4);
}

async function detectExistingAutomationSession({ sourceProfile, automationDir, portFile }) {
  const processes = listAutomationBrowserProcesses(automationDir, {
    includeProfileDirectory: true,
    includeRemoteDebuggingPort: true,
  });

  if (processes.length > 1) {
    return { kind: 'conflict', processes };
  }

  if (processes.length === 1) {
    const processInfo = processes[0];
    const debugUrl = await waitForExistingAutomationDebugUrl(processInfo, portFile, 5000);
    if (debugUrl) return { kind: 'debuggable', processes, debugUrl };
    return { kind: 'in-use', processes };
  }

  const debugUrl = readAutomationDebugUrl(portFile);
  if (debugUrl && await canReachDebugUrl(debugUrl)) {
    return { kind: 'debuggable', processes, debugUrl, sourceProfile };
  }

  return null;
}

function readAutomationDebugUrl(portFile) {
  if (!existsSync(portFile)) return null;
  try {
    const lines = readFileSync(portFile, 'utf8').trim().split('\n');
    const port = lines[0];
    if (!port) return null;
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
}

async function waitForAutomationDebugUrl(portFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const debugUrl = readAutomationDebugUrl(portFile);
    if (debugUrl && await canReachDebugUrl(debugUrl)) return debugUrl;
    await sleep(250);
  }
  return null;
}

async function canReachDebugUrl(debugUrl, timeoutMs = 1500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${debugUrl}/json/version`, { signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForExistingAutomationDebugUrl(processInfo, portFile, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const debugUrl = await resolveExistingAutomationDebugUrl(processInfo, portFile);
    if (debugUrl) return debugUrl;
    await sleep(250);
  }
  return await resolveExistingAutomationDebugUrl(processInfo, portFile);
}

async function resolveExistingAutomationDebugUrl(processInfo, portFile) {
  if (processInfo.remoteDebuggingPort && processInfo.remoteDebuggingPort > 0) {
    const processDebugUrl = `http://127.0.0.1:${processInfo.remoteDebuggingPort}`;
    if (await canReachDebugUrl(processDebugUrl)) return processDebugUrl;
  }

  const portFileDebugUrl = readAutomationDebugUrl(portFile);
  if (portFileDebugUrl && await canReachDebugUrl(portFileDebugUrl)) return portFileDebugUrl;

  return null;
}

async function acquireStartLock({ sourceProfile, startLockFile }, timeoutMs = START_LOCK_TIMEOUT) {
  mkdirSync(dirname(startLockFile), { recursive: true });

  const owner = {
    pid: process.pid,
    profile: sourceProfile,
    createdAt: new Date().toISOString(),
    token: `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
  };
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      writeFileSync(startLockFile, JSON.stringify(owner, null, 2), { flag: 'wx' });
      return () => releaseStartLock(owner.token, startLockFile);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (isStartLockStale(startLockFile)) {
        try { rmSync(startLockFile, { force: true }); } catch {}
        continue;
      }
      await sleep(200);
    }
  }

  throw new Error(`Timed out waiting for cdp start lock: ${startLockFile}`);
}

function releaseStartLock(token, startLockFile) {
  try {
    const lock = readStartLock(startLockFile);
    if (!lock || lock.token === token) rmSync(startLockFile, { force: true });
  } catch {}
}

function readStartLock(startLockFile) {
  if (!existsSync(startLockFile)) return null;
  try {
    return JSON.parse(readFileSync(startLockFile, 'utf8'));
  } catch {
    return null;
  }
}

function isStartLockStale(startLockFile) {
  const lock = readStartLock(startLockFile);
  if (lock?.pid && !isProcessAlive(lock.pid)) return true;
  try {
    return (Date.now() - statSync(startLockFile).mtimeMs) > START_LOCK_STALE_MS;
  } catch {
    return false;
  }
}

function formatProcessList(processes) {
  return processes.map(proc => {
    const port = proc.remoteDebuggingPort != null ? `:${proc.remoteDebuggingPort}` : '';
    return `${proc.pid}${port} [${normalizeProfileName(proc.profileDirectory)}]`;
  }).join(', ');
}

function startWatcherIfPresent(sourceProfile) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const watcherPath = join(scriptDir, '..', 'watch.js');
  if (existsSync(watcherPath)) {
    spawn(process.execPath, [watcherPath], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, CDP_PROFILE: sourceProfile },
    }).unref();
  }
}

function resolveChromeBinary() {
  if (process.env.BROWSER_BIN && existsSync(process.env.BROWSER_BIN)) {
    return process.env.BROWSER_BIN;
  }
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  ];
  return candidates.find(path => existsSync(path)) || null;
}
