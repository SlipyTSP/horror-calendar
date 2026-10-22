# Phase plan — horror-calendar

This is the execution plan for fixing the calendar so that it answers "what horror can
**I** watch?" (Spanish cinemas and the platforms the user subscribes to) instead of "what
horror is released anywhere?". Background and the diagnosis live in the project's
planning folder; this file is what a coding session needs.

## 0. How phases run

- Each phase is executed by one autonomous session of Claude Code (cloud), in its own
  branch, ending in a pull request to `main`. Nothing lands on `main` without the
  owner's review and a rebase merge. See `CLAUDE.md` → "Sesiones cloud" for the session
  rules (git identity, commits, PR hygiene).
- Phases own disjoint sets of files so that two of them can run in parallel. "Owns" means
  the session may create, modify or delete those paths. "Must not touch" is absolute:
  if a change outside the owned set seems necessary, leave it undone and explain it in
  the PR description. The only exceptions are the ones listed as "authorised exceptions".
- The data contract (`docs/data-model.md` + `tests/fixtures/releases.sample.json`) is
  read-only for every phase.
- Done means: the acceptance criteria are met with evidence in the PR description,
  `npm test` is green on the branch, CI is green on the PR, and `CLAUDE.md` describes the
  repository as the phase leaves it.

### Status

| Phase | Branch | PR | Status |
|---|---|---|---|
| Package (this document) | `main` | — | merged |
| F0 — Foundations | `feat/f0-foundations` | | pending |
| F1 — Regional data core + calendars | `feat/f1-regional-data` | | pending (after F0) |
| F2 — Web selector | `feat/f2-web-selector` | | pending (after F0, parallel to F1) |
| F3 light — Visual polish | `feat/f3-visual-polish` | | optional (after F1 + F2) |

Each phase updates its own row when it opens its PR.

### Order and integration

```
F0 ──merge──> F1 ──┐
              F2 ──┴──> merge F1, rebase F2, merge F2 ──> manual workflow run ──> device check
```

F1 and F2 are launched together once F0 is on `main`. F1 is merged first; F2 is rebased
on top and merged second. The first scheduled build after both merges is the first
production validation.

## 1. F0 — Foundations (probe)

**Goal.** Make the repository testable and reviewable from a phone before touching the
data logic: a working test runner, a fixture mechanism that does not need network, a CI
workflow that runs the tests and a real dry run on every PR, and the structural hygiene
that later phases depend on. No behaviour change in the generated calendar.

**Branch.** `feat/f0-foundations`

**Owns.** `package.json`, `package-lock.json`, `.gitignore`, `tests/**` (except the
contract fixture), `scripts/**`, `.github/workflows/**`, `site/**` (creation by move
only), `output/index.html` (removal by move only), `CLAUDE.md` (architecture and commands
sections), `README.md` (only the "Development" section described below).

**Must not touch.** `src/tmdb.js`, `src/index.js`, the content of `index.html` (it is
moved, not edited), `docs/**`, `tests/fixtures/releases.sample.json`, `.env.example`,
`LICENSE`, `.gitattributes`.

**Authorised exceptions.** `src/calendar.js`: add `escapeText`, `foldLine`, `generateUID`
and `buildDescription` to `module.exports` (no other change). The test for the current
UID scheme and for the current inclusion filter will be rewritten by F1; write them
anyway, they document today's behaviour.

**Tasks.**

1. Test runner. `"test": "node --test"` in `package.json` (Node's built-in runner
   discovers `**/*.test.js`; keep test files under `tests/unit/` and helpers under
   `tests/support/` so helpers are not picked up as tests). Minimum Node version in
   `engines` becomes `>=20`.
2. `tests/support/mock-fetch.js`: a `fetch` replacement that maps a request URL (query
   string without `api_key`) to a fixture file under `tests/fixtures/tmdb/`, records every
   call, supports queued responses for the same URL (to test retries, e.g. a 429 followed
   by a 200) and throws a clear error for an unmapped URL. Pure Node, no dependencies.
