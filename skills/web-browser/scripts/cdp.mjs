#!/usr/bin/env node
/**
 * cdp — Chrome DevTools Protocol CLI.
 *
 * Browser automation, inspection, and interaction via a persistent daemon
 * model and a consistent tab-targeting interface.
 *
 * Usage: cdp [--profile <name>] <command> [target] [args...]
 *
 * See `cdp help` for full command list.
 */

import { getOrStartDaemon, sendCommand, stopDaemons, runDaemon } from './lib/daemon.mjs';
import { resolveTarget, listPages } from './lib/resolve-target.mjs';
import { connect, normalizeProfileName } from './lib/cdp.mjs';

// ─── Command dispatch map ───────────────────────────────────────────────────

const COMMANDS = {
  // Convenience (escaping/formatting makes evalraw painful)
  click:        cmd('click'),
  clickxy:      cmd('clickxy'),
  shot:         cmd('shot'),
  type:         cmd('type'),
  keypress:     cmd('keypress'),
  html:         cmd('html'),
  net:          cmd('net'),

  // Multi-step orchestration
  nav:          cmd('nav'),
  loadall:      cmd('loadall'),
  wait:         cmd('wait'),
  pick:         cmd('pick'),
  cookies:      cmd('cookies'),
  batch:        cmd('batch'),
  snap:         cmd('snap'),

  // Discovery & lifecycle
  list:         cmdList,
  open:         cmdOpen,
  start:        cmdStart,
  stop:         cmdStop,

  // Observability
  log:          cmdLog,
  'net-summary': cmdNetSummary,

  // Escape hatch
  evalraw:      cmdEvalraw,
};

function cmd(name) {
  return async (args, ctx = {}) => {
    const { target, rawArgs } = splitTargetAndArgs(args);
    const targetId = await resolveTarget(target, { profile: ctx.profile });
    const conn = await getOrStartDaemon(targetId, { profile: ctx.profile });
    const cmdArgs = parseCmdArgs(name, rawArgs);
    const res = await sendCommand(conn, { cmd: name, args: cmdArgs });
    if (!res.ok) throw new Error(res.error);
    return res.result;
  };
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const parsed = extractProfileArg(process.argv.slice(2));
  const profile = parsed.profile;
  const [cmd, ...args] = parsed.args;

  process.env.CDP_PROFILE = profile;

  if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    showHelp();
    return;
  }

  // Daemon mode (internal — spawned by getOrStartDaemon)
  if (cmd === '_daemon') {
    await runDaemon(args[0], { profile });
    return;
  }

  const handler = COMMANDS[cmd];
  if (!handler) {
    console.error(`Unknown command: ${cmd}`);
    console.log('Run "cdp help" for usage.');
    process.exit(1);
  }

  try {
    const result = await handler(args, { profile });
    if (result) console.log(result);
  } catch (e) {
    console.error('✗', e.message);
    process.exit(1);
  }
}

// ─── Inline command handlers ────────────────────────────────────────────────

async function cmdList(args, ctx = {}) {
  console.log(await listPages({ profile: ctx.profile }));
}

async function cmdOpen(args, ctx = {}) {
  const url = args[0] || 'about:blank';
  const cdp = await connect({ timeout: 5000, profile: ctx.profile });
  try {
    const { targetId } = await cdp.send('Target.createTarget', { url });
    console.log(`Opened new tab: ${targetId.slice(0, 8)}  ${url}`);
    console.log('Note: first command on this tab will need "Allow debugging?" approval.');
  } finally {
    cdp.close();
  }
}

async function cmdStart(args, ctx = {}) {
  // Delegate to the start module
  const start = await import('./cmds/start.mjs');
  await start.run({ args, profile: ctx.profile });
}

async function cmdStop(args, ctx = {}) {
  const targetPrefix = args[0] || null;
  if (!targetPrefix) {
    const stopBrowser = await import('./cmds/stop-browser.mjs');
    await stopBrowser.run({ args, profile: ctx.profile });
    return;
  }

  const stopped = await stopDaemons(targetPrefix, { profile: ctx.profile });
  if (stopped === 0) {
    console.log(targetPrefix ? `No daemon found for ${targetPrefix}` : 'No daemons running');
    return;
  }
  console.log(targetPrefix ? `Stopped daemon for ${targetPrefix}` : `Stopped ${stopped} daemon(s)`);
}

async function cmdLog(args, ctx = {}) {
  const follow = args.includes('--follow');
  const fileIdx = args.indexOf('--file');
  const filePath = fileIdx !== -1 ? args[fileIdx + 1] : null;

  const logModule = await import('./cmds/log.mjs');
  await logModule.run({ follow, filePath, profile: ctx.profile });
}

async function cmdNetSummary(args, ctx = {}) {
  const fileIdx = args.indexOf('--file');
  const filePath = fileIdx !== -1 ? args[fileIdx + 1] : null;

  const netModule = await import('./cmds/net-summary.mjs');
  await netModule.run({ filePath, profile: ctx.profile });
}

