const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getHorrorReleases, fetchHorrorReleases, resolveSettings, parseProviders, parseReleaseNote, parseTypeDates,
  parseDetail, passesRuntimeRule, subtractYears, compareReleases, retryAfterMs, TmdbError, DETAIL_CONCURRENCY,
} = require('../../src/tmdb');
const { createFixtureFetch, readFixture } = require('../support/fixture-fetch');

// Same day as the 2026-10-23 capture: the default 90-day window hits the captured files
const NOW = new Date('2026-10-23T12:00:00.000Z');
const KEY = 'fake-key-0123456789abcdef';
const ENV = { TMDB_API_KEY: KEY };

const WINDOW = 'language=es-ES&region=ES&with_genres=27&release_date.gte=2026-10-23&release_date.lte=2027-01-21';
const discoverKey = (type, page = 1) => `/discover/movie?${WINDOW}&with_release_type=${encodeURIComponent(type)}&page=${page}`;
const CAPTURED_THEATRICAL = readFixture('discover_movie__language=es-ES,page=1,region=ES,release_date.gte=2026-10-23,'
  + 'release_date.lte=2027-01-21,with_genres=27,with_release_type=3~7C2.json');
const CAPTURED_DIGITAL = readFixture('discover_movie__language=es-ES,page=1,region=ES,release_date.gte=2026-10-23,'
  + 'release_date.lte=2027-01-21,with_genres=27,with_release_type=4.json');

function sink() {
  const lines = [];
  const fn = (...args) => lines.push(args.join(' '));
  fn.lines = lines;
  return fn;
}

function sleeper() {
  const delays = [];
  const fn = async (ms) => { delays.push(ms); };
  fn.delays = delays;
  return fn;
}

function movie(id, releaseDate, overrides = {}) {
  return {
    id,
    title: `Película ${id}`,
    original_title: `Movie ${id}`,
    release_date: releaseDate,
    overview: `Sinopsis ${id}.`,
    poster_path: `/p${id}.jpg`,
    ...overrides,
  };
}

const page = (results, totalPages = 1) => ({ body: { page: 1, total_pages: totalPages, total_results: results.length, results } });
// The combined detail request of §7 (one per movie id)
const detailKey = (id) => `/movie/${id}?language=es-ES&append_to_response=${encodeURIComponent('release_dates,watch/providers')}`;
const detail = (id, overrides = {}) => ({
  body: { id, runtime: 90, imdb_id: `tt${id}`, release_dates: { results: [] }, 'watch/providers': { results: {} }, ...overrides },
});

/** Routes for a small synthetic run: given discover results, a 90-min detail per movie id. */
function smallRoutes({ theatrical = [], digital = [] } = {}) {
  const routes = {
    [discoverKey('3|2')]: page(theatrical),
    [discoverKey('4')]: page(digital),
  };
  for (const m of [...theatrical, ...digital]) {
    if (Number.isInteger(m?.id)) routes[detailKey(m.id)] = detail(m.id);
  }
  return routes;
}

async function run(fetchImpl, options = {}) {
  const log = options.log ?? sink();
  const sleep = options.sleep ?? sleeper();
  const result = await fetchHorrorReleases({ fetchImpl, now: NOW, env: ENV, log, sleep, ...options });
  return { ...result, log, sleep };
}

test('captured run: two regional discover queries with the exact §7 parameters', async () => {
  const mockFetch = createFixtureFetch();
  await run(mockFetch);

  const discover = mockFetch.calls.filter((c) => c.key.startsWith('/discover/movie'));
  assert.deepEqual(discover.map((c) => c.key), [
    mockFetch.keyFor(discoverKey('3|2')),
    mockFetch.keyFor(discoverKey('4')),
  ]);
  for (const call of mockFetch.calls) {
    const url = new URL(call.url);
    assert.equal(url.origin + url.pathname.slice(0, 2), 'https://api.themoviedb.org/3');
    assert.equal(url.searchParams.get('api_key'), KEY, 'API v3 key as query parameter');
    assert.doesNotMatch(call.url, /primary_release_date/);
  }
  for (const call of discover) {
    const p = new URL(call.url).searchParams;
    assert.equal(p.get('region'), 'ES');
    assert.equal(p.get('language'), 'es-ES');
    assert.equal(p.get('with_genres'), '27');
    assert.equal(p.get('release_date.gte'), '2026-10-23');
    assert.equal(p.get('release_date.lte'), '2027-01-21');
    assert.equal(p.get('page'), '1');
    assert.equal(p.has('sort_by'), false);
  }
});

