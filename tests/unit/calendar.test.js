const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  generateCalendars, generateICS, escapeText, foldLine, generateUID, buildDescription, buildWhereLine, buildSummary,
} = require('../../src/calendar');
const { assignCalendars } = require('../../src/platforms');
const { validateICS, assertValidICS, unfoldedLines } = require('../support/ics-validator');

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'releases.sample.json'), 'utf-8'));
const NOW = new Date('2026-11-02T06:03:00.000Z');

const LONG_SYNOPSIS = 'Cuando la niña desaparece en el bosque, su madre descubre que la cabaña '
  + 'esconde un sótano olvidado; allí, la oscuridad susurra canciones en un idioma '
  + 'que nadie recuerda 🎃 y cada noche el eco se acerca un poco más a la puerta, '
  + 'mientras el pueblo entero finge no oír nada.';

function release(overrides = {}) {
  return assignCalendars({
    id: 900001,
    title: 'La Casa Vacía',
    originalTitle: 'The Empty House',
    releaseDate: '2026-11-06',
    type: 'theatrical',
    providers: { flatrate: [], rentBuy: [] },
    releaseNote: null,
    posterPath: null,
    overview: 'Una familia hereda una casa.',
    tmdbUrl: 'https://www.themoviedb.org/movie/900001',
    ...overrides,
  });
}

const octets = (s) => Buffer.byteLength(s, 'utf-8');
const unfold = (s) => s.replace(/\r\n /g, '');
const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const byFile = (calendars, file) => calendars.find((c) => c.file === file);
const uids = (ics) => unfoldedLines(ics).filter((l) => l.startsWith('UID:')).map((l) => l.slice(4));

// --- Escaping and folding (unchanged behaviour) ---

test('escapeText escapes backslash, semicolon, comma and newlines (RFC 5545 3.3.11)', () => {
  assert.equal(escapeText('a\\b;c,d'), 'a\\\\b\\;c\\,d');
  assert.equal(escapeText('line1\nline2\r\nline3'), 'line1\\nline2\\nline3');
  assert.equal(escapeText(null), '');
});

test('escapeText escapes backslashes first, so escapes are not doubled', () => {
  assert.equal(escapeText('\\;'), '\\\\\\;');
  assert.equal(escapeText('Sin escapes: ñ á 🎃'), 'Sin escapes: ñ á 🎃');
});

test('escapeText normalises CR, LF and CRLF and drops other control characters', () => {
  assert.equal(escapeText('a\rb\nc\r\nd'), 'a\\nb\\nc\\nd');
  assert.equal(escapeText('bell\u0007 nul\u0000 esc\u001B del\u007F tab\tok'), 'bell nul esc del tab\tok');
});

test('a synopsis with a lone CR and a control character still gives a valid .ics', () => {
  const ics = generateICS([release({ overview: 'Primera línea\rsegunda\u0007 línea; con, signos.' })], { name: 'Cines', now: NOW });
  assertValidICS(ics);
  assert.doesNotMatch(ics, /\u0007/);
  assert.ok(unfoldedLines(ics).some((l) => l.startsWith('DESCRIPTION:Primera línea\\nsegunda línea\\; con\\, signos.')));
});

test('foldLine leaves lines of up to 75 octets untouched', () => {
  const exact = 'X'.repeat(75);
  assert.equal(foldLine(exact), exact);
  assert.equal(foldLine('SUMMARY:Corto'), 'SUMMARY:Corto');
});

test('foldLine splits ASCII at 75 octets with single-space continuations', () => {
  const line = `DESCRIPTION:${'a'.repeat(200)}`;
  const folded = foldLine(line).split('\r\n');

  assert.ok(folded.length > 1);
  assert.equal(octets(folded[0]), 75);
  for (const [i, part] of folded.entries()) {
    assert.ok(octets(part) <= 75, `line ${i} has ${octets(part)} octets`);
    if (i > 0) {
      assert.equal(part[0], ' ');
      assert.notEqual(part[1], ' ');
    }
  }
  assert.equal(unfold(folded.join('\r\n')), line);
});

test('foldLine never splits a multi-byte UTF-8 sequence (accents and emoji)', () => {
  const line = `DESCRIPTION:${escapeText(LONG_SYNOPSIS)}`;
  const folded = foldLine(line);
  const parts = folded.split('\r\n');

  assert.ok(parts.length >= 4);
  for (const [i, part] of parts.entries()) {
    assert.ok(octets(part) <= 75, `line ${i} has ${octets(part)} octets`);
    assert.doesNotThrow(() => strictDecoder.decode(Buffer.from(part, 'utf-8')));
    assert.doesNotMatch(part, /�/);
    if (i > 0) assert.equal(part[0], ' ');
  }
  assert.equal(unfold(folded), line);
});

