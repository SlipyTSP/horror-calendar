const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  getHorrorReleases, fetchHorrorReleases, resolveSettings, parseProviders, parseReleaseNote,
  retryAfterMs, TmdbError, DETAIL_CONCURRENCY,
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
const DIGITAL_IDS = [1507696, 1393171, 1702511, 1739309];

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
const emptyProviders = (id) => ({ body: { id, results: {} } });
const emptyDates = (id) => ({ body: { id, results: [] } });

/** Routes for a small synthetic run: given discover results, empty details for digital ids. */
function smallRoutes({ theatrical = [], digital = [] } = {}) {
  const routes = {
    [discoverKey('3|2')]: page(theatrical),
    [discoverKey('4')]: page(digital),
  };
  for (const m of digital) {
    routes[`/movie/${m.id}/watch/providers`] = emptyProviders(m.id);
    routes[`/movie/${m.id}/release_dates`] = emptyDates(m.id);
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
    assert.deepEqual(Object.keys(r), ['id', 'title', 'originalTitle', 'releaseDate', 'type', 'providers',
      'releaseNote', 'posterPath', 'overview', 'tmdbUrl']);
    assert.equal('calendars' in r, false);
  }
});

test('captured run: details only for digital releases, English overview only when Spanish is empty', async () => {
  const mockFetch = createFixtureFetch();
  const { releases, details } = await run(mockFetch);
  const keys = mockFetch.calls.map((c) => c.key);

  for (const id of DIGITAL_IDS) {
    assert.equal(keys.filter((k) => k === `/movie/${id}/watch/providers`).length, 1);
    assert.equal(keys.filter((k) => k === `/movie/${id}/release_dates`).length, 1);
  }
  for (const m of CAPTURED_THEATRICAL.results) {
    assert.ok(!keys.includes(`/movie/${m.id}/watch/providers`), `theatrical ${m.id} asked for providers`);
    assert.ok(!keys.includes(`/movie/${m.id}/release_dates`), `theatrical ${m.id} asked for release_dates`);
  }
  const english = keys.filter((k) => k.endsWith('?language=en-US')).map((k) => Number(k.split('/')[2].split('?')[0])).sort();
  const withoutOverview = [...CAPTURED_THEATRICAL.results, ...CAPTURED_DIGITAL.results]
    .filter((m) => !m.overview).map((m) => m.id).sort();
  assert.deepEqual(english, withoutOverview);
  assert.deepEqual(details, { total: DIGITAL_IDS.length * 2 + withoutOverview.length, failed: 0 });

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
    '/movie/7/watch/providers': { body: {} },
    '/movie/7/release_dates': { body: { results: [{ iso_3166_1: 'ES' }] } },
    '/movie/7?language=en-US': { body: {} },
  };
  const { releases } = await run(createFixtureFetch({ routes }));
  assert.deepEqual(releases, [{
    id: 7,
    title: 'Only Original',
    originalTitle: 'Only Original',
    releaseDate: '2026-11-11',
    type: 'digital',
    providers: { flatrate: [], rentBuy: [] },
    releaseNote: null,
    posterPath: null,
    overview: '',
    tmdbUrl: 'https://www.themoviedb.org/movie/7',
  }]);
});