test('captured run: 13 theatrical + 4 digital releases with the Spanish regional dates, sorted', async () => {
  const { releases, window, region } = await run(createFixtureFetch());

  assert.equal(region, 'ES');
  assert.deepEqual(window, { from: '2026-10-23', to: '2027-01-21' });
  assert.equal(releases.filter((r) => r.type === 'theatrical').length, 13);
  assert.equal(releases.filter((r) => r.type === 'digital').length, 4);

  // releaseDate is the discover release_date of the query the release came from
  for (const [list, type] of [[CAPTURED_THEATRICAL, 'theatrical'], [CAPTURED_DIGITAL, 'digital']]) {
    for (const m of list.results) {
      const r = releases.find((x) => x.id === m.id && x.type === type);
      assert.ok(r, `${m.id} ${type}`);
      assert.equal(r.releaseDate, m.release_date);
      assert.equal(r.title, m.title);
      assert.equal(r.originalTitle, m.original_title);
      assert.equal(r.posterPath, m.poster_path);
      assert.equal(r.tmdbUrl, `https://www.themoviedb.org/movie/${m.id}`);
    }
  }

  const sorted = [...releases].sort((a, b) => (a.releaseDate === b.releaseDate
    ? a.title.localeCompare(b.title, 'es') : a.releaseDate.localeCompare(b.releaseDate)));
  assert.deepEqual(releases.map((r) => `${r.releaseDate} ${r.title}`), sorted.map((r) => `${r.releaseDate} ${r.title}`));

  for (const r of releases) {
    assert.deepEqual(Object.keys(r), ['id', 'title', 'originalTitle', 'releaseDate', 'type', 'source', 'providers',
      'releaseNote', 'arrivalPlatform', 'sourceUrl', 'runtime', 'posterPath', 'overview', 'tmdbUrl']);
    assert.equal('calendars' in r, false);
    assert.equal(r.source, 'tmdb');
    assert.equal(r.arrivalPlatform, null);
    assert.equal(r.sourceUrl, null);
  }
  assert.equal(releases.find((r) => r.id === 1702511).runtime, 52);
  assert.equal(releases.find((r) => r.id === 1788146).runtime, null, 'runtime 0 is stored as null (kept: imdb_id)');
});

test('captured run: one combined detail request per movie, English overview only when Spanish is empty', async () => {
  const mockFetch = createFixtureFetch();
  const { releases, details } = await run(mockFetch);
  const keys = mockFetch.calls.map((c) => c.key);
  const all = [...CAPTURED_THEATRICAL.results, ...CAPTURED_DIGITAL.results];

  for (const m of all) {
    assert.equal(keys.filter((k) => k === mockFetch.keyFor(detailKey(m.id))).length, 1, `detail of ${m.id}`);
  }
  assert.equal(keys.filter((k) => /\/(watch\/providers|release_dates)$/.test(k)).length, 0, 'no separate requests');
  const english = keys.filter((k) => k.endsWith('?language=en-US')).map((k) => Number(k.split('/')[2].split('?')[0])).sort();
  const withoutOverview = all.filter((m) => !m.overview).map((m) => m.id).sort();
  assert.deepEqual(english, withoutOverview);
  assert.deepEqual(details, { total: all.length + withoutOverview.length, failed: 0 });

  const byId = (id) => releases.find((r) => r.id === id);
  assert.equal(byId(1376400).overview, 'Synthetic English overview for 1376400.');
  assert.equal(byId(1788146).overview, '', 'empty in both languages → empty string');
  assert.equal(byId(1400940).overview, CAPTURED_THEATRICAL.results.find((m) => m.id === 1400940).overview);
});

test('captured run: release notes from the Spanish type-4 entry, providers empty in ES', async () => {
  const { releases } = await run(createFixtureFetch());
  const byId = (id) => releases.find((r) => r.id === id);

  assert.equal(byId(1507696).releaseNote, 'Prime Video', 'type-1 festival note is ignored');
  assert.equal(byId(1702511).releaseNote, 'Netflix', 'US note is ignored, ES note used');
  assert.equal(byId(1393171).releaseNote, null);
  assert.equal(byId(1739309).releaseNote, null);
  for (const r of releases) {
    assert.deepEqual(r.providers, { flatrate: [], rentBuy: [] });
    if (r.type === 'theatrical') assert.equal(r.releaseNote, null);
  }
});

test('getHorrorReleases returns the release array of fetchHorrorReleases', async () => {
  const releases = await getHorrorReleases({ fetchImpl: createFixtureFetch(), now: NOW, env: ENV, log: sink(), sleep: sleeper() });
  assert.ok(Array.isArray(releases));
  assert.equal(releases.length, 17);
});

test('dedup inside a query (first wins); the same id in both queries gives two releases', async () => {
  const routes = smallRoutes({
    theatrical: [movie(1, '2026-11-01'), movie(1, '2026-11-05', { title: 'Duplicada' }), movie(2, '2026-11-02')],
    digital: [movie(1, '2026-12-01'), movie(3, '2026-12-02'), movie(3, '2026-12-03')],
  });
  const { releases } = await run(createFixtureFetch({ routes }));

  assert.deepEqual(releases.map((r) => [r.id, r.type, r.releaseDate]), [
    [1, 'theatrical', '2026-11-01'],
    [2, 'theatrical', '2026-11-02'],
    [1, 'digital', '2026-12-01'],
    [3, 'digital', '2026-12-02'],
  ]);
});

test('strict inclusion: no Spanish date in the window, no entry; synopsis and poster are not criteria', async () => {
  const routes = smallRoutes({
    theatrical: [
      movie(1, '2026-10-23', { overview: '', poster_path: null }),
      movie(2, '2027-01-21'),
      movie(3, '2026-10-22'),
      movie(4, '2027-01-22'),
      movie(5, ''),
      movie(6, null),
      { title: 'Sin id', release_date: '2026-11-01' },
      null,
    ],
  });
  routes['/movie/1?language=en-US'] = { body: { id: 1, overview: null } };
  const { releases } = await run(createFixtureFetch({ routes }));

  assert.deepEqual(releases.map((r) => r.id), [1, 2]);
  assert.equal(releases[0].overview, '');
  assert.equal(releases[0].posterPath, null);
});

