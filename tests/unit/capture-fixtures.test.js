const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { capture } = require('../../scripts/capture-fixtures');
const { createMockFetch, fixtureName } = require('../support/mock-fetch');

const KEY = 'fake-key-0123456789abcdef';
const NOW = new Date('2026-11-02T06:03:00.000Z');
const ENV = { TMDB_API_KEY: KEY };

const COMMON = 'language=es-ES&region=ES&with_genres=27'
  + '&release_date.gte=2026-11-02&release_date.lte=2027-01-31';
const discoverKey = (type, page) => `/discover/movie?${COMMON}&with_release_type=${encodeURIComponent(type)}&page=${page}`;
const movies = (...ids) => ids.map((id) => ({ id, title: `Movie ${id}`, release_date: '2026-11-10' }));

function providers(id, es) {
  return { body: { id, results: { ES: es, US: { flatrate: [{ provider_name: 'US Only' }] } } } };
}

function releaseDates(id) {
  const date = (type, note) => ({ type, note, release_date: '2026-11-10T00:00:00.000Z' });
  const notes = { 1: ' Prime Video ', 2: 'Netflix', 3: '', 4: 'Prime Video' };
  return {
    body: {
      id,
      results: [
        { iso_3166_1: 'US', release_dates: [date(4, 'US Note')] },
        { iso_3166_1: 'ES', release_dates: [date(1, 'Festival de Sitges'), ...(id in notes ? [date(4, notes[id])] : [])] },
      ],
    },
  };
}

// theatrical: two pages (ids 1-7); digital: one page (ids 7-8, 7 repeated across queries)
function routes() {
  return {
    [discoverKey('3|2', 1)]: { body: { page: 1, total_pages: 2, total_results: 7, results: movies(1, 2, 3, 4, 5) } },
    [discoverKey('3|2', 2)]: { body: { page: 2, total_pages: 2, total_results: 7, results: movies(6, 7) } },
    [discoverKey('4', 1)]: { body: { page: 1, total_pages: 1, total_results: 2, results: movies(7, 8) } },
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((id) => [
      `/movie/${id}/watch/providers`,
      providers(id, id % 2 ? { flatrate: [{ provider_name: 'Netflix' }] } : { rent: [{ provider_name: 'Apple TV' }], buy: [{ provider_name: 'Apple TV' }] }),
    ])),
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((id) => [`/movie/${id}/release_dates`, releaseDates(id)])),
    ...Object.fromEntries([1, 2, 3].map((id) => [`/movie/${id}?language=en-US`, { body: { id, overview: `English ${id}` } }])),
  };
}

function tmpOut() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'capture-')), 'tmdb');
}

function sink() {
  const lines = [];
  const fn = (...args) => lines.push(args.join(' '));
  fn.lines = lines;
  return fn;
}

test('without a key it exits with 1, says why and writes nothing', async () => {
  const outDir = tmpOut();
  const mockFetch = createMockFetch({ routes: routes() });
  const log = sink();
  const error = sink();

  for (const env of [{}, { TMDB_API_KEY: '' }, { TMDB_API_KEY: '   ' }]) {
    assert.equal(await capture({ fetchImpl: mockFetch, env, outDir, now: NOW, log, error }), 1);
  }
  assert.equal(fs.existsSync(outDir), false);
  assert.equal(mockFetch.calls.length, 0);
  assert.match(error.lines[0], /TMDB_API_KEY is not set/);
});

test('with a key it performs the expected requests and writes fixtures and manifest', async () => {
  const outDir = tmpOut();
  const mockFetch = createMockFetch({ routes: routes() });
  const log = sink();
  const error = sink();

  assert.equal(await capture({ fetchImpl: mockFetch, env: ENV, outDir, now: NOW, log, error }), 0);
  assert.deepEqual(error.lines, []);

  const keys = mockFetch.calls.map((c) => c.key);
  assert.deepEqual(keys, [
    mockFetch.keyFor(discoverKey('3|2', 1)),
    mockFetch.keyFor(discoverKey('3|2', 2)),
    mockFetch.keyFor(discoverKey('4', 1)),
    // first six of each query, deduplicated: 1-6 from theatrical, 7-8 from digital
    ...[1, 2, 3, 4, 5, 6, 7, 8].flatMap((id) => [`/movie/${id}/watch/providers`, `/movie/${id}/release_dates`]),
    ...[1, 2, 3].map((id) => `/movie/${id}?language=en-US`),
  ]);
  for (const call of mockFetch.calls) {
    assert.equal(new URL(call.url).searchParams.get('api_key'), KEY, 'key sent as query param');
    assert.equal(new URL(call.url).searchParams.has('primary_release_date.gte'), false);
  }

  const written = fs.readdirSync(outDir).sort();
  const expected = [...new Set(keys)].map(fixtureName).concat('manifest.json').sort();
  assert.deepEqual(written, expected);
  assert.ok(written.includes('discover_movie__language=es-ES,page=1,region=ES,release_date.gte=2026-11-02,'
    + 'release_date.lte=2027-01-31,with_genres=27,with_release_type=3~7C2.json'));

  // Bodies are stored as received
  const providersFile = path.join(outDir, 'movie_1_watch_providers.json');
  assert.equal(fs.readFileSync(providersFile, 'utf-8'), JSON.stringify(routes()['/movie/1/watch/providers'].body));
  const datesFile = path.join(outDir, 'movie_1_release_dates.json');
  assert.equal(fs.readFileSync(datesFile, 'utf-8'), JSON.stringify(routes()['/movie/1/release_dates'].body));
  assert.ok(written.includes('movie_8_release_dates.json'));

  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf-8'));
  assert.equal(manifest.capturedAt, '2026-11-02T06:03:00.000Z');
  assert.deepEqual(manifest.window, { from: '2026-11-02', to: '2027-01-31', days: 90 });
  assert.deepEqual(manifest.queries.theatrical, { with_release_type: '3|2', total_results: 7, total_pages: 2, pages: [1, 2] });
  assert.deepEqual(manifest.queries.digital, { with_release_type: '4', total_results: 2, total_pages: 1, pages: [1] });
  assert.equal(manifest.requests.length, keys.length);
  assert.deepEqual(manifest.requests[0].params, {
    language: 'es-ES',
    region: 'ES',
    with_genres: '27',
    'release_date.gte': '2026-11-02',
    'release_date.lte': '2027-01-31',
    with_release_type: '3|2',
    page: 1,
  });
  assert.ok(manifest.requests.every((r) => written.includes(r.file)));

  const output = log.lines.join('\n');
  assert.match(output, /theatrical .*: 7 results .*total_results=7, total_pages=2/);
  assert.match(output, /digital .*: 2 results .*total_results=2, total_pages=1/);
  assert.match(output, /- Apple TV \(buy, rent\)/);
  assert.match(output, /- Netflix \(flatrate\)/);
  assert.doesNotMatch(output, /US Only/, 'only region ES providers are listed');

  // Distinct type-4 notes in region ES: trimmed, other types and regions ignored
  assert.match(output, /Distinct type-4 release notes in region ES \(2\):\n {2}- Netflix \(1\)\n {2}- Prime Video \(2\)\n {2}\(empty note: 1\)/);
  assert.doesNotMatch(output, /US Note|Sitges/);
});

