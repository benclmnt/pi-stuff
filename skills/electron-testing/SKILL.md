---
name: electron-testing
description: Launch, inspect, and test Electron apps via Chrome DevTools Protocol. No daemon, no browser "Allow debugging" modal. Each command connects fresh, making it reliable for CI and testing scripts.
---

# Electron Testing

Lightweight CDP CLI for Electron apps. Opens a fresh WebSocket per command — no long-running daemon, no state files. Stateless: every command reads `ELECTRON_TEST_PORT` from the environment, so there's never any ambiguity about which instance you're talking to.

The CLI script is executable, so you can call it directly without `node`.

## Prerequisites

- Node.js 22+ (uses built-in WebSocket and fetch)
- An Electron app with a local Electron install (via `npm install`)
- `ELECTRON_TEST_PORT` set in your environment

## Setup

```bash
export ELECTRON_TEST_PORT=9223
ET=~/.pi/agent/skills/electron-testing/scripts/electron-test.mjs
```

Or set the port inline per command:

```bash
ELECTRON_TEST_PORT=9223 ~/.pi/agent/skills/electron-testing/scripts/electron-test.mjs launch /path/to/my-electron-app
```

## Usage

```bash
$ET <command> [args...] [flags]
```

## Commands

The CLI lives outside your app repo. Use its full path, or assign it to `ET` as above.

### Lifecycle

```bash
# Launch Electron with remote debugging
$ET launch [appPath]

# Gracefully shut down Electron via CDP
$ET close

# List page targets
$ET list
```

`launch` starts Electron and waits up to 15s for the debugger to become available. Prints the PID on success.

`close` connects to the debugger and sends `Browser.close` — clean shutdown without needing a PID. Works regardless of how Electron was launched.

### Inspect

```bash
$ET eval       <target> <expression>   # Evaluate JS (returns stringified result)
$ET html       <target> [selector]     # Page HTML (default: body). CSS selector for element.
$ET snaplabels <target>                # All ARIA labels on the page
$ET shot       <target> [file]         # Viewport screenshot (default: screenshot-<prefix>.png)
```

### Interact

```bash
$ET click      <target> <selector>     # Click by CSS selector (scrolls into view first)
$ET clicktext  <target> <text>         # Click button/element by text content
$ET keypress   <target> <key>          # Press a key (see below)
$ET type       <target> <text>         # Type at current focus (Input.insertText)
```

### Assert

```bash
$ET waitfor <target> <expression> [--timeout <ms>]
```

Polls the expression every 100ms until it returns a truthy value. Default timeout: 10s.

## Target

The `<target>` is a unique prefix of a page target ID from `list`. Copy the prefix shown in `list` output (e.g. `5F847534`). The CLI rejects ambiguous prefixes.

Use `-` as shorthand for "the only available page". If multiple page targets are open, the CLI fails and asks you to use an explicit prefix.

```bash
$ET click - .my-button
```

## Flags

| Flag | Applies to | Description |
|------|-----------|-------------|
| `--timeout <ms>` | `waitfor` | Max wait in milliseconds (default: 10000) |

## Key names

`keypress` accepts these values:

| Input | Key sent |
|-------|----------|
| `x`, `g`, `Enter`, `Escape`, `Tab` | As-is |
| `ArrowLeft`, `ArrowRight`, `ArrowUp`, `ArrowDown` | Arrow keys |
| `Backspace`, `Delete`, `Home`, `End`, `PageUp`, `PageDown` | Navigation keys |
| `Space` | Spacebar |
| `F1`–`F12` | Function keys |
| `Shift+Tab`, `Ctrl+C`, `Cmd+Z` | Modifier combos |
| `1`–`9`, `0` | Digit keys |

For letter keys, use the lowercase letter (`x`, `g`, etc.). For special keys, use the exact name (`Enter`, `Escape`, etc.).

## Environment

| Variable | Description |
|----------|-------------|
| `ELECTRON_TEST_PORT` | **Required.** The CDP port Electron is listening on (e.g. `9223`) |

## Quoting pitfall: CSS selectors with attribute values containing spaces

When using `eval` or `waitfor` with `document.querySelector`, attribute values with spaces (like `[aria-label="Review mode"]`) create a triple quoting problem. Use this pattern:

```bash
# ✅ Safe: single quotes for JS, escaped double quotes for CSS
$ET eval <target> "document.querySelector('section[aria-label=\"Review mode\"]') !== null"

# ✅ Simpler: avoid attribute-value selectors entirely
$ET eval <target> "[...document.querySelectorAll('section')].map(s=>s.getAttribute('aria-label'))"
```

## Examples

```bash
# Set the port once and create a shortcut for the CLI
export ELECTRON_TEST_PORT=9223
ET=~/.pi/agent/skills/electron-testing/scripts/electron-test.mjs

# Navigate to the project root and launch
cd /path/to/my-electron-app
$ET launch .
# → Launched Electron (pid 1234) on port 9223

# List pages
$ET list
# → 5F847534  My App  http://localhost:5173/

# Click a button, wait for a section to appear, take a screenshot
$ET click 5F847534 .start-button
$ET waitfor 5F847534 "document.querySelector('section[aria-label=\"Review mode\"]') !== null"
$ET shot 5F847534 /tmp/review.png

# Or use - when only one page target is open
$ET click - .next-button

# Shut down
$ET close

# Or inline per command
ELECTRON_TEST_PORT=9224 ~/.pi/agent/skills/electron-testing/scripts/electron-test.mjs list
```