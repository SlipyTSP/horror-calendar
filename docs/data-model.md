# Data model — horror-calendar

Status: **contract**. This document, together with `tests/fixtures/releases.sample.json`,
fixes the data shapes shared by the data layer (`src/`) and the web (`site/`), so that
both can be built in parallel by independent sessions. Sessions must not change this
file or the sample fixture unless their prompt says so explicitly. If an implementation
cannot honour the contract, stop and explain in the PR description instead of changing
the contract silently.

## 1. Pipeline overview

```
src/tmdb.js       TMDB API  ->  raw releases (one per movie *and* release type)
src/platforms.js  provider names -> platform slugs; assigns `calendars` to each release
src/calendar.js   releases -> N iCalendar documents (one per calendar) + legacy alias
src/index.js      orchestrates, writes output/*.ics and output/releases.json
site/             static web: reads releases.json, lets the user pick calendars
```

Everything that touches the network goes through an injectable `fetch` and an
injectable clock (`now`), so the whole pipeline can be unit-tested from fixtures without
network access and without an API key.

## 2. Release object

One object per **movie and release type**. A movie released in Spanish cinemas and later
on a platform produces two objects with the same `id` and different `type`.

| Field | Type | Rules |
|---|---|---|
| `id` | number | TMDB movie id. |
| `title` | string | Title as returned for `language=es-ES`. |
| `originalTitle` | string | `original_title` from TMDB. |
| `releaseDate` | string | `YYYY-MM-DD`. The **Spanish** date for this `type`, as returned by `discover/movie` with `region=ES` + `with_release_type`. Never the global primary date. |
| `type` | `"theatrical"` \| `"digital"` | Given by the query the movie came from, never inferred from other regions. |
| `calendars` | string[] | Slugs of the calendars this release belongs to (see §3). The legacy `all` calendar is implicit and never listed. Never empty. |
| `providers` | object | `{ "flatrate": string[], "rentBuy": string[] }`. Provider names as returned by `watch/providers` for region `ES`. Always present; both arrays empty for theatrical releases. |
| `posterPath` | string \| null | TMDB `poster_path` (relative, e.g. `/abc.jpg`). The web builds `https://image.tmdb.org/t/p/w342{posterPath}`. |
| `overview` | string | Spanish synopsis, English fallback, or empty string. Informational only, never an inclusion criterion. |
| `tmdbUrl` | string | `https://www.themoviedb.org/movie/{id}`. |

Ordering of `releases`: by `releaseDate` ascending, then `title` ascending.

### Inclusion rules (data layer)

- A release enters only if it has a Spanish release date of the given type inside the
  window `[today, today + WINDOW_DAYS]` (default 90 days). No date in Spain, no entry.
- Synopsis, poster and providers are **content**, never inclusion criteria.
- Same `id` appearing twice inside the *same* query is deduplicated (first occurrence wins).
- Same `id` in both queries is kept twice (two legitimate events).

### Provider classification

- `flatrate` = included in a subscription. Only this list drives platform calendar
  membership.
- `rent` and `buy` are merged into `rentBuy`. They never create platform membership and
  are never presented as "streaming".
- `ads`/`free` tiers returned by TMDB are ignored unless they are aliases of a configured
  platform (see §5).

## 3. Calendars

| Slug | File | `kind` | Membership rule | iCalendar name |
|---|---|---|---|---|
| `cines` | `horror-cines.ics` | `cinema` | every release with `type === "theatrical"` | `Terror — Cines` |
| `<platform>` | `horror-<platform>.ics` | `platform` | `type === "digital"` and some `providers.flatrate` entry maps to that platform | `Terror — <Platform name>` |
| `digital` | `horror-digital.ics` | `aggregate` | every release with `type === "digital"` | `Terror — Digital` |
| `all` | `horror.ics` | `legacy` | every release | `Terror — Todo` |

Rules:

- `horror.ics` is a **contract with existing subscribers**: the file name and URL never
  change. It is generated on every build and contains the same events as `cines` +
  `digital`.
- Every calendar is generated on every build, even when it has zero events (a valid
  empty VCALENDAR). Subscribing/unsubscribing happens on the device, never in the build.