test('TMDB fields are optional: missing results, titles and poster are handled', async () => {
  const routes = {
    [discoverKey('3|2')]: { body: { total_pages: null } },
    [discoverKey('4')]: page([{ id: 7, release_date: '2026-11-11', original_title: 'Only Original' }]),
    [detailKey(7)]: { body: { imdb_id: 'tt7', release_dates: { results: [{ iso_3166_1: 'ES' }] }, 'watch/providers': {} } },
    '/movie/7?language=en-US': { body: {} },
  };
  const { releases } = await run(createFixtureFetch({ routes }));
  assert.deepEqual(releases, [{
    id: 7,
    title: 'Only Original',
    originalTitle: 'Only Original',
    releaseDate: '2026-11-11',
    type: 'digital',
    source: 'tmdb',
    providers: { flatrate: [], rentBuy: [] },
    releaseNote: null,
    arrivalPlatform: null,
    sourceUrl: null,
    runtime: null,
    posterPath: null,
    overview: '',
    tmdbUrl: 'https://www.themoviedb.org/movie/7',
  }]);
});

test('a detail that is garbage (array, strings, nulls) never crashes and keeps the release', async () => {
  const routes = smallRoutes({ digital: [movie(1, '2026-11-01'), movie(2, '2026-11-02')] });
  routes[detailKey(1)] = { body: [] };
  routes[detailKey(2)] = { body: { runtime: 'long', imdb_id: 42, release_dates: 'x', 'watch/providers': { results: { ES: 'x' } } } };
  const { releases } = await run(createFixtureFetch({ routes }));
  // runtime unknown and no usable imdb_id: the detail succeeded, so the runtime rule drops them
  assert.deepEqual(releases, []);
  const kept = await run(createFixtureFetch({ routes }), { env: { ...ENV, MIN_RUNTIME: '0' } });
  assert.deepEqual(kept.releases.map((r) => [r.id, r.runtime, r.releaseNote, r.providers.flatrate.length]),
    [[1, null, null, 0], [2, null, null, 0]]);
});

test('provider classification: flatrate included, rent + buy merged without duplicates', async () => {
  const routes = smallRoutes({ digital: [movie(5, '2026-11-20')] });
  routes[detailKey(5)] = detail(5, { 'watch/providers': readFixture('case_watch_providers_es.json') });
  const { releases } = await run(createFixtureFetch({ routes }));

  assert.deepEqual(releases[0].providers, {
    // Netflix deduplicated; the ads tier only because it is a Netflix alias; Pluto TV,
    // RTVE Play (free) and the US entry ignored
    flatrate: ['Netflix', 'Filmin', 'Netflix basic with Ads'],
    rentBuy: ['Apple TV', 'Rakuten TV', 'Google Play Movies'],
  });
});

test('parseProviders is null-safe and only reads the requested region', () => {
  assert.deepEqual(parseProviders(null, 'ES'), { flatrate: [], rentBuy: [] });
  assert.deepEqual(parseProviders({ results: { ES: null } }, 'ES'), { flatrate: [], rentBuy: [] });
  assert.deepEqual(parseProviders({ results: { ES: { flatrate: null, rent: [null, {}], buy: 'x' } } }, 'ES'),
    { flatrate: [], rentBuy: [] });
  assert.deepEqual(parseProviders(readFixture('case_watch_providers_es.json'), 'US'), { flatrate: ['Hulu'], rentBuy: [] });
});

test('parseReleaseNote: region entry, type 4, same day, fallback, empty → null, other types ignored', () => {
  const d = (date, type, note) => ({ release_date: `${date}T00:00:00.000Z`, type, note });
  const body = (es, other = []) => ({ results: [...other, { iso_3166_1: 'ES', release_dates: es }] });

  // same day wins over an earlier type-4 note
  assert.equal(parseReleaseNote(body([d('2026-10-01', 4, 'Filmin'), d('2026-10-30', 4, ' Prime Video ')]), 'ES', '2026-10-30'), 'Prime Video');
  // same day with an empty note: null, no fallback to another digital release
  assert.equal(parseReleaseNote(body([d('2026-10-30', 4, ''), d('2026-12-01', 4, 'Netflix')]), 'ES', '2026-10-30'), null);
  // no type-4 date on that day: first type-4 date with a non-empty note
  assert.equal(parseReleaseNote(body([d('2026-10-01', 4, '  '), d('2026-10-02', 4, 'Netflix'), d('2026-10-03', 4, 'Filmin')]), 'ES', '2026-10-30'), 'Netflix');
  // other types are ignored, even on the same day
  assert.equal(parseReleaseNote(body([d('2026-10-30', 1, 'Sitges'), d('2026-10-30', 3, 'Cines')]), 'ES', '2026-10-30'), null);
  // other regions are ignored
  assert.equal(parseReleaseNote(body([], [{ iso_3166_1: 'US', release_dates: [d('2026-10-30', 4, 'Netflix')] }]), 'ES', '2026-10-30'), null);
  // type given as a string still counts
  assert.equal(parseReleaseNote(body([d('2026-10-30', '4', 'Netflix')]), 'ES', '2026-10-30'), 'Netflix');
  // null-safety
  for (const value of [null, {}, { results: null }, { results: [null] }, body(null), body([null, { type: 4 }])]) {
    assert.equal(parseReleaseNote(value, 'ES', '2026-10-30'), null);
  }
});

