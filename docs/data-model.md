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
data/manual-releases.json   ->  curated Spanish digital releases (§10)
TMDB watch providers + previous snapshot  ->  platform arrivals (§11)
src/platforms.js  provider names + release notes -> platform slugs; assigns `calendars`
src/calendar.js   releases -> N iCalendar documents (one per calendar) + legacy alias
src/index.js      orchestrates, writes output/*.ics, output/releases.json and
                  output/providers-snapshot.json
site/             static web: reads releases.json, lets the user pick calendars
```

Releases come from three **sources** (`source` field, §2): the two regional TMDB
queries (`tmdb`), the curated manual list (`manual`) and the weekly diff of platform
catalogues (`providers`). Everything that touches the network goes through an
injectable `fetch` and an injectable clock (`now`), so the whole pipeline can be
unit-tested from fixtures without network access and without an API key.

## 2. Release object

One object per **movie and release type** (and, for arrivals, per platform). A movie
released in Spanish cinemas and later on a platform produces two objects with the same
`id` and different `type`.

| Field | Type | Rules |
|---|---|---|
| `id` | number | TMDB movie id. |
| `title` | string | Title as returned for `language=es-ES`. |
| `originalTitle` | string | `original_title` from TMDB. |
| `releaseDate` | string | `YYYY-MM-DD`. `tmdb`: the **Spanish** date for this `type`, as returned by `discover/movie` with `region=ES` + `with_release_type`, never the global primary date. `manual`: the Spanish date from the curated entry (§10). `providers`: the UTC date of the build that first detected the movie in that platform's Spanish catalogue (§11). |
| `type` | `"theatrical"` \| `"digital"` \| `"arrival"` | `tmdb`: given by the query the movie came from, never inferred from other regions. `manual`: always `"digital"`. `providers`: always `"arrival"`. |
| `source` | `"tmdb"` \| `"manual"` \| `"providers"` | Where the release comes from. |
| `calendars` | string[] | Slugs of the calendars this release belongs to (see §3). The legacy `all` calendar is implicit and never listed. Never empty. |
| `providers` | object | `{ "flatrate": string[], "rentBuy": string[] }`. Provider names as returned by `watch/providers` for region `ES`. Always present; both arrays empty for theatrical, manual and arrival releases. |
| `releaseNote` | string \| null | Trimmed `note` of the Spanish type-4 (digital) entry in `/movie/{id}/release_dates` (§7), e.g. `"Prime Video"`. TMDB usually fills it **before** the release, when `watch/providers` is still empty. `null` for theatrical, manual and arrival releases, when the note is empty, or when the request failed. |
| `arrivalPlatform` | string \| null | Platform slug (§5) of an arrival. `null` for every other type. |
| `sourceUrl` | string \| null | `https://` URL of the press source of a `manual` release. `null` for every other source. |
| `runtime` | number \| null | Runtime in minutes from `GET /movie/{id}`; `null` when TMDB has none. Used by the runtime rule below, also shown as content. |
| `posterPath` | string \| null | TMDB `poster_path` (relative, e.g. `/abc.jpg`). The web builds `https://image.tmdb.org/t/p/w342{posterPath}`. |
| `overview` | string | Spanish synopsis, English fallback, or empty string. Informational only, never an inclusion criterion. |
| `tmdbUrl` | string | `https://www.themoviedb.org/movie/{id}`. |

Ordering of `releases`: by `releaseDate` ascending, then `title` ascending
(`localeCompare(…, 'es')`), then `type` in the order `theatrical`, `digital`, `arrival`,
then `id`.

### Inclusion rules (data layer)

- **Spanish date.** A `tmdb` release enters only if it has a Spanish release date of the
  given type inside the window `[today, today + WINDOW_DAYS]` (default 90 days). A
  `manual` release enters only if its curated Spanish date is inside the same window.
  An `arrival` enters only if its detection date is inside `[today − ARRIVAL_DAYS, today]`
  (default 30 days). No Spanish date (from TMDB or from a curated Spanish source), no
  entry: dates from other countries are never used.
- **Runtime rule** (all sources). A movie enters only if `runtime >= MIN_RUNTIME`
  (default 40 minutes, the usual feature-film threshold), or, when TMDB has no runtime,
  if TMDB has an `imdb_id`. A TMDB `runtime` of `0` means "no runtime" (stored as
  `null`). `MIN_RUNTIME=0` disables the whole rule, the `imdb_id` check included. Everything else (shorts, school projects, one-off local
  screenings registered as releases) is left out. The run prints how many releases the
  rule removed and their titles (plain lines, not `::warning::`). The 2026-10-25
  measurement (planning folder) removed 18 of 36 releases in Sep–Oct, all shorts of
  1–22 minutes, and no release confirmed by the Spanish press.
- Synopsis, poster and providers are **content**, never inclusion criteria.
- Same `id` appearing twice inside the *same* TMDB query is deduplicated (first
  occurrence wins).
- Same `id` in both TMDB queries is kept twice (two legitimate events).
- A `manual` entry whose `id` already produced a `tmdb` digital release is not emitted
  on its own: TMDB wins for the date and the content, and the curated `platform` is
  **added** to the TMDB release's platform membership (so a TMDB date without note or
  `flatrate` does not lose the curated platform). If the curated date differs from the
  TMDB date, the run prints a `::warning::` (title, id, both dates). Both share the UID
  `tmdb-<id>-digital`, so a later TMDB date updates the event instead of duplicating it.
- An arrival is dropped when it is the announced release itself: the same build has a
  `digital` release of the same `id` in that platform calendar, or the movie has a
  Spanish type-4 date (from its detail request) inside
  `[today − ARRIVAL_DAYS − 7, today]`, or `data/manual-releases.json` has an entry with
  the same `id` and platform whose date is inside that same range (past entries count:
  they stay in the file). The weekly build means an announced release has usually left
  the calendars when its arrival is detected; this rule avoids a second event for it.

### Provider classification

- Platform membership of a `tmdb` digital release comes from two sources, combined as a
  **union**:
  1. `releaseNote` (announced platform of the Spanish digital release, available before
     the release date);
  2. `flatrate` = included in a subscription (TMDB only lists it once the movie is
     actually available in Spain, so for upcoming releases it is usually empty).
  Both are matched against the same aliases (§5). A note that matches no alias creates
  no membership and is reported (§7).
- A `manual` release belongs to the platform named by its curated `platform` slug.
- An `arrival` belongs to its `arrivalPlatform` only.
- `rent` and `buy` are merged into `rentBuy`. They never create platform membership and
  are never presented as "streaming".
- `ads`/`free` tiers returned by TMDB are ignored unless they are aliases of a configured
  platform (see §5).

## 3. Calendars

| Slug | File | `kind` | Membership rule | iCalendar name |
|---|---|---|---|---|
| `cines` | `horror-cines.ics` | `cinema` | every release with `type === "theatrical"` | `Terror — Cines` |
| `<platform>` | `horror-<platform>.ics` | `platform` | `type === "digital"` mapped to that platform (§2), plus every `arrival` whose `arrivalPlatform` is that platform | `Terror — <Platform name>` |
| `digital` | `horror-digital.ics` | `aggregate` | every release with `type === "digital"` (`tmdb` and `manual`) | `Terror — Digital` |
| `all` | `horror.ics` | `legacy` | every `theatrical` and `digital` release | `Terror — Todo` |

Rules:

- `horror.ics` is a **contract with existing subscribers**: the file name and URL never
  change. It is generated on every build and contains the same events as `cines` +
  `digital`. Arrivals are **not** part of `digital` nor of `horror.ics`: those calendars
  keep meaning "releases".
- Every calendar is generated on every build, even when it has zero events (a valid
  empty VCALENDAR). Subscribing/unsubscribing happens on the device, never in the build.
- `calendars` on a release object = `["cines"]` for theatrical, `["digital",
  ...platformSlugs]` for digital (platform slugs in config order), or `[arrivalPlatform]`
  for arrivals.
- Order of calendars everywhere (JSON, web, summaries): `cines`, platforms in config order,
  `digital`, `all`.

## 4. `releases.json`

```json
{
  "schema": 2,
  "generated": "2026-11-02T06:03:00.000Z",
  "region": "ES",
  "window": { "from": "2026-11-02", "to": "2027-01-31" },
  "arrivalWindow": { "from": "2026-10-03", "to": "2026-11-02" },
  "calendars": [
    { "slug": "cines", "file": "horror-cines.ics", "name": "Cines", "kind": "cinema", "count": 3 },
    { "slug": "netflix", "file": "horror-netflix.ics", "name": "Netflix", "kind": "platform", "count": 2 },
    { "slug": "digital", "file": "horror-digital.ics", "name": "Digital", "kind": "aggregate", "count": 7 },
    { "slug": "all", "file": "horror.ics", "name": "Todo", "kind": "legacy", "count": 10 }
  ],
  "releases": [ ]
}
```

| Field | Rules |
|---|---|
| `schema` | Integer, currently `2`. Bump only with a documented change of this file. |
| `generated` | ISO 8601 UTC timestamp of the build. |
| `region` | `TMDB_REGION`, `ES` by default. |
| `window` | The `release_date.gte` / `release_date.lte` values used in the TMDB queries (also the window of manual releases). |
| `arrivalWindow` | `{ from: today − ARRIVAL_DAYS, to: today }`: detection dates of the arrivals kept in this build. |
| `calendars` | Metadata for every generated calendar, in canonical order. `file` is relative to the site root (never an absolute URL). `count` equals the number of releases in that calendar (arrivals included in platform counts). `name` is the short display name (the iCalendar `X-WR-CALNAME` adds the `Terror — ` prefix). |
| `releases` | Array of release objects (§2). |

`tests/fixtures/releases.sample.json` is a complete, valid example covering: theatrical
only, digital on one platform, digital on two platforms, digital on a platform known only
from its release note, digital rent/buy only, digital on a non-configured provider, one
movie with both a theatrical and a digital release, a manual digital release with its
`sourceUrl`, two arrivals on different platforms (one of them with a date before
`window.from`), `runtime: null`, empty `overview`, `posterPath: null`, and platforms with
zero releases.

## 5. Platform configuration — `src/platforms.js`

Single place to add or remove platforms. Shape:

```js
module.exports.PLATFORMS = [
  { slug: 'netflix',       name: 'Netflix',        providerNames: ['Netflix', 'Netflix basic with Ads'] },
  { slug: 'prime-video',   name: 'Prime Video',    providerNames: ['Amazon Prime Video', 'Amazon Prime Video with Ads', 'Prime Video'] },
  { slug: 'hbo-max',       name: 'HBO Max',        providerNames: ['HBO Max', 'Max'] },
  { slug: 'movistar-plus', name: 'Movistar Plus+', providerNames: ['Movistar Plus+', 'Movistar Plus'] },
  { slug: 'filmin',        name: 'Filmin',         providerNames: ['Filmin'] },
  { slug: 'disney-plus',   name: 'Disney+',        providerNames: ['Disney Plus', 'Disney+'] },
  { slug: 'skyshowtime',   name: 'SkyShowtime',    providerNames: ['SkyShowtime'] },
  { slug: 'apple-tv-plus', name: 'Apple TV+',      providerNames: ['Apple TV Plus', 'Apple TV+'] },
];
```

- Matching is by exact name, case-insensitive, after trimming, and applies to both
  `flatrate` entries and `releaseNote`. `providerNames` are aliases: TMDB renames
  providers (Max/HBO Max), adds ad tiers, and release notes use short names
  (`Prime Video`, observed in the 2026-10-23 capture).
- Slugs are file-name safe: lowercase `a-z`, `0-9` and `-` only. Slugs `cines`,
  `digital` and `all` are reserved.
- The same aliases resolve the TMDB provider ids used by the arrivals query (§11).
- Observed type-4 notes in region ES on 2026-10-23: `Prime Video`, `Netflix`, and empty
  strings. Observed `flatrate` names in ES on 2026-10-25 include
  `Movistar Plus+ Ficción Total ` (trailing space, trimmed before matching; it is not an
  alias today) and `HBO Max Amazon Channel` (not an alias: channels are not platforms).

## 6. iCalendar rules

- RFC 5545: CRLF line endings, lines folded at 75 octets without splitting UTF-8
  sequences, text escaped (`\\`, `;`, `,`, newlines), `METHOD:PUBLISH`,
  `CALSCALE:GREGORIAN`, `REFRESH-INTERVAL;VALUE=DURATION:P1D` and `X-PUBLISHED-TTL:P1D`.
- `PRODID:-//Horror Calendar//horror-calendar//ES`.
- `X-WR-CALNAME` per calendar (`Terror — Cines`, `Terror — Netflix`, …). The legacy
  `horror.ics` keeps a stable name too (`Terror — Todo`).
- One `VEVENT` per release, all-day: `DTSTART;VALUE=DATE:YYYYMMDD`, `TRANSP:TRANSPARENT`.
- `UID:tmdb-<id>-<type>@horror-calendar` for theatrical and digital releases (e.g.
  `tmdb-900004-digital@horror-calendar`; a manual release uses the same `digital` UID as
  its future TMDB counterpart). Arrivals: `UID:tmdb-<id>-arrival-<platform>@horror-calendar`.
  Stable across builds: a date or title change in TMDB updates the event instead of
  duplicating it. Never derive UIDs from title or date.
- `SUMMARY`: title plus a type marker (`🎬` theatrical, `📺` digital, `🆕` arrival).
- `DESCRIPTION`, in this order, separated by blank lines: synopsis (if any); a "where"
  line, first rule that applies — `En cines` for theatrical; `Ya disponible en: Netflix`
  for an arrival (platform display name); `Incluido en: Netflix, Filmin` when `flatrate`
  is not empty (provider names as returned); `Estreno en: Prime Video` when `flatrate` is
  empty but the release belongs to platform calendars (platform display names, in config
  order; manual releases fall here); `Alquiler o compra: Apple TV, Rakuten TV` when only
  `rentBuy` is not empty; `Estreno digital` otherwise; then `Fuente: <sourceUrl>` for
  manual releases; then `Más info: <tmdbUrl>`.
- `URL:<tmdbUrl>`.
- `DTSTAMP` is the build time (acceptable; stable DTSTAMP is optional future work).

## 7. TMDB queries (data layer)

The two release queries use `GET /discover/movie` with `api_key` as query parameter
(API v3).

Common parameters: `language=es-ES`, `region=ES`, `with_genres=27`,
`release_date.gte=<today>`, `release_date.lte=<today + WINDOW_DAYS>`, `page=<n>`.

| Query | `with_release_type` | Produces `type` |
|---|---|---|
| theatrical | `3\|2` | `theatrical` |
| digital | `4` | `digital` |

- Never combine `primary_release_date.*` with `region`: TMDB silently ignores the region
  for the date window and returns worldwide releases. That was the original bug. (The
  arrivals query of §11 uses `primary_release_date.gte` **without** `region`, on purpose:
  there it only bounds the age of the catalogue.)
- With `region` + `with_release_type`, the `release_date` field of each result is the
  first Spanish date of that type: use it as `releaseDate`. Do not rely on `sort_by` for
  regional dates; sort in code.
- Pagination: follow `total_pages` up to `MAX_PAGES` (default 5) per query. If a query
  has more pages than `MAX_PAGES`, the cut is never silent: print a line starting with
  `::warning::` (GitHub Actions turns it into a visible annotation) naming the query,
  `total_pages` and `MAX_PAGES`. The 2026-10-23 capture had `total_pages = 1` for both
  queries.
- **Detail request for every release** (all sources): `GET /movie/{id}` with
  `language=es-ES` and `append_to_response=release_dates,watch/providers`. It provides
  `runtime` and `imdb_id` (runtime rule, §2) and, for digital releases, `release_dates`
  and `watch/providers` (region `ES` only) in the same response. From `release_dates`,
  take the entry with `iso_3166_1` equal to the region and, inside it, the type-4 date
  whose day equals `releaseDate` (fallback: the first type-4 date with a non-empty note);
  its trimmed `note` is `releaseNote`, empty → `null`. Release notes of other types
  (festivals, premieres) are ignored. A movie that appears in both queries needs one
  detail request, not two.
- Every non-null `releaseNote` that matches no alias is reported at the end of the run
  with a `::warning::` line (title, id, note), so that the owner can add the alias.
- `GET /movie/{id}?language=en-US` only when the Spanish `overview` is empty (fallback).
- A failed detail request leaves `runtime`, `releaseNote` and providers empty and the
  `tmdb` release is **kept** (the runtime rule only removes releases whose detail
  succeeded). Manual releases and arrivals need the detail for their title: on a failure
  other than 404 they are skipped **in this build only** (a manual entry stays in its
  file, an arrival stays in the snapshot's `arrivals`) with a `::warning::`.
- Concurrency: a pool of 5 simultaneous detail requests. HTTP 429 and 5xx are retried
  (up to 3 times, honouring `Retry-After`, exponential backoff otherwise). Detail failures
  are counted and reported; if more than 20 % of the detail requests of `tmdb` releases fail,
  the run exits with a non-zero code (manual and arrival detail requests are counted
  apart and never count towards that threshold). If both discover queries return zero results, or any discover request
  fails after retries, the run exits non-zero so that CI never publishes an empty or
  partial calendar over a good one. Manual releases and arrivals never make the run
  fail (§10, §11).
- Dates are computed in UTC (`YYYY-MM-DD`). `today` is injectable for tests.

Environment variables (all numeric ones are integers; invalid values fall back to the
default with a warning):

| Variable | Default | Range | Use |
|---|---|---|---|
| `TMDB_API_KEY` | — | required | API key |
| `TMDB_LANGUAGE` | `es-ES` | | language |
| `TMDB_REGION` | `ES` | | region |
| `WINDOW_DAYS` | `90` | 1–366 | release window |
| `MAX_PAGES` | `5` | 1–20 | pages per release query |
| `MIN_RUNTIME` | `40` | 0–300 | runtime rule (0 disables it) |
| `MANUAL_RELEASES_FILE` | `data/manual-releases.json` | | curated list (§10) |
| `SNAPSHOT_URL` | empty | `https://` URL | previous providers snapshot (§11); empty → seed |
| `ARRIVAL_DAYS` | `30` | 1–90 | how long an arrival stays in the calendars |
| `ARRIVAL_MAX_AGE_YEARS` | `3` | 1–20 | age limit of the catalogue watched for arrivals |
| `ARRIVAL_MAX_PAGES` | `50` | 1–100 | pages per platform in the arrivals query |
| `ARRIVAL_MAX_PER_PLATFORM` | `25` | 1–500 | flood guard (§11) |

The release window always starts today: releases leave every calendar on the first build
after their date (decision of 2026-10-23, no look-back). Arrivals are the only look-back
(`ARRIVAL_DAYS`).

## 8. Web contract — `site/`

- The web reads `releases.json` with a relative URL and builds every calendar link from
  `calendars[].file`, relative to the page. No absolute URLs anywhere (the site may be
  served under a sub-path in the future), except the Open Graph/Twitter meta authorised
  in F3.
- The web accepts `schema: 2` only (it shows its "unknown format" message otherwise).
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
  `rentBuy`-only releases show a distinct "rent/buy" badge; arrivals show a distinct
  "Ya disponible" / "Now available" badge next to their platform badge (their dates are
  in the past and sort first). The list keeps the order of `releases` (§2).
- Upcoming-release statistics ("en los próximos meses" and similar) count only
  `theatrical` and `digital` releases. Per-calendar counts include arrivals, so their
  wording must not say "estrenos" only (e.g. "títulos" / "titles").
- Data attribution in the footer: TMDB (F3) and JustWatch for streaming availability
  ("Disponibilidad en plataformas: JustWatch" / "Streaming availability: JustWatch",
  linked to `https://www.justwatch.com/`). TMDB's terms require crediting JustWatch
  when its watch-provider data is used.
- Existing ES/EN i18n is kept; new strings get both languages.

## 9. Change control

A change to this contract is a PR that updates this file, `tests/fixtures/releases.sample.json`
and every consumer in the same PR, and bumps `schema` when `releases.json` changes shape.

History:

- 2026-10-23 — `releaseNote` added and platform membership extended to the union of
  release note and `flatrate` (the capture showed `watch/providers` empty in ES for every
  upcoming release). Additive change made before any consumer existed: `schema` stays `1`.
- 2026-10-26 — Coverage change (F4), after the platform coverage measurement of
  2026-10-25: runtime rule; one detail request per release; curated manual releases
  (§10); platform arrivals from the weekly providers diff (§11); new fields `source`,
  `arrivalPlatform`, `sourceUrl` and `runtime`; new type `arrival`; `arrivalWindow`;
  JustWatch attribution. `schema` goes to `2` (the web rejects other versions, so data
  and web change in the same PR).

## 10. Manual releases — `data/manual-releases.json`

Curated Spanish digital releases that TMDB does not date in Spain (measurement of
2026-10-25: streaming windows after a Spanish theatrical run, and direct-to-platform
releases without a Spanish type-4 date). Owned by the owner; filled from the Spanish
press (by hand or through a pull request that the owner reviews).

```json
{
  "schema": 1,
  "releases": [
    {
      "id": 1107166,
      "releaseDate": "2026-09-09",
      "platform": "disney-plus",
      "sourceUrl": "https://cosasdehalloween.com/estrenos-terror-septiembre-2026/",
      "comment": "Psycho Killer: directo a Disney+ en España"
    }
  ]
}
```

| Field | Rules |
|---|---|
| `id` | Integer TMDB movie id. Required. |
| `releaseDate` | `YYYY-MM-DD`, Spanish date of the platform release. Required. |
| `platform` | A slug of §5. Required. One entry per `id` (a movie on two platforms the same week is out of scope: one UID per movie and type). |
| `sourceUrl` | `https://` URL of the source. Required. |
| `comment` | Free text for the curator. Optional, never published. |

- The file is optional: missing → no manual releases, plain log line. Invalid JSON or an
  unknown `schema` → `::warning::` and no manual releases. An invalid entry (missing or
  malformed field, unknown platform, non-`https` URL, `id` repeated in the file) →
  `::warning::` naming the entry, entry skipped. Never a non-zero exit.
- Entries outside `window` are ignored silently (past entries stay in the file as
  history; cleaning them is optional).
- Each entry inside the window needs the detail request of §7 (title, original title,
  poster, overview, runtime). A 404 → `::warning::` and the entry is skipped.
- The resulting release: `type: "digital"`, `source: "manual"`, `calendars:
  ["digital", platform]`, `sourceUrl` from the entry, `releaseNote: null`, empty
  providers. The runtime rule and the TMDB-wins rule of §2 apply.

## 11. Platform arrivals — providers diff

Weekly detection of horror movies that become included (`flatrate`) in a configured
platform in Spain, including catalogue titles that TMDB never dates as a Spanish release.
Arrival dates are detection dates: an arrival can be up to a week late, and it is shown
as already available, never as an announcement.

- **Provider ids.** `GET /watch/providers/movie?watch_region=ES&language=es-ES`; each
  provider whose `provider_name` matches an alias (§5) adds its `provider_id` to that
  platform's id set.
- **Catalogue query, one per platform** with at least one id: `GET /discover/movie` with
  `language=es-ES`, `watch_region=ES`, `with_watch_providers=<ids joined by |>`,
  `with_watch_monetization_types=flatrate`, `with_genres=27`,
  `primary_release_date.gte=<today − ARRIVAL_MAX_AGE_YEARS years>`,
  `sort_by=primary_release_date.desc`, `page=<n>`, up to `ARRIVAL_MAX_PAGES`. The date is
  a UTC calendar subtraction of whole years (29 February maps to 28 February); the
  cut-off moves daily, which is harmless. A pagination cut → `::warning::` and a partial
  diff for that platform: new arrivals only among the ids actually read, and its new set
  is the union of the previous set and the ids read (unread ids are never treated as
  removed).
- **Snapshot** `output/providers-snapshot.json`, published next to `releases.json`:

  ```json
  {
    "schema": 1,
    "generated": "2026-11-02T06:03:00.000Z",
    "region": "ES",
    "maxAgeYears": 3,
    "platforms": { "netflix": [ 1422096, 852485 ], "movistar-plus": [ 1193501 ] },
    "arrivals": [ { "id": 1422096, "platform": "netflix", "detected": "2026-11-02", "title": "Good Boy" } ]
  }
  ```

  `platforms` lists, per platform, the sorted ids of its current set. A platform that
  could not be diffed this build (query failure, empty-set guard) carries its previous
  set forward unchanged; it is omitted only when there was no previous set either.
  `arrivals` lists the arrivals detected inside `arrivalWindow` (`title` included, for
  logs only), so that they survive later builds. The snapshot is written on **every**
  run that writes `releases.json`, seed mode and partial failures included, so that the
  deploy can always copy it.
- **Previous snapshot.** Read from `SNAPSHOT_URL` (the published copy) at the start of
  the run. Empty variable, network error, non-200, invalid JSON, other `schema` or other
  `region`/`maxAgeYears` → **seed mode**: no new arrivals this build, plain log line (a
  `::warning::` when `SNAPSHOT_URL` was set), and the new snapshot is written normally.
- **Diff, per platform.** New arrivals = ids in the current set and not in the previous
  set. A platform missing from the previous snapshot is seeded (no arrivals). A current
  set that is empty while the previous one was not → `::warning::`, previous set kept,
  no arrivals. More than `ARRIVAL_MAX_PER_PLATFORM` new ids → `::warning::`, no arrivals
  for that platform this week, current set accepted as the new baseline.
- **New arrivals** get the detail request of §7 (runtime rule applies) and become
  releases with `type: "arrival"`, `source: "providers"`, `releaseDate` = today,
  `arrivalPlatform` = slug, `calendars: [slug]`, empty providers and `releaseNote: null`.
  Arrivals carried over from the previous snapshot keep their `detected` date and are
  rebuilt with a detail request; those older than `arrivalWindow.from` are dropped.
- **Best effort.** Any failure in this section (provider list, catalogue query, details)
  → `::warning::` and the build continues with whatever arrivals it has (carried-over
  ones included). Arrivals never cause a non-zero exit.
