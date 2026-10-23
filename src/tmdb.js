// TMDB client for the Spanish regional horror releases (docs/data-model.md §2 and §7).
//
// Two discover/movie queries (theatrical 3|2 and digital 4) with region + release type,
// so that release_date is the Spanish date of that type. Digital releases get
// watch/providers (flatrate vs rent/buy) and release_dates (Spanish type-4 note).
// Everything that touches the network goes through an injectable fetch, clock and sleep.

const { matchPlatform } = require('./platforms');

const BASE_URL = 'https://api.themoviedb.org/3';
const HORROR_GENRE_ID = '27';
const DIGITAL_RELEASE_TYPE = 4;

const QUERIES = [
  { type: 'theatrical', releaseType: '3|2' },
  { type: 'digital', releaseType: '4' },
];

const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_MAX_PAGES = 5;
const DETAIL_CONCURRENCY = 5;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_DETAIL_FAILURE_RATE = 0.2;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

class TmdbError extends Error {}

/**
 * Escapes the message of a GitHub Actions workflow command (`::warning::<message>`), so
 * that a title or note with a line break cannot cut or forge an annotation.
 * @param {string} message
 * @returns {string}
 */
function escapeCommand(message) {
  return String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Parses an integer setting with a default; invalid values fall back with a warning.
 * @returns {number}
 */
function parseIntSetting(value, fallback, { min, max, name }, warn) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const parsed = Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    warn(`${name}="${value}" is not an integer between ${min} and ${max}; using ${fallback}.`);
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

/**
 * Resolves the run settings from the environment and the clock (dates in UTC).
 * @returns {{ apiKey: string, language: string, region: string, windowDays: number,
 *   maxPages: number, from: string, to: string }}
 */
function resolveSettings(env = {}, now = new Date(), warn = console.warn) {
  const windowDays = parseIntSetting(env.WINDOW_DAYS, DEFAULT_WINDOW_DAYS,
    { min: 1, max: 366, name: 'WINDOW_DAYS' }, warn);
  const maxPages = parseIntSetting(env.MAX_PAGES, DEFAULT_MAX_PAGES,
    { min: 1, max: 20, name: 'MAX_PAGES' }, warn);
  return {
    apiKey: String(env.TMDB_API_KEY ?? '').trim(),
    language: String(env.TMDB_LANGUAGE ?? '').trim() || 'es-ES',
    region: String(env.TMDB_REGION ?? '').trim().toUpperCase() || 'ES',
    windowDays,
    maxPages,
    from: isoDate(now),
    to: isoDate(addDays(now, windowDays)),
  };
}

/** Delay in ms from a Retry-After header (seconds or HTTP date), or null. */
function retryAfterMs(header, now = Date.now()) {
  if (header === null || header === undefined || String(header).trim() === '') return null;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/**
 * GET helper with retries on 429, 5xx and network errors (up to MAX_RETRIES), honouring
 * Retry-After and falling back to exponential backoff. Error messages never carry the key.
 */
function createClient({ fetchImpl, apiKey, sleep }) {
  return async function get(pathname, params = {}) {
    const url = new URL(`${BASE_URL}${pathname}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const label = `${url.pathname.replace(/^\/3/, '')}${url.search}`;
    url.searchParams.set('api_key', apiKey);

    for (let attempt = 0; ; attempt += 1) {
      let response = null;
      let failure;
      try {
        response = await fetchImpl(url.toString());
      } catch (err) {
        failure = `network error (${String(err?.message || err).split(apiKey).join('***')})`;
      }

      if (response?.ok) {
        try {
          return await response.json();
        } catch {
          throw new TmdbError(`TMDB ${label} did not return JSON`);
        }
      }

      const status = response?.status;
      const retryable = response === null || status === 429 || status >= 500;
      if (response) {
        failure = `HTTP ${status}`;
        // Release the unread body before retrying or failing (some mocks have no body)
        try {
          await response.body?.cancel?.();
        } catch {
          // Nothing to release
        }
      }
      if (!retryable || attempt >= MAX_RETRIES) {
        const tries = attempt + 1;
        throw new TmdbError(`TMDB ${label} failed: ${failure} after ${tries} attempt${tries === 1 ? '' : 's'}`);
      }
      const delay = retryAfterMs(response?.headers?.get?.('retry-after')) ?? BASE_BACKOFF_MS * 2 ** attempt;
      await sleep(delay);
    }
  };
}

/** Runs fn over items with at most `limit` promises in flight; keeps input order. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

function uniqueNames(entries, seen = new Set()) {
  const names = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const name = text(entry?.provider_name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }
  return names;
}

/**
 * Splits watch/providers for the region into included (flatrate) and rent/buy.
 * ads/free tiers count as included only when they are aliases of a configured platform.
 * @returns {{ flatrate: string[], rentBuy: string[] }}
 */
function parseProviders(body, region) {
  const regional = body?.results?.[region];
  if (!regional || typeof regional !== 'object') return { flatrate: [], rentBuy: [] };
  const included = new Set();
  const flatrate = uniqueNames(regional.flatrate, included);
  const tiers = uniqueNames([...(regional.ads ?? []), ...(regional.free ?? [])], included)
    .filter((name) => matchPlatform(name) !== null);
  const rentBuy = uniqueNames([...(Array.isArray(regional.rent) ? regional.rent : []),
    ...(Array.isArray(regional.buy) ? regional.buy : [])]);
  return { flatrate: [...flatrate, ...tiers], rentBuy };
}

/**
 * Note of the regional type-4 (digital) release whose day equals releaseDate; when no
 * type-4 date has that day, the first type-4 date with a non-empty note. Other types
 * (premieres, festivals) are ignored. Trimmed; empty → null.
 * @returns {string|null}
 */
function parseReleaseNote(body, region, releaseDate) {
  const results = Array.isArray(body?.results) ? body.results : [];
  const entry = results.find((r) => r?.iso_3166_1 === region);
  const dates = (Array.isArray(entry?.release_dates) ? entry.release_dates : [])
    .filter((d) => Number(d?.type) === DIGITAL_RELEASE_TYPE);
  const sameDay = dates.find((d) => typeof d?.release_date === 'string' && d.release_date.slice(0, 10) === releaseDate);
  const chosen = sameDay ?? dates.find((d) => text(d?.note) !== '');
  return text(chosen?.note) || null;
}

function toRelease(movie, type) {
  const title = text(movie.title) || text(movie.original_title);
  return {
    id: movie.id,
    title,
    originalTitle: text(movie.original_title) || title,
    releaseDate: movie.release_date,
    type,
    providers: { flatrate: [], rentBuy: [] },
    releaseNote: null,
    posterPath: text(movie.poster_path) || null,
    overview: text(movie.overview),
    tmdbUrl: `https://www.themoviedb.org/movie/${movie.id}`,
  };
}

function compareReleases(a, b) {
  if (a.releaseDate !== b.releaseDate) return a.releaseDate < b.releaseDate ? -1 : 1;
  return a.title.localeCompare(b.title, 'es') || a.type.localeCompare(b.type) || a.id - b.id;
}

/**
 * Queries TMDB and returns the releases plus run metadata.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - fetch implementation
 * @param {Date} [options.now] - Clock; the window starts on its UTC day
 * @param {object} [options.env] - Environment variables
 * @param {Function} [options.sleep] - Delay between retries, (ms) => Promise
 * @param {Function} [options.log] - Info output (also ::warning:: annotations)
 * @param {Function} [options.warn] - Configuration warnings
 * @returns {Promise<{ releases: object[], region: string, window: { from: string, to: string },
 *   details: { total: number, failed: number } }>}
 */
async function fetchHorrorReleases({
  fetchImpl = globalThis.fetch,
  now = new Date(),
  env = process.env,
  sleep = defaultSleep,
  log = console.log,
  warn = (message) => log(`::warning::${escapeCommand(message)}`),
} = {}) {
  const settings = resolveSettings(env, now, warn);
  const { apiKey, language, region, maxPages, from, to } = settings;
  if (!apiKey) throw new TmdbError('TMDB_API_KEY is not set. Copy .env.example to .env and add your key.');

  const get = createClient({ fetchImpl, apiKey, sleep });

  // 1. Discover: one query per release type, paginated up to MAX_PAGES
  const releases = [];
  for (const query of QUERIES) {
    const params = {
      language,
      region,
      with_genres: HORROR_GENRE_ID,
      'release_date.gte': from,
      'release_date.lte': to,
      with_release_type: query.releaseType,
    };
    const seen = new Set();
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, maxPages); page += 1) {
      const data = await get('/discover/movie', { ...params, page });
      if (page === 1) {
        const reported = Number(data?.total_pages);
        totalPages = Number.isInteger(reported) && reported > 0 ? reported : 1;
        if (totalPages > maxPages) {
          log(`::warning::${escapeCommand(`TMDB query ${query.type} (with_release_type=${query.releaseType}) has `
            + `total_pages=${totalPages} but MAX_PAGES=${maxPages}: only the first ${maxPages} pages were read.`)}`);
        }
      }
      for (const movie of Array.isArray(data?.results) ? data.results : []) {
        if (!Number.isInteger(movie?.id) || seen.has(movie.id)) continue;
        // First occurrence wins, even when it is then dropped by the window check
        seen.add(movie.id);
        // Strict inclusion: a Spanish date of this type inside the window, or nothing
        const date = movie.release_date;
        if (typeof date !== 'string' || !ISO_DATE.test(date) || date < from || date > to) continue;
        releases.push(toRelease(movie, query.type));
      }
    }
  }

  if (releases.length === 0) {
    throw new TmdbError(`Both TMDB discover queries returned 0 releases for ${region} ${from} → ${to}; `
      + 'refusing to publish empty calendars.');
  }

  // 2. Details: providers and release note (digital only), English overview fallback
  const details = { total: 0, failed: 0 };
  const englishOverviews = new Map();
  const tasks = [];
  for (const release of releases) {
    if (release.type === 'digital') {
      tasks.push({
        path: `/movie/${release.id}/watch/providers`,
        apply: (body) => { release.providers = parseProviders(body, region); },
      });
      tasks.push({
        path: `/movie/${release.id}/release_dates`,
        apply: (body) => { release.releaseNote = parseReleaseNote(body, region, release.releaseDate); },
      });
    }
    if (!release.overview) {
      if (!englishOverviews.has(release.id)) {
        englishOverviews.set(release.id, []);
        tasks.push({
          path: `/movie/${release.id}`,
          params: { language: 'en-US' },
          apply: (body) => {
            for (const target of englishOverviews.get(release.id)) target.overview = text(body?.overview);
          },
        });
      }
      englishOverviews.get(release.id).push(release);
    }
  }

  await mapPool(tasks, DETAIL_CONCURRENCY, async (task) => {
    details.total += 1;
    try {
      task.apply(await get(task.path, task.params));
    } catch (err) {
      // A failed detail leaves its data empty; the release itself is kept
      details.failed += 1;
      log(`Detail request failed: ${err?.message || err}`);
    }
  });

  log(`Detail requests: ${details.total}, failed: ${details.failed}.`);
  if (details.total > 0 && details.failed / details.total > MAX_DETAIL_FAILURE_RATE) {
    throw new TmdbError(`${details.failed} of ${details.total} TMDB detail requests failed `
      + `(more than ${MAX_DETAIL_FAILURE_RATE * 100} %); refusing to publish partial calendars.`);
  }

  releases.sort(compareReleases);
  return { releases, region, window: { from, to }, details };
}

/**
 * Spanish horror releases (data model §2) without `calendars`.
 * Same options as fetchHorrorReleases.
 * @returns {Promise<object[]>}
 */
async function getHorrorReleases(options = {}) {
  return (await fetchHorrorReleases(options)).releases;
}

module.exports = {
  getHorrorReleases,
  fetchHorrorReleases,
  escapeCommand,
  resolveSettings,
  parseProviders,
  parseReleaseNote,
  retryAfterMs,
  TmdbError,
  QUERIES,
  DETAIL_CONCURRENCY,
  MAX_RETRIES,
};