test('a failed detail is counted and leaves runtime, note and providers empty; the release is kept', async () => {
  const routes = smallRoutes({ digital: [1, 2, 3, 4, 5, 6].map((id) => movie(id, `2026-11-0${id}`)) });
  routes[detailKey(3)] = { status: 404, body: { status_code: 34 } };
  const { releases, details, log } = await run(createFixtureFetch({ routes }));

  const r = releases.find((x) => x.id === 3);
  assert.ok(r, 'kept: the runtime rule only removes releases whose detail succeeded');
  assert.equal(r.releaseNote, null);
  assert.equal(r.runtime, null);
  assert.deepEqual(r.providers, { flatrate: [], rentBuy: [] });
  assert.deepEqual(details, { total: 6, failed: 1 });
  assert.match(log.lines.join('\n'), /\/movie\/3\?.*failed: HTTP 404/);
  assert.match(log.lines.join('\n'), /Detail requests: 6, failed: 1\./);
});

test('a movie in both queries gets one detail request; both releases use it', async () => {
  const routes = smallRoutes({ theatrical: [movie(1, '2026-11-01')], digital: [movie(1, '2027-01-01')] });
  routes[detailKey(1)] = detail(1, {
    runtime: 101,
    'watch/providers': { results: { ES: { flatrate: [{ provider_name: 'Filmin' }] } } },
    release_dates: { results: [{ iso_3166_1: 'ES', release_dates: [{ type: 4, release_date: '2027-01-01T00:00:00.000Z', note: 'Filmin' }] }] },
  });
  const mockFetch = createFixtureFetch({ routes });
  const { releases, details } = await run(mockFetch);

  assert.equal(mockFetch.calls.filter((c) => c.key === mockFetch.keyFor(detailKey(1))).length, 1);
  assert.deepEqual(details, { total: 1, failed: 0 });
  assert.deepEqual(releases.map((r) => [r.type, r.runtime, r.releaseNote, r.providers.flatrate]), [
    ['theatrical', 101, null, []],
    ['digital', 101, 'Filmin', ['Filmin']],
  ]);
});

test('more than 20 % of the tmdb detail requests failing is an error', async () => {
  // 10 digital releases → 10 detail requests; 3 failures = 30 %
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => movie(id, `2026-11-${String(id).padStart(2, '0')}`));
  const routes = smallRoutes({ digital: ten });
  for (const id of [1, 2, 3]) routes[detailKey(id)] = { status: 404, body: {} };
  await assert.rejects(run(createFixtureFetch({ routes })), (err) => err instanceof TmdbError && /3 of 10 .*detail requests failed/.test(err.message));

  // exactly 20 % is still fine
  const ok = smallRoutes({ digital: ten });
  for (const id of [1, 2]) ok[detailKey(id)] = { status: 404, body: {} };
  const { details } = await run(createFixtureFetch({ routes: ok }));
  assert.deepEqual(details, { total: 10, failed: 2 });
});