test('foldLine backs off to the start of an emoji that straddles the boundary', () => {
  const line = `${'b'.repeat(73)}🎃tail`;
  const [first, second] = foldLine(line).split('\r\n');
  assert.equal(first, 'b'.repeat(73));
  assert.equal(second, ' 🎃tail');
});

test('foldLine backs off to the start of an accented letter that straddles the boundary', () => {
  const line = `${'c'.repeat(74)}ádios`;
  const [first, second] = foldLine(line).split('\r\n');
  assert.equal(first, 'c'.repeat(74));
  assert.equal(second, ' ádios');
});

// --- Structural validator (it must reject what it claims to check) ---

test('the structural validator rejects broken documents', () => {
  const good = generateICS([release()], { name: 'Cines', now: NOW });
  assert.deepEqual(validateICS(good), []);
  assert.ok(validateICS(good.replace(/\r\n/g, '\n')).length > 0, 'LF only');
  assert.ok(validateICS(good.replace('END:VEVENT\r\n', '')).length > 0, 'unbalanced');
  assert.ok(validateICS(good.replace(/UID:[^\r]*\r\n/, '')).length > 0, 'missing UID');
  assert.ok(validateICS(good.replace('METHOD:PUBLISH\r\n', '')).length > 0, 'missing METHOD');
  assert.ok(validateICS(good.replace('URL:', `URL:${'x'.repeat(80)}`)).length > 0, 'unfolded long line');
  assert.ok(validateICS(good.replace(/DTSTART;VALUE=DATE:\d+/, 'DTSTART:20261106T000000')).length > 0, 'not all-day');
  assert.ok(validateICS(good.slice(0, -2)).length > 0, 'no trailing CRLF');
});

// --- Single document ---

test('generateICS writes the VCALENDAR header fields with the calendar name', () => {
  const lines = unfoldedLines(generateICS([release()], { name: 'Netflix', now: NOW }));
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines.at(-1), 'END:VCALENDAR');
  for (const field of [
    'VERSION:2.0',
    'PRODID:-//Horror Calendar//horror-calendar//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Terror — Netflix',
    'REFRESH-INTERVAL;VALUE=DURATION:P1D',
    'X-PUBLISHED-TTL:P1D',
  ]) {
    assert.ok(lines.includes(field), `missing ${field}`);
  }
});

test('generateICS writes one all-day event per release with UID, SUMMARY, DESCRIPTION and URL', () => {
  const ics = generateICS([
    release({ overview: LONG_SYNOPSIS }),
    release({ id: 900002, title: 'Ritual, Nocturno', type: 'digital', releaseDate: '2026-11-13', tmdbUrl: 'https://www.themoviedb.org/movie/900002', providers: { flatrate: ['Netflix', 'Filmin'], rentBuy: [] } }),
  ], { name: 'Todo', now: NOW });
  assertValidICS(ics);
  const lines = unfoldedLines(ics);

  assert.deepEqual(lines.filter((l) => l.startsWith('DTSTART')), ['DTSTART;VALUE=DATE:20261106', 'DTSTART;VALUE=DATE:20261113']);
  assert.equal(lines.filter((l) => l.startsWith('DTEND')).length, 0);
  assert.deepEqual(lines.filter((l) => l.startsWith('DTSTAMP:')), ['DTSTAMP:20261102T060300Z', 'DTSTAMP:20261102T060300Z']);
  assert.equal(lines.filter((l) => l === 'TRANSP:TRANSPARENT').length, 2);
  assert.deepEqual(uids(ics), ['tmdb-900001-theatrical@horror-calendar', 'tmdb-900002-digital@horror-calendar']);
  assert.ok(lines.includes('SUMMARY:La Casa Vacía 🎬'));
  assert.ok(lines.includes('SUMMARY:Ritual\\, Nocturno 📺 Netflix / Filmin'));
  assert.ok(lines.includes('URL:https://www.themoviedb.org/movie/900002'));
  assert.ok(lines.includes('DESCRIPTION:Una familia hereda una casa.\\n\\nIncluido en: Netflix\\, Filmin'
    + '\\n\\nMás info: https://www.themoviedb.org/movie/900002'));
});

test('generateICS with no releases is still a valid empty VCALENDAR', () => {
  const ics = generateICS([], { name: 'Disney+', now: NOW });
  assertValidICS(ics);
  assert.doesNotMatch(ics, /BEGIN:VEVENT/);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
});

