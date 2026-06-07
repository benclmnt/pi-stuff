---
name: web-browser
description: "Control Chrome/Chromium via CDP. Browse, scrape, interact, log — all through a single CLI. Zero dependencies."
---

# Web Browser Skill

Chrome DevTools Protocol CLI for browsing, scraping, interaction, and logging.

## Architecture

```
scripts/
├── cdp.mjs                 ← CLI entry point (./scripts/cdp.mjs)
├── package.json            ← zero dependencies (Node 22+ built-in WebSocket)
├── lib/
│   ├── automation-session.mjs ← shared browser process/session helpers
│   ├── cdp.mjs             ← CDP WebSocket client class + connect()
│   ├── daemon.mjs          ← per-tab persistent daemon (Unix socket IPC)
│   ├── log-files.mjs       ← shared log file discovery helpers
│   └── resolve-target.mjs  ← keyword + prefix page resolution
├── cmds/
│   ├── start.mjs           ← launch Chrome
│   ├── log.mjs             ← read/tail background logs
│   └── net-summary.mjs     ← summarize network responses
domain-skills/
└── <site>/                 ← site-specific scripts
```

**Daemon model.** Each tab gets a persistent Unix-socket daemon holding its CDP session. Chrome's "Allow debugging" modal fires once per daemon (= once per tab), then all subsequent commands are instant. Daemons auto-exit after 20 min idle.

**Isolated browser session.** `cdp start` launches a separate automation Chrome profile, so it does not attach to your main daily browser session. By default it copies your main Chrome user data and launches the isolated session with profile `Default`. Use `--profile <name>` to launch or reuse another copied profile. Each automation profile is isolated under `~/.cache/scraping/profiles/<profile-key>/` with its own browser data, `state.json`, `pid.lock`, and `logs/`.

**Target resolution.** Two strategies, tried in order:
1. **Keyword** — substring match on title/URL (`maps`, `whatsapp`)
2. **Prefix** — target ID prefix from `cdp list` (`6BE8`)
3. **Default** — frontmost tab. Use `--` when the next arg would be ambiguous (`./scripts/cdp.mjs click -- '.save'`).

## Quick Start

```bash
# Launch isolated Chrome automation session
./scripts/cdp.mjs start

# Use another copied Chrome profile
./scripts/cdp.mjs start --profile 'Profile 2'

# List open pages
./scripts/cdp.mjs list
./scripts/cdp.mjs --profile 'Profile 2' list

# Open a new tab
./scripts/cdp.mjs open https://example.com

# Navigate and interact
./scripts/cdp.mjs nav maps https://google.com/maps
./scripts/cdp.mjs wait maps '.section-loaded'
./scripts/cdp.mjs click maps 'button[data-testid="save"]'
./scripts/cdp.mjs shot maps

# Automation
./scripts/cdp.mjs cookies maps
./scripts/cdp.mjs batch maps 'document.title' 'document.URL'
./scripts/cdp.mjs pick maps

# Observability
./scripts/cdp.mjs log --follow

# Escape hatch — raw CDP passthrough
./scripts/cdp.mjs evalraw maps Page.captureScreenshot '{"format":"png"}'
./scripts/cdp.mjs evalraw --list
```

## Commands

### Convenience (escaping/formatting makes `evalraw` painful)

| Command | Description |
|---|---|
| `click <target> <sel>` | Click element by CSS selector. Avoids shell+JSON escaping hell. |
| `clickxy <target> <x> <y>` | Click at CSS pixel coordinates. Uses `Input.dispatchMouseEvent` (move+press+release). |
| `shot <target> [file]` | Screenshot (PNG). Saves to file, prints DPR and coordinate mapping hint. |
| `type <target> <text>` | Type text via `Input.insertText`. Handles quotes, newlines, special chars. Works in cross-origin iframes. |
| `keypress <target> <combo>` | Renderer-level key simulation. Supports `Enter`, `Ctrl+Shift+A`, `Escape`, `ArrowRight`, `F5`, etc. |
| `html <target> [sel]` | Get outerHTML of element or full page. |
| `net <target>` | Print `performance.getEntriesByType('resource')` as a table. |

### Navigation & polling

