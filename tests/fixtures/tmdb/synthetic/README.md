# Synthetic TMDB fixtures

Hand-written responses for what the captures do not cover. They are not
real captures; the owner's re-capture never overwrites them. File names follow
`tests/support/fixture-name.js`, like the captured ones.

- `movie_<id>__append_to_response=release_dates~2Cwatch~2Fproviders,language=es-ES.json`:
  the combined detail request of F4 (`docs/data-model.md` §7) for every captured release
  (17 ids of the 2026-10-23 and 2026-10-24 captures). Built from the captured discover
  entry (title, original title, overview, poster), the captured
  `movie_<id>_release_dates.json` and `movie_<id>_watch_providers.json` when they exist
  (empty otherwise), plus a **synthetic** `runtime` and `imdb_id` (TMDB was not asked for
  them): every runtime is 40 minutes or more so that the captured run keeps all its
  releases, except `1788146`, whose `runtime: 0` with an `imdb_id` exercises the "no
  runtime" branch of the runtime rule. `1702511` *The Class: Online* uses its real 52 min.
- `movie_<id>__language=en-US.json`: English overview fallback for the captured releases
  whose Spanish overview is empty (1788146 has an empty English overview too).
- `watch_providers_movie__language=es-ES,watch_region=ES.json`: the regional provider list
  of the arrivals step (§11), with realistic provider ids and names, including names that
  are not aliases (`Movistar Plus+ Ficción Total ` with its trailing space,
  `HBO Max Amazon Channel`, the `Apple TV` store, `Rakuten TV`).
- `discover_movie__…primary_release_date.gte=2023-10-23…with_watch_providers=<ids>.json`:
  one flatrate catalogue page per configured platform for a build on 2026-10-23
  (synthetic movie ids `9200xx`; SkyShowtime's is empty on purpose).
- `case_*.json`: edge cases used explicitly by tests through routes (ES providers with
  flatrate, ads, free, rent and buy; a 429 body; a discover page with
  `total_pages` above `MAX_PAGES`).

`tests/support/fixture-fetch.js` resolves a request against this folder and the captured
folder (`tests/fixtures/tmdb/`) and refuses name collisions between both.

The ES release dates of the four digital releases lived here until the 2026-10-24
re-capture brought the real ones (same type-4 dates and notes).