// --- UID ---

test('generateUID is tmdb-<id>-<type>@horror-calendar', () => {
  assert.equal(generateUID({ id: 900004, type: 'digital' }), 'tmdb-900004-digital@horror-calendar');
  assert.equal(generateUID({ id: 900004, type: 'theatrical' }), 'tmdb-900004-theatrical@horror-calendar');
});

test('the UID is stable when the release date or the title changes', () => {
  const before = generateICS([release()], { name: 'Cines', now: NOW });
  const after = generateICS([release({ releaseDate: '2026-12-24', title: 'La Casa Llena' })], { name: 'Cines', now: new Date() });
  assert.deepEqual(uids(after), uids(before));
  assert.match(after, /DTSTART;VALUE=DATE:20261224/);
});

test('a movie with a theatrical and a digital release gets two events with different UIDs', () => {
  const ics = generateICS([release(), release({ type: 'digital', releaseDate: '2027-01-15' })], { name: 'Todo', now: NOW });
  assert.deepEqual(uids(ics), ['tmdb-900001-theatrical@horror-calendar', 'tmdb-900001-digital@horror-calendar']);
});

// --- DESCRIPTION rules (§6) ---

test('DESCRIPTION: synopsis, where line and TMDB link; where line follows the first rule that applies', () => {
  const link = '\\n\\nMás info: https://www.themoviedb.org/movie/900001';
  const digital = (overrides) => release({ type: 'digital', overview: '', ...overrides });

  assert.equal(buildDescription(release()), `Una familia hereda una casa.\\n\\nEn cines${link}`);
  // theatrical wins even with providers
  assert.equal(buildDescription(release({ overview: '', providers: { flatrate: ['Filmin'], rentBuy: [] } })), `En cines${link}`);
  // flatrate: provider names as returned
  assert.equal(buildDescription(digital({ releaseNote: 'Prime Video', providers: { flatrate: ['Amazon Prime Video', 'Atresplayer'], rentBuy: ['Apple TV'] } })),
    `Incluido en: Amazon Prime Video\\, Atresplayer${link}`);
  // note-only: platform display names in config order
  assert.equal(buildDescription(digital({ releaseNote: 'prime video' })), `Estreno en: Prime Video${link}`);
  assert.equal(buildDescription(digital({ releaseNote: 'Prime Video', providers: { flatrate: [], rentBuy: ['Apple TV'] } })),
    `Estreno en: Prime Video${link}`);
  // rent/buy only
  assert.equal(buildDescription(digital({ providers: { flatrate: [], rentBuy: ['Apple TV', 'Rakuten TV'] } })),
    `Alquiler o compra: Apple TV\\, Rakuten TV${link}`);
  // unmatched note, nothing else
  assert.equal(buildDescription(digital({ releaseNote: 'Atresplayer' })), `Estreno digital${link}`);
  assert.equal(buildDescription(digital({})), `Estreno digital${link}`);
});

test('DESCRIPTION uses the release calendars for the Estreno en line, in config order', () => {
  const r = { ...release({ type: 'digital', overview: '' }), calendars: ['digital', 'netflix', 'filmin'] };
  assert.match(buildDescription(r), /^Estreno en: Netflix\\, Filmin\\n\\n/);
});

// --- SUMMARY rules (§6) ---

test('G3 SUMMARY: theatrical keeps "Title 🎬", digital adds its platforms, arrivals their platform', () => {
  const digital = (overrides) => release({ type: 'digital', ...overrides });
  assert.equal(buildSummary(release()), 'La Casa Vacía 🎬');
  // theatrical never gets a platform, even with providers
  assert.equal(buildSummary(release({ providers: { flatrate: ['Netflix'], rentBuy: [] } })), 'La Casa Vacía 🎬');
  assert.equal(buildSummary(digital({ releaseNote: 'Movistar Plus' })), 'La Casa Vacía 📺 Movistar Plus+');
  // config order, joined by " / ", whatever the order of flatrate and note
  assert.equal(buildSummary(digital({ releaseNote: 'Prime Video', providers: { flatrate: ['Filmin', 'Netflix'], rentBuy: [] } })),
    'La Casa Vacía 📺 Netflix / Prime Video / Filmin');
  // no platform calendar: rent/buy only, unmatched note, nothing
  assert.equal(buildSummary(digital({ providers: { flatrate: [], rentBuy: ['Apple TV'] } })), 'La Casa Vacía 📺');
  assert.equal(buildSummary(digital({ releaseNote: 'Atresplayer' })), 'La Casa Vacía 📺');
  assert.equal(buildSummary(digital({})), 'La Casa Vacía 📺');
  // arrival: display name of arrivalPlatform
  const arrival = { ...release({ type: 'arrival', title: 'Bitelchús Bitelchús' }), arrivalPlatform: 'hbo-max', calendars: ['hbo-max'] };
  assert.equal(buildSummary(arrival), 'Bitelchús Bitelchús 🆕 HBO Max');
});

