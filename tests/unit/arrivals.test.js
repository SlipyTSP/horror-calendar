const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  computeArrivals, carryForwardArrivals, parseSnapshot, diffPlatform, readSnapshot, readLimited, buildSnapshot,
  fetchProviderIds, MAX_SNAPSHOT_BYTES,
} = require('../../src/arrivals');
const { createContext, resolveSettings } = require('../../src/tmdb');
const { PLATFORMS } = require('../../src/platforms');
const { createFixtureFetch } = require('../support/fixture-fetch');
const { PROVIDER_LIST_KEY, ES_PROVIDERS, providerListBody } = require('../support/providers-es');

// Same day as the synthetic catalogue fixtures (primary_release_date.gte=2023-10-23)
const NOW = new Date('2026-10-23T06:00:00.000Z');
const KEY = 'fake-key-0123456789abcdef';
const SNAPSHOT_URL = 'https://example.org/horror-calendar/providers-snapshot.json';
const ENV = { TMDB_API_KEY: KEY, SNAPSHOT_URL };

// Provider ids of the ES provider list in tests/support/providers-es.js (served by default
// by tests/support/fixture-fetch.js)
const PROVIDERS = {
  netflix: '8|1796', 'prime-video': '119|2100', 'hbo-max': '1899', 'movistar-plus': '149',
  filmin: '63', 'disney-plus': '337', skyshowtime: '1773', 'apple-tv-plus': '350',
};
// Ids of the synthetic catalogue pages
const CATALOGUE = {
  netflix: [920001, 920002, 920003], 'prime-video': [920011, 920012], 'hbo-max': [920021],
  'movistar-plus': [920031, 920032], filmin: [920041], 'disney-plus': [920051], skyshowtime: [], 'apple-tv-plus': [920071],
};

const catalogueKey = (slug, page = 1) => `/discover/movie?${new URLSearchParams({
  language: 'es-ES', watch_region: 'ES', with_watch_providers: PROVIDERS[slug], with_watch_monetization_types: 'flatrate',
  with_genres: '27', 'primary_release_date.gte': '2023-10-23', sort_by: 'primary_release_date.desc', page: String(page),
})}`;
const detailKey = (id) => `/movie/${id}?language=es-ES&append_to_response=${encodeURIComponent('release_dates,watch/providers')}`;
// ES watch/providers of a detail: flatrate, plus optional ads/free/rent/buy tiers
const esProviders = (flatrate = [], tiers = {}) => ({
  results: { ES: { flatrate: flatrate.map((provider_name) => ({ provider_name })),
    ...Object.fromEntries(Object.entries(tiers).map(([k, names]) => [k, names.map((provider_name) => ({ provider_name }))])) } },
});
// By default an arrival detail is a real one: its ES flatrate has the platform whose
// synthetic catalogue holds the id (inclusion check, §11) and it has an audience
// (noise filter, §11)
const FLATRATE_NAME = Object.fromEntries(PLATFORMS.map((p) => [p.slug, p.providerNames[0]]));
const platformOf = (id) => Object.keys(CATALOGUE).find((slug) => CATALOGUE[slug].includes(id));
const detail = (id, overrides = {}) => ({
  body: {
    id, title: `Llegada ${id}`, original_title: `Arrival ${id}`, overview: `Sinopsis ${id}.`, poster_path: `/a${id}.jpg`,
    runtime: 95, imdb_id: `tt${id}`, vote_count: 120, popularity: 8.5, release_dates: { results: [] },
    'watch/providers': esProviders(platformOf(id) ? [FLATRATE_NAME[platformOf(id)]] : []),
    ...overrides,
  },
});
const page = (ids, totalPages = 1) => ({ body: { page: 1, total_pages: totalPages, total_results: ids.length, results: ids.map((id) => ({ id })) } });

function sink() {
  const lines = [];
  const fn = (...args) => lines.push(args.join(' '));
  fn.lines = lines;
  return fn;
}

function snapshot(platforms = CATALOGUE, arrivals = [], overrides = {}) {
  return { schema: 1, generated: '2026-10-16T06:00:00.000Z', region: 'ES', maxAgeYears: 3, platforms, arrivals, ...overrides };
}

async function run({ previous, routes = {}, env = ENV, now = NOW, digitalReleases = [], manualEntries = [] } = {}) {
  const all = { ...routes };
  if (previous !== undefined && !(SNAPSHOT_URL in all)) all[SNAPSHOT_URL] = { body: previous };
  const fetchImpl = createFixtureFetch({ routes: all });
  const log = sink();
  const warn = sink();
  const settings = resolveSettings(env, now, warn);
  const context = createContext({ fetchImpl, settings, sleep: async () => {}, log });
  const result = await computeArrivals({ context, fetchImpl, now, digitalReleases, manualEntries, log, warn });
  return { ...result, log, warn, fetchImpl };
}

const ids = (releases) => releases.map((r) => [r.id, r.arrivalPlatform, r.releaseDate]);

// --- Seed mode ---

test('E4 seed mode (empty SNAPSHOT_URL): no arrivals, plain log line, valid snapshot with every catalogue', async () => {
  const { releases, snapshot: snap, log, warn, seed, fetchImpl } = await run({ env: { TMDB_API_KEY: KEY } });
  assert.equal(seed, true);
  assert.deepEqual(releases, []);
  assert.deepEqual(warn.lines, []);
  assert.match(log.lines.join('\n'), /SNAPSHOT_URL is empty: seed mode/);
  assert.deepEqual(snap, {
    schema: 1, generated: NOW.toISOString(), region: 'ES', maxAgeYears: 3, platforms: CATALOGUE, arrivals: [],
  });
  assert.deepEqual(Object.keys(snap.platforms), Object.keys(CATALOGUE), 'config order');
  assert.ok(!fetchImpl.calls.some((c) => c.key.startsWith('/movie/')), 'no detail request in seed mode');
});