test('a pagination cut is never silent: ::warning:: with query, total_pages and MAX_PAGES', async () => {
  const routes = smallRoutes({ digital: [movie(9, '2026-11-09')] });
  routes[discoverKey('3|2')] = { fixture: 'case_discover_many_pages.json' };
  routes[discoverKey('3|2', 2)] = page([movie(910002, '2026-11-11')], 12);
  for (const id of [910001, 910002]) routes[detailKey(id)] = detail(id);
  const mockFetch = createFixtureFetch({ routes });
  const { releases, log } = await run(mockFetch, { env: { ...ENV, MAX_PAGES: '2' } });

  const pages = mockFetch.calls.filter((c) => c.key.includes('with_release_type=3%7C2')).map((c) => new URL(c.url).searchParams.get('page'));
  assert.deepEqual(pages, ['1', '2']);
  assert.deepEqual(releases.filter((r) => r.type === 'theatrical').map((r) => r.id), [910001, 910002]);
  const warnings = log.lines.filter((l) => l.startsWith('::warning::'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /theatrical \(with_release_type=3\|2\).*total_pages=12.*MAX_PAGES=2/);
});

test('pages are followed up to total_pages without a warning when within MAX_PAGES', async () => {
  const routes = smallRoutes({ digital: [movie(9, '2026-11-09')] });
  routes[discoverKey('3|2')] = page([movie(1, '2026-11-01')], 3);
  routes[discoverKey('3|2', 2)] = page([movie(2, '2026-11-02')], 3);
  routes[discoverKey('3|2', 3)] = page([movie(1, '2026-11-03'), movie(3, '2026-11-03')], 3);
  for (const id of [1, 2, 3]) routes[detailKey(id)] = detail(id);
  const { releases, log } = await run(createFixtureFetch({ routes }));

  assert.deepEqual(releases.filter((r) => r.type === 'theatrical').map((r) => r.id), [1, 2, 3]);
  assert.equal(log.lines.filter((l) => l.startsWith('::warning::')).length, 0);
});

test('429 is retried honouring Retry-After; 5xx with exponential backoff; the sleep is injected', async () => {
  const routes = smallRoutes({ digital: [movie(1, '2026-11-01')] });
  const mockFetch = createFixtureFetch({ routes });
  mockFetch.enqueue(discoverKey('4'), { fixture: 'case_rate_limited.json', status: 429, headers: { 'Retry-After': '7' } });
  mockFetch.enqueue(detailKey(1), { status: 503, body: {} }, { status: 500, body: {} });
  const sleep = sleeper();
  const { releases, details } = await run(mockFetch, { sleep });

  assert.equal(releases.length, 1);
  assert.deepEqual(details, { total: 1, failed: 0 });
  assert.deepEqual(sleep.delays, [7000, 1000, 2000]);
  assert.equal(mockFetch.calls.filter((c) => c.key === mockFetch.keyFor(discoverKey('4'))).length, 2);
  assert.equal(mockFetch.calls.filter((c) => c.key === mockFetch.keyFor(detailKey(1))).length, 3);
});

test('a detail request is retried at most 3 times and then counted as a failure', async () => {
  const routes = smallRoutes({ digital: [1, 2, 3, 4, 5, 6].map((id) => movie(id, `2026-11-0${id}`)) });
  routes[detailKey(2)] = { status: 502, body: {} };
  const mockFetch = createFixtureFetch({ routes });
  const sleep = sleeper();
  const { releases, details } = await run(mockFetch, { sleep });

  assert.equal(mockFetch.calls.filter((c) => c.key === mockFetch.keyFor(detailKey(2))).length, 4);
  assert.deepEqual(sleep.delays, [1000, 2000, 4000]);
  assert.equal(details.failed, 1);
  assert.equal(releases.length, 6);
});

test('4xx other than 429 is not retried', async () => {
  const routes = smallRoutes({ digital: [1, 2, 3, 4, 5, 6].map((id) => movie(id, `2026-11-0${id}`)) });
  routes[detailKey(2)] = { status: 401, body: {} };
  const mockFetch = createFixtureFetch({ routes });
  const sleep = sleeper();
  await run(mockFetch, { sleep });
  assert.equal(mockFetch.calls.filter((c) => c.key === mockFetch.keyFor(detailKey(2))).length, 1);
  assert.deepEqual(sleep.delays, []);
});

test('retryAfterMs reads seconds and HTTP dates, capped, and ignores garbage', () => {
  assert.equal(retryAfterMs('3'), 3000);
  assert.equal(retryAfterMs('0'), 0);
  assert.equal(retryAfterMs('3600'), 60000);
  assert.equal(retryAfterMs(new Date(Date.UTC(2026, 9, 23, 12, 0, 5)).toUTCString(), Date.UTC(2026, 9, 23, 12, 0, 0)), 5000);
  for (const value of [null, undefined, '', 'soon']) assert.equal(retryAfterMs(value), null);
});

test(`detail requests run in a pool of at most ${DETAIL_CONCURRENCY}`, async () => {
  const digital = Array.from({ length: 9 }, (_, i) => movie(i + 1, `2026-11-${String(i + 10)}`, { overview: '' }));
  const routes = smallRoutes({ digital });
  for (const m of digital) routes[`/movie/${m.id}?language=en-US`] = { body: { overview: 'EN' } };
  const inner = createFixtureFetch({ routes });
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = async (url) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => { setImmediate(resolve); });
    try {
      return await inner(url);
    } finally {
      inFlight -= 1;
    }
  };
  const { details } = await run(fetchImpl);
  assert.equal(details.total, 18, '9 details + 9 English overviews');
  assert.equal(peak, DETAIL_CONCURRENCY);
});

test('both discover queries with zero results is an error', async () => {
  await assert.rejects(run(createFixtureFetch({ routes: smallRoutes() })),
    (err) => err instanceof TmdbError && /0 releases/.test(err.message));
});

test('a discover request that fails after retries is an error and the key is not in the message', async () => {
  const routes = smallRoutes({ digital: [movie(1, '2026-11-01')] });
  routes[discoverKey('3|2')] = { status: 500, body: {} };
  const sleep = sleeper();
  await assert.rejects(run(createFixtureFetch({ routes }), { sleep }), (err) => {
    assert.ok(err instanceof TmdbError);
    assert.match(err.message, /discover\/movie.*HTTP 500 after 4 attempts/);
    assert.doesNotMatch(err.message, new RegExp(KEY));
    return true;
  });
  assert.equal(sleep.delays.length, 3);
});

test('network errors are retried and never leak the key', async () => {
  const sleep = sleeper();
  const log = sink();
  const failing = async (url) => { throw new Error(`getaddrinfo ENOTFOUND ${url}`); };
  await assert.rejects(run(failing, { sleep, log }), (err) => {
    assert.match(err.message, /network error/);
    assert.doesNotMatch(err.message, new RegExp(KEY));
    return true;
  });
  assert.equal(sleep.delays.length, 3);
  assert.doesNotMatch(log.lines.join('\n'), new RegExp(KEY));
});