| Command | Description |
|---|---|
| `nav <target> <url>` | Navigate and wait for `Page.loadEventFired` + `readyState === 'complete'`. |
| `wait <target> <sel>` | Poll DOM every 200ms until CSS selector matches. No `sleep` guessing. |
| `wait <target> --expr <js>` | Poll until JS expression is truthy. |

### Interaction

| Command | Description |
|---|---|
| `pick <target>` | Interactive element picker. Hover to highlight, click to select, Cmd+click for multi-select, Enter to finish. |
| `loadall <target> <sel>` | Click "load more" button repeatedly until it disappears. Default 1500ms between clicks. |

### Automation helpers

| Command | Description |
|---|---|
| `cookies <target>` | Dismiss cookie consent dialogs (OneTrust, Cookiebot, Didomi, Google, Quantcast, Usercentrics, etc.). |
| `cookies <target> --reject` | Reject cookies where possible. |
| `batch <target> <expr>...` | Evaluate multiple JS expressions in one daemon session. JSON output. Much faster than N separate CLI calls. |

### Accessibility

| Command | Description |
|---|---|
| `snap <target>` | Recursive accessibility tree from `Accessibility.getFullAXTree`. Filters noise, formats cleanly. |

### Chrome lifecycle & discovery

| Command | Description |
|---|---|
| `list` | List open pages with shortest unique prefix. |
| `open [url]` | Open a new tab. Default: `about:blank`. |
| `start [--profile <name>]` | Launch isolated Chrome automation session. Copies your main Chrome user data into the isolated session; defaults to profile `Default`. |
| `stop [target]` | Stop one daemon by target, or stop the entire automation session when target is omitted. |

### Observability

| Command | Description |
|---|---|
| `log` | Dump latest background log (console, exceptions, network requests). |
| `log --follow` | Tail live. |
| `net-summary` | Summarize network responses from logs (status codes, failures). |

### Raw CDP (escape hatch)

| Command | Description |
|---|---|
| `evalraw <target> <method> [jsonParams]` | Send any CDP method on a page session. |
| `evalraw --browser <method> [jsonParams]` | Send on the browser session. |
| `evalraw --list` | List all tabs via `Target.getTargets`. |

Use `evalraw` when no dedicated command exists. If a pattern repeats, add a command.

## Domain Skills

| Site | Scripts | Purpose |
|---|---|---|
| `domain-skills/google-maps/` | `route.js`, `saved-lists.js`, `save-place.js`, `hotels.js`, `common.js` | Routes, saved lists, hotel search |
| `domain-skills/whatsapp/` | `messages.js`, `scroll.js` | Chat extraction, screenshots |
| `domain-skills/substack/` | `messages.js` | Chat thread extraction |

Domain skills import the CDP library directly (`../../scripts/lib/cdp.mjs`) and use it as a low-level driver — they manage their own eval, wait, and navigation logic. The CLI is not involved.

## Developing Domain Skills

```bash
# Domain skills import the library directly
import { connect } from '../../scripts/lib/cdp.mjs';

const cdp = await connect(5000);
const sessionId = await cdp.attachToPage(targetId);
const result = await cdp.evaluate(sessionId, 'document.title');
cdp.close();
```

Add a `--test` flag for iterative development:

```bash
./domain-skills/<site>/myscript.js --test "some input"
```

## Workspace & Conventions

| Path | Purpose |
|---|---|
| `domain-skills/<site>/` | Shared domain helpers (edit SKILL.md + add scripts there) |
| `scripts/` | Generic browser-harness primitives |
| `scripts/lib/` | Core library (CDP client, daemon, target resolution) |
| `scripts/cmds/` | CLI command implementations |

## Tips

- **Batch DOM queries.** Extract all needed data in ONE `batch` call. Each round-trip costs 300ms+.
- **Don't guess sleep durations.** Use `wait` to poll for a selector or condition.
- **Reuse CDP sessions.** The daemon holds the session open — no need for `--persist`/`--session` flags.
- **Prefer `snap` over `html`** for page structure understanding.
- **Use `type` (not `eval`)** to enter text in cross-origin iframes — `click` to focus first, then `type`.
- **Use `--` to force the default tab** — e.g. `./scripts/cdp.mjs click -- '.save-button'`.
- **`open` then `nav` then inspect** — avoid reading stale tabs that happen to match by title.
- **Daemons auto-exit after 20 min** of inactivity. Use `stop` to force-cleanup.