3. `tests/unit/calendar.test.js` for the current `src/calendar.js`: text escaping; folding
   at 75 octets with multi-byte UTF-8 (a long Spanish synopsis with accents and an emoji),
   continuation lines start with a single space, no UTF-8 sequence is split; CRLF line
   endings everywhere and a trailing CRLF; VCALENDAR header fields; one all-day VEVENT per
   included release with `DTSTART;VALUE=DATE`; UID determinism for identical input.
4. `scripts/capture-fixtures.js`: run once by the owner with a real key, from a shell. It
   performs the two regional discover queries described in `docs/data-model.md` §7
   (pages 1 and 2 of each), then `watch/providers` for up to 12 of the returned movie ids
   (first six from each query) and `movie/{id}?language=en-US` for the first three, and
   writes the raw JSON bodies to `tests/fixtures/tmdb/` with deterministic file names
   derived from the request path and parameters. Writes `tests/fixtures/tmdb/manifest.json`
   with the capture date, the window used and the parameter set of every request. The API
   key must never appear in any file name, file content, log line or manifest. Fails with a
   clear message and non-zero exit when the key is missing, on any non-2xx response, and
   on 429 (no retry here; the user re-runs). Prints a short summary: results per query and
   the distinct `provider_name` values seen in region ES.
5. `scripts/summary.js`: reads `output/releases.json` and prints a Markdown table (date,
   title, type, providers or calendars, one row per release) to stdout. Used by CI to fill
   the job summary; must cope with today's `releases.json` shape and with the F1 shape
   (`docs/data-model.md` §4) by looking at the fields present.
6. `.github/workflows/ci.yml`, triggered on `pull_request`, `push` to `main` and
   `workflow_dispatch`: job `test` (checkout, Node 24, `npm ci`, `npm test`); job
   `dry-run` (needs `test`): `npm start` with `TMDB_API_KEY` from secrets and
   `TMDB_LANGUAGE`/`TMDB_REGION` as in the deploy workflow, then `node scripts/summary.js
   >> "$GITHUB_STEP_SUMMARY"`, then upload `output/` as an artifact (retention 14 days).
   No deploy from this workflow. Pin actions to the same major versions as the existing
   workflow.