test('E4 the catalogue query: one discover per platform with the §11 parameters and no region', async () => {
  const { fetchImpl } = await run({ env: { TMDB_API_KEY: KEY } });
  const discover = fetchImpl.calls.filter((c) => c.key.startsWith('/discover/movie'));
  assert.equal(discover.length, 8);
  for (const [i, slug] of Object.keys(PROVIDERS).entries()) {
    const p = new URL(discover[i].url).searchParams;
    assert.equal(p.get('with_watch_providers'), PROVIDERS[slug], slug);
    assert.equal(p.get('watch_region'), 'ES');
    assert.equal(p.get('with_watch_monetization_types'), 'flatrate');
    assert.equal(p.get('with_genres'), '27');
    assert.equal(p.get('primary_release_date.gte'), '2023-10-23');
    assert.equal(p.get('sort_by'), 'primary_release_date.desc');
    assert.equal(p.get('language'), 'es-ES');
    assert.equal(p.get('api_key'), KEY);
    assert.equal(p.has('region'), false);
  }
  const list = fetchImpl.calls.find((c) => c.key.startsWith('/watch/providers/movie'));
  assert.equal(list.key, '/watch/providers/movie?language=es-ES&watch_region=ES');
});

test('E4 SNAPSHOT_URL set but unusable → seed mode with a ::warning:: and a normal snapshot', async () => {
  const cases = [
    { status: 404, body: 'Not Found' },
    { status: 200, body: 'not json {' },
    { status: 200, body: snapshot(CATALOGUE, [], { schema: 2 }) },
    { status: 200, body: snapshot(CATALOGUE, [], { region: 'MX' }) },
    { status: 200, body: snapshot(CATALOGUE, [], { maxAgeYears: 5 }) },
    { status: 200, body: [] },
    { status: 200, body: snapshot(), headers: { 'content-length': String(MAX_SNAPSHOT_BYTES + 1) } },
  ];
  for (const spec of cases) {
    const { releases, warn, seed, snapshot: snap } = await run({ routes: { [SNAPSHOT_URL]: spec } });
    assert.equal(seed, true, JSON.stringify(spec).slice(0, 80));
    assert.deepEqual(releases, []);
    assert.equal(warn.lines.filter((l) => /seed mode/.test(l)).length, 1);
    assert.deepEqual(snap.platforms, CATALOGUE);
  }
});

test('SNAPSHOT_URL must be https: anything else is seed mode without fetching it', async () => {
  for (const url of ['http://example.org/s.json', 'file:///etc/passwd', 'not a url']) {
    const { warn, seed, fetchImpl } = await run({ env: { TMDB_API_KEY: KEY, SNAPSHOT_URL: url } });
    assert.equal(seed, true, url);
    assert.match(warn.lines.join('\n'), /not an https:\/\/ URL/);
    assert.ok(!fetchImpl.calls.some((c) => !c.url.startsWith('https://api.themoviedb.org/')), url);
  }
});

test('a network error on SNAPSHOT_URL is seed mode; the snapshot request never carries the key', async () => {
  const urls = [];
  const inner = createFixtureFetch();
  const fetchImpl = async (url, init) => {
    urls.push(String(url));
    if (String(url).startsWith(SNAPSHOT_URL)) throw new Error('ECONNRESET');
    return inner(url, init);
  };
  const log = sink();
  const warn = sink();
  const settings = resolveSettings(ENV, NOW, warn);
  const context = createContext({ fetchImpl, settings, sleep: async () => {}, log });
  const result = await computeArrivals({ context, fetchImpl, now: NOW, log, warn });
  assert.equal(result.seed, true);
  assert.match(warn.lines.join('\n'), /network error: ECONNRESET/);
  assert.deepEqual(urls.filter((u) => u.includes(KEY) && !u.startsWith('https://api.themoviedb.org/')), []);
});

// --- Diff ---

test('E4 a second run against the seed snapshot produces arrivals exactly for the new ids', async () => {
  const seedRun = await run({ env: { TMDB_API_KEY: KEY } });
  const previous = JSON.parse(JSON.stringify(seedRun.snapshot));
  previous.platforms.netflix = [920001, 920002];
  previous.platforms['movistar-plus'] = [920031];
  const { releases, snapshot: snap, warn, seed } = await run({
    previous,
    routes: { [detailKey(920003)]: detail(920003), [detailKey(920032)]: detail(920032, { title: 'Silbido' }) },
  });

  assert.equal(seed, false);
  assert.deepEqual(warn.lines, []);
  assert.deepEqual(ids(releases), [[920003, 'netflix', '2026-10-23'], [920032, 'movistar-plus', '2026-10-23']]);
  assert.deepEqual(releases[1], {
    id: 920032,
    title: 'Silbido',
    originalTitle: 'Arrival 920032',
    releaseDate: '2026-10-23',
    type: 'arrival',
    source: 'providers',
    calendars: ['movistar-plus'],
    providers: { flatrate: [], rentBuy: [] },
    releaseNote: null,
    arrivalPlatform: 'movistar-plus',
    sourceUrl: null,
    runtime: 95,
    posterPath: '/a920032.jpg',
    overview: 'Sinopsis 920032.',
    tmdbUrl: 'https://www.themoviedb.org/movie/920032',
  });
  assert.deepEqual(snap.platforms, CATALOGUE);
  assert.deepEqual(snap.arrivals, [
    { id: 920003, platform: 'netflix', detected: '2026-10-23', title: 'Llegada 920003' },
    { id: 920032, platform: 'movistar-plus', detected: '2026-10-23', title: 'Silbido' },
  ]);
});

test('ids that left a catalogue are not arrivals and leave the set', async () => {
  const previous = snapshot({ ...CATALOGUE, filmin: [920041, 910000] });
  const { releases, snapshot: snap } = await run({ previous });
  assert.deepEqual(releases, []);
  assert.deepEqual(snap.platforms.filmin, [920041]);
});

test('E4 guard: a platform missing from the previous snapshot is seeded (no arrivals)', async () => {
  const { 'hbo-max': _, ...rest } = CATALOGUE;
  const { releases, snapshot: snap, log, warn } = await run({ previous: snapshot(rest) });
  assert.deepEqual(releases, []);
  assert.deepEqual(warn.lines, []);
  assert.match(log.lines.join('\n'), /HBO Max is not in the previous snapshot; seeded with 1 ids/);
  assert.deepEqual(snap.platforms['hbo-max'], [920021]);
});

