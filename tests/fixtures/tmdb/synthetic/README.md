# Synthetic TMDB fixtures

Hand-written responses for what the captures do not cover. They are not
real captures; the owner's re-capture never overwrites them.

- `movie_<id>__language=en-US.json`: English overview fallback for the captured releases
  whose Spanish overview is empty (1788146 has an empty English overview too).
- `case_*.json`: edge cases used explicitly by tests through routes (ES providers with
  flatrate, ads, free, rent and buy; a 429 body; a discover page with
  `total_pages` above `MAX_PAGES`).

`tests/support/fixture-fetch.js` resolves a request against this folder and the captured
folder (`tests/fixtures/tmdb/`) and refuses name collisions between both.

The ES release dates of the four digital releases lived here until the 2026-10-24
re-capture brought the real ones (same type-4 dates and notes).
