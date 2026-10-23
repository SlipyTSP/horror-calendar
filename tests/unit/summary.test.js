const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, renderSummary } = require('../../scripts/summary');

const SAMPLE = path.join(__dirname, '..', 'fixtures', 'releases.sample.json');

function capture() {
  const chunks = [];
  return { write: (chunk) => chunks.push(String(chunk)), text: () => chunks.join('') };
}

function writeTmp(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

// Rows of the release table (the one whose header starts with "| Date")
function tableRows(text) {
  const lines = text.split('\n');
  const header = lines.findIndex((l) => l.startsWith('| Date'));
  if (header === -1) return [];
  const rows = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('| ')) break;
    rows.push(line);
  }
  return rows;
}

// Rows of the per-calendar table (header "| Calendar")
function calendarRows(text) {
  const lines = text.split('\n');
  const header = lines.findIndex((l) => l.startsWith('| Calendar'));
  if (header === -1) return [];
  const rows = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('| ')) break;
    rows.push(line);
  }
  return rows;
}

test('renders the current releases.json shape (releaseType + providers array)', () => {
  const doc = {
    generated: '2026-10-19T06:00:00.000Z',
    total: 2,
    releases: [
      { title: 'La Casa Vacía', releaseDate: '2026-11-06', releaseType: 'theatrical', providers: [] },
      { title: 'Ritual | Nocturno', releaseDate: '2026-11-13', releaseType: 'digital', providers: ['Netflix', 'Filmin'] },
    ],
  };
  const text = renderSummary(doc);

  assert.match(text, /^## Horror releases \(2\)\n/);
  assert.match(text, /\| Date \| Title \| Type \| Platforms \|\n/);
  assert.deepEqual(calendarRows(text), [], 'no calendar table for the old shape');
  assert.deepEqual(tableRows(text), [
    '| 2026-11-06 | La Casa Vacía | theatrical | — |',
    '| 2026-11-13 | Ritual \\| Nocturno | digital | Netflix, Filmin |',
  ]);
});

test('renders the data model shape from tests/fixtures/releases.sample.json', () => {
  const out = capture();
  const err = capture();
  assert.equal(run({ file: SAMPLE, out, err }), 0);
  assert.equal(err.text(), '');

  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf-8'));
  const text = out.text();
  const rows = tableRows(text);

  assert.match(text, /\| Date \| Title \| Type \| Calendars \| Release note \|/);
  assert.match(text, /Region: ES · window 2026-11-02 → 2027-01-31/);
  assert.equal(rows.length, sample.releases.length);
  for (const [i, r] of sample.releases.entries()) {
    assert.ok(rows[i].startsWith(`| ${r.releaseDate} | ${r.title} | ${r.type} | `), rows[i]);
    for (const slug of r.calendars) assert.ok(rows[i].includes(slug), `${slug} missing in ${rows[i]}`);
    for (const name of r.providers.rentBuy) assert.ok(rows[i].includes(name), `${name} missing in ${rows[i]}`);
    assert.ok(rows[i].endsWith(r.releaseNote ? ` | ${r.releaseNote} |` : ' | — |'), rows[i]);
  }
  assert.equal(rows.find((row) => row.includes('La Marea Roja')), '| 2026-12-11 | La Marea Roja | digital | digital, prime-video | Prime Video |');
});

test('the data model shape gets a per-calendar count table in canonical order', () => {
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf-8'));
  const rows = calendarRows(renderSummary(sample));
  assert.deepEqual(rows, sample.calendars.map((c) => `| ${c.slug} | ${c.file} | ${c.count} |`));
  assert.equal(rows[0], '| cines | horror-cines.ics | 3 |');
  assert.equal(rows.at(-1), '| all | horror.ics | 9 |');
});

test('without calendars metadata the counts are computed from the releases', () => {
  const sample = JSON.parse(fs.readFileSync(SAMPLE, 'utf-8'));
  const rows = calendarRows(renderSummary({ releases: sample.releases }));
  assert.ok(rows.includes('| cines | — | 3 |'));
  assert.ok(rows.includes('| prime-video | — | 2 |'));
  assert.ok(rows.includes('| digital | — | 6 |'));
  assert.equal(rows.at(-1), '| all | horror.ics | 9 |');
});

test('an empty releases list produces an empty table, not an error', () => {
  const out = capture();
  assert.equal(run({ file: writeTmp('releases.json', '{"releases": []}'), out, err: capture() }), 0);
  assert.match(out.text(), /## Horror releases \(0\)/);
  assert.deepEqual(tableRows(out.text()), []);
});

test('missing fields and a missing releases array are tolerated', () => {
  assert.deepEqual(tableRows(renderSummary({})), []);
  assert.deepEqual(tableRows(renderSummary(null)), []);
  assert.deepEqual(tableRows(renderSummary({ releases: [{}, null] })), ['| — | — | — | — |', '| — | — | — | — |']);
});

test('a missing file exits with 1 and a clear message', () => {
  const out = capture();
  const err = capture();
  const file = path.join(os.tmpdir(), 'does-not-exist', 'releases.json');
  assert.equal(run({ file, out, err }), 1);
  assert.equal(out.text(), '');
  assert.match(err.text(), /cannot read .*releases\.json/);
});

test('a file that is not JSON exits with 1 and a clear message', () => {
  const out = capture();
  const err = capture();
  assert.equal(run({ file: writeTmp('releases.json', 'not json'), out, err }), 1);
  assert.equal(out.text(), '');
  assert.match(err.text(), /is not valid JSON/);
});
