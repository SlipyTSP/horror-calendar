const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createMockFetch, requestKey, fixtureName } = require('../support/mock-fetch');

const BASE = 'https://api.themoviedb.org/3';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mock-fetch-'));
}

test('requestKey drops api_key, the /3 prefix and sorts parameters', () => {
  const a = requestKey(`${BASE}/discover/movie?region=ES&api_key=secret&language=es-ES&page=1`);
  const b = requestKey(`${BASE}/discover/movie?page=1&language=es-ES&region=ES`);
  assert.equal(a, '/discover/movie?language=es-ES&page=1&region=ES');
  assert.equal(a, b);
  assert.equal(requestKey(`${BASE}/movie/42/watch/providers?api_key=x`), '/movie/42/watch/providers');
});

test('fixtureName is deterministic, readable and file-system safe', () => {
  const name = fixtureName(`${BASE}/discover/movie?with_release_type=3|2&api_key=secret&page=2`);
  assert.equal(name, 'discover_movie__page=2,with_release_type=3~7C2.json');
  assert.equal(fixtureName(`${BASE}/movie/42/watch/providers`), 'movie_42_watch_providers.json');
  assert.equal(fixtureName(`${BASE}/movie/42?language=en-US`), 'movie_42__language=en-US.json');
  assert.doesNotMatch(name, /secret|api_key|[|/\\:*?"<>]/);
});

test('serves a fixture file mapped from the URL, ignoring api_key', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'movie_7__language=en-US.json'), '{"id":7,"overview":"Hi"}');
  const mockFetch = createMockFetch({ fixturesDir: dir });

  const res = await mockFetch(`${BASE}/movie/7?api_key=whatever&language=en-US`);
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { id: 7, overview: 'Hi' });
});

test('records every call with its URL, key and init', async () => {
  const mockFetch = createMockFetch({
    fixturesDir: tmpDir(),
    routes: { '/configuration': { body: { ok: true } } },
  });
  await mockFetch(`${BASE}/configuration?api_key=k`, { method: 'GET' });
  await mockFetch(new URL(`${BASE}/configuration`));

  assert.equal(mockFetch.calls.length, 2);
  assert.equal(mockFetch.calls[0].url, `${BASE}/configuration?api_key=k`);
  assert.equal(mockFetch.calls[0].key, '/configuration');
  assert.deepEqual(mockFetch.calls[0].init, { method: 'GET' });
  assert.equal(mockFetch.calls[1].key, '/configuration');
});

test('queued responses are consumed in order before falling back to routes', async () => {
  const url = `${BASE}/discover/movie?page=1`;
  const mockFetch = createMockFetch({
    fixturesDir: tmpDir(),
    routes: { [url]: { body: { page: 1, results: [] } } },
  });
  mockFetch.enqueue(url, { status: 429, headers: { 'Retry-After': '2' }, body: { status_code: 25 } });

  const first = await mockFetch(`${url}&api_key=k`);
  assert.equal(first.status, 429);
  assert.equal(first.ok, false);
  assert.equal(first.headers.get('retry-after'), '2');

  const second = await mockFetch(url);
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { page: 1, results: [] });
});

test('queued responses can be the only mapping for a URL', async () => {
  const mockFetch = createMockFetch({ fixturesDir: tmpDir() });
  mockFetch.enqueue('/movie/1/watch/providers', { status: 503 }, { body: { id: 1, results: {} } });

  assert.equal((await mockFetch(`${BASE}/movie/1/watch/providers`)).status, 503);
  assert.equal((await mockFetch(`${BASE}/movie/1/watch/providers`)).status, 200);
  await assert.rejects(mockFetch(`${BASE}/movie/1/watch/providers`), /unmapped request/);
});

test('queued responses can point to fixture files', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'custom.json'), '{"page":3}');
  const mockFetch = createMockFetch({ fixturesDir: dir });
  mockFetch.enqueue('/discover/movie?page=3', { fixture: 'custom.json' });

  assert.deepEqual(await (await mockFetch(`${BASE}/discover/movie?page=3`)).json(), { page: 3 });
});

test('throws a clear error for an unmapped URL, naming the expected fixture', async () => {
  const mockFetch = createMockFetch({ fixturesDir: tmpDir() });
  await assert.rejects(
    mockFetch(`${BASE}/movie/99?api_key=secret&language=en-US`),
    (err) => {
      assert.match(err.message, /unmapped request \/movie\/99\?language=en-US/);
      assert.match(err.message, /movie_99__language=en-US\.json/);
      assert.doesNotMatch(err.message, /secret/);
      return true;
    },
  );
  assert.equal(mockFetch.calls.length, 1);
});
