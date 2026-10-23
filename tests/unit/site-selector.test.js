const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const selector = require('../../site/selector');

const SAMPLE = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'releases.sample.json'), 'utf8'));
const SITE = path.join(__dirname, '..', '..', 'site');

const known = selector.selectableCalendars(SAMPLE).map((c) => c.slug);

function fakeStorage(initial) {
  const data = new Map(Object.entries(initial || {}));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}

const throwingStorage = {
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
};

const ids = (releases) => releases.map((r) => r.id);

test('module loads without a DOM and exposes the storage key', () => {
  assert.equal(selector.STORAGE_KEY, 'horror-calendar:selection');
  assert.deepEqual(selector.DEFAULT_SELECTION, ['cines']);
});

test('selectable calendars follow JSON order and exclude the legacy calendar', () => {
  assert.deepEqual(known, ['cines', 'netflix', 'prime-video', 'hbo-max', 'movistar-plus',
    'filmin', 'disney-plus', 'skyshowtime', 'apple-tv-plus', 'digital']);
  assert.equal(selector.legacyFile(SAMPLE), 'horror.ics');
  assert.equal(selector.legacyFile({}), 'horror.ics');
});

test('calendars with absolute or unsafe files are not offered', () => {
  const data = { schema: 1, calendars: [
    { slug: 'a', file: 'https://example.org/a.ics', kind: 'platform' },
    { slug: 'b', file: '/b.ics', kind: 'platform' },
    { slug: 'c', file: '../c.ics', kind: 'platform' },
    { slug: 'd', file: 'horror-d.ics', kind: 'platform' },
    { slug: 'e', kind: 'platform' },
    null,
  ] };
  assert.deepEqual(selector.selectableCalendars(data).map((c) => c.slug), ['d']);
});

test('loadSelection defaults to ["cines"] when nothing is stored', () => {
  assert.deepEqual(selector.loadSelection(fakeStorage(), known), ['cines']);
  assert.deepEqual(selector.loadSelection(null, known), ['cines']);
});

test('loadSelection falls back to the default on invalid JSON or a non-array', () => {
  for (const raw of ['not json', '{"a":1}', '"cines"', 'null']) {
    const storage = fakeStorage({ 'horror-calendar:selection': raw });
    assert.deepEqual(selector.loadSelection(storage, known), ['cines'], raw);
  }
});

test('loadSelection drops unknown slugs, non-strings and duplicates', () => {
  const storage = fakeStorage({ 'horror-calendar:selection': '["nope","netflix",3,"netflix","digital"]' });
  assert.deepEqual(selector.loadSelection(storage, known), ['netflix', 'digital']);
});

test('loadSelection keeps an explicit empty selection', () => {
  const storage = fakeStorage({ 'horror-calendar:selection': '[]' });
  assert.deepEqual(selector.loadSelection(storage, known), []);
});

test('loadSelection without known slugs keeps the stored choice (data not loaded)', () => {
  const storage = fakeStorage({ 'horror-calendar:selection': '["netflix"]' });
  assert.deepEqual(selector.loadSelection(storage), ['netflix']);
});

test('saveSelection round-trips through storage as a JSON array', () => {
  const storage = fakeStorage();
  assert.equal(selector.saveSelection(storage, ['cines', 'filmin']), true);
  assert.equal(storage.data.get('horror-calendar:selection'), '["cines","filmin"]');
  assert.deepEqual(selector.loadSelection(storage, known), ['cines', 'filmin']);
});

test('a storage that throws on getItem and setItem never throws', () => {
  assert.doesNotThrow(() => selector.loadSelection(throwingStorage, known));
  assert.deepEqual(selector.loadSelection(throwingStorage, known), ['cines']);
  assert.equal(selector.saveSelection(throwingStorage, ['netflix']), false);
  assert.equal(selector.saveSelection(undefined, ['netflix']), false);
});

test('toggleSelection keeps the canonical calendar order', () => {
  let sel = ['cines'];
  sel = selector.toggleSelection(sel, 'digital', true, known);
  sel = selector.toggleSelection(sel, 'netflix', true, known);
  assert.deepEqual(sel, ['cines', 'netflix', 'digital']);
  sel = selector.toggleSelection(sel, 'cines', false, known);
  assert.deepEqual(sel, ['netflix', 'digital']);
});

