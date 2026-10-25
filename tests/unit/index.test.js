const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../../src/index');
const { createFixtureFetch, readFixture } = require('../support/fixture-fetch');
const { assertValidICS, unfoldedLines } = require('../support/ics-validator');

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'releases.sample.json'), 'utf-8'));
const NOW = new Date('2026-10-23T06:03:00.000Z');
const KEY = 'fake-key-0123456789abcdef';
// Tests never read the owner's data/manual-releases.json: a missing file means no manual releases
const NO_MANUAL = path.join(os.tmpdir(), 'horror-calendar-tests', 'no-manual-releases.json');
const ENV = { TMDB_API_KEY: KEY, MANUAL_RELEASES_FILE: NO_MANUAL };
const SNAPSHOT_URL = 'https://example.org/horror-calendar/providers-snapshot.json';
const detailKey = (id) => `/movie/${id}?language=es-ES&append_to_response=${encodeURIComponent('release_dates,watch/providers')}`;
const detailFixture = (id) => readFixture(`movie_${id}__append_to_response=release_dates~2Cwatch~2Fproviders,language=es-ES.json`);
const WINDOW = 'language=es-ES&region=ES&with_genres=27&release_date.gte=2026-10-23&release_date.lte=2027-01-21';
const discoverKey = (type) => `/discover/movie?${WINDOW}&with_release_type=${encodeURIComponent(type)}&page=1`;

const EXPECTED_FILES = [
  'horror-cines.ics', 'horror-netflix.ics', 'horror-prime-video.ics', 'horror-hbo-max.ics',
  'horror-movistar-plus.ics', 'horror-filmin.ics', 'horror-disney-plus.ics', 'horror-skyshowtime.ics',
  'horror-apple-tv-plus.ics', 'horror-digital.ics', 'horror.ics', 'releases.json', 'providers-snapshot.json',
];
const NULLABLE = new Set(['posterPath', 'releaseNote', 'arrivalPlatform', 'sourceUrl', 'runtime']);

function sink() {
  const lines = [];
  const fn = (...args) => lines.push(args.join(' '));
  fn.lines = lines;
  return fn;
}

const tmpOut = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'horror-out-')), 'output');
const noSleep = async () => {};

const typeOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);

/** Same keys, in the same order, with the same JSON types as the sample. */
function assertSameShape(actual, expected, where) {
  assert.deepEqual(Object.keys(actual), Object.keys(expected), `${where}: keys`);
  for (const key of Object.keys(expected)) {
    const e = expected[key];
    const a = actual[key];
    if (NULLABLE.has(key)) {
      assert.ok(a === null || ['string', 'number'].includes(typeof a), `${where}.${key}`);
    } else {
      assert.equal(typeOf(a), typeOf(e), `${where}.${key}`);
    }
  }
}

async function runMain(options = {}) {
  const outDir = options.outDir ?? tmpOut();
  const log = sink();
  const error = sink();
  const code = await main({
    fetchImpl: options.fetchImpl ?? createFixtureFetch(), now: NOW, env: ENV, outDir, sleep: noSleep, log, error, ...options,
  });
  return { code, outDir, log, error };
}

test('main writes the 11 calendars, releases.json and the providers snapshot from the fixtures', async () => {
  const { code, outDir, error } = await runMain();
  assert.equal(code, 0, error.lines.join('\n'));
  assert.deepEqual(fs.readdirSync(outDir).sort(), [...EXPECTED_FILES].sort());

  const doc = JSON.parse(fs.readFileSync(path.join(outDir, 'releases.json'), 'utf-8'));
  for (const c of doc.calendars) {
    const ics = fs.readFileSync(path.join(outDir, c.file), 'utf-8');
    assertValidICS(ics, c.file);
    assert.equal(unfoldedLines(ics).filter((l) => l === 'BEGIN:VEVENT').length, c.count, c.file);
  }
});