test('provider classification: flatrate included, rent + buy merged without duplicates', async () => {
  const routes = smallRoutes({ digital: [movie(5, '2026-11-20')] });
  routes['/movie/5/watch/providers'] = { fixture: 'case_watch_providers_es.json' };
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

test('a release_dates failure is counted and leaves releaseNote null; the release is kept', async () => {
  const routes = smallRoutes({ digital: [1, 2, 3, 4, 5, 6].map((id) => movie(id, `2026-11-0${id}`)) });
  routes['/movie/3/release_dates'] = { status: 404, body: { status_code: 34 } };
  routes['/movie/3/watch/providers'] = { fixture: 'case_watch_providers_es.json' };
  const { releases, details, log } = await run(createFixtureFetch({ routes }));

  const r = releases.find((x) => x.id === 3);
  assert.equal(r.releaseNote, null);
  assert.deepEqual(r.providers.flatrate, ['Netflix', 'Filmin', 'Netflix basic with Ads']);
  assert.deepEqual(details, { total: 12, failed: 1 });
  assert.match(log.lines.join('\n'), /release_dates failed: HTTP 404/);
  assert.match(log.lines.join('\n'), /Detail requests: 12, failed: 1\./);
});

test('more than 20 % of detail requests failing is an error', async () => {
  // 5 digital releases → 10 detail requests; 3 failures = 30 %
  const routes = smallRoutes({ digital: [1, 2, 3, 4, 5].map((id) => movie(id, `2026-11-0${id}`)) });
  for (const id of [1, 2, 3]) routes[`/movie/${id}/watch/providers`] = { status: 404, body: {} };
  await assert.rejects(run(createFixtureFetch({ routes })), (err) => err instanceof TmdbError && /3 of 10 .*detail requests failed/.test(err.message));

  // exactly 20 % is still fine
  const ok = smallRoutes({ digital: [1, 2, 3, 4, 5].map((id) => movie(id, `2026-11-0${id}`)) });
  for (const id of [1, 2]) ok[`/movie/${id}/watch/providers`] = { status: 404, body: {} };
  const { details } = await run(createFixtureFetch({ routes: ok }));
  assert.deepEqual(details, { total: 10, failed: 2 });
});

test('a pagination cut is never silent: ::warning:: with query, total_pages and MAX_PAGES', async () => {
  const routes = smallRoutes({ digital: [movie(9, '2026-11-09')] });
  routes[discoverKey('3|2')] = { fixture: 'case_discover_many_pages.json' };
  routes[discoverKey('3|2', 2)] = page([movie(910002, '2026-11-11')], 12);
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
  const { releases, log } = await run(createFixtureFetch({ routes }));

  assert.deepEqual(releases.filter((r) => r.type === 'theatrical').map((r) => r.id), [1, 2, 3]);
  assert.equal(log.lines.filter((l) => l.startsWith('::warning::')).length, 0);
});

test('429 is retried honouring Retry-After; 5xx with exponential backoff; the sleep is injected', async () => {
  const routes = smallRoutes({ digital: [movie(1, '2026-11-01')] });
  const mockFetch = createFixtureFetch({ routes });
  mockFetch.enqueue(discoverKey('4'), { fixture: 'case_rate_limited.json', status: 429, headers: { 'Retry-After': '7' } });
  mockFetch.enqueue('/movie/1/watch/providers', { status: 503, body: {} }, { status: 500, body: {} });
  const sleep = sleeper();
  const { releases, details } = await run(mockFetch, { sleep });

  assert.equal(releases.length, 1);
  assert.deepEqual(details, { total: 2, failed: 0 });
  assert.deepEqual(sleep.delays, [7000, 1000, 2000]);
  assert.equal(mockFetch.calls.filter((c) => c.key === mockFetch.keyFor(discoverKey('4'))).length, 2);
  assert.equal(mockFetch.calls.filter((c) => c.key === '/movie/1/watch/providers').length, 3);
});

test('a detail request is retried at most 3 times and then counted as a failure', async () => {
  const routes = smallRoutes({ digital: [1, 2, 3, 4, 5, 6].map((id) => movie(id, `2026-11-0${id}`)) });
  routes['/movie/2/release_dates'] = { status: 502, body: {} };
  const mockFetch = createFixtureFetch({ routes });
  const sleep = sleeper();
  const { releases, details } = await run(mockFetch, { sleep });

  assert.equal(mockFetch.calls.filter((c) => c.key === '/movie/2/release_dates').length, 4);
  assert.deepEqual(sleep.delays, [1000, 2000, 4000]);
  assert.equal(details.failed, 1);
  assert.equal(releases.length, 6);
});

test('4xx other than 429 is not retried', async () => {
  const routes = smallRoutes({ digital: [1, 2, 3, 4, 5, 6].map((id) => movie(id, `2026-11-0${id}`)) });
  routes['/movie/2/release_dates'] = { status: 401, body: {} };
  const mockFetch = createFixtureFetch({ routes });
  const sleep = sleeper();
  await run(mockFetch, { sleep });
  assert.equal(mockFetch.calls.filter((c) => c.key === '/movie/2/release_dates').length, 1);
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
  assert.equal(details.total, 27);
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
  routes['/movie/5/watch/providers'] = { fixture: 'case_watch_providers_es.json' };
  routes['/movie/5/release_dates'] = {
    body: { id: 5, results: [{ iso_3166_1: 'ES', release_dates: [{ type: 4, release_date: '2026-11-20T00:00:00.000Z', note: 'Netflix' }] }] },
  };
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