test('filtering with the sample: prime-video, cines, digital', () => {
  const releases = selector.listReleases(SAMPLE);
  assert.deepEqual(ids(selector.filterReleases(releases, ['prime-video'])), [900005, 900008]);
  assert.deepEqual(ids(selector.filterReleases(releases, ['cines'])), [900001, 900004, 900007]);
  assert.equal(selector.filterReleases(releases, ['digital']).length, 6);
  assert.equal(selector.filterReleases(releases, ['cines', 'digital']).length, 9);
  assert.deepEqual(selector.filterReleases(releases, []), []);
  assert.deepEqual(selector.filterReleases(releases, ['disney-plus']), []);
});

test('filtered counts match calendars[].count in the sample', () => {
  const releases = selector.listReleases(SAMPLE);
  for (const cal of selector.selectableCalendars(SAMPLE)) {
    assert.equal(selector.filterReleases(releases, [cal.slug]).length, cal.count, cal.slug);
  }
});

test('filtered list is sorted by date then title', () => {
  const releases = selector.filterReleases(selector.listReleases(SAMPLE), ['cines', 'digital']);
  const dates = releases.map((r) => r.releaseDate);
  assert.deepEqual(dates, [...dates].sort());
});

test('releases without calendars or with unknown slugs do not break filtering or badges', () => {
  const odd = [
    { id: 1, title: 'No calendars' },
    { id: 2, calendars: 'cines' },
    { id: 3, calendars: ['mystery', 'cines'], releaseDate: '2026-11-01' },
    null,
  ];
  assert.deepEqual(ids(selector.filterReleases(odd, ['cines'])), [3]);
  const badges = selector.releaseBadges(odd[2], SAMPLE.calendars);
  assert.deepEqual(badges.map((b) => b.label), ['Cines']);
  assert.deepEqual(selector.releaseBadges({ id: 4 }, SAMPLE.calendars), []);
});

test('badges come from release.calendars mapped through calendars[].name', () => {
  const byKey = (id, type) => SAMPLE.releases.find((r) => r.id === id && r.type === type);
  const labels = (r) => selector.releaseBadges(r, SAMPLE.calendars).map((b) => b.label || b.kind);
  assert.deepEqual(labels(byKey(900001, 'theatrical')), ['Cines']);
  assert.deepEqual(labels(byKey(900005, 'digital')), ['Prime Video', 'Filmin', 'Digital']);
  assert.deepEqual(labels(byKey(900002, 'digital')), ['Netflix', 'Digital']);
});

test('the rent/buy badge appears only on 900003 in the sample', () => {
  const withRentBuy = SAMPLE.releases.filter((r) =>
    selector.releaseBadges(r, SAMPLE.calendars).some((b) => b.kind === 'rentbuy'));
  assert.deepEqual(withRentBuy.map((r) => r.id), [900003]);
});

test('calendar URLs at the site root', () => {
  const urls = selector.buildCalendarUrls('horror-cines.ics', 'https://example.org/');
  assert.deepEqual(urls, {
    https: 'https://example.org/horror-cines.ics',
    webcal: 'webcal://example.org/horror-cines.ics',
  });
  assert.equal(selector.buildCalendarUrls('horror.ics', 'https://example.org/index.html?x=1#top').https,
    'https://example.org/horror.ics');
});

test('calendar URLs under a sub-path', () => {
  for (const base of ['https://example.org/horror-calendar/', 'https://example.org/horror-calendar/index.html']) {
    assert.deepEqual(selector.buildCalendarUrls('horror-netflix.ics', base), {
      https: 'https://example.org/horror-calendar/horror-netflix.ics',
      webcal: 'webcal://example.org/horror-calendar/horror-netflix.ics',
    });
  }
  assert.equal(selector.buildCalendarUrls('horror.ics', 'https://example.org/a/b/c/').webcal,
    'webcal://example.org/a/b/c/horror.ics');
});

test('calendar URLs from a local http preview and invalid input', () => {
  assert.equal(selector.buildCalendarUrls('horror.ics', 'http://localhost:8000/').webcal,
    'webcal://localhost:8000/horror.ics');
  assert.equal(selector.buildCalendarUrls('https://evil.example/x.ics', 'https://example.org/'), null);
  assert.equal(selector.buildCalendarUrls('/horror.ics', 'https://example.org/sub/'), null);
  assert.equal(selector.buildCalendarUrls(undefined, 'https://example.org/'), null);
  assert.equal(selector.buildCalendarUrls('horror.ics', 'file:///tmp/index.html'), null);
});