- `calendars` on a release object = `["cines"]` for theatrical, or `["digital", ...platformSlugs]`
  for digital (platform slugs in config order).
- Order of calendars everywhere (JSON, web, summaries): `cines`, platforms in config order,
  `digital`, `all`.

## 4. `releases.json`

```json
{
  "schema": 1,
  "generated": "2026-11-02T06:03:00.000Z",
  "region": "ES",
  "window": { "from": "2026-11-02", "to": "2027-01-31" },
  "calendars": [
    { "slug": "cines", "file": "horror-cines.ics", "name": "Cines", "kind": "cinema", "count": 3 },
    { "slug": "netflix", "file": "horror-netflix.ics", "name": "Netflix", "kind": "platform", "count": 1 },
    { "slug": "digital", "file": "horror-digital.ics", "name": "Digital", "kind": "aggregate", "count": 5 },
    { "slug": "all", "file": "horror.ics", "name": "Todo", "kind": "legacy", "count": 8 }
  ],
  "releases": [ ]
}
```

| Field | Rules |
|---|---|
| `schema` | Integer, currently `1`. Bump only with a documented change of this file. |
| `generated` | ISO 8601 UTC timestamp of the build. |
| `region` | `TMDB_REGION`, `ES` by default. |
| `window` | The `release_date.gte` / `release_date.lte` values used in the queries. |
| `calendars` | Metadata for every generated calendar, in canonical order. `file` is relative to the site root (never an absolute URL). `count` equals the number of releases in that calendar. `name` is the short display name (the iCalendar `X-WR-CALNAME` adds the `Terror — ` prefix). |
| `releases` | Array of release objects (§2). |

`tests/fixtures/releases.sample.json` is a complete, valid example covering: theatrical
only, digital on one platform, digital on two platforms, digital rent/buy only, digital on
a non-configured provider, one movie with both a theatrical and a digital release, empty
`overview`, `posterPath: null`, and platforms with zero releases.

## 5. Platform configuration — `src/platforms.js`

Single place to add or remove platforms. Shape:

```js
module.exports.PLATFORMS = [
  { slug: 'netflix',       name: 'Netflix',        providerNames: ['Netflix', 'Netflix basic with Ads'] },
  { slug: 'prime-video',   name: 'Prime Video',    providerNames: ['Amazon Prime Video', 'Amazon Prime Video with Ads'] },
  { slug: 'hbo-max',       name: 'HBO Max',        providerNames: ['HBO Max', 'Max'] },
  { slug: 'movistar-plus', name: 'Movistar Plus+', providerNames: ['Movistar Plus+', 'Movistar Plus'] },
  { slug: 'filmin',        name: 'Filmin',         providerNames: ['Filmin'] },
  { slug: 'disney-plus',   name: 'Disney+',        providerNames: ['Disney Plus', 'Disney+'] },
  { slug: 'skyshowtime',   name: 'SkyShowtime',    providerNames: ['SkyShowtime'] },
  { slug: 'apple-tv-plus', name: 'Apple TV+',      providerNames: ['Apple TV Plus', 'Apple TV+'] },
];
```

- Matching is by exact provider name, case-insensitive, after trimming. `providerNames`
  are aliases: TMDB renames providers (Max/HBO Max) and adds ad tiers.
- Slugs are file-name safe: lowercase `a-z`, `0-9` and `-` only. Slugs `cines`,
  `digital` and `all` are reserved.
- The initial `providerNames` above are the expected TMDB names for region `ES`; F1 must
  verify them against the captured fixtures in `tests/fixtures/tmdb/` and adjust the
  aliases (not the slugs).

## 6. iCalendar rules

- RFC 5545: CRLF line endings, lines folded at 75 octets without splitting UTF-8
  sequences, text escaped (`\\`, `;`, `,`, newlines), `METHOD:PUBLISH`,
  `CALSCALE:GREGORIAN`, `REFRESH-INTERVAL;VALUE=DURATION:P1D` and `X-PUBLISHED-TTL:P1D`.
- `PRODID:-//Horror Calendar//horror-calendar//ES`.
- `X-WR-CALNAME` per calendar (`Terror — Cines`, `Terror — Netflix`, …). The legacy
  `horror.ics` keeps a stable name too (`Terror — Todo`).
