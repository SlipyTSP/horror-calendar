// Deterministic mapping between a TMDB request and its fixture file name.
// Shared by tests/support/mock-fetch.js and scripts/capture-fixtures.js so that
// captured fixtures are found by the mock without any manual renaming.

const API_VERSION_PREFIX = /^\/3(?=\/)/;

/**
 * Builds the canonical key of a request: path without the API version prefix and
 * the query string without `api_key`, with parameters sorted by name.
 * Example: "/discover/movie?language=es-ES&page=1".
 * @param {string|URL} input - Absolute URL, or a key that is already canonical
 * @returns {string}
 */
function requestKey(input) {
  const url = new URL(String(input), 'https://api.themoviedb.org');
  url.searchParams.delete('api_key');
  const params = [...url.searchParams.entries()]
    .sort(([a, va], [b, vb]) => (a === b ? cmp(va, vb) : cmp(a, b)));
  const path = url.pathname.replace(API_VERSION_PREFIX, '') || '/';
  if (params.length === 0) return path;
  const query = params
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${path}?${query}`;
}

function cmp(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * File name for a request: path segments joined with "_", then "__" and the
 * sorted parameters as "name=value" joined with ",". Characters outside
 * [A-Za-z0-9._=,-] become "~XX" (hex), so names are safe on Linux, macOS and
 * Windows file systems (WSL on /mnt/c included).
 * Example: "discover_movie__language=es-ES,page=1,with_release_type=3~7C2.json".
 * @param {string|URL} input - Absolute URL or request key
 * @returns {string}
 */
function fixtureName(input) {
  const url = new URL(requestKey(input), 'https://api.themoviedb.org');
  const pathPart = url.pathname.split('/').filter(Boolean).map(safe).join('_') || 'root';
  const params = [...url.searchParams.entries()].map(([k, v]) => `${safe(k)}=${safe(v)}`);
  const name = params.length > 0 ? `${pathPart}__${params.join(',')}` : pathPart;
  return `${name}.json`;
}

function safe(text) {
  return Array.from(String(text), (ch) => {
    if (/[A-Za-z0-9._-]/.test(ch)) return ch;
    return Array.from(Buffer.from(ch, 'utf-8'), (b) => `~${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
  }).join('');
}

module.exports = { requestKey, fixtureName };
