// Tests for the current src/calendar.js (pre-F1). They document today's behaviour:
// UID from title + date and the soft inclusion filter will be rewritten by F1.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  generateICS, escapeText, foldLine, generateUID, buildDescription,
} = require('../../src/calendar');

const LONG_SYNOPSIS = 'Cuando la niña desaparece en el bosque, su madre descubre que la cabaña '
  + 'esconde un sótano olvidado; allí, la oscuridad susurra canciones en un idioma '
  + 'que nadie recuerda 🎃 y cada noche el eco se acerca un poco más a la puerta, '
  + 'mientras el pueblo entero finge no oír nada.';

function release(overrides = {}) {
  return {
    title: 'La Casa Vacía',
    releaseDate: '2026-11-06',
    overview: 'Una familia hereda una casa.',
    providers: [],
    releaseType: 'theatrical',
    tmdbUrl: 'https://www.themoviedb.org/movie/900001',
    ...overrides,
  };
}

const octets = (s) => Buffer.byteLength(s, 'utf-8');
const unfold = (s) => s.replace(/\r\n /g, '');
const physicalLines = (ics) => ics.split('\r\n').slice(0, -1);
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

test('escapeText escapes backslash, semicolon, comma and newlines (RFC 5545 3.3.11)', () => {
  assert.equal(escapeText('a\\b;c,d'), 'a\\\\b\\;c\\,d');
  assert.equal(escapeText('line1\nline2\r\nline3'), 'line1\\nline2\\nline3');
});

test('escapeText escapes backslashes first, so escapes are not doubled', () => {
  assert.equal(escapeText('\\;'), '\\\\\\;');
  assert.equal(escapeText('Sin escapes: ñ á 🎃'), 'Sin escapes: ñ á 🎃');
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
    // A split sequence would make the strict decoder throw or yield U+FFFD
    assert.doesNotThrow(() => strictDecoder.decode(Buffer.from(part, 'utf-8')));
    assert.doesNotMatch(part, /�/);
    if (i > 0) assert.equal(part[0], ' ');
  }
  assert.equal(unfold(folded), line);
});

test('foldLine backs off to the start of an emoji that straddles the boundary', () => {
  // 73 ASCII octets, then a 4-octet emoji covering octets 74-77
  const line = `${'b'.repeat(73)}🎃tail`;
  const [first, second] = foldLine(line).split('\r\n');
  assert.equal(first, 'b'.repeat(73));
  assert.equal(second, ' 🎃tail');
});

test('foldLine backs off to the start of an accented letter that straddles the boundary', () => {
  // 74 ASCII octets, then "á" (2 octets) covering octets 75-76
  const line = `${'c'.repeat(74)}ádios`;
  const [first, second] = foldLine(line).split('\r\n');
  assert.equal(first, 'c'.repeat(74));
  assert.equal(second, ' ádios');
});

test('generateICS uses CRLF on every line and ends with CRLF', () => {
  const { ics } = generateICS([release({ overview: LONG_SYNOPSIS })]);
  assert.ok(ics.endsWith('\r\n'));
  assert.doesNotMatch(ics.replace(/\r\n/g, ''), /[\r\n]/, 'no bare CR or LF');
  for (const line of physicalLines(ics)) {
    assert.ok(octets(line) <= 75, `"${line}" exceeds 75 octets`);
  }
});

test('generateICS writes the VCALENDAR header fields', () => {
  const lines = physicalLines(generateICS([release()]).ics);
  assert.equal(lines[0], 'BEGIN:VCALENDAR');
  assert.equal(lines.at(-1), 'END:VCALENDAR');
  for (const field of [
    'VERSION:2.0',
    'PRODID:-//Horror Calendar//horror-calendar//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:🎬 Estrenos de Terror',
    'REFRESH-INTERVAL;VALUE=DURATION:P1D',
    'X-PUBLISHED-TTL:P1D',
  ]) {
    assert.ok(lines.includes(field), `missing ${field}`);
  }
});

