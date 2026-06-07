import { execSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeProfileName } from './cdp.mjs';

export function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function readChromeArg(command, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const pattern of [
    new RegExp(`${escaped}="([^"]+)"`),
    new RegExp(`${escaped}=([^\\s]+)`),
    new RegExp(`${escaped}\\s+"([^"]+)"`),
    new RegExp(`${escaped}\\s+([^\\s]+)`),
  ]) {
    const match = command.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export function listAutomationBrowserProcesses(automationDir, options = {}) {
  const { includeProfileDirectory = false, includeRemoteDebuggingPort = false } = options;
  if (process.platform === 'win32') return [];

  try {
    const output = execSync('ps axww -o pid=,command=', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });

    return output
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        if (!match) return null;
        const [, pidText, command] = match;
        if (/\s--type=/.test(command)) return null;
        const userDataDir = readChromeArg(command, '--user-data-dir');
        if (userDataDir !== automationDir) return null;

        const processInfo = {
          pid: Number(pidText),
          command,
        };

        if (includeProfileDirectory) {
          processInfo.profileDirectory = normalizeProfileName(readChromeArg(command, '--profile-directory'));
        }

        if (includeRemoteDebuggingPort) {
          const portText = readChromeArg(command, '--remote-debugging-port');
          processInfo.remoteDebuggingPort = portText ? Number(portText) : null;
        }

        return processInfo;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function writeTimestampedJson(path, data) {
  try {
    writeFileSync(path, JSON.stringify({
      ...data,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

export function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function readNumericFile(path) {
  if (!existsSync(path)) return null;
  try {
    const value = Number(String(readFileSync(path, 'utf8')).trim());
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function getChromeRuntimeArtifactPaths(automationDir) {
  return [
    join(automationDir, 'DevToolsActivePort'),
    join(automationDir, 'DevToolsActivePort.lock'),
    join(automationDir, 'Default', 'DevToolsActivePort'),
    join(automationDir, 'Default', 'DevToolsActivePort.lock'),
    join(automationDir, 'SingletonCookie'),
    join(automationDir, 'SingletonLock'),
    join(automationDir, 'SingletonSocket'),
  ];
}

export function removePaths(paths) {
  for (const path of paths) {
    try { rmSync(path, { force: true }); } catch {}
  }
}

export function removeChromeRuntimeArtifacts(automationDir, extraPaths = []) {
  removePaths([...getChromeRuntimeArtifactPaths(automationDir), ...extraPaths]);
}
