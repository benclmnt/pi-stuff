/**
 * net-summary — summarize network responses from background logs.
 *
 * Ported from web-browser's scripts/net-summary.js.
 */

import { readFileSync } from 'node:fs';
import { normalizeProfileName } from '../lib/cdp.mjs';
import { findLatestLogFile } from '../lib/log-files.mjs';

export async function run({ filePath, profile }) {
  const profileName = normalizeProfileName(profile);
  const fp = filePath || findLatestLogFile(profileName);

  if (!fp) {
    console.error(`✗ No log file found for profile ${profileName}`);
    process.exit(1);
  }

  const statusCounts = new Map();
  const failures = [];
  let totalResponses = 0;
  let totalRequests = 0;

  const data = readFileSync(fp, 'utf8');
  const lines = data.split('\n').filter(Boolean);

  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }

    if (entry.type === 'network.request') {
      totalRequests += 1;
    } else if (entry.type === 'network.response') {
      totalResponses += 1;
      const status = String(entry.status ?? 'unknown');
      statusCounts.set(status, (statusCounts.get(status) || 0) + 1);
    } else if (entry.type === 'network.failure') {
      failures.push({ requestId: entry.requestId, errorText: entry.errorText });
    }
  }

  console.log(`profile: ${profileName}`);
  console.log(`file: ${fp}`);
  console.log(`requests: ${totalRequests}`);
  console.log(`responses: ${totalResponses}`);

  const statuses = Array.from(statusCounts.entries()).sort((a, b) => Number(a[0]) - Number(b[0]));
  for (const [status, count] of statuses) {
    console.log(`  status ${status}: ${count}`);
  }

  if (failures.length > 0) {
    console.log('failures:');
    for (const failure of failures.slice(0, 10)) {
      console.log(`  - ${failure.errorText || 'unknown'} (${failure.requestId})`);
    }
    if (failures.length > 10) {
      console.log(`  - ... ${failures.length - 10} more`);
    }
  }
}

