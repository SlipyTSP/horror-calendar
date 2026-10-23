// Mock fetch over the captured fixtures (tests/fixtures/tmdb/) plus the hand-written
// ones in tests/fixtures/tmdb/synthetic/. mock-fetch.js reads a single directory, so
// both folders are merged into one temporary directory (once per process). A file name
// present in both folders is an error: synthetic fixtures add data, never replace it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockFetch, DEFAULT_FIXTURES_DIR } = require('./mock-fetch');

const SYNTHETIC_DIR = path.join(DEFAULT_FIXTURES_DIR, 'synthetic');

let mergedDir = null;

function jsonFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json') && e.name !== 'manifest.json')
    .map((e) => e.name);
}

/** Returns the merged fixtures directory, creating it on first use. */
function mergedFixturesDir() {
  if (mergedDir) return mergedDir;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmdb-fixtures-'));
  const captured = new Set(jsonFiles(DEFAULT_FIXTURES_DIR));
  for (const name of captured) fs.copyFileSync(path.join(DEFAULT_FIXTURES_DIR, name), path.join(dir, name));
  for (const name of jsonFiles(SYNTHETIC_DIR)) {
    if (captured.has(name)) {
      throw new Error(`fixture-fetch: synthetic/${name} collides with a captured fixture; `
        + 'the capture now covers it, so delete the synthetic copy and update the tests that used it');
    }
    fs.copyFileSync(path.join(SYNTHETIC_DIR, name), path.join(dir, name));
  }
  mergedDir = dir;
  return dir;
}

/**
 * createMockFetch over captured + synthetic fixtures.
 * @param {object} [options] - Same options as createMockFetch except fixturesDir
 */
function createFixtureFetch(options = {}) {
  return createMockFetch({ ...options, fixturesDir: mergedFixturesDir() });
}

/** Reads a fixture body (captured or synthetic) as parsed JSON. */
function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(mergedFixturesDir(), name), 'utf-8'));
}

module.exports = { createFixtureFetch, readFixture, mergedFixturesDir, SYNTHETIC_DIR };
