import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getAutomationLogDir } from './cdp.mjs';

export function findLatestLogFile(profile) {
  const logRoot = getAutomationLogDir(profile);
  if (!existsSync(logRoot)) return null;

  const dirs = readdirSync(logRoot)
    .filter(name => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .map(name => join(logRoot, name))
    .filter(path => statSync(path)?.isDirectory())
    .sort();

  if (dirs.length === 0) return null;

  const latestDir = dirs[dirs.length - 1];
  const files = readdirSync(latestDir)
    .filter(name => name.endsWith('.jsonl'))
    .map(name => join(latestDir, name))
    .map(path => ({ path, mtime: statSync(path)?.mtimeMs || 0 }))
    .sort((a, b) => b.mtime - a.mtime);

  return files[0]?.path || null;
}