test('E4 guard: an empty current set while the previous one was not → warning, previous set kept', async () => {
  // The synthetic SkyShowtime catalogue is empty
  const { releases, snapshot: snap, warn } = await run({ previous: snapshot({ ...CATALOGUE, skyshowtime: [5, 6] }) });
  assert.deepEqual(releases, []);
  assert.equal(warn.lines.length, 1);
  assert.match(warn.lines[0], /catalogue of SkyShowtime came back empty .*2 ids; previous set kept/);
  assert.deepEqual(snap.platforms.skyshowtime, [5, 6]);
  // empty before and now: no warning
  const quiet = await run({ previous: snapshot() });
  assert.deepEqual(quiet.warn.lines, []);
  assert.deepEqual(quiet.snapshot.platforms.skyshowtime, []);
});

test('E4 guard: more than ARRIVAL_MAX_PER_PLATFORM new ids → warning, no arrivals, new baseline', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [920001], 'prime-video': [920011] });
  const { releases, snapshot: snap, warn } = await run({
    previous,
    env: { ...ENV, ARRIVAL_MAX_PER_PLATFORM: '1' },
    routes: { [detailKey(920012)]: detail(920012) },
  });
  assert.deepEqual(ids(releases), [[920012, 'prime-video', '2026-10-23']], 'one new id is within the limit');
  assert.equal(warn.lines.length, 1);
  assert.match(warn.lines[0], /2 new ids in Netflix, more than ARRIVAL_MAX_PER_PLATFORM=1/);
  assert.deepEqual(snap.platforms.netflix, [920001, 920002, 920003]);
});

test('E4 guard: a pagination cut warns and diffs only the ids read; unread ids are never removed', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [920001, 910001, 910002] });
  const { releases, snapshot: snap, warn, fetchImpl } = await run({
    previous,
    env: { ...ENV, ARRIVAL_MAX_PAGES: '2' },
    routes: {
      [catalogueKey('netflix')]: page([920001, 920002], 7),
      [catalogueKey('netflix', 2)]: page([920003], 7),
      [detailKey(920002)]: detail(920002),
      [detailKey(920003)]: detail(920003),
    },
  });
  assert.equal(fetchImpl.calls.filter((c) => c.key.includes('with_watch_providers=8%7C1796')).length, 2);
  assert.equal(warn.lines.length, 1);
  assert.match(warn.lines[0], /catalogue of Netflix has total_pages=7 but ARRIVAL_MAX_PAGES=2: partial diff/);
  assert.deepEqual(ids(releases), [[920002, 'netflix', '2026-10-23'], [920003, 'netflix', '2026-10-23']]);
  assert.deepEqual(snap.platforms.netflix, [910001, 910002, 920001, 920002, 920003]);
});

// --- Carried-over arrivals ---

test('E4 carried-over arrivals keep their detection date and leave after ARRIVAL_DAYS', async () => {
  const previous = snapshot(CATALOGUE, [
    { id: 920001, platform: 'netflix', detected: '2026-09-22', title: 'Old' },
    { id: 920002, platform: 'netflix', detected: '2026-09-23', title: 'Oldest kept' },
    { id: 920031, platform: 'movistar-plus', detected: '2026-10-16', title: 'Last week' },
    { id: 920031, platform: 'movistar-plus', detected: '2026-10-16', title: 'Duplicate' },
    { id: 920041, platform: 'filmin', detected: '2026-10-24', title: 'Future: garbage' },
    { id: 920051, platform: 'nope', detected: '2026-10-16' },
    { id: 'x', platform: 'netflix', detected: '2026-10-16' },
    null,
  ]);
  const { releases, snapshot: snap, fetchImpl } = await run({
    previous,
    routes: { [detailKey(920002)]: detail(920002), [detailKey(920031)]: detail(920031) },
  });
  assert.deepEqual(ids(releases), [[920002, 'netflix', '2026-09-23'], [920031, 'movistar-plus', '2026-10-16']]);
  assert.deepEqual(snap.arrivals.map((a) => [a.id, a.detected]), [[920002, '2026-09-23'], [920031, '2026-10-16']]);
  assert.ok(!fetchImpl.calls.some((c) => c.key.startsWith('/movie/920001')), 'no request for an expired arrival');

  // A week later the first one has left the window too (ARRIVAL_DAYS=30)
  const later = await run({
    previous: snap,
    now: new Date('2026-10-30T06:00:00.000Z'),
    routes: {
      ...Object.fromEntries(Object.keys(PROVIDERS).map((slug) => [catalogueKey(slug).replace('2023-10-23', '2023-10-30'),
        page(CATALOGUE[slug])])),
      [detailKey(920031)]: detail(920031),
    },
  });
  assert.deepEqual(ids(later.releases), [[920031, 'movistar-plus', '2026-10-16']]);
});

test('ARRIVAL_DAYS shortens the window of carried-over arrivals', async () => {
  const previous = snapshot(CATALOGUE, [{ id: 920031, platform: 'movistar-plus', detected: '2026-10-16', title: 'x' }]);
  const { releases } = await run({ previous, env: { ...ENV, ARRIVAL_DAYS: '6' } });
  assert.deepEqual(releases, []);
});

// --- Dropped arrivals ---

test('§2 an arrival is dropped when the build has a digital release of the same id in that platform', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [920001], 'prime-video': [920011] });
  const digitalReleases = [
    { id: 920002, type: 'digital', calendars: ['digital', 'netflix'] },
    { id: 920003, type: 'digital', calendars: ['digital', 'filmin'] },
    { id: 920012, type: 'digital', calendars: ['digital'] },
  ];
  const { releases, snapshot: snap, log } = await run({
    previous,
    digitalReleases,
    routes: { [detailKey(920002)]: detail(920002), [detailKey(920003)]: detail(920003), [detailKey(920012)]: detail(920012) },
  });
  assert.deepEqual(ids(releases).map(([id]) => id), [920003, 920012]);
  assert.match(log.lines.join('\n'), /"Llegada 920002" \(TMDB 920002\) on Netflix is its announced digital release; dropped/);
  assert.deepEqual(snap.arrivals.map((a) => a.id), [920003, 920012]);
});