test('a missing API key is an error before any request', async () => {
  const mockFetch = createFixtureFetch();
  await assert.rejects(fetchHorrorReleases({ fetchImpl: mockFetch, now: NOW, env: {}, log: sink() }), /TMDB_API_KEY/);
  assert.equal(mockFetch.calls.length, 0);
});

test('WINDOW_DAYS and MAX_PAGES: defaults, valid values and invalid values with a warning', () => {
  const warn = sink();
  assert.deepEqual(
    (({ windowDays, maxPages, from, to, language, region }) => ({ windowDays, maxPages, from, to, language, region }))(resolveSettings({}, NOW, warn)),
    { windowDays: 90, maxPages: 5, from: '2026-10-23', to: '2027-01-21', language: 'es-ES', region: 'ES' },
  );
  assert.deepEqual(warn.lines, []);

  const ok = resolveSettings({ WINDOW_DAYS: ' 30 ', MAX_PAGES: '20', TMDB_LANGUAGE: 'en-US', TMDB_REGION: 'MX' }, NOW, warn);
  assert.deepEqual([ok.windowDays, ok.maxPages, ok.to, ok.language, ok.region], [30, 20, '2026-11-22', 'en-US', 'MX']);
  assert.deepEqual(warn.lines, []);

  for (const [name, value, fallback] of [
    ['WINDOW_DAYS', '0', 90], ['WINDOW_DAYS', '367', 90], ['WINDOW_DAYS', '1.5', 90], ['WINDOW_DAYS', 'abc', 90],
    ['MAX_PAGES', '0', 5], ['MAX_PAGES', '21', 5], ['MAX_PAGES', '-1', 5], ['MAX_PAGES', '2e', 5],
  ]) {
    const w = sink();
    const s = resolveSettings({ [name]: value }, NOW, w);
    assert.equal(name === 'WINDOW_DAYS' ? s.windowDays : s.maxPages, fallback, `${name}=${value}`);
    assert.equal(w.lines.length, 1);
    assert.match(w.lines[0], new RegExp(`${name}="${value.replace('.', '\\.')}".*using ${fallback}`));
  }
});

test('the window is computed in UTC from the injected clock', () => {
  const lateNight = resolveSettings({ WINDOW_DAYS: '1' }, new Date('2026-12-31T23:59:59.999Z'), sink());
  assert.deepEqual([lateNight.from, lateNight.to], ['2026-12-31', '2027-01-01']);
  const leap = resolveSettings({ WINDOW_DAYS: '366' }, new Date('2028-01-01T00:00:00.000Z'), sink());
  assert.deepEqual([leap.from, leap.to], ['2028-01-01', '2029-01-01']);
});

test('invalid settings become ::warning:: lines in the run log', async () => {
  const { log } = await run(createFixtureFetch(), { env: { ...ENV, WINDOW_DAYS: 'nope' } });
  assert.ok(log.lines.some((l) => /^::warning::WINDOW_DAYS="nope".*using 90/.test(l)));
});

test('TMDB_REGION is upper-cased: "es" queries region=ES and reads results.ES and iso_3166_1 "ES"', async () => {
  const routes = smallRoutes({ digital: [movie(5, '2026-11-20')] });
  routes[detailKey(5)] = detail(5, {
    'watch/providers': readFixture('case_watch_providers_es.json'),
    release_dates: { results: [{ iso_3166_1: 'ES', release_dates: [{ type: 4, release_date: '2026-11-20T00:00:00.000Z', note: 'Netflix' }] }] },
  });
  const mockFetch = createFixtureFetch({ routes });
  const { releases, region } = await run(mockFetch, { env: { ...ENV, TMDB_REGION: ' es ' } });

  assert.equal(region, 'ES');
  for (const call of mockFetch.calls.filter((c) => c.key.startsWith('/discover/movie'))) {
    assert.equal(new URL(call.url).searchParams.get('region'), 'ES');
  }
  assert.deepEqual(releases[0].providers.flatrate, ['Netflix', 'Filmin', 'Netflix basic with Ads']);
  assert.equal(releases[0].releaseNote, 'Netflix');
});

test('dedup marks an id as seen before the window check: an out-of-window first occurrence wins', async () => {
  const routes = smallRoutes({
    theatrical: [movie(1, '2027-02-01'), movie(2, '2026-11-02'), movie(1, '2026-11-05')],
    digital: [movie(1, '2026-12-01')],
  });
  const { releases } = await run(createFixtureFetch({ routes }));

  assert.deepEqual(releases.map((r) => [r.id, r.type, r.releaseDate]), [
    [2, 'theatrical', '2026-11-02'],
    [1, 'digital', '2026-12-01'],
  ]);
});

test('escapeCommand escapes %, CR and LF for workflow commands', () => {
  const { escapeCommand } = require('../../src/tmdb');
  assert.equal(escapeCommand('a%b\r\nc\nd\re'), 'a%25b%0D%0Ac%0Ad%0De');
  assert.equal(escapeCommand('plain: text'), 'plain: text');
});

