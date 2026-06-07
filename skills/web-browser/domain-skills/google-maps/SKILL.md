# Google Maps Domain Skill

Google Maps helpers built on top of the `web-browser` CDP skill.

Defaults:
- reuses an existing Google Maps tab when possible
- only opens a new tab if none exists, or if you pass `--new-tab`
- runs silently in the background by default
- uses slower, human-ish pacing between actions
- review extraction reuses the current Maps tab unless you explicitly pass `--new-tab`

## Scripts

```bash
./route.js "<origin>" "<destination>" [--mode car|transit|walk]
./route.js --from "<origin>" --to "<destination>" --mode transit
./route.js "A" "B" -j

./saved-lists.js list
./saved-lists.js show "Saved places"
./saved-lists.js show "Japan" -j

./save-place.js "Singapore Flyer" --list "Want to go"
./save-place.js "Starbucks Singapore" --list "food?" -j

./hotels.js "Shinjuku Tokyo"
./hotels.js "Tokyo" --check-in 2026-06-15 --check-out 2026-06-18 --guests 2 --min-rating 4 --max-price 250
./hotels.js "Shinjuku Tokyo" --sort price -j

./reviews.js "Singapore Flyer"
./reviews.js --place-url "https://www.google.com/maps/place/..."
./reviews.js "best ramen shinjuku" --sort newest
./reviews.js "Gardens by the Bay" --out gardens.md
./reviews.js "Tokyo Skytree" -j
```

## Notes

- `route.js` returns the primary Google Maps route summary for car, transit, or walking.
- `saved-lists.js list` lists all saved lists.
- `saved-lists.js show <name>` opens a saved list and reads its places.
- `save-place.js` searches for a place, picks the best visible Google Maps match, and saves it into the target list.
- If the target list does not exist, `save-place.js` creates it automatically.
- `hotels.js` searches Google Maps hotels for an area and can constrain by stay dates, guests, minimum rating, price range, and output sort.
- `reviews.js` should prefer `--place-url` when the exact Google Maps place URL is already known.
- If `reviews.js` is given only a query and Google Maps shows multiple place candidates, it returns the candidate list with Google Maps URLs instead of auto-picking one.
- Once a place is resolved, `reviews.js` scrapes a mixed review sample (most relevant + newest + low-rated + high-rated), preserves approximate month/season context from relative review timestamps, includes raw Google review topics, and outputs the sampled reviews in Markdown or JSON.
