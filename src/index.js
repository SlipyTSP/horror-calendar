// Entry point: queries TMDB, adds the curated manual releases and the platform arrivals,
// assigns calendars and writes every .ics plus releases.json and providers-snapshot.json
// (docs/data-model.md §3, §4, §10 and §11). Exits non-zero only on the conditions of §7,
// so that CI never publishes empty or partial calendars over good ones; manual releases
// and arrivals are best effort and never fail the run.

const fs = require('fs');
const path = require('path');
const {
  fetchHorrorReleases, createContext, resolveSettings, escapeCommand, compareReleases, describeRemoved,
} = require('./tmdb');
const { assignCalendars, matchPlatform } = require('./platforms');
const { generateCalendars } = require('./calendar');
const { loadManualEntries, buildManualReleases } = require('./manual');
const { computeArrivals, emptySnapshot, SNAPSHOT_FILE } = require('./arrivals');

const ROOT_DIR = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(ROOT_DIR, 'output');
const SCHEMA_VERSION = 2;
const TYPE_EMOJI = { theatrical: '🎬', digital: '📺', arrival: '🆕' };

/**
 * Builds the releases.json document (§4).
 * @returns {object}
 */
function buildReleasesDocument({ now, region, window, arrivalWindow, calendars, releases }) {
  return {
    schema: SCHEMA_VERSION,
    generated: now.toISOString(),
    region,
    window,
    arrivalWindow,
    calendars: calendars.map(({ slug, file, name, kind, count }) => ({ slug, file, name, kind, count })),
    releases,
  };
}

const errorMessage = (err) => String(err?.message || err);

/**
 * Runs the whole pipeline. Returns the exit code instead of exiting, for tests.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - fetch implementation (TMDB and SNAPSHOT_URL)
 * @param {Date} [options.now] - Build time and start of the window
 * @param {object} [options.env] - Environment variables
 * @param {string} [options.outDir] - Output directory
 * @param {string} [options.rootDir] - Base of a relative MANUAL_RELEASES_FILE
 * @param {Function} [options.sleep] - Delay between retries
 * @param {Function} [options.log] - Standard output (also ::warning:: annotations)
 * @param {Function} [options.error] - Error output
 * @returns {Promise<number>}
 */
async function main({
  fetchImpl = globalThis.fetch,
  now = new Date(),
  env = process.env,
  outDir = OUTPUT_DIR,
  rootDir = ROOT_DIR,
  sleep,
  log = console.log,
  error = console.error,
} = {}) {
  const apiKey = String(env?.TMDB_API_KEY ?? '').trim();
  const redact = (text) => (apiKey ? String(text).split(apiKey).join('***') : String(text));
  const out = (text) => log(redact(text));
  const warn = (message) => out(`::warning::${escapeCommand(message)}`);

  try {
    log('🎬 Horror Calendar — Spanish horror releases\n');
    const settings = resolveSettings(env ?? {}, now, warn);
    const context = createContext({ fetchImpl, settings, sleep, log: out });

    log('Querying TMDB...');
    const { releases: tmdbReleases, region, window, removed: tmdbRemoved } = await fetchHorrorReleases({
      fetchImpl, now, env, sleep, log: out, warn, settings, context,
    });

    // Manual releases (§10): best effort
    log('\nManual releases...');
    let manualEntries = [];
    let manual = { releases: [], removed: [], curatedPlatforms: new Map() };
    try {
      manualEntries = loadManualEntries(path.resolve(rootDir, settings.manualFile), { log: out, warn });
      manual = await buildManualReleases({ entries: manualEntries, window, tmdbReleases, context, log: out, warn });
    } catch (err) {
      warn(`Manual releases failed (${errorMessage(err)}); none this build.`);
    }

    const releases = [
      ...tmdbReleases.map((r) => assignCalendars(r, { platforms: manual.curatedPlatforms.get(r.id) })),
      ...manual.releases,
    ];

    // Platform arrivals (§11): best effort, the snapshot is always written
    log('\nPlatform arrivals...');
    let arrivals;
    try {
      arrivals = await computeArrivals({
        context,
        fetchImpl,
        now,
        digitalReleases: releases.filter((r) => r.type === 'digital'),
        manualEntries,
        log: out,
        warn,
      });
    } catch (err) {
      warn(`Platform arrivals failed (${errorMessage(err)}); none this build, empty snapshot written.`);
      arrivals = {
        releases: [],
        removed: [],
        snapshot: emptySnapshot({ now, region, maxAgeYears: settings.arrivalMaxAgeYears }),
      };
    }
    releases.push(...arrivals.releases);
    releases.sort(compareReleases);

    // One line per movie and type: a TMDB release removed by the rule may also come back
    // through its manual entry (same detail, same result)
    const removed = [];
    const removedKeys = new Set();
    for (const r of [...tmdbRemoved, ...manual.removed, ...arrivals.removed]) {
      const key = `${r.id}:${r.type}`;
      if (removedKeys.has(key)) continue;
      removedKeys.add(key);
      removed.push(r);
    }
    log(`\nRuntime rule (MIN_RUNTIME=${settings.minRuntime}): removed ${removed.length} release${removed.length === 1 ? '' : 's'}.`);
    for (const r of removed) out(`  - ${describeRemoved(r)}`);

    const calendars = generateCalendars(releases, { now });
    const doc = buildReleasesDocument({ now, region, window, arrivalWindow: settings.arrivalWindow, calendars, releases });

    out(`\n${releases.length} releases in ${region} from ${window.from} to ${window.to} `
      + `(arrivals since ${settings.arrivalWindow.from}):`);
    for (const r of releases) {
      out(`  ${TYPE_EMOJI[r.type] ?? '•'} ${r.releaseDate} ${r.type.padEnd(10)} ${r.title} → ${r.calendars.join(', ')}`);
    }

    fs.mkdirSync(outDir, { recursive: true });
    for (const calendar of calendars) {
      fs.writeFileSync(path.join(outDir, calendar.file), calendar.ics, 'utf-8');
    }
    fs.writeFileSync(path.join(outDir, 'releases.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
    fs.writeFileSync(path.join(outDir, SNAPSHOT_FILE), `${JSON.stringify(arrivals.snapshot, null, 2)}\n`, 'utf-8');

    log(`\nWrote ${calendars.length} calendars, releases.json and ${SNAPSHOT_FILE} to ${outDir}:`);
    for (const c of calendars) log(`  ${c.file.padEnd(26)} ${String(c.count).padStart(3)}  ${c.name}`);

    // Release notes that name no configured platform: the owner may need a new alias
    for (const r of releases) {
      if (r.releaseNote !== null && matchPlatform(r.releaseNote) === null) {
        warn(`Release note "${r.releaseNote}" of "${r.title}" (TMDB ${r.id}) matches no platform alias in src/platforms.js.`);
      }
    }

    log('\n✅ Done.');
    return 0;
  } catch (err) {
    error(`\n❌ Calendar generation failed: ${redact(errorMessage(err))}`);
    if (/TMDB_API_KEY/.test(String(err?.message))) error('   Copy .env.example to .env and set TMDB_API_KEY.');
    return 1;
  }
}

if (require.main === module) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = { main, buildReleasesDocument, OUTPUT_DIR, SCHEMA_VERSION };
