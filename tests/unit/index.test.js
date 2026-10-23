const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { main } = require('../../src/index');
const { createFixtureFetch } = require('../support/fixture-fetch');
const { assertValidICS, unfoldedLines } = require('../support/ics-validator');

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'releases.sample.json'), 'utf-8'));
const NOW = new Date('2026-10-23T06:03:00.000Z');
const KEY = 'fake-key-0123456789abcdef';
const ENV = { TMDB_API_KEY: KEY };
const WINDOW = 'language=es-ES&region=ES&with_genres=27&release_date.gte=2026-10-23&release_date.lte=2027-01-21';
const discoverKey = (type) => `/discover/movie?${WINDOW}&with_release_type=${encodeURIComponent(type)}&page=1`;

const EXPECTED_FILES = [
  'horror-cines.ics', 'horror-netflix.ics', 'horror-prime-video.ics', 'horror-hbo-max.ics',
  'horror-movistar-plus.ics', 'horror-filmin.ics', 'horror-disney-plus.ics', 'horror-skyshowtime.ics',
  'horror-apple-tv-plus.ics', 'horror-digital.ics', 'horror.ics', 'releases.json',
];

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
    if (key === 'posterPath' || key === 'releaseNote') {
      assert.ok(a === null || typeof a === 'string', `${where}.${key}`);
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

test('main writes the 11 calendars and releases.json from the captured fixtures', async () => {
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
  assert.equal(doc.schema, 1);
  assert.equal(doc.generated, NOW.toISOString());
  assert.equal(doc.region, 'ES');
  assert.deepEqual(doc.window, { from: '2026-10-23', to: '2027-01-21' });

  assert.deepEqual(doc.calendars.map(({ count, ...rest }) => rest), SAMPLE.calendars.map(({ count, ...rest }) => rest));
  for (const [i, c] of doc.calendars.entries()) assertSameShape(c, SAMPLE.calendars[i], `calendars[${i}]`);

  assert.equal(doc.releases.length, 17);
  for (const [i, r] of doc.releases.entries()) {
    assertSameShape(r, SAMPLE.releases[0], `releases[${i}]`);
    assertSameShape(r.providers, SAMPLE.releases[0].providers, `releases[${i}].providers`);
    assert.match(r.releaseDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(['theatrical', 'digital'].includes(r.type));
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
      '/movie/1393171/release_dates': {
        body: { id: 1393171, results: [{ iso_3166_1: 'ES', release_dates: [{ type: 4, release_date: '2026-12-01T00:00:00.000Z', note: 'Atresplayer' }] }] },
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
  const routes = {};
  for (const id of [1507696, 1393171, 1702511]) routes[`/movie/${id}/watch/providers`] = { status: 404, body: {} };
  const { code, outDir } = await runMain({ fetchImpl: createFixtureFetch({ routes }) });
  assert.equal(code, 1);
  assert.equal(fs.existsSync(outDir), false);
});

test('a missing API key exits non-zero with a hint', async () => {
  const { code, error } = await runMain({ env: {} });
  assert.equal(code, 1);
  assert.match(error.lines.join('\n'), /TMDB_API_KEY/);
});
