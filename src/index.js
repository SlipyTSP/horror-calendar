// Entry point: queries TMDB, assigns calendars and writes every .ics plus releases.json
// (docs/data-model.md §3 and §4). Exits non-zero on the conditions of §7 so that CI
// never publishes empty or partial calendars over good ones.

const fs = require('fs');
const path = require('path');
const { fetchHorrorReleases } = require('./tmdb');
const { assignCalendars, matchPlatform } = require('./platforms');
const { generateCalendars } = require('./calendar');

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const SCHEMA_VERSION = 1;
const TYPE_EMOJI = { theatrical: '🎬', digital: '📺' };

/**
 * Builds the releases.json document (§4).
 * @returns {object}
 */
function buildReleasesDocument({ now, region, window, calendars, releases }) {
  return {
    schema: SCHEMA_VERSION,
    generated: now.toISOString(),
    region,
    window,
    calendars: calendars.map(({ slug, file, name, kind, count }) => ({ slug, file, name, kind, count })),
    releases,
  };
}

/**
 * Runs the whole pipeline. Returns the exit code instead of exiting, for tests.
 * @param {object} [options]
 * @param {Function} [options.fetchImpl] - fetch implementation
 * @param {Date} [options.now] - Build time and start of the window
 * @param {object} [options.env] - Environment variables
 * @param {string} [options.outDir] - Output directory
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
  sleep,
  log = console.log,
  error = console.error,
} = {}) {
  const apiKey = String(env?.TMDB_API_KEY ?? '').trim();
  const redact = (text) => (apiKey ? String(text).split(apiKey).join('***') : String(text));

  try {
    log('🎬 Horror Calendar — Spanish horror releases\n');
    log('Querying TMDB...');
    const { releases: found, region, window } = await fetchHorrorReleases({ fetchImpl, now, env, sleep, log });
    const releases = found.map(assignCalendars);
    const calendars = generateCalendars(releases, { now });
    const doc = buildReleasesDocument({ now, region, window, calendars, releases });

    log(`\n${releases.length} releases in ${region} from ${window.from} to ${window.to}:`);
    for (const r of releases) {
      log(`  ${TYPE_EMOJI[r.type] ?? '•'} ${r.releaseDate} ${r.type.padEnd(10)} ${r.title} → ${r.calendars.join(', ')}`);
    }

    fs.mkdirSync(outDir, { recursive: true });
    for (const calendar of calendars) {
      fs.writeFileSync(path.join(outDir, calendar.file), calendar.ics, 'utf-8');
    }
    fs.writeFileSync(path.join(outDir, 'releases.json'), `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');

    log(`\nWrote ${calendars.length} calendars and releases.json to ${outDir}:`);
    for (const c of calendars) log(`  ${c.file.padEnd(26)} ${String(c.count).padStart(3)}  ${c.name}`);

    // Release notes that name no configured platform: the owner may need a new alias
    for (const r of releases) {
      if (r.releaseNote !== null && matchPlatform(r.releaseNote) === null) {
        log(`::warning::Release note "${r.releaseNote}" of "${r.title}" (TMDB ${r.id}) matches no platform alias `
          + 'in src/platforms.js.');
      }
    }

    log('\n✅ Done.');
    return 0;
  } catch (err) {
    error(`\n❌ Calendar generation failed: ${redact(err?.message || err)}`);
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

module.exports = { main, buildReleasesDocument, OUTPUT_DIR };
