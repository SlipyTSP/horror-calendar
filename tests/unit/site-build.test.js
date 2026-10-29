// Web ↔ build agreement (F5, G6): the subscription file the selector offers for a
// selection is a file the build writes, and its X-WR-CALNAME follows §3.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const selector = require('../../site/selector');
const { generateCalendars, generateMixes, escapeText } = require('../../src/calendar');
const { unfoldedLines } = require('../support/ics-validator');

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'releases.sample.json'), 'utf-8'));
const NOW = new Date('2026-11-02T06:03:00.000Z');

// The build output for the sample, laid out as src/index.js writes it
function buildOutput() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'horror-site-build-'));
  fs.mkdirSync(path.join(dir, 'mix'));
  for (const c of [...generateCalendars(SAMPLE.releases, { now: NOW }), ...generateMixes(SAMPLE.releases, { now: NOW })]) {
    fs.writeFileSync(path.join(dir, c.file), c.ics, 'utf-8');
  }
  return dir;
}

const OUT = buildOutput();
after(() => fs.rmSync(OUT, { recursive: true, force: true }));
const known = selector.selectableCalendars(SAMPLE).map((c) => c.slug);

function assertOffered(selection) {
  const target = selector.subscriptionFile(SAMPLE, selection);
  assert.ok(target, JSON.stringify(selection));
  const file = path.join(OUT, target.file);
  assert.ok(fs.existsSync(file), `${target.file} is not in the build output`);
  const lines = unfoldedLines(fs.readFileSync(file, 'utf-8'));
  assert.ok(lines.includes(`X-WR-CALNAME:${escapeText(`Terror — ${target.name}`)}`), target.file);
  return target;
}

test('G6 the selector offers a file of the build: two, five, all, Digital + one platform', () => {
  assert.equal(assertOffered(['cines', 'netflix']).name, 'Cines, Netflix');
  assert.equal(assertOffered(['cines', 'netflix', 'prime-video', 'hbo-max', 'filmin']).name, 'Mi selección');
  assert.equal(assertOffered(known).file, `mix/${known.join('_')}.ics`);
  assert.equal(assertOffered(['digital', 'movistar-plus']).file, 'mix/movistar-plus_digital.ics');
  assert.equal(assertOffered(['skyshowtime']).file, 'horror-skyshowtime.ics');
});

test('G6 every non-empty selection of the sample maps to a written file with the §3 name', () => {
  const offered = new Set();
  for (let mask = 1; mask < 2 ** known.length; mask += 1) {
    const selection = known.filter((_, i) => mask & (1 << i));
    offered.add(assertOffered(selection).file);
  }
  // 1023 selections, 1023 distinct files: the 10 single calendars and the 1013 mixes
  assert.equal(offered.size, 1023);
  assert.equal(fs.readdirSync(path.join(OUT, 'mix')).length, 1013);
  for (const f of fs.readdirSync(path.join(OUT, 'mix'))) assert.ok(offered.has(`mix/${f}`), f);
});

test('G6 the mix offered for a selection holds exactly the releases the page lists for it', () => {
  for (const selection of [['cines', 'netflix'], ['digital', 'movistar-plus'], ['netflix', 'movistar-plus', 'filmin'], known]) {
    const { file } = selector.subscriptionFile(SAMPLE, selection);
    const events = unfoldedLines(fs.readFileSync(path.join(OUT, file), 'utf-8')).filter((l) => l === 'BEGIN:VEVENT').length;
    assert.equal(events, selector.filterReleases(SAMPLE.releases, selection).length, file);
  }
});
