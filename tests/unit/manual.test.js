const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateManualDocument, loadManualEntries, buildManualReleases, httpsUrl } = require('../../src/manual');
const { createContext, resolveSettings } = require('../../src/tmdb');
const { createFixtureFetch } = require('../support/fixture-fetch');

const NOW = new Date('2026-10-23T06:00:00.000Z');
const ENV = { TMDB_API_KEY: 'fake-key-0123456789abcdef' };
const WINDOW = { from: '2026-10-23', to: '2027-01-21' };
const detailKey = (id) => `/movie/${id}?language=es-ES&append_to_response=${encodeURIComponent('release_dates,watch/providers')}`;

function sink() {
  const lines = [];
  const fn = (...args) => lines.push(args.join(' '));
  fn.lines = lines;
  return fn;
}

const entry = (overrides = {}) => ({
  id: 1, releaseDate: '2026-11-25', platform: 'disney-plus', sourceUrl: 'https://example.com/prensa/1', comment: 'x', ...overrides,
});

function writeTmp(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'manual-')), 'manual-releases.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

function context(routes, env = ENV) {
  const log = sink();
  const fetchImpl = createFixtureFetch({ routes });
  const settings = resolveSettings(env, NOW, log);
  return { ctx: createContext({ fetchImpl, settings, sleep: async () => {}, log }), fetchImpl, log };
}

const detail = (id, overrides = {}) => ({
  body: {
    id, title: `Película ${id}`, original_title: `Movie ${id}`, overview: `Sinopsis ${id}.`, poster_path: `/p${id}.jpg`,
    runtime: 95, imdb_id: `tt${id}`, release_dates: { results: [] }, 'watch/providers': { results: {} }, ...overrides,
  },
});

async function build({ entries, routes, tmdbReleases = [], env }) {
  const { ctx, fetchImpl, log } = context(routes, env);
  const warn = sink();
  const result = await buildManualReleases({ entries, window: WINDOW, tmdbReleases, context: ctx, log, warn });
  return { ...result, log, warn, fetchImpl };
}

// --- Validation (§10) ---

test('validateManualDocument accepts valid entries and drops the comment', () => {
  const { entries, problems, valid } = validateManualDocument({ schema: 1, releases: [entry(), entry({ id: 2, comment: undefined })] });
  assert.equal(valid, true);
  assert.deepEqual(problems, []);
  assert.deepEqual(entries, [
    { id: 1, releaseDate: '2026-11-25', platform: 'disney-plus', sourceUrl: 'https://example.com/prensa/1' },
    { id: 2, releaseDate: '2026-11-25', platform: 'disney-plus', sourceUrl: 'https://example.com/prensa/1' },
  ]);
});