test('releases.json follows the shape of releases.sample.json (§4)', async () => {
  const { outDir } = await runMain();
  const doc = JSON.parse(fs.readFileSync(path.join(outDir, 'releases.json'), 'utf-8'));

  assertSameShape(doc, SAMPLE, 'document');
  assert.equal(doc.schema, 2);
  assert.equal(doc.generated, NOW.toISOString());
  assert.equal(doc.region, 'ES');
  assert.deepEqual(doc.window, { from: '2026-10-23', to: '2027-01-21' });
  assert.deepEqual(doc.arrivalWindow, { from: '2026-09-23', to: '2026-10-23' });

  assert.deepEqual(doc.calendars.map(({ count, ...rest }) => rest), SAMPLE.calendars.map(({ count, ...rest }) => rest));
  for (const [i, c] of doc.calendars.entries()) assertSameShape(c, SAMPLE.calendars[i], `calendars[${i}]`);

  assert.equal(doc.releases.length, 17);
  for (const [i, r] of doc.releases.entries()) {
    assertSameShape(r, SAMPLE.releases[0], `releases[${i}]`);
    assertSameShape(r.providers, SAMPLE.releases[0].providers, `releases[${i}].providers`);
    assert.match(r.releaseDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['theatrical', 'digital'].includes(r.type));
    assert.equal(r.source, 'tmdb');
    assert.ok(r.calendars.length > 0);
    assert.equal(r.calendars[0], r.type === 'theatrical' ? 'cines' : 'digital');
  }

  // count equals the number of releases listing the slug; all = every release
  for (const c of doc.calendars) {
    const expected = c.slug === 'all' ? doc.releases.length : doc.releases.filter((r) => r.calendars.includes(c.slug)).length;
    assert.equal(c.count, expected, c.slug);
  }
  const count = (slug) => doc.calendars.find((c) => c.slug === slug).count;
  assert.deepEqual([count('cines'), count('digital'), count('all'), count('netflix'), count('prime-video')], [13, 4, 17, 1, 1]);
});

test('B9: release notes put note-only digital releases in their platform calendars', async () => {
  const { outDir } = await runMain();
  const doc = JSON.parse(fs.readFileSync(path.join(outDir, 'releases.json'), 'utf-8'));
  const byId = (id) => doc.releases.find((r) => r.id === id);

  assert.equal(byId(1507696).title, 'Apocalipsis Z: Nuevo mundo');
  assert.deepEqual(byId(1507696).calendars, ['digital', 'prime-video']);
  assert.deepEqual(byId(1507696).providers, { flatrate: [], rentBuy: [] });
  assert.equal(byId(1702511).title, 'The Class: Online');
  assert.deepEqual(byId(1702511).calendars, ['digital', 'netflix']);
  assert.deepEqual(byId(1393171).calendars, ['digital']);

  const prime = fs.readFileSync(path.join(outDir, 'horror-prime-video.ics'), 'utf-8');
  assert.ok(unfoldedLines(prime).includes('UID:tmdb-1507696-digital@horror-calendar'));
  assert.match(prime.replace(/\r\n /g, ''), /Estreno en: Prime Video/);
  const netflix = fs.readFileSync(path.join(outDir, 'horror-netflix.ics'), 'utf-8');
  assert.ok(unfoldedLines(netflix).includes('UID:tmdb-1702511-digital@horror-calendar'));
});

test('console preview: one line per release with date, type, title and calendars', async () => {
  const { log } = await runMain();
  const preview = log.lines.filter((l) => /^ {2}\S+ \d{4}-\d{2}-\d{2} /.test(l));
  assert.equal(preview.length, 17);
  assert.ok(preview.some((l) => /2026-10-30 digital +Apocalipsis Z: Nuevo mundo → digital, prime-video$/.test(l)));
  assert.ok(preview.some((l) => /2026-10-23 theatrical Clayface → cines$/.test(l)));
  assert.equal(log.lines.filter((l) => l.startsWith('::warning::')).length, 0, 'every captured note matches an alias');
});