test('§2 an arrival is dropped when its Spanish type-4 date is in [today − ARRIVAL_DAYS − 7, today]', async () => {
  const dates = (date, iso = 'ES', type = 4) => ({
    results: [{ iso_3166_1: iso, release_dates: [{ type, release_date: `${date}T00:00:00.000Z`, note: '' }] }],
  });
  const previous = snapshot({ ...CATALOGUE, netflix: [] , 'movistar-plus': [] });
  const { releases } = await run({
    previous,
    routes: {
      [detailKey(920001)]: detail(920001, { release_dates: dates('2026-09-16') }), // first day of the range: dropped
      [detailKey(920002)]: detail(920002, { release_dates: dates('2026-09-15') }), // before the range: kept
      [detailKey(920003)]: detail(920003, { release_dates: dates('2026-10-20', 'US') }), // other country: kept
      [detailKey(920031)]: detail(920031, { release_dates: dates('2026-10-20', 'ES', 3) }), // theatrical: kept
      [detailKey(920032)]: detail(920032, { release_dates: dates('2026-10-23') }), // today: dropped
    },
  });
  assert.deepEqual(ids(releases).map(([id]) => id), [920002, 920003, 920031]);
});

test('§2 an arrival is dropped when the manual file has the same id and platform inside the range, past entries included', async () => {
  const previous = snapshot({ ...CATALOGUE, 'movistar-plus': [] });
  const manualEntries = [
    { id: 920031, platform: 'movistar-plus', releaseDate: '2026-09-20', sourceUrl: 'https://example.com/1' },
    { id: 920032, platform: 'filmin', releaseDate: '2026-10-20', sourceUrl: 'https://example.com/2' },
  ];
  const { releases } = await run({
    previous,
    manualEntries,
    routes: { [detailKey(920031)]: detail(920031), [detailKey(920032)]: detail(920032) },
  });
  assert.deepEqual(ids(releases).map(([id]) => id), [920032], 'other platform: not the announced release');
});

test('E1 the runtime rule applies to arrivals; removed ones leave the snapshot arrivals', async () => {
  const previous = snapshot({ ...CATALOGUE, 'movistar-plus': [] });
  const { releases, removed, snapshot: snap } = await run({
    previous,
    routes: {
      [detailKey(920031)]: detail(920031, { runtime: 12 }),
      [detailKey(920032)]: detail(920032, { runtime: 0, imdb_id: 'tt1' }),
    },
  });
  assert.deepEqual(ids(releases).map(([id]) => id), [920032]);
  assert.deepEqual(removed.map((r) => [r.id, r.type, r.runtime]), [[920031, 'arrival', 12]]);
  assert.deepEqual(snap.arrivals.map((a) => a.id), [920032]);
});

// --- Inclusion check (§11, H2) ---

test('H2 a new candidate whose platform is only in rent/buy is dropped, left out of arrivals and of the set', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [920001] });
  const { releases, snapshot: snap, log, warn, details } = await run({
    previous,
    routes: {
      // Only rent/buy on the store: the false positive seen with Apple TV Store on 2026-10-31
      [detailKey(920002)]: detail(920002, { 'watch/providers': esProviders(['Movistar Plus+'], { rent: ['Netflix'], buy: ['Apple TV Store'] }) }),
      [detailKey(920003)]: detail(920003),
    },
  });
  assert.deepEqual(ids(releases), [[920003, 'netflix', '2026-10-23']]);
  assert.deepEqual(snap.arrivals.map((a) => a.id), [920003]);
  assert.deepEqual(snap.platforms.netflix, [920001, 920003], '920002 leaves the set so a later build evaluates it again');
  const lines = log.lines.filter((l) => /is not in its ES flatrate/.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Arrival "Llegada 920002" \(TMDB 920002\) on Netflix is not in its ES flatrate \(Movistar Plus\+\); dropped/);
  assert.deepEqual(warn.lines, [], 'a plain log line, not a warning');
  assert.deepEqual(details, { total: 2, failed: 0 }, 'one detail per candidate, no extra request');
  assert.match(log.lines.join('\n'), /Arrivals: 1 \(1 new, 0 carried over\); 1 not in their platform's flatrate/);

  // Next build: the id is new again and gets evaluated again (here it is now included)
  const next = await run({ previous: snap, routes: { [detailKey(920002)]: detail(920002), [detailKey(920003)]: detail(920003) } });
  assert.deepEqual(ids(next.releases).sort(), [[920002, 'netflix', '2026-10-23'], [920003, 'netflix', '2026-10-23']]);
});

test('H2 order: a 20-min candidate outside its platform flatrate is an inclusion drop, not a runtime-rule removal', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [920001, 920002] });
  const { releases, removed, snapshot: snap, log } = await run({
    previous,
    routes: { [detailKey(920003)]: detail(920003, { runtime: 20, 'watch/providers': esProviders(['Filmin']) }) },
  });
  assert.deepEqual(releases, []);
  assert.deepEqual(removed, [], 'absent from the runtime-rule report');
  assert.deepEqual(snap.arrivals, []);
  assert.deepEqual(snap.platforms.netflix, [920001, 920002], 'id out of the set');
  assert.ok(log.lines.some((l) => /^Arrival "Llegada 920003" \(TMDB 920003\) on Netflix is not in its ES flatrate \(Filmin\)/.test(l)));

  // In its flatrate, the same 20-min candidate is a runtime-rule removal (id stays in the set)
  const short = await run({ previous, routes: { [detailKey(920003)]: detail(920003, { runtime: 20 }) } });
  assert.deepEqual(short.removed.map((r) => [r.id, r.runtime]), [[920003, 20]]);
  assert.deepEqual(short.snapshot.platforms.netflix, [920001, 920002, 920003]);
});

test('H2 the platform reached through an alias tier (ads) is included; an unaliased tier is not', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [920001] });
  const { releases, snapshot: snap } = await run({
    previous,
    routes: {
      [detailKey(920002)]: detail(920002, { 'watch/providers': esProviders([], { ads: ['Netflix basic with Ads'] }) }),
      [detailKey(920003)]: detail(920003, { 'watch/providers': esProviders(['netflix ']) }),
    },
  });
  assert.deepEqual(ids(releases).map(([id]) => id), [920002, 920003]);
  assert.deepEqual(snap.platforms.netflix, [920001, 920002, 920003]);

  const free = await run({
    previous,
    routes: {
      [detailKey(920002)]: detail(920002, { 'watch/providers': esProviders([], { free: ['Pluto TV'] }) }),
      [detailKey(920003)]: detail(920003, { 'watch/providers': esProviders(['HBO Max Amazon Channel']) }),
    },
  });
  assert.deepEqual(free.releases, []);
  assert.deepEqual(free.snapshot.platforms.netflix, [920001]);
});