test('non-OK response bodies are cancelled before retrying or failing; a missing body is tolerated', async () => {
  const routes = smallRoutes({ digital: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((id) => movie(id, `2026-11-${String(id).padStart(2, '0')}`)) });
  routes[detailKey(2)] = { status: 404, body: {} };
  const inner = createFixtureFetch({ routes });
  inner.enqueue(detailKey(1), { status: 503, body: {} });
  let cancelled = 0;
  let bodyless = 0;
  const fetchImpl = async (url) => {
    if (url.includes('/movie/3?')) {
      bodyless += 1;
      // Mock response without a body stream
      return { ok: false, status: 500, headers: new Headers() };
    }
    const res = await inner(url);
    if (!res.ok && res.body) {
      const original = res.body.cancel.bind(res.body);
      res.body.cancel = async (...args) => {
        cancelled += 1;
        return original(...args);
      };
    }
    return res;
  };
  const { details } = await run(fetchImpl);

  assert.equal(cancelled, 2, 'the 503 before its retry and the final 404');
  assert.equal(bodyless, 4, 'bodyless 500 retried 3 times without throwing');
  assert.deepEqual(details, { total: 10, failed: 2 });
});

// --- Runtime rule (§2) and the settings of F4 ---

test('E1 runtime rule: 20 min removed, 52 min kept, no runtime kept only with imdb_id, runtime 0 = no runtime', async () => {
  const routes = smallRoutes({
    theatrical: [movie(1, '2026-11-01'), movie(2, '2026-11-02'), movie(3, '2026-11-03'), movie(4, '2026-11-04')],
    digital: [movie(5, '2026-11-05', { overview: '' }), movie(6, '2026-11-06')],
  });
  routes[detailKey(1)] = detail(1, { runtime: 20 });
  routes[detailKey(2)] = detail(2, { runtime: 52, imdb_id: null });
  routes[detailKey(3)] = detail(3, { runtime: null, imdb_id: 'tt0000003' });
  routes[detailKey(4)] = detail(4, { runtime: 0, imdb_id: '' });
  routes[detailKey(5)] = detail(5, { runtime: 0, imdb_id: null });
  routes[detailKey(6)] = detail(6, { runtime: 40 });
  const mockFetch = createFixtureFetch({ routes });
  const { releases, removed } = await run(mockFetch);

  assert.deepEqual(releases.map((r) => [r.id, r.runtime]), [[2, 52], [3, null], [6, 40]]);
  assert.deepEqual(removed.map((r) => [r.id, r.type, r.runtime]), [[1, 'theatrical', 20], [4, 'theatrical', null], [5, 'digital', null]]);
  assert.ok(!mockFetch.calls.some((c) => c.key === '/movie/5?language=en-US'), 'no English fallback for a removed release');
});

test('E1 MIN_RUNTIME: custom threshold, and 0 disables the whole rule (imdb_id check included)', async () => {
  const routes = smallRoutes({ theatrical: [movie(1, '2026-11-01'), movie(2, '2026-11-02'), movie(3, '2026-11-03')] });
  routes[detailKey(1)] = detail(1, { runtime: 20 });
  routes[detailKey(2)] = detail(2, { runtime: 75 });
  routes[detailKey(3)] = detail(3, { runtime: null, imdb_id: null });

  const strict = await run(createFixtureFetch({ routes }), { env: { ...ENV, MIN_RUNTIME: '80' } });
  assert.deepEqual(strict.releases.map((r) => r.id), []);
  const off = await run(createFixtureFetch({ routes }), { env: { ...ENV, MIN_RUNTIME: '0' } });
  assert.deepEqual(off.releases.map((r) => r.id), [1, 2, 3]);
  assert.deepEqual(off.removed, []);
});

test('passesRuntimeRule and parseDetail are null-safe', () => {
  assert.equal(passesRuntimeRule({ runtime: 40, imdbId: null }, 40), true);
  assert.equal(passesRuntimeRule({ runtime: 39, imdbId: 'tt1' }, 40), false, 'a runtime wins over the imdb_id');
  assert.equal(passesRuntimeRule({ runtime: null, imdbId: 'tt1' }, 40), true);
  assert.equal(passesRuntimeRule({ runtime: null, imdbId: null }, 40), false);
  assert.equal(passesRuntimeRule(null, 40), false);
  assert.equal(passesRuntimeRule(null, 0), true);
  for (const body of [null, undefined, 'x', 42, [], {}]) {
    assert.deepEqual(parseDetail(body), {
      id: null, title: '', originalTitle: '', overview: '', posterPath: null, runtime: null, imdbId: null,
      releaseDates: null, providers: null,
    });
  }
  assert.equal(parseDetail({ runtime: -5 }).runtime, null);
  assert.equal(parseDetail({ runtime: '95' }).runtime, 95);
  assert.equal(parseDetail({ runtime: '' }).runtime, null);
  assert.equal(parseDetail({ imdb_id: '  ' }).imdbId, null);
});