7. `.github/workflows/update-calendar.yml`: add `npm test` before generation; copy the
   whole `site/` directory into `_site` (`cp -r site/. _site/`) plus `output/*.ics` and
   `output/releases.json` (glob, so new calendars from F1 need no workflow change); keep
   the Monday 06:00 UTC cron; add a keep-alive so that GitHub does not disable the
   schedule after 60 days without commits (preferred: `gautamkrishnar/keepalive-workflow`
   in its API mode, which needs `permissions: actions: write` and creates no commits; read
   the action's current README and follow it; never add dummy commits to `main`).
8. Hygiene: `git mv output/index.html site/index.html` with no content change; `.gitignore`
   ignores `output/` entirely plus `site/releases.json` and `site/*.ics` (local preview
   copies); delete `scripts/generate.js` (empty, unused); `tests/fixtures/tmdb/.gitkeep`.
9. Docs: update the "Comandos" and "Arquitectura" sections of `CLAUDE.md`; add a short
   "Development" section to `README.md` (install, test, run, capture fixtures, local web
   preview by copying the sample fixture to `site/releases.json`).

**Acceptance criteria.**

- A1. `npm test` passes on Node 20, 22 and 24 (CI runs 24; the session runs whatever is
  installed) with at least the calendar tests above.
- A2. `npm start` produces the same `output/horror.ics` and `output/releases.json` as before
  the phase (only `index.html` moved).
- A3. On the PR, CI runs the `test` job and the `dry-run` job; the dry run publishes the
  release table in the job summary and an `output` artifact. (The owner verifies this on
  GitHub; the session verifies the workflow syntax with a YAML parse and by reading it.)
- A4. `node scripts/capture-fixtures.js` without a key exits non-zero with a clear message
  and writes nothing. With a key (owner, later) it writes the files described above with no
  trace of the key.
- A5. The deploy workflow copies `site/`, `output/*.ics` and `output/releases.json`, runs
  tests first, and includes the keep-alive step.

**Out of scope.** Any change to queries, filtering, UIDs, calendar count or the web page
content.

## 2. F1 — Regional data core + multi-calendar (Node side)

**Goal.** Replace the worldwide query with two Spanish regional queries, apply the strict
inclusion rules, classify providers, and generate one calendar per platform plus the
aggregates and the legacy alias, exactly as `docs/data-model.md` specifies.

**Branch.** `feat/f1-regional-data`

**Owns.** `src/**` (including new `src/platforms.js`), `tests/unit/**`,
`tests/fixtures/tmdb/**` (read; may add hand-written fixtures for edge cases in a
clearly named `tests/fixtures/tmdb/synthetic/` folder), `scripts/summary.js`,
`.env.example`, `README.md`, `CLAUDE.md` (architecture, TMDB and ICS sections),
`docs/phases.md` (status row only).

**Must not touch.** `site/**`, `.github/workflows/ci.yml`, `scripts/capture-fixtures.js`,
`docs/data-model.md`, `tests/fixtures/releases.sample.json`, `tests/support/mock-fetch.js`
(if it needs a feature, add a new helper file instead).

**Authorised exceptions.** `.github/workflows/update-calendar.yml` only if the copy step
from F0 turns out not to pick up the new files (it should, it is a glob).

**Tasks.**

1. `src/tmdb.js`: `getHorrorReleases({ fetchImpl = fetch, now = new Date(), env =
   process.env })` returns release objects (§2 of the data model) **without** `calendars`.
   Two discover queries (§7), deduplication inside each query, both types kept, Spanish
   regional date as `releaseDate`, sort in code, pagination up to `MAX_PAGES`,
   `watch/providers` (ES) for digital releases only with `flatrate` vs `rentBuy`, English
   overview fallback, concurrency pool of 5, retries with backoff on 429/5xx honouring
   `Retry-After`, failure counter with a final console report, non-zero exit conditions
   (§7). Remove the ES→GB→FR→DE→US cascade, the synopsis-based inclusion and the
   `release_dates` request (the type comes from the query).
2. `src/platforms.js`: `PLATFORMS` (§5), `assignCalendars(release)` → copy with
   `calendars` set, `calendarDefinitions()` → the canonical ordered list of
   `{ slug, file, name, kind }` for cines, platforms, digital, all.
3. `src/calendar.js`: `generateCalendars(releases, { now })` → array of
   `{ slug, file, name, kind, count, ics }` in canonical order; UID
   `tmdb-<id>-<type>@horror-calendar`; `X-WR-CALNAME` per calendar; DESCRIPTION rules
   (§6); remove `shouldInclude` (filtering lives in the data layer only); keep folding,
   escaping and CRLF behaviour. Empty calendars are valid VCALENDAR documents.
4. `src/index.js`: orchestrate `getHorrorReleases` → `assignCalendars` →
   `generateCalendars` → write every `.ics` to `output/` and `output/releases.json` (§4,
   `schema: 1`, canonical `calendars` metadata with counts). Console preview: one line per
   release with date, type, title and calendars. Exit codes as in §7.
5. `scripts/summary.js`: show the `calendars` column and the per-calendar counts.
6. Tests (fixtures only, no network): query parameters built exactly as §7 (assert on the
   recorded URLs); regional date used; dedup inside a query; same id in both queries gives
   two releases; strict inclusion; provider classification; alias matching
   (case-insensitive, `Max` → `hbo-max`); pool + retry on 429 with `Retry-After`; failure
   threshold → non-zero; empty discover → non-zero; `assignCalendars` and
   `generateCalendars` fed with `tests/fixtures/releases.sample.json` reproduce its
   `calendars` metadata and counts exactly; UID stable when a release date changes;
   `horror.ics` contains cines + digital; every generated `.ics` passes a structural
   validator written in the tests (CRLF, folding, BEGIN/END pairs, required fields).
7. Docs: apply the README draft (project description, offer, usage, configuration,
   architecture, data attribution, license); update `CLAUDE.md`; mark the status row.

**Acceptance criteria** (the eight from the original brief, restated for this split).

- B1. Only movies with a Spanish release date of the queried type inside the window are
  generated; the queries never use `primary_release_date.*` together with `region`.
- B2. Theatrical events carry the Spanish theatrical date, digital events the Spanish
  digital date; a movie with both produces two events with different UIDs.
- B3. No `rent`/`buy` provider ever appears as "included" nor creates platform membership.
- B4. `output/` contains `horror-cines.ics`, one `horror-<slug>.ics` per configured platform,
  `horror-digital.ics` and `horror.ics`, all valid RFC 5545 (verified by tests), plus
  `releases.json` conforming to the data model (verified by a test against the sample).
- B5. Regenerating after a date change keeps the UID (test).
- B6. `npm test` green locally and in CI; the dry run on the PR shows a Spanish-only list
  (owner checks the summary: expected volume 10–25 releases per 90 days).
- B7. `horror.ics` keeps its file name and remains the full aggregate.
- B8. `MAX_PAGES`, `WINDOW_DAYS` and any other numeric input are parsed defensively
  (invalid → default with a warning); TMDB fields are treated as optional (`null`-safe).

**Out of scope.** Anything under `site/`, posters, redesign.

## 3. F2 — Web selector (`site/` only)

**Goal.** Turn the static page into the calendar selector: the user ticks cinemas and the
platforms they subscribe to, gets a subscribe button and a copyable URL per calendar, and
the release list follows the selection. Built against the data contract only.

**Branch.** `feat/f2-web-selector`

**Owns.** `site/**`, `tests/unit/site-*.test.js`, `docs/phases.md` (status row only).

**Must not touch.** Anything else: `src/**`, `scripts/**`, `.github/**`, `package.json`,
`tests/fixtures/**`, `tests/support/**`, `docs/data-model.md`, `CLAUDE.md`, `README.md`.

**Tasks.**

1. Split the page into `site/index.html`, `site/styles.css` and `site/selector.js` (plain
   ES2020, no build step, no framework, no new dependencies). `selector.js` keeps its pure
   logic (selection state, filtering, URL building, i18n lookup) in functions that are
   exported with a `module.exports` guard so that `node --test` can import the file
   without a DOM.
2. Behaviour as in `docs/data-model.md` §8: checkboxes from `calendars` (not the legacy
   one), counts, `localStorage` key `horror-calendar:selection`, default `["cines"]`,
   unknown slugs ignored, per-selected-calendar `webcal://` button and copyable https URL,
   filtered release list, badges per calendar, distinct rent/buy badge, the classic full
   calendar link kept for existing subscribers, ES/EN strings for every new label,
   generation date shown from `generated`.
3. Relative URLs only. Works when opened at `/horror-calendar/` and when served under a
   different sub-path.
4. Graceful states: `releases.json` missing or `schema` ≠ 1 → readable error, selector
   still renders from nothing; zero releases for the selection → empty-state message;
   `localStorage` unavailable (private mode) → selection works for the session without
   throwing.
5. Local preview: `cp tests/fixtures/releases.sample.json site/releases.json` and any
   static server; document it in a comment at the top of `selector.js`.
6. Tests: `tests/unit/site-selector.test.js` covering selection load/save with a fake
   storage (including a throwing storage), filtering with `releases.sample.json`, URL
   building for root and sub-path bases, and the i18n table having identical key sets for
   ES and EN.
7. Visual check at 320, 390, 820 and 1440 px wide if a headless browser is available in
   the session; otherwise reason about the CSS and say so in the PR.

**Acceptance criteria.**

- C1. Selector filters the list, persists in `localStorage`, offers webcal + URL for each
  selected calendar (the original brief's criterion 7).
- C2. Every link on the page is relative; no `slipytsp.github.io` literal in `site/`.
- C3. All tests green; CI green on the PR.
- C4. The existing ES/EN switch still works and no string is missing in either language.

**Out of scope.** Posters, favicon, fonts, OG tags (F3), anything in `src/`.

## 4. F3 light — Visual polish (optional)

**Goal.** Small, self-contained improvements on the current page: poster thumbnails from
`posterPath` (`https://image.tmdb.org/t/p/w342`), a favicon, Open Graph / Twitter meta
tags, a system font stack instead of Google Fonts, and grouping the list by month.

**Branch.** `feat/f3-visual-polish`. **Owns** `site/**` and `tests/unit/site-*.test.js`.
**Must not touch** anything else. Runs only after F1 and F2 are merged. The full redesign
is deliberately not part of this plan.
