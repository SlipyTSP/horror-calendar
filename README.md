# horror-calendar

Subscribable iCalendar feeds with the **horror movie releases in Spain**: what opens in
Spanish cinemas and what arrives on the streaming platforms available in Spain. The data
comes from [TMDB](https://www.themoviedb.org/), it is refreshed every Monday and published
on GitHub Pages together with a small web page to pick the calendars.

**Live page:** <https://slipytsp.github.io/horror-calendar/>

## What you can subscribe to

Every build publishes one calendar per audience, so you subscribe only to what you can
actually watch:

| Calendar | File | Contents |
|---|---|---|
| Cines | `horror-cines.ics` | Theatrical releases in Spain |
| Netflix, Prime Video, HBO Max, Movistar Plus+, Filmin, Disney+, SkyShowtime, Apple TV+ | `horror-<platform>.ics` | Digital releases announced for that platform (Spanish release note, curated press list) or included in its subscription, plus the horror movies that have just **arrived** in its catalogue (🆕) |
| Digital | `horror-digital.ics` | Every digital release in Spain, whatever the platform (no arrivals) |
| Todo | `horror.ics` | Every release (cinemas + digital, no arrivals). Kept for existing subscribers |

Rules that shape the calendars:

- Only movies with a **Spanish** release date of that type inside the next 90 days, from
  TMDB or, for platform releases that TMDB does not date in Spain, from the curated list
  of Spanish press sources (`data/manual-releases.json`). Dates from other countries are
  never used.
- Only feature films: 40 minutes or more, or without a runtime in TMDB but with an IMDb
  id. Shorts and one-off local screenings are left out.
- A movie released in cinemas and later on a platform gives two events.
- Rent and buy offers are shown in the description but never count as "included".
- Events are all-day, with the synopsis, where to watch it (and the press source for
  curated releases) and a link to TMDB.
- Event identifiers are stable: a date change in TMDB moves the event instead of
  duplicating it.

### Platform arrivals

Many horror movies reach a platform without any Spanish release date in TMDB: catalogue
titles, streaming windows after a theatrical run. Every build compares the flatrate
horror catalogue of each platform in Spain (movies of the last 3 years) with the one
published the week before (`providers-snapshot.json`, next to the calendars) and adds
the movies that are new in it as **arrival** events (🆕, "Ya disponible en: …") to that
platform's calendar only, for 30 days.

- An arrival is dated on the day the build **detected** it. Builds run weekly, so an
  arrival can show up to a week after the movie actually became available: it is shown as
  already available, never as an announcement.
- A movie whose digital release was already announced (TMDB date or curated entry) does
  not get a second, arrival event.
- The first build after this feature is deployed, and any build that cannot read the
  previous snapshot, runs in **seed mode**: it records the catalogues and reports no
  arrivals (a warning in the log says so). Arrivals start with the next build.
- Safety nets: an empty catalogue keeps the previous one, more than 25 new titles on a
  platform in one week publishes none (a TMDB glitch is more likely than a real flood),
  and a catalogue that cannot be read in full is only diffed on what was read.

## Usage

Open the [published page](https://slipytsp.github.io/horror-calendar/) and tick the
calendars you want; each one has a subscribe button
(`webcal://`) and a copyable URL. On iOS: *Settings → Calendar → Accounts → Add Account →
Other → Add Subscribed Calendar* and paste the URL. Calendar apps refresh the feeds about
once a day; the data itself is rebuilt every Monday at 06:00 UTC. The page also lists the
upcoming releases and the recent platform arrivals of your selection, grouped by month, with
their TMDB posters.

## Configuration

Environment variables (`.env` locally, repository secrets and workflow `env` in CI):

| Variable | Default | Meaning |
|---|---|---|
| `TMDB_API_KEY` | — (required) | TMDB API v3 key |
| `TMDB_LANGUAGE` | `es-ES` | Language of titles and synopses |
| `TMDB_REGION` | `ES` | Region of release dates and providers |
| `WINDOW_DAYS` | `90` | Days ahead to look for releases (integer 1–366) |
| `MAX_PAGES` | `5` | Discover pages read per query (integer 1–20) |
| `MIN_RUNTIME` | `40` | Runtime rule in minutes (integer 0–300; `0` disables it) |
| `MANUAL_RELEASES_FILE` | `data/manual-releases.json` | Curated manual releases (relative to the repository root) |
| `SNAPSHOT_URL` | empty | `https://` URL of the previous `providers-snapshot.json`; empty → seed mode |
| `ARRIVAL_DAYS` | `30` | Days an arrival stays in the calendars (integer 1–90) |
| `ARRIVAL_MAX_AGE_YEARS` | `3` | Age limit of the catalogue watched for arrivals (integer 1–20) |
| `ARRIVAL_MAX_PAGES` | `50` | Discover pages read per platform for arrivals (integer 1–100) |
| `ARRIVAL_MAX_PER_PLATFORM` | `25` | More new titles than this on one platform in one build → none published (integer 1–500) |

Invalid numbers fall back to the default with a warning. Platforms and their TMDB
provider aliases live in `src/platforms.js`. Both workflows set `SNAPSHOT_URL` to the
published copy (`https://slipytsp.github.io/horror-calendar/providers-snapshot.json`).

## Curated manual releases (owner)

`data/manual-releases.json` lists Spanish digital releases that TMDB does not date in
Spain, taken from the Spanish press. Add an entry per movie, by hand or through a pull
request that you review:

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

- `id`: the TMDB movie id (the number in `themoviedb.org/movie/<id>`).
- `releaseDate`: the **Spanish** date of the platform release, `YYYY-MM-DD`.
- `platform`: a slug of `src/platforms.js` (`netflix`, `prime-video`, `hbo-max`,
  `movistar-plus`, `filmin`, `disney-plus`, `skyshowtime`, `apple-tv-plus`).
- `sourceUrl`: the `https://` URL of the press article; it goes into the event
  description as `Fuente:` (it is not shown on the web page).
- `comment`: optional note for you; never published.

One entry per movie. Entries outside the 90-day window are ignored, so past entries can
stay as history. When TMDB later dates the same digital release, TMDB wins: the manual
entry is no longer published on its own, its platform is still added to the event, and
the build warns if the two dates differ (same event UID, so subscribers see an update,
not a duplicate). An invalid entry (unknown platform, non-https URL, repeated id…) is
skipped with a warning in the build log; the file never makes the build fail. The
runtime rule applies to these entries too.

## Architecture

```
src/tmdb.js       two regional discover/movie queries (theatrical 3|2, digital 4), one
                  detail request per movie, runtime rule
src/manual.js     curated manual releases (data/manual-releases.json)
src/arrivals.js   weekly providers diff → platform arrivals + providers snapshot
src/platforms.js  platform config; calendar membership of every release
src/calendar.js   one RFC 5545 VCALENDAR per calendar
src/index.js      writes output/*.ics, output/releases.json, output/providers-snapshot.json
data/             owner's curated manual releases
site/             static page that reads releases.json (no build, no framework)
site/assets/      favicon, Apple touch icon and Open Graph image
site/fonts/       self-hosted Creepster display font (woff2) and its OFL license
```

The data contract between the Node side and the web is `docs/data-model.md`; the phase
plan is `docs/phases.md`. The build fails (and nothing is published) when TMDB returns
no releases, when a discover request fails, or when more than 20 % of the detail requests
of the TMDB releases fail. Manual releases and arrivals are best effort: their problems
are warnings in the log, never a failed build.

## Development

Requires Node.js 20 or later (CI uses Node 24).

```bash
npm ci                      # install dependencies from the lockfile
cp .env.example .env        # then set TMDB_API_KEY in .env (never commit it)
npm test                    # unit tests (node --test), no network needed
npm start                   # query TMDB and write output/*.ics, releases.json and providers-snapshot.json
node scripts/summary.js     # print output/releases.json as Markdown tables (source, runtime, arrivals)
```

**Capturing TMDB fixtures.** With `TMDB_API_KEY` in `.env` (or exported), run
`node scripts/capture-fixtures.js` once. It performs the regional discover queries,
`watch/providers`, `release_dates` and English details requests described in
`docs/data-model.md` §7 and writes the raw responses plus `manifest.json` to
`tests/fixtures/tmdb/`. It does not retry: on any error (including HTTP 429) it writes
nothing and exits with code 1, so just re-run it later. The key is never written to any
file or log. It prints the provider names and the type-4 release notes seen in the
region, to check the aliases in `src/platforms.js`. Review the files and commit them.
Hand-written fixtures for cases the capture does not cover live in
`tests/fixtures/tmdb/synthetic/`.

**Local web preview.** The page lives in `site/`. Copy the sample data next to it and serve
the folder with any static server:

```bash
cp tests/fixtures/releases.sample.json site/releases.json
npx --yes serve site        # or: python3 -m http.server -d site
```

`site/releases.json` and `site/*.ics` are git-ignored local copies.

## Data attribution

This product uses the TMDB API but is not endorsed or certified by TMDB. Movie data,
release dates, providers, synopses and poster images come from
[The Movie Database](https://www.themoviedb.org/); posters are loaded from TMDB's image
servers and are not stored in this repository. Streaming availability (the platform
providers and the arrivals) comes from TMDB's watch-provider data, which is provided by
[JustWatch](https://www.justwatch.com/); TMDB's terms require crediting JustWatch, so the
web page credits both in its footer.

## License

Code: [MIT](LICENSE).

The Creepster font in `site/fonts/` is © 2011 Font Diner, Inc and is distributed under the
[SIL Open Font License 1.1](site/fonts/OFL.txt), not under the MIT license.
