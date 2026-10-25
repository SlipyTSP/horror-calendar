// Curated manual releases from data/manual-releases.json (docs/data-model.md §10).
//
// Spanish digital releases that TMDB does not date in Spain, filled by the owner from
// the Spanish press. Best effort: nothing in this file can make the run fail. Every
// field of the file is optional and validated; an invalid entry is skipped with a
// ::warning::, a missing file is a plain log line.

const fs = require('fs');
const { PLATFORMS, assignCalendars } = require('./platforms');
const {
  isIsoDate, mapPool, passesRuntimeRule, releaseFromDetail, fillEnglishOverviews,
  DETAIL_CONCURRENCY,
} = require('./tmdb');

const MANUAL_SCHEMA_VERSION = 1;
const MAX_FILE_BYTES = 1024 * 1024;

const SLUGS = new Set(PLATFORMS.map((p) => p.slug));

/** The URL normalised when it is an absolute https:// URL, otherwise null. */
function httpsUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && url.hostname ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Validates the parsed manual file. Returns the valid entries (any date) and the
 * problems found, one per skipped entry or per document error.
 * @param {*} doc - Parsed JSON
 * @returns {{ entries: Array<{ id: number, releaseDate: string, platform: string, sourceUrl: string }>,
 *   problems: string[], valid: boolean }}
 */
function validateManualDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { entries: [], problems: ['the file is not a JSON object'], valid: false };
  }
  if (doc.schema !== MANUAL_SCHEMA_VERSION) {
    return { entries: [], problems: [`unknown schema ${JSON.stringify(doc.schema)} (expected ${MANUAL_SCHEMA_VERSION})`], valid: false };
  }
  if (!Array.isArray(doc.releases)) {
    return { entries: [], problems: ['"releases" is not an array'], valid: false };
  }

  const problems = [];
  const candidates = [];
  doc.releases.forEach((raw, index) => {
    const label = `entry #${index + 1}${Number.isInteger(raw?.id) ? ` (id ${raw.id})` : ''}`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      problems.push(`${label} is not an object`);
      return;
    }
    const errors = [];
    if (!Number.isInteger(raw.id) || raw.id <= 0) errors.push('"id" is not a positive integer');
    if (!isIsoDate(raw.releaseDate)) errors.push('"releaseDate" is not a YYYY-MM-DD date');
    if (typeof raw.platform !== 'string' || !SLUGS.has(raw.platform)) errors.push(`unknown platform ${JSON.stringify(raw.platform)}`);
    const sourceUrl = httpsUrl(raw.sourceUrl);
    if (!sourceUrl) errors.push('"sourceUrl" is not an https:// URL');
    if (errors.length > 0) {
      problems.push(`${label} skipped: ${errors.join('; ')}`);
      return;
    }
    candidates.push({ index, entry: { id: raw.id, releaseDate: raw.releaseDate, platform: raw.platform, sourceUrl } });
  });

  // One entry per id: a repeated id is ambiguous, so every entry with it is skipped
  const seen = new Map();
  for (const { entry } of candidates) seen.set(entry.id, (seen.get(entry.id) ?? 0) + 1);
  const entries = [];
  for (const { index, entry } of candidates) {
    if (seen.get(entry.id) > 1) {
      problems.push(`entry #${index + 1} (id ${entry.id}) skipped: id repeated in the file`);
      continue;
    }
    entries.push(entry);
  }
  return { entries, problems, valid: true };
}

/**
 * Reads and validates the manual releases file. Never throws.
 * @param {string} file - Absolute path
 * @param {{ log: Function, warn: Function }} io
 * @returns {Array<{ id: number, releaseDate: string, platform: string, sourceUrl: string }>}
 */
