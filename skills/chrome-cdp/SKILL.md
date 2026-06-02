---
name: chrome-cdp
description: Interact with local Chrome browser session (only on explicit user approval after being asked to inspect, debug, or interact with a page open in Chrome)
---

# Chrome CDP

Lightweight Chrome DevTools Protocol CLI. Connects directly via WebSocket — no Puppeteer, works with 100+ tabs, instant connection.

## Prerequisites

- Chrome (or Chromium, Brave, Edge, Vivaldi) with remote debugging enabled: open `chrome://inspect/#remote-debugging` and toggle the switch
- Node.js 22+ (uses built-in WebSocket)
- If your browser's `DevToolsActivePort` is in a non-standard location, set `CDP_PORT_FILE` to its full path

## Commands

All commands use `scripts/cdp.mjs`. The `<target>` is a **unique** targetId prefix from `list`; copy the full prefix shown in the `list` output (for example `6BE827FA`). The CLI rejects ambiguous prefixes.

### List open pages

```bash
scripts/cdp.mjs list
```

### Take a screenshot

```bash
scripts/cdp.mjs shot <target> [file]    # default: screenshot-<target>.png in runtime dir
```

Captures the **viewport only**. Scroll first with `eval` if you need content below the fold. Output includes the page's DPR and coordinate conversion hint (see **Coordinates** below).

### Accessibility tree snapshot

```bash
scripts/cdp.mjs snap <target>
```

### Evaluate JavaScript

```bash
scripts/cdp.mjs eval <target> <expr>
```

> **Watch out:** avoid index-based selection (`querySelectorAll(...)[i]`) across multiple `eval` calls when the DOM can change between them (e.g. after clicking Ignore, card indices shift). Collect all data in one `eval` or use stable selectors.

### Other commands

```bash
scripts/cdp.mjs html    <target> [selector]   # full page or element HTML
scripts/cdp.mjs nav     <target> <url>         # navigate and wait for load
scripts/cdp.mjs net     <target>               # resource timing entries
scripts/cdp.mjs click   <target> <selector>    # click element by CSS selector
scripts/cdp.mjs clickxy <target> <x> <y>       # click at CSS pixel coords
scripts/cdp.mjs type    <target> <text>         # Input.insertText at current focus; works in cross-origin iframes unlike eval
scripts/cdp.mjs loadall <target> <selector> [ms]  # click "load more" until gone (default 1500ms between clicks)
scripts/cdp.mjs evalraw <target> <method> [json]  # raw CDP command passthrough
scripts/cdp.mjs open    [url]                  # open new tab (each triggers Allow prompt)
scripts/cdp.mjs stop    [target]               # stop daemon(s)
```

### Simulate keyboard input

```bash
scripts/cdp.mjs keypress <target> <combo>
```

Fires `keydown`/`keyup` through the renderer — the only reliable way to trigger `window.addEventListener('keydown', …)` handlers in SPAs and Electron apps.

```bash
cdp keypress <target> x                  # single character
cdp keypress <target> 5                  # digit (rate 5★)
cdp keypress <target> Enter              # special key
cdp keypress <target> ArrowRight         # arrow navigation
cdp keypress <target> Ctrl+Enter         # modifier combo
cdp keypress <target> Shift+Tab          # shift combo
cdp keypress <target> Ctrl+Shift+A       # multi-modifier
cdp keypress <target> F5                 # function key
cdp keypress <target> Escape             # escape
cdp keypress <target> Backspace          # backspace
cdp keypress <target> Space              # spacebar
cdp keypress <target> "+"                # plus sign (quote in shell)
```

Supported modifiers: `Ctrl`, `Alt`, `Shift`, `Meta`/`Cmd`/`Command`. The `<combo>` is split on `+`; the last segment is the key, everything before it is a modifier.

> **Tip:** After sending keys, verify the effect with `eval` or `snap`.
>
> **Focus matters:** If the key handler checks `document.activeElement` or ignores events inside `<input>` elements, focus the target element first with `click` before dispatching the key press.
```

## Coordinates

`shot` saves an image at native resolution: image pixels = CSS pixels × DPR. CDP Input events (`clickxy` etc.) take **CSS pixels**.

```
CSS px = screenshot image px / DPR
```

`shot` prints the DPR for the current page. Typical Retina (DPR=2): divide screenshot coords by 2.

## Tips

- When using this skill to inspect a local app or verify a specific page, **do not assume an existing tab is on the right URL**.
- Prefer this sequence:
  1. `open [url]` to create a fresh browser tab/session for the target page.
  2. If needed, `nav <target> <url>` to ensure the tab is at the exact URL you want.
  3. Only then run `snap`, `html`, `eval`, `click`, or screenshots.
- In other words: **open or navigate first, then inspect**. This avoids reading stale prod tabs, old QA pages, or unrelated pages that happen to match by title.
- If the task is to verify a change on localhost, explicitly open the localhost URL first instead of inspecting an already-open production tab.

- Prefer `snap --compact` over `html` for page structure.
- Use `type` (not eval) to enter text in cross-origin iframes — `click`/`clickxy` to focus first, then `type`.
- Chrome shows an "Allow debugging" modal once per tab on first access. A background daemon keeps the session alive so subsequent commands need no further approval. Daemons auto-exit after 20 minutes of inactivity.
