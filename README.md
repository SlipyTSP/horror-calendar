# horror-calendar
Auto-updated ICS calendar with horror movie releases

## Development

Requires Node.js 20 or later (CI uses Node 24).

```bash
npm ci                      # install dependencies from the lockfile
cp .env.example .env        # then set TMDB_API_KEY in .env (never commit it)
npm test                    # unit tests (node --test), no network needed
npm start                   # query TMDB and write output/horror.ics and output/releases.json
node scripts/summary.js     # print output/releases.json as a Markdown table
```

**Capturing TMDB fixtures.** With `TMDB_API_KEY` in `.env` (or exported), run
`node scripts/capture-fixtures.js` once. It performs the regional discover queries,
`watch/providers` and English details requests described in `docs/data-model.md` §7 and
writes the raw responses plus `manifest.json` to `tests/fixtures/tmdb/`. It does not retry:
on any error (including HTTP 429) it writes nothing and exits with code 1, so just re-run
it later. The key is never written to any file or log. Review the files and commit them.

**Local web preview.** The page lives in `site/`. Copy the sample data next to it and serve
the folder with any static server:

```bash
cp tests/fixtures/releases.sample.json site/releases.json
npx --yes serve site        # or: python3 -m http.server -d site
```

`site/releases.json` and `site/*.ics` are git-ignored local copies.
