// Platform arrivals from the weekly providers diff (docs/data-model.md §11).
//
// Each build reads the flatrate horror catalogue of every configured platform in the
// region, compares it with the previous snapshot (the copy published next to
// releases.json, read from SNAPSHOT_URL) and turns the new ids into `arrival` releases
// dated on the build day. The new snapshot is always produced, seed mode and partial
// failures included. Best effort: every failure here is a ::warning:: and the build goes
// on; nothing in this file can make the run fail.

const { PLATFORMS, matchPlatform, assignCalendars, platformName } = require('./platforms');
const {
  HORROR_GENRE_ID, DETAIL_CONCURRENCY, isIsoDate, mapPool, parseTypeDates, passesRuntimeRule,
  releaseFromDetail, fillEnglishOverviews,
} = require('./tmdb');

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_FILE = 'providers-snapshot.json';
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const SNAPSHOT_TIMEOUT_MS = 30_000;
// An announced release detected late: its type-4 date may be up to a week before the
// arrival window (weekly build)
const ANNOUNCED_GRACE_DAYS = 7;

const SLUGS = PLATFORMS.map((p) => p.slug);
const isId = (value) => Number.isInteger(value) && value > 0;

function shiftDate(isoDay, days) {
  const date = new Date(`${isoDay}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/**
 * Validates a parsed snapshot against §11 and the current settings. Unknown platforms,
 * malformed ids and malformed arrivals are dropped; a wrong schema, region or maxAgeYears
 * rejects the whole document.
 * @returns {{ ok: true, platforms: Map<string, Set<number>>, arrivals: object[] } | { ok: false, reason: string }}
 */
function parseSnapshot(doc, { region, maxAgeYears }) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'it is not a JSON object' };
  if (doc.schema !== SNAPSHOT_SCHEMA_VERSION) return { ok: false, reason: `schema ${JSON.stringify(doc.schema)} is not ${SNAPSHOT_SCHEMA_VERSION}` };
  if (doc.region !== region) return { ok: false, reason: `region ${JSON.stringify(doc.region)} is not ${region}` };
  if (doc.maxAgeYears !== maxAgeYears) return { ok: false, reason: `maxAgeYears ${JSON.stringify(doc.maxAgeYears)} is not ${maxAgeYears}` };

  const platforms = new Map();
  const rawPlatforms = doc.platforms && typeof doc.platforms === 'object' && !Array.isArray(doc.platforms) ? doc.platforms : {};
  for (const slug of SLUGS) {
    if (Object.prototype.hasOwnProperty.call(rawPlatforms, slug) && Array.isArray(rawPlatforms[slug])) {
      platforms.set(slug, new Set(rawPlatforms[slug].filter(isId)));
    }
  }

  const arrivals = [];
  const seen = new Set();
  for (const a of Array.isArray(doc.arrivals) ? doc.arrivals : []) {
    if (!a || typeof a !== 'object' || !isId(a.id) || !SLUGS.includes(a.platform) || !isIsoDate(a.detected)) continue;
    const key = `${a.id}:${a.platform}`;
    if (seen.has(key)) continue;
    seen.add(key);
    arrivals.push({ id: a.id, platform: a.platform, detected: a.detected, title: typeof a.title === 'string' ? a.title.trim() : '' });
  }
  return { ok: true, platforms, arrivals };
}

/**
 * Reads a response body as UTF-8 text, chunk by chunk, and stops as soon as it goes over
 * `limit` bytes (content-length may be missing or wrong).
 * @returns {Promise<string|null>} null when the body is larger than the limit
 */
async function readLimited(response, limit) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf-8') > limit ? null : text;
  }
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      try {
        await reader.cancel();
      } catch {
        // Nothing to release
      }
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf-8');
}

/**
 * Reads the previous snapshot from SNAPSHOT_URL. Any problem means seed mode (null):
 * a plain log line when the variable is empty, a ::warning:: otherwise.
 * @returns {Promise<{ platforms: Map<string, Set<number>>, arrivals: object[] } | null>}
 */
async function readSnapshot({ url, fetchImpl, region, maxAgeYears, log, warn }) {
  const seed = (reason) => {
    warn(`Previous providers snapshot not usable (${reason}): seed mode, no new arrivals this build.`);
    return null;
  };
  if (!url) {
    log('SNAPSHOT_URL is empty: seed mode, no new arrivals this build.');
    return null;
  }
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    parsedUrl = null;
  }
  if (!parsedUrl || parsedUrl.protocol !== 'https:') return seed('SNAPSHOT_URL is not an https:// URL');

  let body;
  try {
    const signal = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(SNAPSHOT_TIMEOUT_MS) : undefined;
    const response = await fetchImpl(parsedUrl.href, { signal, redirect: 'error', headers: { accept: 'application/json' } });
    // A redirect is refused by `redirect: 'error'`; a final URL other than https is refused too
    if (typeof response?.url === 'string' && response.url !== '' && !response.url.startsWith('https://')) {
      try {
        await response.body?.cancel?.();
      } catch {
        // Nothing to release
      }
      return seed('the response does not come from an https:// URL');
    }
    if (response?.status !== 200) {
      try {
        await response?.body?.cancel?.();
      } catch {
        // Nothing to release
      }
      return seed(`HTTP ${response?.status}`);
    }
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > MAX_SNAPSHOT_BYTES) {
      try {
        await response.body?.cancel?.();
      } catch {
        // Nothing to release
      }
      return seed(`larger than ${MAX_SNAPSHOT_BYTES} bytes`);
    }
    body = await readLimited(response, MAX_SNAPSHOT_BYTES);
    if (body === null) return seed(`larger than ${MAX_SNAPSHOT_BYTES} bytes`);
  } catch (err) {
    return seed(`network error: ${err?.message || err}`);
  }
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf-8') > MAX_SNAPSHOT_BYTES) {
    return seed(`larger than ${MAX_SNAPSHOT_BYTES} bytes`);
  }

  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return seed('invalid JSON');
  }
  const parsed = parseSnapshot(doc, { region, maxAgeYears });
  if (!parsed.ok) return seed(parsed.reason);
  log(`Previous providers snapshot: ${parsed.platforms.size} platforms, ${parsed.arrivals.length} arrivals.`);
  return { platforms: parsed.platforms, arrivals: parsed.arrivals };
}

/**
 * TMDB provider ids per platform slug, from the regional provider list (§11).
 * @returns {Promise<Map<string, number[]>>} Sorted ids per slug
 */
async function fetchProviderIds(context) {
  const { region, language } = context.settings;
  const data = await context.get('/watch/providers/movie', { watch_region: region, language });
  const ids = new Map();
  for (const provider of Array.isArray(data?.results) ? data.results : []) {
    const slug = matchPlatform(provider?.provider_name);
    if (!slug || !isId(provider?.provider_id)) continue;
    if (!ids.has(slug)) ids.set(slug, new Set());
    ids.get(slug).add(provider.provider_id);
  }
  return new Map([...ids].map(([slug, set]) => [slug, [...set].sort((a, b) => a - b)]));
}

/**
 * Flatrate horror catalogue of one platform, paginated up to ARRIVAL_MAX_PAGES.
 * @returns {Promise<{ ids: Set<number>, totalPages: number, cut: boolean }>}
 */
async function fetchCatalogue(context, providerIds) {
  const { region, language, catalogueFrom, arrivalMaxPages } = context.settings;
  const params = {
    language,
    watch_region: region,
    with_watch_providers: providerIds.join('|'),
    with_watch_monetization_types: 'flatrate',
    with_genres: HORROR_GENRE_ID,
    'primary_release_date.gte': catalogueFrom,
    sort_by: 'primary_release_date.desc',
  };
  const ids = new Set();
  let totalPages = 1;
  for (let page = 1; page <= Math.min(totalPages, arrivalMaxPages); page += 1) {
    const data = await context.get('/discover/movie', { ...params, page });
    if (page === 1) {
      const reported = Number(data?.total_pages);
      totalPages = Number.isInteger(reported) && reported > 0 ? reported : 1;
    }
    for (const movie of Array.isArray(data?.results) ? data.results : []) {
      if (isId(movie?.id)) ids.add(movie.id);
    }
  }
  return { ids, totalPages, cut: totalPages > arrivalMaxPages };
}

/**
 * Per-platform diff with the guards of §11. Pure.
 * @param {object} input
 * @param {Set<number>|undefined} input.previous - Previous set (undefined: platform not in the snapshot)
 * @param {boolean} input.seed - No usable previous snapshot at all
 * @param {Set<number>} input.current - Ids read this build
 * @param {boolean} input.cut - Pagination cut
 * @param {number} input.maxNew - ARRIVAL_MAX_PER_PLATFORM
 * @returns {{ set: Set<number>, arrivals: number[], status: string }}
 *   status: seed | new-platform | empty-guard | flood-guard | diff
 */
function diffPlatform({ previous, seed, current, cut, maxNew }) {
  if (seed) return { set: new Set(current), arrivals: [], status: 'seed' };
  if (previous === undefined) return { set: new Set(current), arrivals: [], status: 'new-platform' };
  if (current.size === 0 && previous.size > 0) return { set: new Set(previous), arrivals: [], status: 'empty-guard' };
  const fresh = [...current].filter((id) => !previous.has(id)).sort((a, b) => a - b);
  // A cut never removes anything: unread ids stay in the set
  const set = cut ? new Set([...previous, ...current]) : new Set(current);
  if (fresh.length > maxNew) return { set, arrivals: [], status: 'flood-guard', count: fresh.length };
  return { set, arrivals: fresh, status: 'diff' };
}

/** Snapshot document (§11): platforms in config order, sorted ids; arrivals sorted. */
function buildSnapshot({ now, region, maxAgeYears, platforms, arrivals }) {
  const out = {};
  for (const slug of SLUGS) {
    if (platforms.has(slug)) out[slug] = [...platforms.get(slug)].sort((a, b) => a - b);
  }
  const order = (slug) => SLUGS.indexOf(slug);
  return {
    schema: SNAPSHOT_SCHEMA_VERSION,
    generated: now.toISOString(),
    region,
    maxAgeYears,
    platforms: out,
    arrivals: [...arrivals]
      .sort((a, b) => (a.detected === b.detected ? order(a.platform) - order(b.platform) || a.id - b.id
        : (a.detected < b.detected ? -1 : 1)))
      .map(({ id, platform, detected, title }) => ({ id, platform, detected, title })),
  };
}

/**
 * Whole arrivals step of §11. Never throws for data or network problems.
 * @param {object} options
 * @param {object} options.context - Shared TMDB context (src/tmdb.js createContext)
 * @param {Function} options.fetchImpl - fetch for SNAPSHOT_URL
 * @param {Date} options.now - Build time
 * @param {object[]} options.digitalReleases - Digital releases of this build, with calendars
 * @param {object[]} options.manualEntries - Every valid entry of the manual file (any date)
 * @param {Function} options.log
 * @param {Function} options.warn
 * @returns {Promise<{ releases: object[], removed: object[], snapshot: object, seed: boolean,
 *   details: { total: number, failed: number } }>}
 */
async function computeArrivals({
  context, fetchImpl, now, digitalReleases = [], manualEntries = [], log, warn, previous: givenPrevious,
}) {
  const {
    region, today, snapshotUrl, arrivalMaxAgeYears, arrivalMaxPerPlatform, arrivalMaxPages, arrivalWindow,
  } = context.settings;

  // `previous` may be read by the caller (src/index.js keeps it for its fallback); null = seed
  const previous = givenPrevious !== undefined ? givenPrevious
    : await readSnapshot({ url: snapshotUrl, fetchImpl, region, maxAgeYears: arrivalMaxAgeYears, log, warn });
  const seed = previous === null;

  let providerIds = null;
  try {
    providerIds = await fetchProviderIds(context);
  } catch (err) {
    warn(`Arrivals: the provider list failed (${err?.message || err}); no catalogue diff this build.`);
  }

  // 1. Catalogue diff per platform
  const platforms = new Map();
  const carry = (slug) => {
    if (previous?.platforms.has(slug)) platforms.set(slug, new Set(previous.platforms.get(slug)));
  };
  const fresh = [];
  for (const { slug, name } of PLATFORMS) {
    if (providerIds === null) {
      carry(slug);
      continue;
    }
    const ids = providerIds.get(slug) ?? [];
    if (ids.length === 0) {
      warn(`Arrivals: no TMDB provider in ${region} matches the aliases of ${name} (src/platforms.js); not diffed.`);
      carry(slug);
      continue;
    }
    let catalogue;
    try {
      catalogue = await fetchCatalogue(context, ids);
    } catch (err) {
      warn(`Arrivals: catalogue query of ${name} failed (${err?.message || err}); previous set kept, no arrivals.`);
      carry(slug);
      continue;
    }
    if (catalogue.cut) {
      warn(`Arrivals: catalogue of ${name} has total_pages=${catalogue.totalPages} but ARRIVAL_MAX_PAGES=`
        + `${arrivalMaxPages}: partial diff, unread ids kept.`);
    }
    const result = diffPlatform({
      previous: previous?.platforms.get(slug), seed, current: catalogue.ids, cut: catalogue.cut, maxNew: arrivalMaxPerPlatform,
    });
    platforms.set(slug, result.set);
    if (result.status === 'new-platform') {
      log(`Arrivals: ${name} is not in the previous snapshot; seeded with ${result.set.size} ids, no arrivals.`);
    } else if (result.status === 'empty-guard') {
      warn(`Arrivals: catalogue of ${name} came back empty while the previous snapshot had `
        + `${previous.platforms.get(slug).size} ids; previous set kept, no arrivals.`);
    } else if (result.status === 'flood-guard') {
      warn(`Arrivals: ${result.count} new ids in ${name}, more than ARRIVAL_MAX_PER_PLATFORM=${arrivalMaxPerPlatform}; `
        + 'no arrivals for it this build, current set accepted as the new baseline.');
    }
    for (const id of result.arrivals) fresh.push({ id, platform: slug, detected: today, title: '' });
  }

  // 2. Candidates: carried-over arrivals still inside the window, then the new ones
  const candidates = [];
  const keys = new Set();
  for (const a of [...(previous?.arrivals ?? []), ...fresh]) {
    if (a.detected < arrivalWindow.from || a.detected > arrivalWindow.to) continue;
    const key = `${a.id}:${a.platform}`;
    if (keys.has(key)) continue;
    keys.add(key);
    candidates.push(a);
  }

  const { releases, removed, kept, details } = await buildArrivalReleases({
    context, candidates, digitalReleases, manualEntries, log, warn,
  });
  const fromPrevious = releases.filter((r) => r.releaseDate !== today).length;
  log(`Arrivals: ${releases.length} (${releases.length - fromPrevious} new, ${fromPrevious} carried over)`
    + `${seed ? ', seed mode' : ''}; detail requests: ${details.total}, failed: ${details.failed}.`);

  return {
    releases,
    removed,
    seed,
    details,
    snapshot: buildSnapshot({ now, region, maxAgeYears: arrivalMaxAgeYears, platforms, arrivals: kept }),
  };
}

/** Arrivals of the previous snapshot whose detection date is inside the arrival window. */
function carriedArrivals(previous, arrivalWindow) {
  const out = [];
  const keys = new Set();
  for (const a of previous?.arrivals ?? []) {
    if (a.detected < arrivalWindow.from || a.detected > arrivalWindow.to) continue;
    const key = `${a.id}:${a.platform}`;
    if (keys.has(key)) continue;
    keys.add(key);
    out.push(a);
  }
  return out;
}

/**
 * Detail, announced-release check (§2) and runtime rule for the arrival candidates.
 * @returns {Promise<{ releases: object[], removed: object[], kept: object[], details: object }>}
 *   releases with calendars; kept = snapshot arrivals (emitted + transient failures)
 */
async function buildArrivalReleases({ context, candidates, digitalReleases = [], manualEntries = [], log, warn }) {
  const { region, today, arrivalDays, minRuntime } = context.settings;
  const announcedFrom = shiftDate(today, -(arrivalDays + ANNOUNCED_GRACE_DAYS));
  const inAnnouncedRange = (day) => day >= announcedFrom && day <= today;
  await mapPool(candidates, DETAIL_CONCURRENCY, (a) => context.detail(a.id, 'arrivals'));
  const releases = [];
  const removed = [];
  const kept = [];
  for (const a of candidates) {
    const label = `${a.title ? `"${a.title}" ` : ''}(TMDB ${a.id}) on ${platformName(a.platform)}`;
    const result = await context.detail(a.id, 'arrivals');
    if (!result.ok) {
      if (result.status === 404) {
        warn(`Arrival ${label} does not exist in TMDB (HTTP 404); dropped.`);
      } else {
        warn(`Arrival ${label}: detail request failed (${result.error}); skipped in this build only.`);
        kept.push(a);
      }
      continue;
    }
    const { detail } = result;
    const announced = digitalReleases.some((r) => r.id === a.id && Array.isArray(r.calendars) && r.calendars.includes(a.platform))
      || parseTypeDates(detail.releaseDates, region, 4).some(inAnnouncedRange)
      || manualEntries.some((e) => e.id === a.id && e.platform === a.platform && inAnnouncedRange(e.releaseDate));
    const release = releaseFromDetail(a.id, detail, {
      releaseDate: a.detected, type: 'arrival', source: 'providers', arrivalPlatform: a.platform,
    });
    if (announced) {
      log(`Arrival "${release.title}" (TMDB ${a.id}) on ${platformName(a.platform)} is its announced digital release; dropped.`);
      continue;
    }
    if (!passesRuntimeRule(detail, minRuntime)) {
      removed.push(release);
      continue;
    }
    releases.push(release);
    kept.push({ ...a, title: release.title });
  }
  await fillEnglishOverviews(context, releases, 'arrivals');
  return { releases: releases.map((r) => assignCalendars(r)), removed, kept, details: context.counts('arrivals') };
}

/**
 * Fallback when computeArrivals crashes (§11: a platform that could not be diffed carries
 * its previous set forward; best effort, carried-over arrivals included). With a previous
 * snapshot: its platforms unchanged, its arrivals inside the window, and the releases of
 * those arrivals that can still be rebuilt. Without one: an empty snapshot, so that the
 * next build seeds again. Never throws.
 * @returns {Promise<{ releases: object[], removed: object[], snapshot: object }>}
 */
async function carryForwardArrivals({ context, previous, now, digitalReleases = [], manualEntries = [], log, warn }) {
  const { region, arrivalMaxAgeYears, arrivalWindow } = context.settings;
  if (!previous) return { releases: [], removed: [], snapshot: emptySnapshot({ now, region, maxAgeYears: arrivalMaxAgeYears }) };
  const carried = carriedArrivals(previous, arrivalWindow);
  const snapshot = buildSnapshot({ now, region, maxAgeYears: arrivalMaxAgeYears, platforms: previous.platforms, arrivals: carried });
  try {
    const { releases, removed } = await buildArrivalReleases({ context, candidates: carried, digitalReleases, manualEntries, log, warn });
    log(`Arrivals fallback: previous snapshot carried forward, ${releases.length} carried-over arrivals rebuilt.`);
    return { releases, removed, snapshot };
  } catch (err) {
    warn(`Arrivals fallback could not rebuild the carried-over arrivals (${err?.message || err}); none this build.`);
    return { releases: [], removed: [], snapshot };
  }
}

/**
 * Snapshot used when the arrivals step itself crashes: empty, so that the next build
 * seeds the platforms again instead of reporting a flood of arrivals.
 */
function emptySnapshot({ now, region, maxAgeYears }) {
  return buildSnapshot({ now, region, maxAgeYears, platforms: new Map(), arrivals: [] });
}

module.exports = {
  computeArrivals,
  carryForwardArrivals,
  readSnapshot,
  readLimited,
  parseSnapshot,
  fetchProviderIds,
  fetchCatalogue,
  diffPlatform,
  buildSnapshot,
  emptySnapshot,
  SNAPSHOT_FILE,
  SNAPSHOT_SCHEMA_VERSION,
  MAX_SNAPSHOT_BYTES,
  ANNOUNCED_GRACE_DAYS,
};
