// TMDB client for the Spanish regional horror releases (docs/data-model.md §2 and §7).
//
// Two discover/movie queries (theatrical 3|2 and digital 4) with region + release type,
// so that release_date is the Spanish date of that type. Every movie then gets one
// detail request (GET /movie/{id} with release_dates and watch/providers appended):
// runtime and imdb_id for the runtime rule, and for digital releases the flatrate vs
// rent/buy split and the Spanish type-4 note. The detail cache is shared with the manual
// releases and the arrivals (src/manual.js, src/arrivals.js), so a movie id is requested
// once per build. Everything that touches the network goes through an injectable fetch,
// clock and sleep.

const { matchPlatform } = require('./platforms');

const BASE_URL = 'https://api.themoviedb.org/3';
const HORROR_GENRE_ID = '27';
const DIGITAL_RELEASE_TYPE = 4;
const DETAIL_APPEND = 'release_dates,watch/providers';

const QUERIES = [
  { type: 'theatrical', releaseType: '3|2' },
  { type: 'digital', releaseType: '4' },
];

// Order of `type` for releases on the same day with the same title (§2)
const TYPE_ORDER = { theatrical: 0, digital: 1, arrival: 2 };

const DEFAULT_WINDOW_DAYS = 90;
const DEFAULT_MAX_PAGES = 5;
const DEFAULT_MIN_RUNTIME = 40;
const DEFAULT_MANUAL_RELEASES_FILE = 'data/manual-releases.json';
const DEFAULT_ARRIVAL_DAYS = 30;
const DEFAULT_ARRIVAL_MAX_AGE_YEARS = 3;
const DEFAULT_ARRIVAL_MAX_PAGES = 50;
const DEFAULT_ARRIVAL_MAX_PER_PLATFORM = 25;
const DETAIL_CONCURRENCY = 5;
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_DETAIL_FAILURE_RATE = 0.2;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

class TmdbError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.status = status;
  }
}

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
  const raw = value === undefined || value === null ? '' : String(value).trim();
  if (raw === '') return fallback;
  // Decimal integers only: "1e1", "0x10" or "10.5" are not accepted even if Number() reads them
  const parsed = /^-?\d+$/.test(raw) ? Number(raw) : NaN;
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
 * UTC calendar subtraction of whole years: same month and day, 29 February → 28 February.
 * @param {Date} date
 * @param {number} years
 * @returns {string} YYYY-MM-DD
 */
function subtractYears(date, years) {
  const year = date.getUTCFullYear() - years;
  const month = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return isoDate(new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay))));
}

/** True for a real calendar date written as YYYY-MM-DD. */
function isIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && isoDate(date) === value;
}

/**
 * Resolves the run settings from the environment and the clock (dates in UTC).
 * @returns {{ apiKey: string, language: string, region: string, windowDays: number,
 *   maxPages: number, from: string, to: string, today: string, minRuntime: number,
 *   manualFile: string, snapshotUrl: string, arrivalDays: number, arrivalMaxAgeYears: number,
 *   arrivalMaxPages: number, arrivalMaxPerPlatform: number,
 *   arrivalWindow: { from: string, to: string }, catalogueFrom: string }}
 */