test('H2 a carried-over arrival that is no longer in the platform flatrate is dropped and leaves the set', async () => {
  const previous = snapshot(CATALOGUE, [
    { id: 920031, platform: 'movistar-plus', detected: '2026-10-16', title: 'Gone' },
    { id: 920041, platform: 'filmin', detected: '2026-10-16', title: 'Still there' },
  ]);
  const { releases, snapshot: snap, log } = await run({
    previous,
    routes: {
      [detailKey(920031)]: detail(920031, { 'watch/providers': esProviders(['Netflix']) }),
      [detailKey(920041)]: detail(920041),
    },
  });
  assert.deepEqual(ids(releases), [[920041, 'filmin', '2026-10-16']]);
  assert.deepEqual(snap.arrivals.map((a) => a.id), [920041]);
  assert.deepEqual(snap.platforms['movistar-plus'], [920032]);
  assert.match(log.lines.join('\n'), /"Llegada 920031" \(TMDB 920031\) on Movistar Plus\+ is not in its ES flatrate \(Netflix\)/);
});

test('H2 odd watch/providers data counts as "not included" and never throws', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [] });
  const odd = [null, 'x', { results: null }, { results: { ES: 'x' } }, { results: { ES: { flatrate: 'Netflix', ads: 5 } } },
    { results: { US: { flatrate: [{ provider_name: 'Netflix' }] } } }];
  for (const providers of odd) {
    const { releases, snapshot: snap, warn } = await run({
      previous,
      routes: {
        [detailKey(920001)]: detail(920001, { 'watch/providers': providers }),
        [detailKey(920002)]: detail(920002),
        [detailKey(920003)]: detail(920003),
      },
    });
    assert.deepEqual(ids(releases).map(([id]) => id), [920002, 920003], JSON.stringify(providers));
    assert.deepEqual(snap.platforms.netflix, [920002, 920003]);
    assert.deepEqual(warn.lines, []);
  }
});

test('H2 a failed detail keeps the current behaviour: skipped this build, kept in the snapshot and in the set', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [920001, 920002] });
  const { releases, snapshot: snap, warn } = await run({ previous, routes: { [detailKey(920003)]: { status: 503, body: {} } } });
  assert.deepEqual(releases, []);
  assert.match(warn.lines.join('\n'), /920003.*skipped in this build only/);
  assert.deepEqual(snap.arrivals.map((a) => a.id), [920003]);
  assert.deepEqual(snap.platforms.netflix, [920001, 920002, 920003]);
});

test('H2 carryForwardArrivals applies the inclusion check: dropped arrival out of the snapshot and of its set', async () => {
  const fetchImpl = createFixtureFetch({
    routes: {
      [detailKey(920031)]: detail(920031, { 'watch/providers': esProviders([], { rent: ['Movistar Plus+'] }) }),
      [detailKey(920041)]: detail(920041),
    },
  });
  const log = sink();
  const settings = resolveSettings(ENV, NOW, sink());
  const context = createContext({ fetchImpl, settings, sleep: async () => {}, log });
  const previous = parseSnapshot(snapshot(CATALOGUE, [
    { id: 920031, platform: 'movistar-plus', detected: '2026-10-16', title: 'x' },
    { id: 920041, platform: 'filmin', detected: '2026-10-16', title: 'y' },
  ]), { region: 'ES', maxAgeYears: 3 });
  const result = await carryForwardArrivals({ context, previous, now: NOW, log, warn: sink() });
  assert.deepEqual(ids(result.releases), [[920041, 'filmin', '2026-10-16']]);
  assert.deepEqual(result.snapshot.arrivals.map((a) => a.id), [920041]);
  assert.deepEqual(result.snapshot.platforms, { ...CATALOGUE, 'movistar-plus': [920032] });
  assert.deepEqual([...previous.platforms.get('movistar-plus')], [920031, 920032], 'the previous snapshot is not mutated');
});

// --- Noise filter (§11, H6) ---

test('H6 a new candidate with 0 votes and popularity 0.4 is filtered: not emitted, not in arrivals, id kept in the set', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [920001] });
  const { releases, removed, snapshot: snap, log, warn, details } = await run({
    previous,
    routes: {
      [detailKey(920002)]: detail(920002, { vote_count: 0, popularity: 0.4 }),
      [detailKey(920003)]: detail(920003),
    },
  });
  assert.deepEqual(ids(releases), [[920003, 'netflix', '2026-10-23']]);
  assert.deepEqual(snap.arrivals.map((a) => a.id), [920003]);
  assert.deepEqual(snap.platforms.netflix, [920001, 920002, 920003], 'the filtered id stays in the set');
  assert.deepEqual(removed, [], 'not a runtime-rule removal');
  const lines = log.lines.filter((l) => /filtered as noise:/.test(l));
  assert.deepEqual(lines, ['Arrival "Llegada 920002" (TMDB 920002) on Netflix filtered as noise: 0 votes, popularity 0.4 '
    + '(ARRIVAL_MIN_VOTES=5, ARRIVAL_MIN_POPULARITY=5); not announced, id kept in the set.']);
  assert.ok(!log.lines.some((l) => /Runtime rule/.test(l)));
  assert.deepEqual(warn.lines, []);
  assert.deepEqual(details, { total: 2, failed: 0 }, 'no extra request');
  assert.match(log.lines.join('\n'), /0 not in their platform's flatrate, 1 filtered as noise/);

  // Next build: the id is in the previous set, so it is never announced late
  const next = await run({ previous: snap, routes: { [detailKey(920003)]: detail(920003) } });
  assert.deepEqual(ids(next.releases), [[920003, 'netflix', '2026-10-23']]);
  assert.ok(!next.fetchImpl.calls.some((c) => c.key.startsWith('/movie/920002')));
});

