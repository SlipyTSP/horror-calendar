# Synthetic TMDB fixtures

Hand-written responses for what the 2026-10-23 capture does not cover. They are not
real captures; the owner's re-capture never overwrites them.

- `movie_<id>_release_dates.json`: values observed on 2026-10-23 for the four digital
  releases in region ES (1507696 type 4 on 2026-10-30 with note `Prime Video`, plus a
  type 1 festival entry; 1702511 type 4 on 2026-11-01 `Netflix`; 1393171 and 1739309
  type 4 with an empty note).
- `movie_<id>__language=en-US.json`: English overview fallback for the captured releases
  whose Spanish overview is empty (1788146 has an empty English overview too).
- `case_*.json`: edge cases used explicitly by tests through routes (ES providers with
  flatrate, ads, free, rent and buy; a 429 body; a discover page with
  `total_pages` above `MAX_PAGES`).

`tests/support/fixture-fetch.js` resolves a request against this folder and the captured
folder (`tests/fixtures/tmdb/`) and refuses name collisions between both.
