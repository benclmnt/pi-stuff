/**
 * Internal helper used by `cdp stop` with no target.
 * Stops the isolated Chrome automation session for one profile.
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { stopDaemons } from '../lib/daemon.mjs';
import {
  connect,
  getAutomationLockFile,
  getAutomationProfileDir,
  getAutomationStateFile,
  normalizeProfileName,
} from '../lib/cdp.mjs';
import {
  isProcessAlive,
  listAutomationBrowserProcesses,
  readJsonFile,
  readNumericFile,
  removeChromeRuntimeArtifacts,
  sleep,
  unique,
  writeTimestampedJson,
} from '../lib/automation-session.mjs';

export async function run({ profile }) {
  const profileName = normalizeProfileName(profile);
  const automationDir = getAutomationProfileDir(profileName);
  const stateFile = getAutomationStateFile(profileName);
  const pidLockFile = getAutomationLockFile(profileName);
  const watchPidFile = join(automationDir, 'watch.pid');
  const startLockFile = join(automationDir, '.start.lock');
  const browserProcesses = listAutomationBrowserProcesses(automationDir);
  const browserPids = unique([
    ...browserProcesses.map(proc => proc.pid),
    readJsonFile(pidLockFile)?.pid,
  ].filter(pid => Number.isInteger(pid) && pid > 0));

  const stoppedDaemons = await stopDaemons(null, { profile: profileName }).catch(() => 0);
  const stoppedWatcher = stopProcessFromPidFile(watchPidFile);
  const attemptedBrowserClose = await closeBrowserViaCdp(profileName);

  if (browserPids.length > 0) {
    await waitForExit(browserPids, 2000);
    terminatePids(browserPids);
    await waitForExit(browserPids, 3000);
    forceKillPids(browserPids.filter(isProcessAlive));
    await waitForExit(browserPids, 1000);
  }

  const remainingBrowserPids = unique([
    ...browserPids.filter(isProcessAlive),
    ...listAutomationBrowserProcesses(automationDir).map(proc => proc.pid),
  ]);

  cleanupAutomationArtifacts({ automationDir, pidLockFile, watchPidFile, startLockFile });

  const hadAnythingToStop = browserPids.length > 0 || stoppedDaemons > 0 || stoppedWatcher || attemptedBrowserClose;
  const status = remainingBrowserPids.length === 0 ? 'stopped' : 'error';
  if (existsSync(automationDir) || hadAnythingToStop || existsSync(stateFile)) {
    mkdirSync(automationDir, { recursive: true });
    writeTimestampedJson(stateFile, {
      profile: profileName,
      userDataDir: automationDir,
      browserPid: null,
      debugUrl: null,
      status,
      stoppedAt: new Date().toISOString(),
      remainingBrowserPids,
    });
  }

  if (remainingBrowserPids.length > 0) {
    throw new Error(`Failed to stop browser PID(s): ${remainingBrowserPids.join(', ')}`);
  }

  if (!hadAnythingToStop) {
    console.log(`No isolated Chrome automation session running for profile ${profileName}`);
    return;
  }

  const parts = [`Stopped isolated Chrome automation session for profile ${profileName}`];
  if (browserPids.length) parts.push(`browser PID(s): ${browserPids.join(', ')}`);
  if (stoppedDaemons) parts.push(`daemons: ${stoppedDaemons}`);
  if (stoppedWatcher) parts.push('watcher: stopped');
  console.log(parts.join('\n'));
}

async function closeBrowserViaCdp(profile) {
  try {
    const cdp = await connect({ timeout: 1500, profile });
    try {
      await cdp.send('Browser.close').catch(() => {});
      return true;
    } finally {
      try { cdp.close(); } catch {}
    }
  } catch {
    return false;
  }
}

function cleanupAutomationArtifacts({ automationDir, pidLockFile, watchPidFile, startLockFile }) {
  removeChromeRuntimeArtifacts(automationDir, [pidLockFile, watchPidFile, startLockFile]);
}

function stopProcessFromPidFile(pidFile) {
  const pid = readJsonFile(pidFile)?.pid ?? readNumericFile(pidFile);
  if (!pid || !isProcessAlive(pid)) {
    try { rmSync(pidFile, { force: true }); } catch {}
    return false;
  }

  try { process.kill(pid, 'SIGTERM'); } catch {}
  return true;
}

function terminatePids(pids) {
  for (const pid of unique(pids)) {
    if (!isProcessAlive(pid)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
}

function forceKillPids(pids) {
  for (const pid of unique(pids)) {
    if (!isProcessAlive(pid)) continue;
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
}

async function waitForExit(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pids.every(pid => !isProcessAlive(pid))) return true;
    await sleep(100);
  }
  return pids.every(pid => !isProcessAlive(pid));
}