test('external links only accept http(s)', () => {
  assert.equal(selector.safeExternalUrl('https://www.themoviedb.org/movie/1'), 'https://www.themoviedb.org/movie/1');
  assert.equal(selector.safeExternalUrl('javascript:alert(1)'), null);
  assert.equal(selector.safeExternalUrl(undefined), null);
});

test('schema validation', () => {
  assert.deepEqual(selector.validateData(SAMPLE), { ok: true });
  assert.deepEqual(selector.validateData({ ...SAMPLE, schema: 2 }), { ok: false, reason: 'schema' });
  assert.deepEqual(selector.validateData({ generated: 'x', total: 3, releases: [] }), { ok: false, reason: 'schema' });
  assert.deepEqual(selector.validateData(null), { ok: false, reason: 'shape' });
  assert.deepEqual(selector.validateData([]), { ok: false, reason: 'shape' });
});

test('schema 1 with missing fields degrades to empty lists', () => {
  const data = { schema: 1 };
  assert.deepEqual(selector.selectableCalendars(data), []);
  assert.deepEqual(selector.listReleases(data), []);
});

test('i18n tables for ES and EN have the same keys and no empty strings', () => {
  const es = Object.keys(selector.I18N.es).sort();
  const en = Object.keys(selector.I18N.en).sort();
  assert.deepEqual(en, es);
  for (const lang of ['es', 'en']) {
    for (const [key, value] of Object.entries(selector.I18N[lang])) {
      assert.equal(typeof value, 'string', `${lang}.${key}`);
      assert.ok(value.trim() !== '', `${lang}.${key}`);
    }
  }
});

test('every data-i18n key used in index.html exists in the tables', () => {
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(keys.length > 0);
  for (const key of keys) assert.ok(Object.hasOwn(selector.I18N.es, key), key);
});

test('every translate() key used in selector.js exists in the tables', () => {
  const js = fs.readFileSync(path.join(SITE, 'selector.js'), 'utf8');
  const direct = [...js.matchAll(/\bt\('([a-z_]+)'/g)].map((m) => m[1]);
  const plurals = [...js.matchAll(/plural\(state\.lang, '([a-z_]+)'/g)]
    .flatMap((m) => [m[1] + '_one', m[1] + '_other']);
  assert.ok(direct.length > 0 && plurals.length > 0);
  for (const key of [...direct, ...plurals]) assert.ok(Object.hasOwn(selector.I18N.es, key), key);
});

test('translate substitutes variables and falls back to Spanish, then the key', () => {
  assert.equal(selector.translate('en', 'count_other', { count: 3 }), '3 releases');
  assert.equal(selector.plural('es', 'count', 1, { count: 1 }), '1 estreno');
  assert.equal(selector.plural('es', 'count', 0, { count: 0 }), '0 estrenos');
  assert.equal(selector.translate('fr', 'copy_btn'), 'Copiar URL');
  assert.equal(selector.translate('es', 'missing_key'), 'missing_key');
});

test('release dates are parsed as local dates without timezone shift', () => {
  const date = selector.parseLocalDate('2026-11-06');
  assert.equal(date.getFullYear(), 2026);
  assert.equal(date.getMonth(), 10);
  assert.equal(date.getDate(), 6);
  assert.equal(selector.parseLocalDate('2026-02-30'), null);
  assert.equal(selector.parseLocalDate('not a date'), null);
  assert.equal(selector.formatReleaseDate('garbage', 'es-ES'), 'garbage');
  assert.equal(selector.formatReleaseDate(undefined, 'es-ES'), '');
  assert.equal(selector.formatGenerated('nope', 'es-ES'), '');
  assert.ok(selector.formatGenerated(SAMPLE.generated, 'es-ES').includes('2026'));
});

test('site/ contains no absolute link to the production host', () => {
  for (const file of fs.readdirSync(SITE)) {
    if (!/\.(html|css|js)$/.test(file)) continue;
    const text = fs.readFileSync(path.join(SITE, file), 'utf8');
    assert.ok(!/slipytsp\.github\.io/i.test(text), file);
  }
});