test('a release note that matches no alias produces a ::warning:: line with title, id and note', async () => {
  const fetchImpl = createFixtureFetch({
    routes: {
      [detailKey(1393171)]: {
        body: {
          ...detailFixture(1393171),
          release_dates: { results: [{ iso_3166_1: 'ES', release_dates: [{ type: 4, release_date: '2026-12-01T00:00:00.000Z', note: 'Atresplayer' }] }] },
        },
      },
    },
  });
  const { code, log, outDir } = await runMain({ fetchImpl });
  assert.equal(code, 0);
  const warnings = log.lines.filter((l) => l.startsWith('::warning::'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"Atresplayer".*"Chicken Boy".*1393171/);
  const doc = JSON.parse(fs.readFileSync(path.join(outDir, 'releases.json'), 'utf-8'));
  assert.deepEqual(doc.releases.find((r) => r.id === 1393171).calendars, ['digital']);
});

test('empty discover results exit non-zero and write nothing', async () => {
  const empty = { body: { page: 1, total_pages: 1, total_results: 0, results: [] } };
  const fetchImpl = createFixtureFetch({ routes: { [discoverKey('3|2')]: empty, [discoverKey('4')]: empty } });
  const { code, outDir, error } = await runMain({ fetchImpl });
  assert.equal(code, 1);
  assert.equal(fs.existsSync(outDir), false);
  assert.match(error.lines.join('\n'), /0 releases/);
});

test('a failing discover request exits non-zero, writes nothing and never prints the key', async () => {
  const fetchImpl = createFixtureFetch({ routes: { [discoverKey('4')]: { status: 503, body: {} } } });
  const { code, outDir, log, error } = await runMain({ fetchImpl });
  assert.equal(code, 1);
  assert.equal(fs.existsSync(outDir), false);
  assert.match(error.lines.join('\n'), /HTTP 503/);
  assert.doesNotMatch([...log.lines, ...error.lines].join('\n'), new RegExp(KEY));
});

test('too many failed detail requests exit non-zero and write nothing', async () => {
  // 17 details + 6 English overviews; 5 failures = 21.7 %
  const routes = {};
  for (const id of [1507696, 1393171, 1702511, 1400940, 1232569]) routes[detailKey(id)] = { status: 404, body: {} };
  const { code, outDir } = await runMain({ fetchImpl: createFixtureFetch({ routes }) });
  assert.equal(code, 1);
  assert.equal(fs.existsSync(outDir), false);
});

test('a missing API key exits non-zero with a hint', async () => {
  const { code, error } = await runMain({ env: {} });
  assert.equal(code, 1);
  assert.match(error.lines.join('\n'), /TMDB_API_KEY/);
});

test('::warning:: lines escape %, CR and LF so a title with a line break stays one annotation', async () => {
  const fetchImpl = createFixtureFetch({
    routes: {
      [discoverKey('4')]: {
        body: { page: 1, total_pages: 1, total_results: 1, results: [{ id: 1393171, title: 'Chicken\nBoy\r 100%', release_date: '2026-12-01', overview: 'x' }] },
      },
      [detailKey(1393171)]: {
        body: {
          ...detailFixture(1393171),
          release_dates: { results: [{ iso_3166_1: 'ES', release_dates: [{ type: 4, release_date: '2026-12-01T00:00:00.000Z', note: 'Atresplayer' }] }] },
        },
      },
    },
  });
  const { code, log } = await runMain({ fetchImpl });
  assert.equal(code, 0);
  const warnings = log.lines.filter((l) => l.startsWith('::warning::'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"Chicken%0ABoy%0D 100%25"/);
  assert.doesNotMatch(warnings[0], /[\r\n]/);
});

// --- F4: runtime rule, manual releases, arrivals and the snapshot ---

const readJson = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
const readIcs = (dir, file) => fs.readFileSync(path.join(dir, file), 'utf-8');
const icsUids = (ics) => unfoldedLines(ics).filter((l) => l.startsWith('UID:')).map((l) => l.slice(4));
const warnings = (log) => log.lines.filter((l) => l.startsWith('::warning::'));

function writeManual(content) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'horror-manual-')), 'manual-releases.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

const manualDetail = (id, overrides = {}) => ({
  body: {
    id, title: `Manual ${id}`, original_title: `Manual ${id}`, overview: `Sinopsis ${id}.`, poster_path: `/m${id}.jpg`,
    runtime: 92, imdb_id: `tt${id}`, release_dates: { results: [] }, 'watch/providers': { results: {} }, ...overrides,
  },
});

test('E1 the runtime rule removes shorts and logs the count and titles as plain lines', async () => {
  const fetchImpl = createFixtureFetch({
    routes: { [detailKey(1739309)]: { body: { ...detailFixture(1739309), runtime: 20 } } },
  });
  const { code, outDir, log } = await runMain({ fetchImpl });
  assert.equal(code, 0);
  const doc = readJson(outDir, 'releases.json');
  assert.equal(doc.releases.some((r) => r.id === 1739309), false);
  const at = log.lines.findIndex((l) => /^\nRuntime rule \(MIN_RUNTIME=40\): removed 1 release\.$/.test(l));
  assert.ok(at >= 0, log.lines.join('\n'));
  assert.match(log.lines[at + 1], /^ {2}- .+ \(TMDB 1739309, digital, 20 min\)$/);
  assert.equal(warnings(log).length, 0);
});