test('generateICS emits one all-day VEVENT per included release', () => {
  const releases = [
    release(),
    release({ title: 'Ritual Nocturno', releaseDate: '2026-11-13', releaseType: 'digital', providers: ['Netflix'] }),
    release({ title: 'Voces', releaseDate: '2027-01-02', releaseType: null, overview: 'Algo pasa.' }),
  ];
  const { ics, total, excluded } = generateICS(releases);
  const lines = physicalLines(ics);

  assert.equal(total, 3);
  assert.equal(excluded, 0);
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 3);
  assert.equal(lines.filter((l) => l === 'END:VEVENT').length, 3);
  assert.deepEqual(
    lines.filter((l) => l.startsWith('DTSTART')),
    ['DTSTART;VALUE=DATE:20261106', 'DTSTART;VALUE=DATE:20261113', 'DTSTART;VALUE=DATE:20270102'],
  );
  assert.equal(lines.filter((l) => l.startsWith('DTEND')).length, 0);
  assert.equal(lines.filter((l) => l === 'TRANSP:TRANSPARENT').length, 3);
  for (const stamp of lines.filter((l) => l.startsWith('DTSTAMP:'))) {
    assert.match(stamp, /^DTSTAMP:\d{8}T\d{6}Z$/);
  }
});

test('generateICS writes each event with UID, SUMMARY with type emoji, DESCRIPTION and URL', () => {
  const lines = physicalLines(unfold(generateICS([
    release({ title: 'Ritual, Nocturno', releaseType: 'digital', providers: ['Netflix', 'Filmin'] }),
  ]).ics));

  assert.ok(lines.some((l) => /^UID:[0-9a-f]{16}@horror-calendar$/.test(l)));
  assert.ok(lines.includes('SUMMARY:Ritual\\, Nocturno 📺'));
  assert.ok(lines.includes('URL:https://www.themoviedb.org/movie/900001'));
  assert.ok(lines.includes(
    'DESCRIPTION:Una familia hereda una casa.\\n\\n📺 Streaming: Netflix\\, Filmin'
    + '\\n\\nMás info: https://www.themoviedb.org/movie/900001',
  ));
});

test('generateICS excludes releases without overview, providers or release type (today\'s filter)', () => {
  const { ics, total, excluded } = generateICS([
    release(),
    release({ title: 'Nada', overview: '', providers: [], releaseType: null }),
  ]);
  assert.equal(total, 1);
  assert.equal(excluded, 1);
  assert.doesNotMatch(ics, /Nada/);
});

test('generateICS with no releases is still a valid empty VCALENDAR', () => {
  const { ics, total } = generateICS([]);
  assert.equal(total, 0);
  assert.doesNotMatch(ics, /BEGIN:VEVENT/);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
});

test('generateUID is deterministic for identical input and changes with title or date', () => {
  const uid = generateUID('La Casa Vacía', '2026-11-06');
  assert.equal(uid, generateUID('La Casa Vacía', '2026-11-06'));
  assert.match(uid, /^[0-9a-f]{16}@horror-calendar$/);
  assert.notEqual(uid, generateUID('La Casa Vacía', '2026-11-07'));
  assert.notEqual(uid, generateUID('La Casa Vacia', '2026-11-06'));
});

test('generateICS produces the same UIDs for the same releases on every run', () => {
  const uids = (ics) => ics.split('\r\n').filter((l) => l.startsWith('UID:'));
  const input = [release(), release({ title: 'Otra', releaseDate: '2026-12-01' })];
  assert.deepEqual(uids(generateICS(input).ics), uids(generateICS(input).ics));
  assert.equal(new Set(uids(generateICS(input).ics)).size, 2);
});

test('buildDescription joins synopsis, where line and TMDB link, escaped', () => {
  assert.equal(
    buildDescription(release()),
    'Una familia hereda una casa.\\n\\n🎬 En cines\\n\\nMás info: https://www.themoviedb.org/movie/900001',
  );
  assert.equal(
    buildDescription(release({ overview: '', releaseType: 'theatrical', providers: ['Filmin'] })),
    '🎬 En cines | 📺 También en: Filmin\\n\\nMás info: https://www.themoviedb.org/movie/900001',
  );
  assert.equal(
    buildDescription(release({ overview: '', releaseType: 'digital', providers: [] })),
    '📺 Estreno digital\\n\\nMás info: https://www.themoviedb.org/movie/900001',
  );
  assert.equal(
    buildDescription(release({ overview: '', releaseType: null, providers: [] })),
    'Más info: https://www.themoviedb.org/movie/900001',
  );
});