test('H6 either threshold is enough: 5 votes and popularity 0, or 0 votes and popularity 5, are published', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [920001] });
  const { releases, log } = await run({
    previous,
    routes: {
      [detailKey(920002)]: detail(920002, { vote_count: 5, popularity: 0 }),
      [detailKey(920003)]: detail(920003, { vote_count: 0, popularity: 5 }),
    },
  });
  assert.deepEqual(ids(releases).map(([id]) => id), [920002, 920003]);
  assert.ok(!log.lines.some((l) => /filtered as noise:/.test(l)));

  const below = await run({
    previous,
    routes: {
      [detailKey(920002)]: detail(920002, { vote_count: 4, popularity: 4.99 }),
      [detailKey(920003)]: detail(920003, { vote_count: 1 }),
    },
  });
  assert.deepEqual(ids(below.releases).map(([id]) => id), [920003], 'popularity 8.5 is enough');
});

test('H6 a carried-over arrival that no longer passes the filter leaves the calendars and the snapshot arrivals', async () => {
  const previous = snapshot(CATALOGUE, [
    { id: 920031, platform: 'movistar-plus', detected: '2026-10-16', title: 'Noise' },
    { id: 920041, platform: 'filmin', detected: '2026-10-16', title: 'Fine' },
  ]);
  const { releases, snapshot: snap } = await run({
    previous,
    routes: {
      [detailKey(920031)]: detail(920031, { vote_count: 1, popularity: 0.6 }),
      [detailKey(920041)]: detail(920041),
    },
  });
  assert.deepEqual(ids(releases), [[920041, 'filmin', '2026-10-16']]);
  assert.deepEqual(snap.arrivals.map((a) => a.id), [920041]);
  assert.deepEqual(snap.platforms['movistar-plus'], [920031, 920032]);
});

test('H6 ARRIVAL_MIN_VOTES=0 or ARRIVAL_MIN_POPULARITY=0 disables the filter', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [920001] });
  const routes = {
    [detailKey(920002)]: detail(920002, { vote_count: 0, popularity: 0 }),
    [detailKey(920003)]: detail(920003, { vote_count: undefined, popularity: undefined }),
  };
  for (const env of [{ ARRIVAL_MIN_VOTES: '0' }, { ARRIVAL_MIN_POPULARITY: '0' }]) {
    const { releases, log } = await run({ previous, routes, env: { ...ENV, ...env } });
    assert.deepEqual(ids(releases).map(([id]) => id), [920002, 920003], JSON.stringify(env));
    assert.ok(!log.lines.some((l) => /filtered as noise:/.test(l)));
  }
  const strict = await run({ previous, routes, env: { ...ENV, ARRIVAL_MIN_VOTES: '1', ARRIVAL_MIN_POPULARITY: '1' } });
  assert.deepEqual(strict.releases, []);
});

test('H6 missing or non-numeric votes and popularity count as 0, without exceptions', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [920001] });
  const { releases, log, warn } = await run({
    previous,
    routes: {
      [detailKey(920002)]: detail(920002, { vote_count: '50', popularity: null }),
      [detailKey(920003)]: detail(920003, { vote_count: NaN, popularity: { x: 1 } }),
    },
  });
  assert.deepEqual(releases, []);
  assert.equal(log.lines.filter((l) => /filtered as noise: 0 votes, popularity 0 /.test(l)).length, 2);
  assert.deepEqual(warn.lines, []);
});

test('H2 + H6 order: a candidate failing both checks is an inclusion drop (id out of the set), not noise', async () => {
  const previous = snapshot({ ...CATALOGUE, netflix: [920001, 920002] });
  const { releases, snapshot: snap, log } = await run({
    previous,
    routes: { [detailKey(920003)]: detail(920003, { vote_count: 0, popularity: 0, 'watch/providers': esProviders(['Filmin']) }) },
  });
  assert.deepEqual(releases, []);
  assert.deepEqual(snap.platforms.netflix, [920001, 920002]);
  assert.ok(log.lines.some((l) => /920003.*is not in its ES flatrate/.test(l)));
  assert.ok(!log.lines.some((l) => /filtered as noise:/.test(l)));
});

test('H6 carryForwardArrivals applies the noise filter too', async () => {
  const fetchImpl = createFixtureFetch({
    routes: { [detailKey(920031)]: detail(920031, { vote_count: 0, popularity: 0.1 }), [detailKey(920041)]: detail(920041) },
  });
  const log = sink();
  const settings = resolveSettings(ENV, NOW, sink());
  const context = createContext({ fetchImpl, settings, sleep: async () => {}, log });
  const previous = parseSnapshot(snapshot(CATALOGUE, [
    { id: 920031, platform: 'movistar-plus', detected: '2026-10-16', title: 'x' },
    { id: 920041, platform: 'filmin', detected: '2026-10-16', title: 'y' },
  ]), { region: 'ES', maxAgeYears: 3 });
  const result = await carryForwardArrivals({ context, previous, now: NOW, log, warn: sink() });
  assert.deepEqual(ids(result.releases), [[920041, 'filmin', '2026-10-16']]);
  assert.deepEqual(result.snapshot.arrivals.map((a) => a.id), [920041]);
  assert.deepEqual(result.snapshot.platforms, CATALOGUE, 'filtered ids stay in their set');
});

// --- Best effort (§11) ---

test('detail failures: 404 drops the arrival, other failures keep it in the snapshot for the next build', async () => {
  const previous = snapshot({ ...CATALOGUE, 'movistar-plus': [] });
  const { releases, snapshot: snap, warn, details } = await run({
    previous,
    routes: { [detailKey(920031)]: { status: 404, body: {} }, [detailKey(920032)]: { status: 503, body: {} } },
  });
  assert.deepEqual(releases, []);
  assert.equal(warn.lines.length, 2);
  assert.match(warn.lines[0], /920031.*HTTP 404\); dropped/);
  assert.match(warn.lines[1], /920032.*skipped in this build only/);
  assert.deepEqual(snap.arrivals, [{ id: 920032, platform: 'movistar-plus', detected: '2026-10-23', title: '' }]);
  assert.deepEqual(details, { total: 2, failed: 2 });
});

