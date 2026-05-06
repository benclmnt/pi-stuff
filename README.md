# pi-stuff 🧩

A collection of custom extensions, prompts, and configurations for [pi.dev](https://github.com/mariozechner/pi-coding-agent), an AI coding agent framework.

Built to extend pi with better editing workflows, desktop notifications, usage tracking, model provider integrations, and specialised prompt templates.

---

## Extensions

| Extension | Description |
|---|---|
| **[multi-edit](./extensions/multi-edit.ts)** | Replace the built-in `edit` tool with batch multi-edit support (via `multi` array) and Codex-style `patch` payloads. Includes a preflight pass that validates all edits before touching files. |
| **[notify](./extensions/notify.ts)** | Sends a native desktop notification when the agent finishes processing and is waiting for input. Uses OSC 777 escape sequences — supports Ghostty, iTerm2, WezTerm, and rxvt-unicode. |
| **[parallel-web-search](./extensions/parallel-web-search.ts)** | Adds a `web_search` tool backed by [Parallel's Search API](https://parallel.ai) for LLM-optimised web search with multiple queries and an objective context. |
| **[usage-bar](./extensions/usage-bar.ts)** | Displays AI provider usage stats with progress bars, provider status, and reset countdowns — similar to CodexBar. Run `/usage` to invoke. |
| **[split-fork](./extensions/split-fork.ts)** | Opens a new Ghostty window or split pane for the agent — useful for side-by-side contexts. Supports macOS Ghostty via AppleScript. |
| **[user-keys-env](./extensions/user-keys-env.ts)** | Reads `~/.pi/agent/user-keys.json` and injects API keys into `process.env` so they're available to other extensions without modifying the shell environment. |


## Prompts

| Prompt | File | Description |
|---|---|---|
| **Oracle** | [`prompts/oracle.md`](./prompts/oracle.md) | Expert AI advisor with advanced reasoning — provides technical guidance, architecture advice, and strategic planning. Invoked when the main agent needs a smarter model. |
| **Grill Me** | [`prompts/grill-me.md`](./prompts/grill-me.md) | Stress-tests a plan or design by interviewing the user relentlessly, walking down each branch of the decision tree. |
| **Review** | [`prompts/review.md`](./prompts/review.md) | Default code review mindset: prioritises bugs, risks, regressions, and missing tests with severity-ordered findings. |

## Model Providers

Configured in [`models.json`](./models.json):

## Configuration

- **`user-keys.sample.json`** — Template for `user-keys.json`.

## Getting Started

```bash
# Install dependencies
npm install

# Set up API keys (see user-keys.sample.json)
cp user-keys.sample.json user-keys.json
# Edit user-keys.json with your keys

# Load in pi via your pi config
```

## License

MIT

## Attribution

Some of these extensions are copied/heavily inspired by 
- [agent-stuff](https://github.com/mitsuhiko/agent-stuff)
- [Amp](https://ampcode.com)