- One `VEVENT` per release, all-day: `DTSTART;VALUE=DATE:YYYYMMDD`, `TRANSP:TRANSPARENT`.
- `UID:tmdb-<id>-<type>@horror-calendar` (e.g. `tmdb-900004-digital@horror-calendar`).
  Stable across builds: a date or title change in TMDB updates the event instead of
  duplicating it. Never derive UIDs from title or date.
- `SUMMARY`: title plus a type marker (`🎬` theatrical, `📺` digital), as today.
- `DESCRIPTION`, in this order, separated by blank lines: synopsis (if any); a "where"
  line — `En cines` for theatrical, `Incluido en: Netflix, Filmin` when `flatrate` is not
  empty, `Alquiler o compra: Apple TV, Rakuten TV` when only `rentBuy` is not empty,
  `Estreno digital` when neither is known; `Más info: <tmdbUrl>`.
- `URL:<tmdbUrl>`.
- `DTSTAMP` is the build time (acceptable; stable DTSTAMP is optional future work).

## 7. TMDB queries (data layer)

Both queries use `GET /discover/movie` with `api_key` as query parameter (API v3).

Common parameters: `language=es-ES`, `region=ES`, `with_genres=27`,
`release_date.gte=<today>`, `release_date.lte=<today + WINDOW_DAYS>`, `page=<n>`.

| Query | `with_release_type` | Produces `type` |
|---|---|---|
| theatrical | `3\|2` | `theatrical` |
| digital | `4` | `digital` |

- Never combine `primary_release_date.*` with `region`: TMDB silently ignores the region
  for the date window and returns worldwide releases. That was the original bug.
- With `region` + `with_release_type`, the `release_date` field of each result is the
  first Spanish date of that type: use it as `releaseDate`. Do not rely on `sort_by` for
  regional dates; sort in code.
- Pagination: follow `total_pages` up to `MAX_PAGES` (default 5) per query.
- Per movie, one extra request: `GET /movie/{id}/watch/providers`, region `ES` only.
  Theatrical releases skip this request.
- `GET /movie/{id}?language=en-US` only when the Spanish `overview` is empty (fallback).
- Concurrency: a pool of 5 simultaneous detail requests. HTTP 429 and 5xx are retried
  (up to 3 times, honouring `Retry-After`, exponential backoff otherwise). Detail failures
  are counted and reported; if more than 20 % of detail requests fail, the run exits with
  a non-zero code. If both discover queries return zero results, or any discover request
  fails after retries, the run exits non-zero so that CI never publishes an empty or
  partial calendar over a good one.
- Dates are computed in UTC (`YYYY-MM-DD`). `today` is injectable for tests.

Environment variables: `TMDB_API_KEY` (required), `TMDB_LANGUAGE` (default `es-ES`),
`TMDB_REGION` (default `ES`), `WINDOW_DAYS` (default `90`, integer 1–366, invalid values
fall back to the default with a warning), `MAX_PAGES` (default `5`, integer 1–20, same
fallback).

## 8. Web contract — `site/`

- The web reads `releases.json` with a relative URL and builds every calendar link from
  `calendars[].file`, relative to the page. No absolute URLs anywhere (the site may be
  served under a sub-path in the future).
- `webcal://` links are derived from the resolved absolute URL at runtime
  (`new URL(file, location.href)`), replacing the scheme.
- Selector: one checkbox per calendar with `kind` `cinema`, `platform` or `aggregate`, in
  the order given by `calendars`, showing `count`. The `legacy` calendar is not a
  checkbox; it stays reachable as the "classic" full calendar link.
- Selection persisted in `localStorage` under the key `horror-calendar:selection` as a
  JSON array of slugs. Default when nothing is stored: `["cines"]`. Unknown slugs in
  storage are ignored.
- The release list shows a release when `release.calendars` intersects the selection.
  Badges per release come from `release.calendars` mapped through `calendars[].name`;
  `rentBuy`-only releases show a distinct "rent/buy" badge.
- Existing ES/EN i18n is kept; new strings get both languages.

## 9. Change control

A change to this contract is a PR that updates this file, `tests/fixtures/releases.sample.json`
and every consumer in the same PR, and bumps `schema` when `releases.json` changes shape.