test('a failed provider list carries every previous set forward; carried-over arrivals are still emitted', async () => {
  const previous = snapshot(CATALOGUE, [{ id: 920031, platform: 'movistar-plus', detected: '2026-10-16', title: 'x' }]);
  const { releases, snapshot: snap, warn } = await run({
    previous,
    routes: { '/watch/providers/movie?watch_region=ES&language=es-ES': { status: 500, body: {} }, [detailKey(920031)]: detail(920031) },
  });
  assert.match(warn.lines.join('\n'), /provider list failed/);
  assert.deepEqual(ids(releases), [[920031, 'movistar-plus', '2026-10-16']]);
  assert.deepEqual(snap.platforms, CATALOGUE);
});

test('a failed catalogue query keeps that platform\'s previous set; in seed mode the platform is omitted', async () => {
  const routes = { [catalogueKey('filmin')]: { status: 500, body: {} } };
  const withPrevious = await run({ previous: snapshot({ ...CATALOGUE, filmin: [1, 2] }), routes });
  assert.match(withPrevious.warn.lines.join('\n'), /catalogue query of Filmin failed/);
  assert.deepEqual(withPrevious.snapshot.platforms.filmin, [1, 2]);

  const seedRun = await run({ env: { TMDB_API_KEY: KEY }, routes });
  assert.equal('filmin' in seedRun.snapshot.platforms, false);
  assert.equal(Object.keys(seedRun.snapshot.platforms).length, 7);
});

test('a platform whose aliases match no TMDB provider is reported and not diffed', async () => {
  const routes = {
    '/watch/providers/movie?watch_region=ES&language=es-ES': {
      body: { results: [{ provider_id: 8, provider_name: 'Netflix' }, { provider_id: 'x', provider_name: 'Filmin' }, null] },
    },
    [catalogueKey('netflix').replace('8%7C1796', '8')]: page([920001]),
  };
  const { warn, snapshot: snap } = await run({ env: { TMDB_API_KEY: KEY }, routes });
  assert.equal(warn.lines.filter((l) => /matches the aliases of/.test(l)).length, 7);
  assert.deepEqual(snap.platforms, { netflix: [920001] });
});

test('H1 with the ES provider list of 2026-10-31, Apple TV+ resolves id 350 only (not the store nor the channels)', async () => {
  assert.ok(ES_PROVIDERS.some(([, name]) => name === 'Apple TV Store'));
  const fetchImpl = createFixtureFetch();
  const settings = resolveSettings(ENV, NOW, sink());
  const context = createContext({ fetchImpl, settings, sleep: async () => {}, log: sink() });
  const resolved = await fetchProviderIds(context);
  assert.deepEqual(resolved.get('apple-tv-plus'), [350]);
  assert.deepEqual(Object.fromEntries([...resolved].map(([slug, list]) => [slug, list.join('|')])), PROVIDERS);
});

test('H1 the build no longer warns about Apple TV+ and diffs its catalogue (with_watch_providers=350)', async () => {
  const { warn, fetchImpl, snapshot: snap } = await run({ previous: snapshot() });
  assert.deepEqual(warn.lines, []);
  assert.ok(fetchImpl.calls.some((c) => c.key === fetchImpl.keyFor(catalogueKey('apple-tv-plus'))));
  assert.deepEqual(snap.platforms['apple-tv-plus'], [920071]);

  // The list as it was before the rename (no "Apple TV" subscription) still warns
  const old = await run({
    previous: snapshot(),
    routes: { [PROVIDER_LIST_KEY]: { body: providerListBody(ES_PROVIDERS.filter(([id]) => id !== 350)) } },
  });
  assert.equal(old.warn.lines.length, 1);
  assert.match(old.warn.lines[0], /matches the aliases of Apple TV\+/);
});

test('H1 a platform with 0 ids read and 0 in the previous snapshot: no arrivals and no warning', async () => {
  // The synthetic SkyShowtime catalogue is empty
  const { releases, warn, snapshot: snap } = await run({ previous: snapshot({ ...CATALOGUE, skyshowtime: [] }) });
  assert.deepEqual(releases, []);
  assert.deepEqual(warn.lines, []);
  assert.deepEqual(snap.platforms.skyshowtime, []);
  assert.deepEqual(diffPlatform({ previous: new Set(), seed: false, current: new Set(), cut: false, maxNew: 25 }),
    { set: new Set(), arrivals: [], status: 'diff' });
});

// --- Pure helpers ---

test('diffPlatform: seed, new platform, empty guard, flood guard, cut and plain diff', () => {
  const set = (...values) => new Set(values);
  const base = { seed: false, cut: false, maxNew: 2 };
  assert.deepEqual(diffPlatform({ ...base, seed: true, previous: set(1), current: set(1, 2) }), { set: set(1, 2), arrivals: [], status: 'seed' });
  assert.deepEqual(diffPlatform({ ...base, previous: undefined, current: set(1, 2) }), { set: set(1, 2), arrivals: [], status: 'new-platform' });
  assert.deepEqual(diffPlatform({ ...base, previous: set(1), current: set() }), { set: set(1), arrivals: [], status: 'empty-guard' });
  assert.deepEqual(diffPlatform({ ...base, previous: set(), current: set() }), { set: set(), arrivals: [], status: 'diff' });
  assert.deepEqual(diffPlatform({ ...base, previous: set(1), current: set(1, 2, 3, 4) }),
    { set: set(1, 2, 3, 4), arrivals: [], status: 'flood-guard', count: 3 });
  assert.deepEqual(diffPlatform({ ...base, previous: set(1, 5), current: set(3, 1) }), { set: set(3, 1), arrivals: [3], status: 'diff' });
  assert.deepEqual(diffPlatform({ ...base, cut: true, previous: set(1, 5), current: set(3, 1) }), { set: set(1, 5, 3), arrivals: [3], status: 'diff' });
});

