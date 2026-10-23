// Captures real TMDB responses as test fixtures (run once by the owner, with a key):
//
//   node scripts/capture-fixtures.js
//
// Requests (docs/data-model.md §7), sequential and without retries:
//   - discover/movie for the theatrical (3|2) and digital (4) queries, pages 1 and 2
//   - movie/{id}/watch/providers for up to 12 ids (first six of each query)
//   - movie/{id}?language=en-US for the first three of those ids
// Bodies are written as received to tests/fixtures/tmdb/<fixtureName>.json, plus
// manifest.json. Nothing is written unless every request succeeds. The API key never
// appears in file names, contents, logs or the manifest.

const fs = require('fs');
const path = require('path');
const { requestKey, fixtureName } = require('../tests/support/fixture-name');

const BASE_URL = 'https://api.themoviedb.org/3';
const DEFAULT_OUT_DIR = path.join(__dirname, '..', 'tests', 'fixtures', 'tmdb');
const HORROR_GENRE_ID = '27';
const PAGES = [1, 2];
const PROVIDER_IDS_PER_QUERY = 6;
const ENGLISH_DETAILS = 3;
const DEFAULT_WINDOW_DAYS = 90;

const QUERIES = [
  { name: 'theatrical', releaseType: '3|2' },
  { name: 'digital', releaseType: '4' },
];

/**
 * Parses an integer from the environment with a default and a warning.
 * @returns {number}
 */
function parseIntEnv(value, fallback, { min, max, name }, warn) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    warn(`capture: ${name}="${value}" is not an integer between ${min} and ${max}; using ${fallback}.`);
    return fallback;
  }
  return parsed;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

class CaptureError extends Error {}

/**
 * Runs the capture. Returns the exit code (0 on success, 1 on any failure).
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - fetch implementation
 * @param {object} [options.env] - Environment variables
 * @param {string} [options.outDir] - Destination directory
 * @param {Date} [options.now] - Capture date (defaults to the current time)
 * @param {Function} [options.log] - Info output
 * @param {Function} [options.error] - Error output
 * @returns {Promise<number>}
 */