test('E3 manual releases end to end: window, invalid entries, TMDB wins, Fuente line, exit 0', async () => {
  const file = writeManual({
    schema: 1,
    releases: [
      { id: 900301, releaseDate: '2026-11-25', platform: 'movistar-plus', sourceUrl: 'https://example.com/prensa/900301', comment: 'ok' },
      { id: 900302, releaseDate: '2026-10-01', platform: 'filmin', sourceUrl: 'https://example.com/prensa/old' },
      { id: 900303, releaseDate: '2026-11-26', platform: 'atresplayer', sourceUrl: 'https://example.com/prensa/x' },
      // TMDB dates 1507696 (Apocalipsis Z) as digital on 2026-10-30
      { id: 1507696, releaseDate: '2026-11-02', platform: 'filmin', sourceUrl: 'https://example.com/prensa/apocalipsis' },
    ],
  });
  const fetchImpl = createFixtureFetch({ routes: { [detailKey(900301)]: manualDetail(900301) } });
  const { code, outDir, log } = await runMain({ fetchImpl, env: { ...ENV, MANUAL_RELEASES_FILE: file } });
  assert.equal(code, 0);

  const doc = readJson(outDir, 'releases.json');
  const manual = doc.releases.filter((r) => r.source === 'manual');
  assert.deepEqual(manual.map((r) => [r.id, r.releaseDate, r.calendars, r.sourceUrl]), [
    [900301, '2026-11-25', ['digital', 'movistar-plus'], 'https://example.com/prensa/900301'],
  ]);
  const apocalipsis = doc.releases.filter((r) => r.id === 1507696);
  assert.deepEqual(apocalipsis.map((r) => [r.source, r.releaseDate, r.calendars]),
    [['tmdb', '2026-10-30', ['digital', 'prime-video', 'filmin']]], 'TMDB wins and gains the curated platform');

  const w = warnings(log);
  assert.equal(w.length, 2, w.join('\n'));
  assert.match(w[0], /entry #3 \(id 900303\) skipped: unknown platform "atresplayer"/);
  assert.match(w[1], /Manual release 1507696 \("Apocalipsis Z: Nuevo mundo"\).*TMDB 2026-10-30, manual 2026-11-02/);

  const movistar = readIcs(outDir, 'horror-movistar-plus.ics');
  assert.deepEqual(icsUids(movistar), ['tmdb-900301-digital@horror-calendar']);
  assert.match(movistar.replace(/\r\n /g, ''), /Estreno en: Movistar Plus\+\\n\\nFuente: https:\/\/example\.com\/prensa\/900301\\n\\nMás info:/);
  assert.ok(icsUids(readIcs(outDir, 'horror-filmin.ics')).includes('tmdb-1507696-digital@horror-calendar'));
  for (const file of ['horror-digital.ics', 'horror.ics']) {
    assert.ok(icsUids(readIcs(outDir, file)).includes('tmdb-900301-digital@horror-calendar'), file);
  }
  const count = (slug) => doc.calendars.find((c) => c.slug === slug).count;
  assert.deepEqual([count('digital'), count('all'), count('movistar-plus'), count('filmin')], [5, 18, 1, 1]);
});

test('manual and arrival detail failures never count towards the 20 % threshold nor fail the run', async () => {
  const releases = Array.from({ length: 12 }, (_, i) => ({
    id: 900400 + i, releaseDate: '2026-11-25', platform: 'filmin', sourceUrl: `https://example.com/p/${i}`,
  }));
  const routes = {};
  for (const r of releases) routes[detailKey(r.id)] = { status: 500, body: {} };
  const file = writeManual({ schema: 1, releases });
  const { code, outDir, log } = await runMain({ fetchImpl: createFixtureFetch({ routes }), env: { ...ENV, MANUAL_RELEASES_FILE: file } });
  assert.equal(code, 0);
  assert.equal(warnings(log).length, 12);
  assert.ok(log.lines.some((l) => l === 'Detail requests: 23, failed: 0.'));
  assert.equal(readJson(outDir, 'releases.json').releases.filter((r) => r.source === 'manual').length, 0);
});

test('a broken manual file is a warning and the run still exits 0', async () => {
  const { code, log } = await runMain({ env: { ...ENV, MANUAL_RELEASES_FILE: writeManual('{ nope') } });
  assert.equal(code, 0);
  assert.equal(warnings(log).length, 1);
  assert.match(warnings(log)[0], /is not valid JSON/);
});

test('E8 first build against the published snapshot URL: seed mode with a warning, snapshot written', async () => {
  const fetchImpl = createFixtureFetch({ routes: { [SNAPSHOT_URL]: { status: 404, body: 'Not Found' } } });
  const { code, outDir, log } = await runMain({ fetchImpl, env: { ...ENV, SNAPSHOT_URL } });
  assert.equal(code, 0);
  assert.equal(warnings(log).length, 1);
  assert.match(warnings(log)[0], /Previous providers snapshot not usable \(HTTP 404\): seed mode/);

  const snap = readJson(outDir, 'providers-snapshot.json');
  assert.deepEqual(Object.keys(snap), ['schema', 'generated', 'region', 'maxAgeYears', 'platforms', 'arrivals']);
  assert.deepEqual([snap.schema, snap.generated, snap.region, snap.maxAgeYears], [1, NOW.toISOString(), 'ES', 3]);
  assert.equal(Object.keys(snap.platforms).length, 8);
  assert.deepEqual(snap.arrivals, []);
  assert.equal(readJson(outDir, 'releases.json').releases.some((r) => r.type === 'arrival'), false);
  const files = fs.readdirSync(outDir).map((f) => fs.readFileSync(path.join(outDir, f), 'utf-8'));
  assert.ok(files.every((text) => !text.includes(KEY)), 'the key is in no output file');
});

test('E4 + E5 second build: arrivals only in their platform calendar, horror.ics still cines + digital', async () => {
  const first = await runMain({ env: { ...ENV } });
  const previous = readJson(first.outDir, 'providers-snapshot.json');
  previous.platforms.netflix = previous.platforms.netflix.filter((id) => id !== 920003);
  previous.platforms['movistar-plus'] = previous.platforms['movistar-plus'].filter((id) => id !== 920032);
  previous.arrivals = [{ id: 920041, platform: 'filmin', detected: '2026-10-16', title: 'Carried' }];

  const fetchImpl = createFixtureFetch({
    routes: {
      [SNAPSHOT_URL]: { body: previous },
      [detailKey(920003)]: manualDetail(920003, { title: 'Llegada Netflix' }),
      [detailKey(920032)]: manualDetail(920032, { title: 'Llegada Movistar' }),
      [detailKey(920041)]: manualDetail(920041, { title: 'Llegada Filmin' }),
    },
  });
  const { code, outDir, log } = await runMain({ fetchImpl, env: { ...ENV, SNAPSHOT_URL } });
  assert.equal(code, 0, log.lines.join('\n'));
  assert.equal(warnings(log).length, 0);

  const doc = readJson(outDir, 'releases.json');
  const arrivals = doc.releases.filter((r) => r.type === 'arrival');
  assert.deepEqual(arrivals.map((r) => [r.id, r.arrivalPlatform, r.releaseDate, r.calendars]), [
    [920041, 'filmin', '2026-10-16', ['filmin']],
    [920032, 'movistar-plus', '2026-10-23', ['movistar-plus']],
    [920003, 'netflix', '2026-10-23', ['netflix']],
  ]);
  assert.deepEqual(doc.releases.slice(0, 1).map((r) => r.id), [920041], 'arrivals before window.from sort first');
  for (const [i, r] of doc.releases.entries()) assertSameShape(r, SAMPLE.releases[0], `releases[${i}]`);

  const uids = (file) => icsUids(readIcs(outDir, file));
  assert.ok(uids('horror-netflix.ics').includes('tmdb-920003-arrival-netflix@horror-calendar'));
  assert.deepEqual(uids('horror-movistar-plus.ics'), ['tmdb-920032-arrival-movistar-plus@horror-calendar']);
  assert.match(readIcs(outDir, 'horror-movistar-plus.ics'), /SUMMARY:Llegada Movistar 🆕/);
  assert.match(readIcs(outDir, 'horror-movistar-plus.ics').replace(/\r\n /g, ''), /Ya disponible en: Movistar Plus\+/);
  const all = uids('horror.ics');
  assert.deepEqual(new Set(all), new Set([...uids('horror-cines.ics'), ...uids('horror-digital.ics')]));
  assert.ok(all.every((u) => !u.includes('-arrival-')));

  const count = (slug) => doc.calendars.find((c) => c.slug === slug).count;
  assert.deepEqual([count('netflix'), count('movistar-plus'), count('filmin'), count('digital'), count('all')], [2, 1, 1, 4, 17]);
  for (const c of doc.calendars) {
    const expected = c.slug === 'all' ? doc.releases.filter((r) => r.type !== 'arrival').length
      : doc.releases.filter((r) => r.calendars.includes(c.slug)).length;
    assert.equal(c.count, expected, c.slug);
    assertValidICS(readIcs(outDir, c.file), c.file);
  }

  const snap = readJson(outDir, 'providers-snapshot.json');
  // Sorted by detection date, then platform in config order
  assert.deepEqual(snap.arrivals, [
    { id: 920041, platform: 'filmin', detected: '2026-10-16', title: 'Llegada Filmin' },
    { id: 920003, platform: 'netflix', detected: '2026-10-23', title: 'Llegada Netflix' },
    { id: 920032, platform: 'movistar-plus', detected: '2026-10-23', title: 'Llegada Movistar' },
  ]);
  assert.ok(snap.platforms.netflix.includes(920003));
});

test('E8 arrivals failures are warnings: the run exits 0 and the snapshot carries the previous sets', async () => {
  const previous = {
    schema: 1, generated: '2026-10-16T06:00:00.000Z', region: 'ES', maxAgeYears: 3, platforms: { filmin: [1, 2] }, arrivals: [],
  };
  const fetchImpl = createFixtureFetch({
    routes: {
      [SNAPSHOT_URL]: { body: previous },
      '/watch/providers/movie?watch_region=ES&language=es-ES': { status: 503, body: {} },
    },
  });
  const { code, outDir, log } = await runMain({ fetchImpl, env: { ...ENV, SNAPSHOT_URL } });
  assert.equal(code, 0);
  assert.match(warnings(log).join('\n'), /provider list failed/);
  assert.deepEqual(readJson(outDir, 'providers-snapshot.json').platforms, { filmin: [1, 2] });
});

test('E2 one detail request per movie id across sources; an announced digital release is not also an arrival', async () => {
  const first = await runMain({ env: { ...ENV } });
  const previous = readJson(first.outDir, 'providers-snapshot.json');
  // 1507696 (Apocalipsis Z, digital on Prime Video by its note) shows up in the Prime Video catalogue
  const key = '/discover/movie?' + new URLSearchParams({
    language: 'es-ES', watch_region: 'ES', with_watch_providers: '119|2100', with_watch_monetization_types: 'flatrate',
    with_genres: '27', 'primary_release_date.gte': '2023-10-23', sort_by: 'primary_release_date.desc', page: '1',
  });
  const fetchImpl = createFixtureFetch({
    routes: {
      [SNAPSHOT_URL]: { body: previous },
      [key]: { body: { page: 1, total_pages: 1, results: [...previous.platforms['prime-video'], 1507696].map((id) => ({ id })) } },
    },
  });
  const { code, outDir, log } = await runMain({ fetchImpl, env: { ...ENV, SNAPSHOT_URL } });
  assert.equal(code, 0);
  assert.equal(fetchImpl.calls.filter((c) => c.key === fetchImpl.keyFor(detailKey(1507696))).length, 1);
  const doc = readJson(outDir, 'releases.json');
  assert.equal(doc.releases.some((r) => r.type === 'arrival'), false);
  assert.match(log.lines.join('\n'), /\(TMDB 1507696\) on Prime Video is its announced digital release; dropped/);
  assert.ok(readJson(outDir, 'providers-snapshot.json').platforms['prime-video'].includes(1507696));
});

test('the runtime rule log lists a release once even when its manual entry is removed too', async () => {
  // 1739309 is a TMDB digital release (2026-10-31); its manual entry has another date, so it
  // is not "TMDB wins" (the TMDB release was removed) and goes through the same short detail
  const file = writeManual({
    schema: 1,
    releases: [{ id: 1739309, releaseDate: '2026-11-20', platform: 'filmin', sourceUrl: 'https://example.com/prensa/short' }],
  });
  const fetchImpl = createFixtureFetch({
    routes: { [detailKey(1739309)]: { body: { ...detailFixture(1739309), runtime: 20 } } },
  });
  const { code, log } = await runMain({ fetchImpl, env: { ...ENV, MANUAL_RELEASES_FILE: file } });
  assert.equal(code, 0);
  assert.ok(log.lines.some((l) => /Runtime rule \(MIN_RUNTIME=40\): removed 1 release\.$/.test(l)), log.lines.join('\n'));
  assert.equal(log.lines.filter((l) => /\(TMDB 1739309, digital, 20 min\)$/.test(l)).length, 1);
});