test('G3 SUMMARY of the sample: platform names from release.calendars, same text in every calendar', () => {
  const expected = [
    'SUMMARY:Noche de Lobos 🆕 Movistar Plus+',
    'SUMMARY:La Niña del Pantano 🆕 Netflix',
    'SUMMARY:La Casa Vacía 🎬',
    'SUMMARY:Ritual Nocturno 📺 Netflix',
    'SUMMARY:Voces en el Sótano 📺',
    'SUMMARY:El Pozo 📺 Disney+',
    'SUMMARY:Sombras del Ayer 🎬',
    'SUMMARY:La Cosecha 📺 Prime Video / Filmin',
    'SUMMARY:La Marea Roja 📺 Prime Video',
    'SUMMARY:El Faro del Fin 📺',
    'SUMMARY:Sombras del Ayer 📺 HBO Max',
    'SUMMARY:El Último Tren 🎬',
  ];
  const byUid = new Map();
  for (const c of generateCalendars(SAMPLE.releases, { now: NOW })) {
    const lines = unfoldedLines(c.ics);
    for (const [i, line] of lines.entries()) {
      if (!line.startsWith('UID:')) continue;
      const summary = lines.slice(i).find((l) => l.startsWith('SUMMARY:'));
      if (byUid.has(line)) assert.equal(summary, byUid.get(line), `${line} in ${c.file}`);
      byUid.set(line, summary);
    }
  }
  assert.deepEqual(SAMPLE.releases.map((r) => byUid.get(`UID:${generateUID(r)}`)), expected);
});

// --- Multi-calendar ---

test('generateCalendars returns every calendar in canonical order with counts matching the sample', () => {
  const calendars = generateCalendars(SAMPLE.releases, { now: NOW });
  assert.deepEqual(calendars.map(({ ics, ...meta }) => meta), SAMPLE.calendars);
});

// The curated platform of a manual release lives in data/manual-releases.json, not in
// the release object: it is passed to assignCalendars, as src/manual.js does
const curated = (r) => (r.source === 'manual' ? { platforms: r.calendars.filter((s) => s !== 'digital') } : undefined);

test('E6 assignCalendars + generateCalendars on the sample releases reproduce it exactly, counts included', () => {
  const assigned = SAMPLE.releases.map((r) => {
    const { calendars, ...rest } = r;
    return assignCalendars(rest, curated(r));
  });
  assert.deepEqual(assigned, SAMPLE.releases);
  const calendars = generateCalendars(assigned, { now: NOW });
  assert.deepEqual(calendars.map(({ ics, ...meta }) => meta), SAMPLE.calendars);
});

test('every generated calendar passes the structural validator, empty ones included', () => {
  const calendars = generateCalendars(SAMPLE.releases, { now: NOW });
  assert.equal(calendars.length, 11);
  for (const c of calendars) {
    assertValidICS(c.ics, c.file);
    const lines = unfoldedLines(c.ics);
    assert.ok(lines.includes(`X-WR-CALNAME:Terror — ${c.name}`), c.file);
    assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, c.count, c.file);
  }
  assert.ok(byFile(calendars, 'horror-skyshowtime.ics').ics.length > 0);
  assert.equal(byFile(calendars, 'horror-skyshowtime.ics').count, 0);
});

test('each calendar contains exactly the releases that list its slug', () => {
  const calendars = generateCalendars(SAMPLE.releases, { now: NOW });
  for (const c of calendars.filter((x) => x.slug !== 'all')) {
    const expected = SAMPLE.releases.filter((r) => r.calendars.includes(c.slug)).map(generateUID);
    assert.deepEqual(uids(c.ics), expected, c.file);
  }
  const prime = byFile(calendars, 'horror-prime-video.ics');
  assert.deepEqual(uids(prime.ics), ['tmdb-900005-digital@horror-calendar', 'tmdb-900008-digital@horror-calendar']);
  assert.match(unfold(prime.ics), /Estreno en: Prime Video/, 'note-only release 900008');
});

