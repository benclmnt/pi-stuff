/**
 * log — read/tail background log files.
 *
 * Ported from web-browser's scripts/logs-tail.js.
 */

import { existsSync, readFileSync, watch } from 'node:fs';
import { normalizeProfileName } from '../lib/cdp.mjs';
import { findLatestLogFile } from '../lib/log-files.mjs';

export async function run({ follow, filePath, profile }) {
  const profileName = normalizeProfileName(profile);
  const fp = filePath || findLatestLogFile(profileName);

  if (!fp) {
    console.error(`✗ No log file found for profile ${profileName}`);
    process.exit(1);
  }

  if (!existsSync(fp)) {
    console.error(`✗ Log file not found: ${fp}`);
    process.exit(1);
  }

  if (follow) {
    const data = readFileSync(fp, 'utf8');
    process.stdout.write(data);
    let offset = data.length;

    watch(fp, { persistent: true }, () => {
      const newData = readFileSync(fp, 'utf8');
      if (newData.length > offset) {
        process.stdout.write(newData.slice(offset));
        offset = newData.length;
      }
    });
  } else {
    const data = readFileSync(fp, 'utf8');
    process.stdout.write(data);
  }
}