test('parseTypeDates reads the regional dates of one type and ignores garbage', () => {
  const body = { results: [
    { iso_3166_1: 'US', release_dates: [{ type: 4, release_date: '2026-01-01T00:00:00.000Z' }] },
    { iso_3166_1: 'ES', release_dates: [{ type: 4, release_date: '2026-10-01T00:00:00.000Z' }, { type: 3, release_date: '2026-09-01T00:00:00.000Z' },
      { type: '4', release_date: '2026-10-05' }, { type: 4, release_date: 'soon' }, null, { type: 4 }] },
  ] };
  assert.deepEqual(parseTypeDates(body, 'ES', 4), ['2026-10-01', '2026-10-05']);
  assert.deepEqual(parseTypeDates(null, 'ES', 4), []);
});

test('the F4 settings: defaults, ranges and invalid values with a warning (E9)', () => {
  const warn = sink();
  const s = resolveSettings({}, NOW, warn);
  assert.deepEqual(
    [s.minRuntime, s.manualFile, s.snapshotUrl, s.arrivalDays, s.arrivalMaxAgeYears, s.arrivalMaxPages, s.arrivalMaxPerPlatform],
    [40, 'data/manual-releases.json', '', 30, 3, 50, 25],
  );
  assert.deepEqual(s.arrivalWindow, { from: '2026-09-23', to: '2026-10-23' });
  assert.equal(s.catalogueFrom, '2023-10-23');
  assert.equal(s.today, '2026-10-23');
  assert.deepEqual(warn.lines, []);

  const custom = resolveSettings({
    MIN_RUNTIME: '0', MANUAL_RELEASES_FILE: ' x.json ', SNAPSHOT_URL: ' https://example.org/s.json ', ARRIVAL_DAYS: '90',
    ARRIVAL_MAX_AGE_YEARS: '20', ARRIVAL_MAX_PAGES: '100', ARRIVAL_MAX_PER_PLATFORM: '500',
  }, NOW, warn);
  assert.deepEqual(
    [custom.minRuntime, custom.manualFile, custom.snapshotUrl, custom.arrivalDays, custom.arrivalMaxAgeYears, custom.arrivalMaxPages, custom.arrivalMaxPerPlatform],
    [0, 'x.json', 'https://example.org/s.json', 90, 20, 100, 500],
  );
  assert.deepEqual(warn.lines, []);

  for (const [name, value, key, fallback] of [
    ['MIN_RUNTIME', '-1', 'minRuntime', 40], ['MIN_RUNTIME', '301', 'minRuntime', 40], ['MIN_RUNTIME', '4O', 'minRuntime', 40],
    ['ARRIVAL_DAYS', '0', 'arrivalDays', 30], ['ARRIVAL_DAYS', '91', 'arrivalDays', 30],
    ['ARRIVAL_MAX_AGE_YEARS', '0', 'arrivalMaxAgeYears', 3], ['ARRIVAL_MAX_AGE_YEARS', '21', 'arrivalMaxAgeYears', 3],
    ['ARRIVAL_MAX_PAGES', '101', 'arrivalMaxPages', 50], ['ARRIVAL_MAX_PER_PLATFORM', '0', 'arrivalMaxPerPlatform', 25],
    ['ARRIVAL_MAX_PER_PLATFORM', '1e3', 'arrivalMaxPerPlatform', 25],
  ]) {
    const w = sink();
    assert.equal(resolveSettings({ [name]: value }, NOW, w)[key], fallback, `${name}=${value}`);
    assert.equal(w.lines.length, 1, `${name}=${value}`);
  }
});

test('subtractYears is a UTC calendar subtraction; 29 February maps to 28 February', () => {
  assert.equal(subtractYears(new Date('2026-10-23T23:59:59.000Z'), 3), '2023-10-23');
  assert.equal(subtractYears(new Date('2028-02-29T12:00:00.000Z'), 1), '2027-02-28');
  assert.equal(subtractYears(new Date('2028-02-29T12:00:00.000Z'), 4), '2024-02-29');
  assert.equal(subtractYears(new Date('2027-01-01T00:00:00.000Z'), 20), '2007-01-01');
});

test('compareReleases: date, title (es), then theatrical, digital, arrival, then id', () => {
  const r = (id, releaseDate, title, type) => ({ id, releaseDate, title, type });
  const list = [
    r(5, '2026-11-02', 'B', 'arrival'), r(4, '2026-11-02', 'B', 'digital'), r(3, '2026-11-02', 'B', 'theatrical'),
    r(2, '2026-11-02', 'Á', 'digital'), r(1, '2026-11-01', 'Z', 'arrival'), r(0, '2026-11-02', 'B', 'digital'),
  ];
  assert.deepEqual([...list].sort(compareReleases).map((x) => x.id), [1, 2, 3, 0, 4, 5]);
});

test('numeric settings accept decimal integers only (§7): 1e1, 0x10, 10.5 fall back with a warning', () => {
  for (const value of ['1e1', '0x10', '10.5', '+10', '1_0', '10 days', '٣٠']) {
    const w = sink();
    assert.equal(resolveSettings({ WINDOW_DAYS: value }, NOW, w).windowDays, 90, value);
    assert.equal(w.lines.length, 1, value);
    assert.match(w.lines[0], /WINDOW_DAYS=.*using 90/);
  }
  const w = sink();
  assert.equal(resolveSettings({ WINDOW_DAYS: ' 010 ', MIN_RUNTIME: '0' }, NOW, w).windowDays, 10);
  assert.deepEqual(w.lines, []);
});