async function cmdEvalraw(args, ctx = {}) {
  const browserFlagIdx = args.indexOf('--browser');
  const listFlag = args.includes('--list');
  const target = args[0];

  if (listFlag) {
    const cdp = await connect({ timeout: 5000, profile: ctx.profile });
    try {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const pages = targetInfos.filter(t => t.type === 'page');
      pages.forEach((p, i) => {
        console.log(`${i + 1}. ${p.title || '(no title)'}`);
        console.log(`   ${p.url}`);
      });
    } finally { cdp.close(); }
    return;
  }

  if (browserFlagIdx !== -1) {
    // Browser-level command (e.g., Target.getTargets)
    const method = args[browserFlagIdx + 1];
    const params = args[browserFlagIdx + 2] ? JSON.parse(args[browserFlagIdx + 2]) : {};
    if (!method) throw new Error('CDP method required');
    const cdp = await connect({ timeout: 5000, profile: ctx.profile });
    try {
      const result = await cdp.send(method, params);
      console.log(JSON.stringify(result, null, 2));
    } finally { cdp.close(); }
    return;
  }

  // Page-level evalraw — needs daemon
  if (!target) throw new Error('Target required. Usage: cdp evalraw <target> <method> [jsonParams]');
  const targetId = await resolveTarget(target, { profile: ctx.profile });
  const conn = await getOrStartDaemon(targetId, { profile: ctx.profile });

  const method = args[1];
  if (!method) throw new Error('CDP method required');
  const params = args[2] ? JSON.parse(args[2]) : {};

  const res = await sendCommand(conn, { cmd: 'evalraw', args: [method, params] });
  if (!res.ok) throw new Error(res.error);
  console.log(res.result);
}

// ─── Arg parsing ────────────────────────────────────────────────────────────

function parseCmdArgs(cmd, raw) {
  switch (cmd) {
    case 'type':
      // Join all remaining args as a single expression/text
      return [raw.join(' ')];
    case 'keypress':
      return [raw[0]];
    case 'batch':
      return raw; // array of expressions
    case 'cookies':
      return [{ reject: raw.includes('--reject') }];
    case 'wait': {
      let selector = null, expr = null, timeout = 15000;
      for (let i = 0; i < raw.length; i++) {
        const a = raw[i];
        if (a === '--expr') { expr = raw[++i]; }
        else if (!isNaN(Number(a)) && (selector || expr)) { timeout = Number(a); }
        else if (!selector && !expr) { selector = a; }
      }
      return [{ selector, expr, timeout }];
    }
    case 'shot':
      return [raw[0]]; // optional file path
    case 'loadall':
      return [raw[0], raw[1]]; // selector, optional interval
    default:
      return raw;
  }
}

function splitTargetAndArgs(args) {
  if (args.length === 0) return { target: null, rawArgs: [] };
  if (args[0] === '--') return { target: null, rawArgs: args.slice(1) };
  if (args[0].startsWith('--')) return { target: null, rawArgs: args };
  return { target: args[0], rawArgs: args.slice(1) };
}

function extractProfileArg(argv) {
  const args = [];
  let profile = process.env.CDP_PROFILE || 'Default';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--profile=')) {
      profile = arg.slice('--profile='.length) || 'Default';
      continue;
    }
    if (arg === '--profile') {
      const value = argv[i + 1];
      profile = !value || value.startsWith('--') ? 'Default' : value;
      if (value && !value.startsWith('--')) i++;
      continue;
    }
    args.push(arg);
  }

  return { args, profile: normalizeProfileName(profile) };
}

// ─── Help ───────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`
cdp — Chrome DevTools Protocol CLI

USAGE
  cdp [--profile <name>] <command> [target] [args...]

  <target> is a keyword (title/URL match) or target ID prefix.
  Omit target to use the frontmost tab. If the next arg starts with --,
  or would otherwise be ambiguous, write an explicit separator: cdp click -- '.btn'
  Omit --profile to use the isolated automation profile "Default".

COMMANDS

  Convenience (escaping/formatting makes evalraw painful)
    click    <target> <sel>        Click element by CSS selector
    clickxy  <target> <x> <y>      Click at CSS pixel coordinates
    shot     <target> [file]       Screenshot (saves PNG, shows DPR mapping)
    type     <target> <text>       Type text via Input.insertText (handles escaping)
    keypress <target> <combo>      Press key(s): Enter, Ctrl+Shift+A, Escape, etc.
    html     <target> [sel]        Get element or full page HTML
    net      <target>              Network resource timing entries

  Navigation & polling
    nav      <target> <url>        Navigate and wait for load
    wait     <target> <sel>        Wait for CSS selector to appear (polls DOM)
    wait     <target> --expr <js>  Wait for JS expression to be truthy

  Interaction
    pick     <target>              Interactive element picker (click to select)
    loadall  <target> <sel>        Click "load more" repeatedly until gone

  Automation helpers
    cookies  <target>              Dismiss cookie consent dialogs (auto)
    cookies  <target> --reject     Reject cookies where possible
    batch    <target> <expr>...    Evaluate multiple JS expressions in one daemon session

  Accessibility
    snap     <target>              Print accessibility tree

  Chrome lifecycle & discovery
    list                           List open pages with unique target prefixes
    open     [url]                  Open new tab (default: about:blank)
    start    [--profile <name>]     Launch isolated Chrome automation session
    stop     [target]               Stop one daemon, or the whole automation session when target is omitted

  Observability
    log                            Dump latest background log
    log      --follow              Tail live
    net-summary                    Summarize network responses from logs

  Raw CDP (escape hatch — use when nothing else fits)
    evalraw  <target> <method> [jsonParams]
    evalraw  --browser <method> [jsonParams]
    evalraw  --list                List all tabs

EXAMPLES
  cdp list
  cdp --profile 'Profile 2' list
  cdp open https://example.com
  cdp start
  cdp start --profile 'Profile 2'
  cdp nav maps https://google.com/maps
  cdp wait maps '.section-loaded'
  cdp batch maps 'document.title' 'document.URL'
  cdp cookies maps
  cdp click maps 'button[data-testid="save"]'
  cdp click -- 'button[data-testid="save"]'
  cdp shot maps
  cdp keypress maps 'Ctrl+Enter'
  cdp pick maps
  cdp snap maps
  cdp evalraw maps Page.captureScreenshot '{"format":"png"}'
  cdp log --follow
`);
}

main().catch(e => { console.error('✗', e.message); process.exit(1); });