function loadManualEntries(file, { log, warn }) {
  let raw;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOTFILE' });
    if (stat.size > MAX_FILE_BYTES) {
      warn(`Manual releases file ${file} is larger than ${MAX_FILE_BYTES} bytes; no manual releases this build.`);
      return [];
    }
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      log(`No manual releases file at ${file}; no manual releases.`);
    } else {
      warn(`Manual releases file ${file} cannot be read (${err?.code || err?.message}); no manual releases this build.`);
    }
    return [];
  }

  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    warn(`Manual releases file ${file} is not valid JSON (${err.message}); no manual releases this build.`);
    return [];
  }
  const { entries, problems, valid } = validateManualDocument(doc);
  if (!valid) {
    warn(`Manual releases file ${file}: ${problems[0]}; no manual releases this build.`);
    return [];
  }
  for (const problem of problems) warn(`Manual releases file ${file}: ${problem}.`);
  log(`Manual releases file: ${entries.length} valid entr${entries.length === 1 ? 'y' : 'ies'}.`);
  return entries;
}

/**
 * Turns the valid entries inside the window into releases (§10), applying the TMDB-wins
 * and runtime rules of §2. Never throws for data problems.
 * @param {object} options
 * @param {object[]} options.entries - Valid entries (loadManualEntries)
 * @param {{ from: string, to: string }} options.window
 * @param {object[]} options.tmdbReleases - TMDB releases of this build (after the runtime rule)
 * @param {object} options.context - Shared TMDB context (src/tmdb.js createContext)
 * @param {Function} options.log
 * @param {Function} options.warn
 * @returns {Promise<{ releases: object[], removed: object[], curatedPlatforms: Map<number, string[]>,
 *   details: { total: number, failed: number } }>}
 */
async function buildManualReleases({ entries, window, tmdbReleases, context, log, warn }) {
  const { minRuntime } = context.settings;
  const inWindow = entries.filter((e) => e.releaseDate >= window.from && e.releaseDate <= window.to);
  const tmdbDigital = new Map(tmdbReleases.filter((r) => r.type === 'digital').map((r) => [r.id, r]));

  // TMDB wins: no manual release, the curated platform joins the TMDB release's calendars
  const curatedPlatforms = new Map();
  const pending = [];
  for (const entry of inWindow) {
    const tmdb = tmdbDigital.get(entry.id);
    if (!tmdb) {
      pending.push(entry);
      continue;
    }
    curatedPlatforms.set(entry.id, [entry.platform]);
    if (tmdb.releaseDate !== entry.releaseDate) {
      warn(`Manual release ${entry.id} ("${tmdb.title}") is also dated by TMDB: TMDB ${tmdb.releaseDate}, `
        + `manual ${entry.releaseDate}. TMDB wins; the manual entry only adds ${entry.platform}.`);
    } else {
      log(`Manual release ${entry.id} ("${tmdb.title}") is also dated by TMDB on the same day; TMDB wins.`);
    }
  }

  await mapPool(pending, DETAIL_CONCURRENCY, (entry) => context.detail(entry.id, 'manual'));
  const releases = [];
  const removed = [];
  for (const entry of pending) {
    const result = await context.detail(entry.id, 'manual');
    if (!result.ok) {
      warn(result.status === 404
        ? `Manual release ${entry.id} does not exist in TMDB (HTTP 404); entry skipped.`
        : `Manual release ${entry.id}: detail request failed (${result.error}); skipped in this build only.`);
      continue;
    }
    const release = releaseFromDetail(entry.id, result.detail, {
      releaseDate: entry.releaseDate,
      type: 'digital',
      source: 'manual',
      sourceUrl: entry.sourceUrl,
    });
    if (passesRuntimeRule(result.detail, minRuntime)) releases.push(release);
    else removed.push(release);
  }
  await fillEnglishOverviews(context, releases, 'manual');

  const assigned = releases.map((release) => assignCalendars(release,
    { platforms: [inWindow.find((e) => e.id === release.id).platform] }));
  const details = context.counts('manual');
  if (details.total > 0) log(`Manual detail requests: ${details.total}, failed: ${details.failed}.`);
  return { releases: assigned, removed, curatedPlatforms, details };
}

module.exports = {
  validateManualDocument,
  loadManualEntries,
  buildManualReleases,
  httpsUrl,
  MANUAL_SCHEMA_VERSION,
};
