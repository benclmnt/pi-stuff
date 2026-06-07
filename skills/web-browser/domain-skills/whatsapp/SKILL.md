# WhatsApp Web Domain Skill

Site-specific helpers for WhatsApp Web. Use the generic `web-browser` skill for browser primitives and these scripts only for WhatsApp-specific message extraction or chat screenshots.

## Scripts

```bash
./messages.js              # list chats
./messages.js <keyword>    # extract messages from matching chat
./messages.js <keyword> -a # scroll up to load more history
./messages.js <keyword> -j # output JSON

./scroll.js [chat-keyword] --all
```