async function capture({
  fetchImpl = globalThis.fetch,
  env = process.env,
  outDir = DEFAULT_OUT_DIR,
  now = new Date(),
  log = console.log,
  error = console.error,
} = {}) {
  const apiKey = String(env?.TMDB_API_KEY ?? '').trim();
  // Every message goes through redact() so the key cannot leak, even from fetch errors
  const redact = (text) => (apiKey ? String(text).split(apiKey).join('***') : String(text));
  const say = (text) => log(redact(text));
  const fail = (text) => error(redact(text));

  if (!apiKey) {
    fail('capture: TMDB_API_KEY is not set. Add it to .env (see .env.example) or export it, then re-run.');
    return 1;
  }

  const language = env.TMDB_LANGUAGE || 'es-ES';
  const region = env.TMDB_REGION || 'ES';
  const windowDays = parseIntEnv(env.WINDOW_DAYS, DEFAULT_WINDOW_DAYS,
    { min: 1, max: 366, name: 'WINDOW_DAYS' }, fail);
  const from = isoDate(now);
  const to = isoDate(addDays(now, windowDays));

  const files = new Map(); // file name -> raw body
  const requests = [];

  async function get(pathname, params = {}) {
    const url = new URL(`${BASE_URL}${pathname}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const key = requestKey(url);
    url.searchParams.set('api_key', apiKey);

    let response;
    try {
      response = await fetchImpl(url.toString());
    } catch (err) {
      throw new CaptureError(`request ${key} failed: ${err?.message || err}`);
    }
    if (!response.ok) {
      const hint = response.status === 429 ? ' (rate limited; wait a minute and re-run)' : '';
      throw new CaptureError(`request ${key} returned HTTP ${response.status}${hint}. No retries; nothing written.`);
    }
    const body = await response.text();
    let json;
    try {
      json = JSON.parse(body);
    } catch {
      throw new CaptureError(`request ${key} did not return JSON.`);
    }

    const file = fixtureName(key);
    files.set(file, body);
    requests.push({ file, path: pathname, params: { ...params }, status: response.status });
    return json;
  }

  const queries = {};
  const providerNames = new Map(); // provider_name -> Set of categories

  try {
    for (const query of QUERIES) {
      const summary = {
        with_release_type: query.releaseType,
        total_results: null,
        total_pages: null,
        pages: [],
        results: 0,
        ids: [],
      };
      for (const page of PAGES) {
        if (page > 1 && Number(summary.total_pages ?? 0) < page) break;
        const data = await get('/discover/movie', {
          language,
          region,
          with_genres: HORROR_GENRE_ID,
          'release_date.gte': from,
          'release_date.lte': to,
          with_release_type: query.releaseType,
          page,
        });
        if (page === 1) {
          summary.total_results = Number.isFinite(Number(data?.total_results)) ? Number(data.total_results) : null;
          summary.total_pages = Number.isFinite(Number(data?.total_pages)) ? Number(data.total_pages) : null;
        }
        const results = Array.isArray(data?.results) ? data.results : [];
        summary.pages.push(page);
        summary.results += results.length;
        for (const movie of results) {
          if (movie?.id !== undefined && movie?.id !== null) summary.ids.push(movie.id);
        }
      }
      queries[query.name] = summary;
    }

    const ids = [];
    for (const summary of Object.values(queries)) {
      for (const id of summary.ids.slice(0, PROVIDER_IDS_PER_QUERY)) {
        if (!ids.includes(id)) ids.push(id);
      }
    }

    for (const id of ids) {
      const data = await get(`/movie/${id}/watch/providers`);
      const regional = data?.results?.[region];
      if (regional && typeof regional === 'object') {
        for (const [category, entries] of Object.entries(regional)) {
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            if (!entry?.provider_name) continue;
            if (!providerNames.has(entry.provider_name)) providerNames.set(entry.provider_name, new Set());
            providerNames.get(entry.provider_name).add(category);
          }
        }
      }
    }

    for (const id of ids.slice(0, ENGLISH_DETAILS)) {
      await get(`/movie/${id}`, { language: 'en-US' });
    }
  } catch (err) {
    if (!(err instanceof CaptureError)) throw err;
    fail(`capture: ${err.message}`);
    return 1;
  }

  const manifest = {
    capturedAt: now.toISOString(),
    window: { from, to, days: windowDays },
    language,
    region,
    queries: Object.fromEntries(Object.entries(queries).map(([name, q]) => [name, {
      with_release_type: q.with_release_type,
      total_results: q.total_results,
      total_pages: q.total_pages,
      pages: q.pages,
    }])),
    requests,
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  // Last line of defence: refuse to write anything that contains the key
  for (const [file, body] of [...files, ['manifest.json', manifestText]]) {
    if (file.includes(apiKey) || body.includes(apiKey)) {
      fail(`capture: refusing to write ${redact(file)}: it contains the API key.`);
      return 1;
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const [file, body] of files) fs.writeFileSync(path.join(outDir, file), body, 'utf-8');
  fs.writeFileSync(path.join(outDir, 'manifest.json'), manifestText, 'utf-8');

  say(`Captured ${files.size} responses into ${outDir} (window ${from} → ${to}).`);
  for (const [name, q] of Object.entries(queries)) {
    say(`  ${name} (with_release_type=${q.with_release_type}): ${q.results} results in pages `
      + `${q.pages.join(', ')}; total_results=${q.total_results ?? '?'}, total_pages=${q.total_pages ?? '?'}`);
  }
  const names = [...providerNames.keys()].sort((a, b) => a.localeCompare(b));
  say(`Distinct provider_name values in region ${region} (${names.length}):`);
  for (const name of names) say(`  - ${name} (${[...providerNames.get(name)].sort().join(', ')})`);
  return 0;
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  capture().then((code) => {
    process.exitCode = code;
  }, (err) => {
    // Unexpected bug: print only the message, never the request URL
    const key = String(process.env.TMDB_API_KEY ?? '').trim();
    const message = String(err?.message || err);
    console.error(`capture: unexpected error: ${key ? message.split(key).join('***') : message}`);
    process.exitCode = 1;
  });
}

module.exports = { capture, DEFAULT_OUT_DIR };
