// Drop-in replacement for fetch used by the tests: no network, ever.
//
// A request is resolved, in this order, from:
//   1. responses queued for its key with mock.enqueue() (consumed first in, first out),
//   2. persistent routes passed to createMockFetch({ routes }),
//   3. a fixture file named fixtureName(url) inside fixturesDir.
// Anything else throws an error that names the key and the expected fixture file.
//
// The key of a request is its path without "/3" and its sorted query string without
// api_key (see tests/support/fixture-name.js), so tests never depend on the API key.
//
// A response spec is either { fixture: 'file.json' } (read from fixturesDir) or
// { status = 200, body, headers }, where an object body is serialised as JSON.

const fs = require('fs');
const path = require('path');
const { requestKey, fixtureName } = require('./fixture-name');

const DEFAULT_FIXTURES_DIR = path.join(__dirname, '..', 'fixtures', 'tmdb');

/**
 * @param {object} [options]
 * @param {string} [options.fixturesDir] - Directory with fixture files
 * @param {Object<string, object>} [options.routes] - Persistent responses by URL or key
 * @returns {Function & { calls: Array, enqueue: Function, keyFor: Function }}
 */
function createMockFetch({ fixturesDir = DEFAULT_FIXTURES_DIR, routes = {} } = {}) {
  const persistent = new Map();
  for (const [urlOrKey, spec] of Object.entries(routes)) {
    persistent.set(requestKey(urlOrKey), spec);
  }
  const queues = new Map();
  const calls = [];

  async function mockFetch(input, init = {}) {
    const url = typeof input === 'object' && input !== null && 'url' in input ? input.url : String(input);
    const key = requestKey(url);
    calls.push({ url, key, init });

    const queue = queues.get(key);
    if (queue && queue.length > 0) return toResponse(queue.shift(), fixturesDir);
    if (persistent.has(key)) return toResponse(persistent.get(key), fixturesDir);

    const file = fixtureName(key);
    if (fs.existsSync(path.join(fixturesDir, file))) {
      return toResponse({ fixture: file }, fixturesDir);
    }

    throw new Error(`mock-fetch: unmapped request ${key} (no queued response, no route, `
      + `no fixture file ${file} in ${fixturesDir})`);
  }

  /** Queues one-shot responses for a URL or key, e.g. a 429 followed by a 200. */
  mockFetch.enqueue = (urlOrKey, ...specs) => {
    const key = requestKey(urlOrKey);
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key).push(...specs);
    return mockFetch;
  };
  mockFetch.calls = calls;
  mockFetch.keyFor = requestKey;

  return mockFetch;
}

function toResponse(spec, fixturesDir) {
  if (spec && spec.fixture) {
    const body = fs.readFileSync(path.join(fixturesDir, spec.fixture), 'utf-8');
    return new Response(body, {
      status: spec.status ?? 200,
      headers: { 'content-type': 'application/json;charset=utf-8', ...spec.headers },
    });
  }
  const { status = 200, body = null, headers = {} } = spec || {};
  const text = body === null || typeof body === 'string' ? body : JSON.stringify(body);
  const contentType = typeof body === 'string' ? {} : { 'content-type': 'application/json;charset=utf-8' };
  // Response rejects a body on null-body statuses (204, 304)
  const allowsBody = ![204, 205, 304].includes(status);
  return new Response(allowsBody ? text : null, { status, headers: { ...contentType, ...headers } });
}

module.exports = { createMockFetch, requestKey, fixtureName, DEFAULT_FIXTURES_DIR };
