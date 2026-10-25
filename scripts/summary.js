// Prints Markdown tables of output/releases.json: titles and arrivals per calendar and one
// row per release (with its source, runtime and release note in the data model shape).
// CI appends it to the job summary: node scripts/summary.js >> "$GITHUB_STEP_SUMMARY"
//
// Copes with both shapes of releases.json, looking at the fields present:
// - current: { releaseType, providers: string[] }
// - data model §4: { type, source, calendars: string[], providers: { flatrate, rentBuy } }

const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'output', 'releases.json');

/**
 * True when the document follows docs/data-model.md §4.
 * @param {object} doc - Parsed releases.json
 * @param {object[]} releases
 */
function isDataModelShape(doc, releases) {
  if (doc?.schema !== undefined || Array.isArray(doc?.calendars)) return true;
  return releases.some((r) => Array.isArray(r?.calendars)
    || (r?.providers && typeof r.providers === 'object' && !Array.isArray(r.providers)));
}

function cell(value) {
  const text = value === undefined || value === null || value === '' ? '—' : String(value);
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}

function list(value) {
  return Array.isArray(value) ? value.filter((v) => v !== undefined && v !== null && v !== '').join(', ') : '';
}

function legacyRow(r) {
  return [r?.releaseDate, r?.title, r?.releaseType, list(r?.providers)];
}

function dataModelRow(r) {
  const rentBuy = list(r?.providers?.rentBuy);
  const calendars = list(r?.calendars);
  const where = rentBuy ? `${calendars || '—'} (rent/buy: ${rentBuy})` : calendars;
  const note = typeof r?.releaseNote === 'string' && r.releaseNote.trim() ? r.releaseNote.trim() : '';
  const runtime = Number.isFinite(r?.runtime) ? `${r.runtime} min` : '';
  return [r?.releaseDate, r?.title, r?.type ?? r?.releaseType, r?.source, runtime, where, note];
}

/** Arrivals per calendar slug, counted from the releases (§3: only platform calendars). */
function arrivalCounts(releases) {
  const counts = new Map();
  for (const r of releases) {
    if (r?.type !== 'arrival') continue;
    for (const slug of Array.isArray(r?.calendars) ? r.calendars : []) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  return counts;
}

/**
 * Per-calendar counts: the `calendars` metadata when present, otherwise counted from
 * the releases (first-seen order, plus the implicit `all`).
 * @returns {Array<{ slug: string, file: string, count: number }>}
 */
function calendarCounts(doc, releases) {
  if (Array.isArray(doc?.calendars)) {
    return doc.calendars.filter((c) => c && typeof c === 'object')
      .map((c) => ({ slug: c.slug, file: c.file, count: c.count }));
  }
  const counts = new Map();
  for (const r of releases) {
    for (const slug of Array.isArray(r?.calendars) ? r.calendars : []) counts.set(slug, (counts.get(slug) ?? 0) + 1);
  }
  // horror.ics holds every release except arrivals
  return [...counts].map(([slug, count]) => ({ slug, file: null, count }))
    .concat({ slug: 'all', file: 'horror.ics', count: releases.filter((r) => r?.type !== 'arrival').length });
}

/**
 * Builds the Markdown summary for a parsed releases.json.
 * @param {object} doc
 * @returns {string}
 */
function renderSummary(doc) {
  const releases = Array.isArray(doc?.releases) ? doc.releases : [];
  const modern = isDataModelShape(doc, releases);
  const lastColumn = modern ? 'Calendars' : 'Platforms';

  const lines = [`## Horror releases (${releases.length})`, ''];
  if (doc?.generated) lines.push(`Generated: ${cell(doc.generated)}`, '');
  if (modern && doc?.region && doc?.window) {
    lines.push(`Region: ${cell(doc.region)} · window ${cell(doc.window.from)} → ${cell(doc.window.to)}`, '');
  }
  if (modern && doc?.arrivalWindow) {
    lines.push(`Arrivals detected ${cell(doc.arrivalWindow.from)} → ${cell(doc.arrivalWindow.to)}`, '');
  }
  if (modern) {
    const arrivals = arrivalCounts(releases);
    lines.push('| Calendar | File | Titles | Arrivals |', '|---|---|---|---|');
    for (const c of calendarCounts(doc, releases)) {
      lines.push(`| ${[c.slug, c.file, c.count, arrivals.get(c.slug) ?? 0].map(cell).join(' | ')} |`);
    }
    lines.push('');
    lines.push(`| Date | Title | Type | Source | Runtime | ${lastColumn} | Release note |`, '|---|---|---|---|---|---|---|');
  } else {
    lines.push(`| Date | Title | Type | ${lastColumn} |`, '|---|---|---|---|');
  }
  for (const r of releases) {
    lines.push(`| ${(modern ? dataModelRow(r) : legacyRow(r)).map(cell).join(' | ')} |`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Reads the file and writes the table to `out`. Returns the exit code.
 * @param {object} [options]
 * @param {string} [options.file] - Path to releases.json
 * @param {NodeJS.WritableStream} [options.out] - Where the table goes
 * @param {NodeJS.WritableStream} [options.err] - Where errors go
 * @returns {number}
 */
function run({ file = DEFAULT_FILE, out = process.stdout, err = process.stderr } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    err.write(`summary: cannot read ${file} (${error.code || error.message}). Run "npm start" first.\n`);
    return 1;
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    err.write(`summary: ${file} is not valid JSON (${error.message}).\n`);
    return 1;
  }

  out.write(renderSummary(doc));
  return 0;
}

if (require.main === module) {
  process.exitCode = run({ file: process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_FILE });
}

module.exports = { run, renderSummary, DEFAULT_FILE };
