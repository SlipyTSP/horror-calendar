const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  PLATFORMS, matchPlatform, assignCalendars, calendarDefinitions,
} = require('../../src/platforms');

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'releases.sample.json'), 'utf-8'));

function digital(overrides = {}) {
  return {
    id: 1,
    type: 'digital',
    providers: { flatrate: [], rentBuy: [] },
    releaseNote: null,
    ...overrides,
  };
}

test('PLATFORMS has valid, unique, non-reserved slugs', () => {
  const slugs = PLATFORMS.map((p) => p.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const slug of slugs) {
    assert.match(slug, /^[a-z0-9-]+$/);
    assert.ok(!['cines', 'digital', 'all'].includes(slug), `${slug} is reserved`);
  }
});

test('matchPlatform is exact, case-insensitive and trims', () => {
  assert.equal(matchPlatform('Netflix'), 'netflix');
  assert.equal(matchPlatform('  netflix basic with ads '), 'netflix');
  assert.equal(matchPlatform('PRIME VIDEO'), 'prime-video');
  assert.equal(matchPlatform('Amazon Prime Video'), 'prime-video');
  assert.equal(matchPlatform('Max'), 'hbo-max');
  assert.equal(matchPlatform('HBO Max'), 'hbo-max');
  assert.equal(matchPlatform('Movistar Plus'), 'movistar-plus');
  assert.equal(matchPlatform('Disney Plus'), 'disney-plus');
  assert.equal(matchPlatform('Apple TV+'), 'apple-tv-plus');
});

test('matchPlatform returns null for unknown names, partial matches and non-strings', () => {
  for (const name of ['Atresplayer', 'Apple TV', 'Netflix España', 'Prime', '', '   ', null, undefined, 42]) {
    assert.equal(matchPlatform(name), null, String(name));
  }
});

test('assignCalendars puts theatrical releases in cines only, ignoring providers and notes', () => {
  const r = assignCalendars({ id: 1, type: 'theatrical', providers: { flatrate: ['Netflix'], rentBuy: [] }, releaseNote: 'Netflix' });
  assert.deepEqual(r.calendars, ['cines']);
});

test('assignCalendars does not mutate its input', () => {
  const input = digital({ releaseNote: 'Netflix' });
  const out = assignCalendars(input);
  assert.notEqual(out, input);
  assert.equal('calendars' in input, false);
});

test('a release note alone gives platform membership (note-only)', () => {
  assert.deepEqual(assignCalendars(digital({ releaseNote: 'Prime Video' })).calendars, ['digital', 'prime-video']);
});

test('note and flatrate are combined as a union without duplicates, in config order', () => {
  const r = assignCalendars(digital({
    releaseNote: 'Filmin',
    providers: { flatrate: ['Amazon Prime Video', 'Filmin', 'Netflix'], rentBuy: [] },
  }));
  assert.deepEqual(r.calendars, ['digital', 'netflix', 'prime-video', 'filmin']);
});

test('rent and buy never create platform membership', () => {
  const r = assignCalendars(digital({ providers: { flatrate: [], rentBuy: ['Netflix', 'Apple TV+', 'HBO Max'] } }));
  assert.deepEqual(r.calendars, ['digital']);
});

test('an unmatched note or provider leaves only the digital calendar', () => {
  const r = assignCalendars(digital({ releaseNote: 'Atresplayer', providers: { flatrate: ['Atresplayer'], rentBuy: [] } }));
  assert.deepEqual(r.calendars, ['digital']);
});

test('assignCalendars tolerates missing providers and note', () => {
  assert.deepEqual(assignCalendars({ id: 1, type: 'digital' }).calendars, ['digital']);
  assert.deepEqual(assignCalendars({ id: 1, type: 'digital', providers: { flatrate: null } }).calendars, ['digital']);
});

test('assignCalendars reproduces the calendars of every release in releases.sample.json', () => {
  for (const release of SAMPLE.releases) {
    const { calendars, ...withoutCalendars } = release;
    // A manual release's platform comes from the curated file (src/manual.js passes it)
    const options = release.source === 'manual' ? { platforms: calendars.filter((s) => s !== 'digital') } : undefined;
    const out = assignCalendars(withoutCalendars, options);
    assert.deepEqual(out.calendars, calendars, `${release.id} ${release.type}`);
    assert.deepEqual(out, release);
  }
  // The two cases called out by the contract
  const byId = (id) => SAMPLE.releases.find((r) => r.id === id);
  assert.deepEqual(assignCalendars({ ...byId(900008), calendars: undefined }).calendars, ['digital', 'prime-video']);
  assert.deepEqual(assignCalendars({ ...byId(900006), calendars: undefined }).calendars, ['digital']);
});

test('calendarDefinitions follows the canonical order and matches the sample metadata', () => {
  const defs = calendarDefinitions();
  const expected = SAMPLE.calendars.map(({ count, ...rest }) => rest);
  assert.deepEqual(defs, expected);
  assert.equal(defs[0].slug, 'cines');
  assert.equal(defs.at(-2).slug, 'digital');
  assert.deepEqual(defs.at(-1), { slug: 'all', file: 'horror.ics', name: 'Todo', kind: 'legacy' });
});

test('arrivals belong to their arrivalPlatform only, whatever their providers or note', () => {
  const arrival = { id: 1, type: 'arrival', source: 'providers', providers: { flatrate: ['Netflix'], rentBuy: [] }, releaseNote: 'Filmin', arrivalPlatform: 'hbo-max' };
  assert.deepEqual(assignCalendars(arrival).calendars, ['hbo-max']);
  assert.deepEqual(assignCalendars(arrival, { platforms: ['netflix'] }).calendars, ['hbo-max']);
  assert.deepEqual(assignCalendars({ ...arrival, arrivalPlatform: 'nope' }).calendars, []);
});

test('manual releases: the curated platform only, no note or flatrate union', () => {
  const manual = digital({ source: 'manual', releaseNote: 'Netflix', providers: { flatrate: ['Filmin'], rentBuy: [] } });
  assert.deepEqual(assignCalendars(manual, { platforms: ['disney-plus'] }).calendars, ['digital', 'disney-plus']);
  assert.deepEqual(assignCalendars(manual).calendars, ['digital']);
});

test('TMDB wins: a curated platform is added to the note + flatrate union, in config order, unknown slugs ignored', () => {
  const r = digital({ source: 'tmdb', releaseNote: 'Filmin' });
  assert.deepEqual(assignCalendars(r, { platforms: ['movistar-plus', 'filmin', 'cines', 'nope'] }).calendars,
    ['digital', 'movistar-plus', 'filmin']);
  // Array.prototype.map passes an index as second argument: it is ignored
  assert.deepEqual([r].map(assignCalendars)[0].calendars, ['digital', 'filmin']);
});

test('assignCalendars places calendars right after type, as in the data model', () => {
  const out = assignCalendars({ id: 1, title: 'T', releaseDate: '2026-11-01', type: 'digital', providers: { flatrate: [], rentBuy: [] }, releaseNote: null });
  assert.deepEqual(Object.keys(out), ['id', 'title', 'releaseDate', 'type', 'calendars', 'providers', 'releaseNote']);
  // With `source` (schema 2) calendars go right after it
  const withSource = assignCalendars({ id: 1, type: 'digital', source: 'tmdb', providers: { flatrate: [], rentBuy: [] } });
  assert.deepEqual(Object.keys(withSource), ['id', 'type', 'source', 'calendars', 'providers']);
  for (const r of SAMPLE.releases) assert.deepEqual(Object.keys(assignCalendars(r)), Object.keys(r));
});
