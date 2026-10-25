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
| Netflix, Prime Video, HBO Max, Movistar Plus+, Filmin, Disney+, SkyShowtime, Apple TV+ | `horror-<platform>.ics` | Digital releases announced for that platform (Spanish release note) or included in its subscription |
| Digital | `horror-digital.ics` | Every digital release in Spain, whatever the platform |
| Todo | `horror.ics` | Everything (cinemas + digital). Kept for existing subscribers |

Rules that shape the calendars:

- Only movies with a **Spanish** release date of that type inside the next 90 days.
- A movie released in cinemas and later on a platform gives two events.
- Rent and buy offers are shown in the description but never count as "included".
- Events are all-day, with the synopsis, where to watch it and a link to TMDB.
- Event identifiers are stable: a date change in TMDB moves the event instead of
  duplicating it.

## Usage

Open the [published page](https://slipytsp.github.io/horror-calendar/) and tick the
calendars you want; each one has a subscribe button
(`webcal://`) and a copyable URL. On iOS: *Settings → Calendar → Accounts → Add Account →
Other → Add Subscribed Calendar* and paste the URL. Calendar apps refresh the feeds about
once a day; the data itself is rebuilt every Monday at 06:00 UTC. The page also lists the
upcoming releases grouped by month, with their TMDB posters.

## Configuration

Environment variables (`.env` locally, repository secrets and workflow `env` in CI):

| Variable | Default | Meaning |
|---|---|---|
| `TMDB_API_KEY` | — (required) | TMDB API v3 key |
| `TMDB_LANGUAGE` | `es-ES` | Language of titles and synopses |
| `TMDB_REGION` | `ES` | Region of release dates and providers |
| `WINDOW_DAYS` | `90` | Days ahead to look for releases (integer 1–366) |
| `MAX_PAGES` | `5` | Discover pages read per query (integer 1–20) |

Invalid numbers fall back to the default with a warning. Platforms and their TMDB
provider aliases live in `src/platforms.js`.

## Architecture

```
src/tmdb.js       two regional discover/movie queries (theatrical 3|2, digital 4) + details
src/platforms.js  platform config; release note + flatrate → platform calendars
src/calendar.js   one RFC 5545 VCALENDAR per calendar
src/index.js      writes output/*.ics and output/releases.json
site/             static page that reads releases.json (no build, no framework)
site/assets/      favicon, Apple touch icon and Open Graph image
site/fonts/       self-hosted Creepster display font (woff2) and its OFL license
```

The data contract between the Node side and the web is `docs/data-model.md`; the phase
plan is `docs/phases.md`. The build fails (and nothing is published) when TMDB returns
no releases, when a discover request fails, or when more than 20 % of the detail requests
fail.

## Development

Requires Node.js 20 or later (CI uses Node 24).

```bash
npm ci                      # install dependencies from the lockfile
cp .env.example .env        # then set TMDB_API_KEY in .env (never commit it)
npm test                    # unit tests (node --test), no network needed
npm start                   # query TMDB and write output/*.ics and output/releases.json
node scripts/summary.js     # print output/releases.json as Markdown tables
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
servers and are not stored in this repository. Streaming availability in TMDB is provided
by JustWatch.

## License

Code: [MIT](LICENSE).

The Creepster font in `site/fonts/` is © 2011 Font Diner, Inc and is distributed under the
[SIL Open Font License 1.1](site/fonts/OFL.txt), not under the MIT license.