function resolveSettings(env = {}, now = new Date(), warn = console.warn) {
  const int = (name, fallback, min, max) => parseIntSetting(env[name], fallback, { min, max, name }, warn);
  const windowDays = int('WINDOW_DAYS', DEFAULT_WINDOW_DAYS, 1, 366);
  const maxPages = int('MAX_PAGES', DEFAULT_MAX_PAGES, 1, 20);
  const minRuntime = int('MIN_RUNTIME', DEFAULT_MIN_RUNTIME, 0, 300);
  const arrivalDays = int('ARRIVAL_DAYS', DEFAULT_ARRIVAL_DAYS, 1, 90);
  const arrivalMaxAgeYears = int('ARRIVAL_MAX_AGE_YEARS', DEFAULT_ARRIVAL_MAX_AGE_YEARS, 1, 20);
  const arrivalMaxPages = int('ARRIVAL_MAX_PAGES', DEFAULT_ARRIVAL_MAX_PAGES, 1, 100);
  const arrivalMaxPerPlatform = int('ARRIVAL_MAX_PER_PLATFORM', DEFAULT_ARRIVAL_MAX_PER_PLATFORM, 1, 500);
  const today = isoDate(now);
  return {
    apiKey: String(env.TMDB_API_KEY ?? '').trim(),
    language: String(env.TMDB_LANGUAGE ?? '').trim() || 'es-ES',
    region: String(env.TMDB_REGION ?? '').trim().toUpperCase() || 'ES',
    windowDays,
    maxPages,
    from: today,
    to: isoDate(addDays(now, windowDays)),
    today,
    minRuntime,
    manualFile: String(env.MANUAL_RELEASES_FILE ?? '').trim() || DEFAULT_MANUAL_RELEASES_FILE,
    snapshotUrl: String(env.SNAPSHOT_URL ?? '').trim(),
    arrivalDays,
    arrivalMaxAgeYears,
    arrivalMaxPages,
    arrivalMaxPerPlatform,
    arrivalWindow: { from: isoDate(addDays(now, -arrivalDays)), to: today },
    catalogueFrom: subtractYears(now, arrivalMaxAgeYears),
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
        throw new TmdbError(`TMDB ${label} failed: ${failure} after ${tries} attempt${tries === 1 ? '' : 's'}`,
          { status: status ?? null });
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

/**
 * Days (YYYY-MM-DD) of the regional release dates of one type, in TMDB order.
 * @returns {string[]}
 */
function parseTypeDates(body, region, type) {
  const results = Array.isArray(body?.results) ? body.results : [];
  const entry = results.find((r) => r?.iso_3166_1 === region);
  return (Array.isArray(entry?.release_dates) ? entry.release_dates : [])
    .filter((d) => Number(d?.type) === type && typeof d?.release_date === 'string')
    .map((d) => d.release_date.slice(0, 10))
    .filter(isIsoDate);
}

/** Runtime in minutes; 0, negative or non-numeric → null (§2). */
function parseRuntime(value) {
  const n = Number(value);
  return value !== null && value !== '' && Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/**
 * The fields used from `GET /movie/{id}?append_to_response=release_dates,watch/providers`.
 * Every TMDB field is optional; garbage gives empty values, never an exception.
 * @returns {{ id: number|null, title: string, originalTitle: string, overview: string,
 *   posterPath: string|null, runtime: number|null, imdbId: string|null,
 *   releaseDates: object|null, providers: object|null }}
 */
function parseDetail(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return {
    id: Number.isInteger(b.id) ? b.id : null,
    title: text(b.title),
    originalTitle: text(b.original_title),
    overview: text(b.overview),
    posterPath: text(b.poster_path) || null,
    runtime: parseRuntime(b.runtime),
    imdbId: text(b.imdb_id) || null,
    releaseDates: b.release_dates ?? null,
    providers: b['watch/providers'] ?? null,
  };
}

/**
 * Runtime rule (§2): runtime >= minRuntime, or no runtime but an imdb_id.
 * minRuntime 0 disables the whole rule.
 * @param {{ runtime: number|null, imdbId: string|null }} detail
 * @param {number} minRuntime
 * @returns {boolean}
 */
function passesRuntimeRule(detail, minRuntime) {
  if (minRuntime === 0) return true;
  if (detail?.runtime !== null && detail?.runtime !== undefined) return detail.runtime >= minRuntime;
  return Boolean(detail?.imdbId);
}

/**
 * Shared TMDB access for one build: the retrying GET, a cache of detail requests (one
 * per movie id, whoever asks first) and of English overviews. Requests are counted per
 * category (`tmdb`, `manual`, `arrivals`) so that only `tmdb` counts towards the 20 %
 * threshold.
 */
function createContext({ fetchImpl = globalThis.fetch, settings, sleep = defaultSleep, log = console.log }) {
  const get = createClient({ fetchImpl, apiKey: settings.apiKey, sleep });
  const details = new Map();
  const english = new Map();
  const counts = {};
  const tally = (category) => {
    if (!counts[category]) counts[category] = { total: 0, failed: 0 };
    return counts[category];
  };

  /** @returns {Promise<{ ok: true, detail: object } | { ok: false, status: number|null, error: string }>} */
  function detail(id, category) {
    if (!details.has(id)) {
      const count = tally(category);
      count.total += 1;
      details.set(id, get(`/movie/${id}`, { language: settings.language, append_to_response: DETAIL_APPEND })
        .then((body) => ({ ok: true, detail: parseDetail(body) }), (err) => {
          count.failed += 1;
          const error = String(err?.message || err);
          log(`Detail request failed: ${error}`);
          return { ok: false, status: err?.status ?? null, error };
        }));
    }
    return details.get(id);
  }

  /** English overview ('' when empty or when the request fails). */
  function englishOverview(id, category) {
    if (!english.has(id)) {
      const count = tally(category);
      count.total += 1;
      english.set(id, get(`/movie/${id}`, { language: 'en-US' })
        .then((body) => text(body?.overview), (err) => {
          count.failed += 1;
          log(`Detail request failed: ${err?.message || err}`);
          return '';
        }));
    }
    return english.get(id);
  }

  return { get, settings, log, detail, englishOverview, counts: (category) => ({ ...tally(category) }) };
}

/**
 * English overview fallback for every release whose overview is still empty (§7).
 * @param {object[]} releases - Mutated in place
 */
async function fillEnglishOverviews(context, releases, category) {
  const ids = [...new Set(releases.filter((r) => !r.overview).map((r) => r.id))];
  await mapPool(ids, DETAIL_CONCURRENCY, (id) => context.englishOverview(id, category));
  for (const release of releases) {
    if (!release.overview) release.overview = await context.englishOverview(release.id, category);
  }
}

/**
 * A release object with every field of §2 except `calendars`, in the field order of the
 * data model (src/platforms.js inserts `calendars` after `source`).
 */
function makeRelease({
  id, title, originalTitle, releaseDate, type, source, providers = null, releaseNote = null,
  arrivalPlatform = null, sourceUrl = null, runtime = null, posterPath = null, overview = '',
}) {
  const safeTitle = text(title) || text(originalTitle) || `TMDB ${id}`;
  return {
    id,
    title: safeTitle,
    originalTitle: text(originalTitle) || safeTitle,
    releaseDate,
    type,
    source,
    providers: {
      flatrate: Array.isArray(providers?.flatrate) ? providers.flatrate : [],
      rentBuy: Array.isArray(providers?.rentBuy) ? providers.rentBuy : [],
    },
    releaseNote,
    arrivalPlatform,
    sourceUrl,
    runtime,
    posterPath,
    overview: text(overview),
    tmdbUrl: `https://www.themoviedb.org/movie/${id}`,
  };
}

/**
 * A release built from a successful detail (manual releases and arrivals).
 * @returns {object}
 */
function releaseFromDetail(id, detail, fields) {
  return makeRelease({
    id,
    title: detail.title,
    originalTitle: detail.originalTitle,
    runtime: detail.runtime,
    posterPath: detail.posterPath,
    overview: detail.overview,
    ...fields,
  });
}

function toRelease(movie, type) {
  return makeRelease({
    id: movie.id,
    title: movie.title,
    originalTitle: movie.original_title,
    releaseDate: movie.release_date,
    type,
    source: 'tmdb',
    posterPath: text(movie.poster_path) || null,
    overview: movie.overview,
  });
}

/** releaseDate, then title (es), then type (theatrical, digital, arrival), then id (§2). */
function compareReleases(a, b) {
  if (a.releaseDate !== b.releaseDate) return a.releaseDate < b.releaseDate ? -1 : 1;
  return a.title.localeCompare(b.title, 'es')
    || (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9)
    || a.id - b.id;
}

/** "Title (TMDB id, type, N min)" line for the runtime rule log. */
function describeRemoved(release) {
  const runtime = release.runtime === null ? 'no runtime, no imdb_id' : `${release.runtime} min`;
  return `${release.title} (TMDB ${release.id}, ${release.type}, ${runtime})`;
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
 * @param {object} [options.settings] - Already resolved settings (src/index.js)
 * @param {object} [options.context] - Shared context from createContext (src/index.js)
 * @returns {Promise<{ releases: object[], region: string, window: { from: string, to: string },
 *   details: { total: number, failed: number }, removed: object[] }>}
 */
async function fetchHorrorReleases({
  fetchImpl = globalThis.fetch,
  now = new Date(),
  env = process.env,
  sleep = defaultSleep,
  log = console.log,
  warn = (message) => log(`::warning::${escapeCommand(message)}`),
  settings: givenSettings,
  context: givenContext,
} = {}) {
  const settings = givenSettings ?? resolveSettings(env, now, warn);
  const { apiKey, language, region, maxPages, from, to, minRuntime } = settings;
  if (!apiKey) throw new TmdbError('TMDB_API_KEY is not set. Copy .env.example to .env and add your key.');

  const context = givenContext ?? createContext({ fetchImpl, settings, sleep, log });
  const { get } = context;

  // 1. Discover: one query per release type, paginated up to MAX_PAGES
  const found = [];
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
        if (!Number.isInteger(movie?.id) || movie.id <= 0 || seen.has(movie.id)) continue;
        // First occurrence wins, even when it is then dropped by the window check
        seen.add(movie.id);
        // Strict inclusion: a Spanish date of this type inside the window, or nothing
        const date = movie.release_date;
        if (!isIsoDate(date) || date < from || date > to) continue;
        found.push(toRelease(movie, query.type));
      }
    }
  }

  if (found.length === 0) {
    throw new TmdbError(`Both TMDB discover queries returned 0 releases for ${region} ${from} → ${to}; `
      + 'refusing to publish empty calendars.');
  }

  // 2. One detail request per movie id (a movie in both queries is requested once)
  const ids = [...new Set(found.map((r) => r.id))];
  await mapPool(ids, DETAIL_CONCURRENCY, (id) => context.detail(id, 'tmdb'));

  const releases = [];
  const removed = [];
  for (const release of found) {
    const result = await context.detail(release.id, 'tmdb');
    // A failed detail leaves runtime, note and providers empty; the release is kept
    if (!result.ok) {
      releases.push(release);
      continue;
    }
    const { detail } = result;
    release.runtime = detail.runtime;
    if (!release.title && detail.title) release.title = detail.title;
    if (!release.posterPath) release.posterPath = detail.posterPath;
    if (!release.overview) release.overview = detail.overview;
    if (release.type === 'digital') {
      release.providers = parseProviders(detail.providers, region);
      release.releaseNote = parseReleaseNote(detail.releaseDates, region, release.releaseDate);
    }
    if (passesRuntimeRule(detail, minRuntime)) releases.push(release);
    else removed.push(release);
  }

  // 3. English overview fallback, only for the releases that stay
  await fillEnglishOverviews(context, releases, 'tmdb');

  const details = context.counts('tmdb');
  log(`Detail requests: ${details.total}, failed: ${details.failed}.`);
  if (details.total > 0 && details.failed / details.total > MAX_DETAIL_FAILURE_RATE) {
    throw new TmdbError(`${details.failed} of ${details.total} TMDB detail requests failed `
      + `(more than ${MAX_DETAIL_FAILURE_RATE * 100} %); refusing to publish partial calendars.`);
  }

  releases.sort(compareReleases);
  return { releases, region, window: { from, to }, details, removed };
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
  createContext,
  fillEnglishOverviews,
  escapeCommand,
  resolveSettings,
  parseIntSetting,
  parseProviders,
  parseReleaseNote,
  parseTypeDates,
  parseDetail,
  passesRuntimeRule,
  releaseFromDetail,
  compareReleases,
  describeRemoved,
  mapPool,
  isIsoDate,
  subtractYears,
  retryAfterMs,
  TmdbError,
  QUERIES,
  HORROR_GENRE_ID,
  DETAIL_CONCURRENCY,
  MAX_RETRIES,
};