test('E3 invalid entries are skipped with one problem each; a repeated id skips every entry with it', () => {
  const { entries, problems } = validateManualDocument({
    schema: 1,
    releases: [
      entry({ id: 10 }),
      entry({ id: '11' }),
      entry({ id: 12, releaseDate: '2026-02-30' }),
      entry({ id: 13, releaseDate: '25/11/2026' }),
      entry({ id: 14, platform: 'atresplayer' }),
      entry({ id: 15, platform: 'cines' }),
      entry({ id: 16, sourceUrl: 'http://example.com/x' }),
      entry({ id: 17, sourceUrl: 'javascript:alert(1)' }),
      entry({ id: 18, sourceUrl: undefined }),
      null,
      'text',
      [],
      entry({ id: 19 }),
      entry({ id: 19, platform: 'filmin' }),
      entry({ id: -1 }),
      entry({ id: 1.5 }),
      entry({ id: 20, comment: { not: 'a string' } }),
    ],
  });
  assert.deepEqual(entries.map((e) => e.id), [10, 20]);
  assert.equal(problems.length, 15);
  assert.ok(problems.some((p) => /entry #2 .*"id" is not a positive integer/.test(p)));
  assert.ok(problems.some((p) => /entry #3 \(id 12\).*"releaseDate"/.test(p)));
  assert.ok(problems.some((p) => /entry #5 \(id 14\).*unknown platform "atresplayer"/.test(p)));
  assert.ok(problems.some((p) => /entry #7 \(id 16\).*https/.test(p)));
  assert.ok(problems.some((p) => /entry #10 is not an object/.test(p)));
  assert.equal(problems.filter((p) => /id 19\) skipped: id repeated/.test(p)).length, 2);
});

test('a repeated id counts invalid entries too: the valid one is skipped as repeated', () => {
  const { entries, problems } = validateManualDocument({
    schema: 1,
    releases: [entry({ id: 5 }), entry({ id: 5, releaseDate: 'bad' }), entry({ id: 6 })],
  });
  assert.deepEqual(entries.map((e) => e.id), [6]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /entry #2 \(id 5\) skipped: "releaseDate"/);
  assert.match(problems[1], /entry #1 \(id 5\) skipped: id repeated in the file/);
});

test('validateManualDocument rejects documents that are not schema 1 with a releases array', () => {
  for (const doc of [null, [], 'x', {}, { schema: 2, releases: [] }, { schema: '1', releases: [] }, { schema: 1 }, { schema: 1, releases: {} }]) {
    const result = validateManualDocument(doc);
    assert.equal(result.valid, false, JSON.stringify(doc));
    assert.deepEqual(result.entries, []);
    assert.equal(result.problems.length, 1);
  }
});

test('httpsUrl accepts absolute https URLs only', () => {
  assert.equal(httpsUrl(' https://example.com/a b '), 'https://example.com/a%20b');
  for (const value of ['http://example.com', 'ftp://x', '//example.com', '/x', '', null, 42, 'https://']) {
    assert.equal(httpsUrl(value), null, String(value));
  }
});

// --- File loading ---

test('a missing file is a plain log line, never a warning', () => {
  const log = sink();
  const warn = sink();
  assert.deepEqual(loadManualEntries(path.join(os.tmpdir(), 'nope', 'manual-releases.json'), { log, warn }), []);
  assert.match(log.lines.join('\n'), /No manual releases file at/);
  assert.deepEqual(warn.lines, []);
});

test('invalid JSON, an unknown schema or a directory → warning and no manual releases', () => {
  for (const content of ['not json', '{"schema": 2, "releases": []}', '[]']) {
    const warn = sink();
    assert.deepEqual(loadManualEntries(writeTmp(content), { log: sink(), warn }), [], content);
    assert.equal(warn.lines.length, 1, content);
  }
  const warn = sink();
  assert.deepEqual(loadManualEntries(os.tmpdir(), { log: sink(), warn }), []);
  assert.equal(warn.lines.length, 1);
});

test('loadManualEntries warns once per invalid entry and keeps the valid ones', () => {
  const log = sink();
  const warn = sink();
  const entries = loadManualEntries(writeTmp({ schema: 1, releases: [entry(), entry({ id: 2, platform: 'nope' })] }), { log, warn });
  assert.deepEqual(entries.map((e) => e.id), [1]);
  assert.equal(warn.lines.length, 1);
  assert.match(warn.lines[0], /entry #2 \(id 2\) skipped: unknown platform "nope"/);
  assert.match(log.lines.join('\n'), /1 valid entry/);
});

// --- Releases (§10 + TMDB wins of §2) ---

test('E3 a valid entry inside the window becomes a manual digital release in digital + its platform', async () => {
  const { releases, warn, removed } = await build({
    entries: [entry({ id: 900009 })],
    routes: { [detailKey(900009)]: detail(900009, { title: 'El Pozo', original_title: 'The Well', runtime: 97 }) },
  });
  assert.deepEqual(warn.lines, []);
  assert.deepEqual(removed, []);
  assert.deepEqual(releases, [{
    id: 900009,
    title: 'El Pozo',
    originalTitle: 'The Well',
    releaseDate: '2026-11-25',
    type: 'digital',
    source: 'manual',
    calendars: ['digital', 'disney-plus'],
    providers: { flatrate: [], rentBuy: [] },
    releaseNote: null,
    arrivalPlatform: null,
    sourceUrl: 'https://example.com/prensa/1',
    runtime: 97,
    posterPath: '/p900009.jpg',
    overview: 'Sinopsis 900009.',
    tmdbUrl: 'https://www.themoviedb.org/movie/900009',
  }]);
});

test('entries outside the window are ignored silently and need no request', async () => {
  const { releases, warn, fetchImpl } = await build({
    entries: [entry({ id: 1, releaseDate: '2026-10-22' }), entry({ id: 2, releaseDate: '2027-01-22' }),
      entry({ id: 3, releaseDate: '2026-10-23' }), entry({ id: 4, releaseDate: '2027-01-21' })],
    routes: { [detailKey(3)]: detail(3), [detailKey(4)]: detail(4) },
  });
  assert.deepEqual(releases.map((r) => r.id), [3, 4]);
  assert.deepEqual(warn.lines, []);
  assert.equal(fetchImpl.calls.length, 2);
});

test('E3 TMDB wins: same date → no manual release, plain line; the curated platform joins the TMDB release', async () => {
  const tmdbReleases = [{ id: 7, type: 'digital', title: 'Siete', releaseDate: '2026-11-25' }];
  const { releases, warn, log, curatedPlatforms, fetchImpl } = await build({ entries: [entry({ id: 7 })], routes: {}, tmdbReleases });
  assert.deepEqual(releases, []);
  assert.deepEqual(warn.lines, []);
  assert.match(log.lines.join('\n'), /Manual release 7 \("Siete"\) is also dated by TMDB on the same day/);
  assert.deepEqual([...curatedPlatforms], [[7, ['disney-plus']]]);
  assert.equal(fetchImpl.calls.length, 0);
});

test('E3 TMDB wins with differing dates: ::warning:: with title, id and both dates', async () => {
  const tmdbReleases = [{ id: 7, type: 'digital', title: 'Siete', releaseDate: '2026-12-02' }];
  const { releases, warn, curatedPlatforms } = await build({ entries: [entry({ id: 7, platform: 'movistar-plus' })], routes: {}, tmdbReleases });
  assert.deepEqual(releases, []);
  assert.equal(warn.lines.length, 1);
  assert.match(warn.lines[0], /Manual release 7 \("Siete"\).*TMDB 2026-12-02, manual 2026-11-25/);
  assert.deepEqual(curatedPlatforms.get(7), ['movistar-plus']);
});

test('a TMDB theatrical release of the same id does not stop the manual digital release', async () => {
  const tmdbReleases = [{ id: 7, type: 'theatrical', title: 'Siete', releaseDate: '2026-10-30' }];
  const { releases } = await build({ entries: [entry({ id: 7 })], routes: { [detailKey(7)]: detail(7) }, tmdbReleases });
  assert.deepEqual(releases.map((r) => [r.id, r.type, r.source]), [[7, 'digital', 'manual']]);
});

test('E1 the runtime rule applies to manual releases', async () => {
  const { releases, removed } = await build({
    entries: [entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })],
    routes: {
      [detailKey(1)]: detail(1, { runtime: 20 }),
      [detailKey(2)]: detail(2, { runtime: null, imdb_id: 'tt2' }),
      [detailKey(3)]: detail(3, { runtime: 0, imdb_id: null }),
    },
  });
  assert.deepEqual(releases.map((r) => r.id), [2]);
  assert.deepEqual(removed.map((r) => [r.id, r.source, r.runtime]), [[1, 'manual', 20], [3, 'manual', null]]);
});

test('a 404 or a failed detail skips the entry with a warning; never throws', async () => {
  const { releases, warn, details } = await build({
    entries: [entry({ id: 1 }), entry({ id: 2 }), entry({ id: 3 })],
    routes: { [detailKey(1)]: { status: 404, body: {} }, [detailKey(2)]: { status: 500, body: {} }, [detailKey(3)]: detail(3) },
  });
  assert.deepEqual(releases.map((r) => r.id), [3]);
  assert.equal(warn.lines.length, 2);
  assert.match(warn.lines[0], /Manual release 1 does not exist in TMDB \(HTTP 404\)/);
  assert.match(warn.lines[1], /Manual release 2: detail request failed .*HTTP 500.*skipped in this build only/);
  assert.deepEqual(details, { total: 3, failed: 2 });
});

test('the detail fills an empty Spanish overview from English and keeps garbage fields safe', async () => {
  const { releases } = await build({
    entries: [entry({ id: 5 })],
    routes: {
      [detailKey(5)]: detail(5, { title: null, original_title: ['x'], overview: '', poster_path: 7, runtime: '88' }),
      '/movie/5?language=en-US': { body: { overview: 'English overview.' } },
    },
  });
  assert.deepEqual(
    (({ title, originalTitle, overview, posterPath, runtime }) => ({ title, originalTitle, overview, posterPath, runtime }))(releases[0]),
    { title: 'TMDB 5', originalTitle: 'TMDB 5', overview: 'English overview.', posterPath: null, runtime: 88 },
  );
});
