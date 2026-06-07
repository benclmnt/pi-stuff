# Substack Chat Domain Skill

Site-specific helpers for Substack Chat. Use the generic `web-browser` skill for browser primitives and this script only for Substack chat/thread extraction.

## Scripts

```bash
./messages.js              # collect top-level chat threads
./messages.js -j           # output JSON
./messages.js -d           # drill down into thread replies
./messages.js -d -m 5      # drill into at most 5 threads
```