test('horror.ics keeps its file name, is named "Terror — Todo" and holds cines + digital', () => {
  const calendars = generateCalendars(SAMPLE.releases, { now: NOW });
  const all = byFile(calendars, 'horror.ics');
  assert.equal(all.slug, 'all');
  assert.ok(unfoldedLines(all.ics).includes('X-WR-CALNAME:Terror — Todo'));

  const cines = uids(byFile(calendars, 'horror-cines.ics').ics);
  const digital = uids(byFile(calendars, 'horror-digital.ics').ics);
  assert.deepEqual(new Set(uids(all.ics)), new Set([...cines, ...digital]));
  assert.equal(all.count, cines.length + digital.length);
  assert.equal(all.count, SAMPLE.releases.filter((r) => r.type !== 'arrival').length);
});

// --- Arrivals and manual releases (F4) ---

test('E5 arrivals: only in their platform calendar, never in digital nor horror.ics', () => {
  const calendars = generateCalendars(SAMPLE.releases, { now: NOW });
  const arrivalUids = ['tmdb-900010-arrival-movistar-plus@horror-calendar', 'tmdb-900011-arrival-netflix@horror-calendar'];
  for (const c of calendars) {
    const found = uids(c.ics).filter((u) => u.includes('-arrival-'));
    const expected = { 'movistar-plus': [arrivalUids[0]], netflix: [arrivalUids[1]] }[c.slug] ?? [];
    assert.deepEqual(found, expected, c.file);
  }
  assert.doesNotMatch(byFile(calendars, 'horror.ics').ics, /🆕|arrival/);
  assert.doesNotMatch(byFile(calendars, 'horror-digital.ics').ics, /🆕|arrival/);
});

test('E5 arrival event: UID with the platform, 🆕 marker and "Ya disponible en:" line', () => {
  const arrival = SAMPLE.releases.find((r) => r.id === 900010);
  assert.equal(generateUID(arrival), 'tmdb-900010-arrival-movistar-plus@horror-calendar');
  const lines = unfoldedLines(generateICS([arrival], { name: 'Movistar Plus+', now: NOW }));
  assert.ok(lines.includes('UID:tmdb-900010-arrival-movistar-plus@horror-calendar'));
  assert.ok(lines.includes('SUMMARY:Noche de Lobos 🆕 Movistar Plus+'));
  assert.ok(lines.includes('DTSTART;VALUE=DATE:20261026'));
  assert.ok(lines.includes(`DESCRIPTION:${escapeText(arrival.overview)}\\n\\nYa disponible en: Movistar Plus+`
    + '\\n\\nMás info: https://www.themoviedb.org/movie/900010'));
  // The same movie on two platforms gives two UIDs
  assert.notEqual(generateUID({ ...arrival, arrivalPlatform: 'filmin' }), generateUID(arrival));
  // Arrival wins over flatrate in the where line
  assert.equal(buildWhereLine({ ...arrival, providers: { flatrate: ['Filmin'], rentBuy: [] } }), 'Ya disponible en: Movistar Plus+');
});

test('E3 manual release: digital UID shared with TMDB, "Estreno en:" then "Fuente:" line', () => {
  const manual = SAMPLE.releases.find((r) => r.source === 'manual');
  assert.equal(generateUID(manual), 'tmdb-900009-digital@horror-calendar');
  assert.equal(generateUID({ ...manual, source: 'tmdb', sourceUrl: null }), generateUID(manual));
  assert.equal(buildDescription(manual), `${escapeText(manual.overview)}\\n\\nEstreno en: Disney+`
    + '\\n\\nFuente: https://example.com/prensa/el-pozo-disney-plus\\n\\nMás info: https://www.themoviedb.org/movie/900009');
  // Only manual releases get the source line
  assert.doesNotMatch(buildDescription({ ...manual, source: 'tmdb' }), /Fuente:/);
  const calendars = generateCalendars(SAMPLE.releases, { now: NOW });
  for (const file of ['horror-disney-plus.ics', 'horror-digital.ics', 'horror.ics']) {
    assert.ok(uids(byFile(calendars, file).ics).includes('tmdb-900009-digital@horror-calendar'), file);
    assert.match(unfold(byFile(calendars, file).ics), /Fuente: https:\/\/example\.com\/prensa\/el-pozo-disney-plus/, file);
  }
});

test('with no releases every calendar is still generated as a valid empty VCALENDAR', () => {
  const calendars = generateCalendars([], { now: NOW });
  assert.equal(calendars.length, 11);
  for (const c of calendars) {
    assert.equal(c.count, 0);
    assertValidICS(c.ics, c.file);
  }
});