test('parseSnapshot drops garbage ids, unknown platforms and malformed arrivals', () => {
  const parsed = parseSnapshot(snapshot({ netflix: [3, 1, 'x', -2, 1.5, null], nope: [7], filmin: 'x' }, [
    { id: 1, platform: 'netflix', detected: '2026-10-16', title: 5 },
    { id: 1, platform: 'netflix', detected: '2026-10-09' },
    { id: 2, platform: 'netflix', detected: '2026-13-01' },
  ]), { region: 'ES', maxAgeYears: 3 });
  assert.equal(parsed.ok, true);
  assert.deepEqual([...parsed.platforms], [['netflix', new Set([3, 1])]]);
  assert.deepEqual(parsed.arrivals, [{ id: 1, platform: 'netflix', detected: '2026-10-16', title: '' }]);
  assert.equal(parseSnapshot(snapshot({}, [], { platforms: null, arrivals: 'x' }), { region: 'ES', maxAgeYears: 3 }).ok, true);
});

test('readSnapshot reads a valid published snapshot', async () => {
  const fetchImpl = createFixtureFetch({ routes: { [SNAPSHOT_URL]: { body: snapshot() } } });
  const log = sink();
  const warn = sink();
  const result = await readSnapshot({ url: SNAPSHOT_URL, fetchImpl, region: 'ES', maxAgeYears: 3, log, warn });
  assert.equal(result.platforms.get('netflix').size, 3);
  assert.deepEqual(warn.lines, []);
  assert.match(log.lines[0], /Previous providers snapshot: 8 platforms, 0 arrivals/);
});

test('buildSnapshot sorts ids and arrivals (date, platform order, id) and keeps only §11 fields', () => {
  const doc = buildSnapshot({
    now: NOW,
    region: 'ES',
    maxAgeYears: 3,
    platforms: new Map([['filmin', new Set([3, 1])], ['netflix', new Set([2])]]),
    arrivals: [
      { id: 9, platform: 'filmin', detected: '2026-10-23', title: 'b', extra: 1 },
      { id: 8, platform: 'netflix', detected: '2026-10-23', title: 'a' },
      { id: 7, platform: 'filmin', detected: '2026-10-16', title: 'c' },
    ],
  });
  assert.deepEqual(doc.platforms, { netflix: [2], filmin: [1, 3] });
  assert.deepEqual(doc.arrivals, [
    { id: 7, platform: 'filmin', detected: '2026-10-16', title: 'c' },
    { id: 8, platform: 'netflix', detected: '2026-10-23', title: 'a' },
    { id: 9, platform: 'filmin', detected: '2026-10-23', title: 'b' },
  ]);
});

// --- Snapshot reading limits (review fixes) ---

test('the snapshot is fetched with redirect: "error"; a non-https final URL is seed mode', async () => {
  const fetchImpl = createFixtureFetch({ routes: { [SNAPSHOT_URL]: { body: snapshot() } } });
  await readSnapshot({ url: SNAPSHOT_URL, fetchImpl, region: 'ES', maxAgeYears: 3, log: sink(), warn: sink() });
  assert.equal(fetchImpl.calls[0].init.redirect, 'error');

  const redirected = async () => ({
    status: 200, url: 'http://example.org/s.json', headers: new Headers(), text: async () => JSON.stringify(snapshot()),
  });
  const warn = sink();
  const result = await readSnapshot({ url: SNAPSHOT_URL, fetchImpl: redirected, region: 'ES', maxAgeYears: 3, log: sink(), warn });
  assert.equal(result, null);
  assert.match(warn.lines[0], /does not come from an https:\/\/ URL.*seed mode/);
});

test('a snapshot body over the limit without content-length is cut while reading → seed mode', async () => {
  const big = JSON.stringify(snapshot(CATALOGUE, [{ id: 1, platform: 'netflix', detected: '2026-10-16', title: 'x'.repeat(MAX_SNAPSHOT_BYTES * 2) }]));
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      const chunk = Buffer.from(big.slice(pulled, pulled + 65536));
      pulled += 65536;
      if (chunk.length === 0) controller.close(); else controller.enqueue(chunk);
    },
  });
  const response = new Response(stream, { status: 200 });
  assert.equal(response.headers.get('content-length'), null);
  const warn = sink();
  const result = await readSnapshot({ url: SNAPSHOT_URL, fetchImpl: async () => response, region: 'ES', maxAgeYears: 3, log: sink(), warn });
  assert.equal(result, null);
  assert.match(warn.lines[0], /larger than \d+ bytes.*seed mode/);
  assert.ok(pulled < big.length, 'the reader stopped before the end of the body');
});

test('readLimited returns the text under the limit and null over it, with or without a stream', async () => {
  assert.equal(await readLimited(new Response('{"a":1}'), 100), '{"a":1}');
  assert.equal(await readLimited(new Response('ñ'.repeat(60)), 100), null, '120 bytes in UTF-8');
  assert.equal(await readLimited({ text: async () => 'abc' }, 3), 'abc');
  assert.equal(await readLimited({ text: async () => 'abcd' }, 3), null);
});

// --- Fallback when the arrivals step crashes (review fix) ---

test('carryForwardArrivals keeps the previous platforms and in-window arrivals and rebuilds what it can', async () => {
  const fetchImpl = createFixtureFetch({ routes: { [detailKey(920031)]: detail(920031) } });
  const log = sink();
  const warn = sink();
  const settings = resolveSettings(ENV, NOW, warn);
  const context = createContext({ fetchImpl, settings, sleep: async () => {}, log });
  const previous = parseSnapshot(snapshot(CATALOGUE, [
    { id: 920031, platform: 'movistar-plus', detected: '2026-10-16', title: 'In window' },
    { id: 920001, platform: 'netflix', detected: '2026-09-01', title: 'Expired' },
  ]), { region: 'ES', maxAgeYears: 3 });
  const result = await carryForwardArrivals({ context, previous, now: NOW, log, warn });
  assert.deepEqual(result.snapshot.platforms, CATALOGUE);
  // Same rules as computeArrivals: the snapshot keeps the rebuilt arrivals, with their current title
  assert.deepEqual(result.snapshot.arrivals, [{ id: 920031, platform: 'movistar-plus', detected: '2026-10-16', title: 'Llegada 920031' }]);
  assert.deepEqual(ids(result.releases), [[920031, 'movistar-plus', '2026-10-16']]);

  const none = await carryForwardArrivals({ context, previous: null, now: NOW, log, warn });
  assert.deepEqual([none.snapshot.platforms, none.snapshot.arrivals, none.releases], [{}, [], []]);
});