test('a release_dates failure stops the capture like any other request', async () => {
  const outDir = tmpOut();
  const mockFetch = createMockFetch({ routes: { ...routes(), '/movie/5/release_dates': { status: 404, body: { status_code: 34 } } } });
  const error = sink();

  assert.equal(await capture({ fetchImpl: mockFetch, env: ENV, outDir, now: NOW, log: sink(), error }), 1);
  assert.equal(fs.existsSync(outDir), false);
  assert.match(error.lines.join('\n'), /movie\/5\/release_dates returned HTTP 404/);
});

test('the API key never appears in file names, contents or logs', async () => {
  const outDir = tmpOut();
  const log = sink();
  const error = sink();
  await capture({ fetchImpl: createMockFetch({ routes: routes() }), env: ENV, outDir, now: NOW, log, error });

  for (const file of fs.readdirSync(outDir)) {
    assert.doesNotMatch(file, new RegExp(KEY));
    assert.doesNotMatch(fs.readFileSync(path.join(outDir, file), 'utf-8'), new RegExp(KEY));
  }
  assert.doesNotMatch([...log.lines, ...error.lines].join('\n'), new RegExp(KEY));
});

test('a 429 stops the capture with exit 1, no retry and nothing written', async () => {
  const outDir = tmpOut();
  const mockFetch = createMockFetch({ routes: routes() });
  mockFetch.enqueue('/movie/3/watch/providers', { status: 429, headers: { 'Retry-After': '1' } });
  const error = sink();

  assert.equal(await capture({ fetchImpl: mockFetch, env: ENV, outDir, now: NOW, log: sink(), error }), 1);
  assert.equal(fs.existsSync(outDir), false);
  assert.equal(mockFetch.calls.filter((c) => c.key === '/movie/3/watch/providers').length, 1);
  assert.match(error.lines.join('\n'), /movie\/3\/watch\/providers returned HTTP 429/);
});

test('any other non-2xx response stops the capture with exit 1', async () => {
  const outDir = tmpOut();
  const mockFetch = createMockFetch({ routes: { ...routes(), [discoverKey('4', 1)]: { status: 401, body: { status_code: 7 } } } });
  const error = sink();

  assert.equal(await capture({ fetchImpl: mockFetch, env: ENV, outDir, now: NOW, log: sink(), error }), 1);
  assert.equal(fs.existsSync(outDir), false);
  assert.match(error.lines.join('\n'), /HTTP 401/);
});

test('a network error is reported without leaking the key', async () => {
  const outDir = tmpOut();
  const error = sink();
  const failingFetch = async (url) => {
    throw new Error(`connect ECONNREFUSED ${url}`);
  };

  assert.equal(await capture({ fetchImpl: failingFetch, env: ENV, outDir, now: NOW, log: sink(), error }), 1);
  assert.equal(fs.existsSync(outDir), false);
  assert.match(error.lines.join('\n'), /ECONNREFUSED/);
  assert.doesNotMatch(error.lines.join('\n'), new RegExp(KEY));
});

test('an invalid WINDOW_DAYS falls back to 90 with a warning', async () => {
  const outDir = tmpOut();
  const error = sink();
  const code = await capture({
    fetchImpl: createMockFetch({ routes: routes() }),
    env: { ...ENV, WINDOW_DAYS: 'abc' },
    outDir,
    now: NOW,
    log: sink(),
    error,
  });
  assert.equal(code, 0);
  assert.match(error.lines[0], /WINDOW_DAYS="abc".*using 90/);
});
