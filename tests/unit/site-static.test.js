const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, '..', '..', 'site');

// Every text file under site/, recursively, with its path relative to site/.
function siteTextFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(html|css|js|svg|txt|json|webmanifest)$/.test(entry.name)) {
        out.push({ rel: path.relative(SITE, full), text: fs.readFileSync(full, 'utf8') });
      }
    }
  };
  walk(SITE);
  return out;
}

test('site/ never references Google Fonts', () => {
  for (const { rel, text } of siteTextFiles()) {
    assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/i.test(text), rel);
  }
});

test('Creepster is self-hosted with its licence and declared with @font-face', () => {
  const css = fs.readFileSync(path.join(SITE, 'styles.css'), 'utf8');
  assert.ok(!/@import/.test(css));
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(faces.length > 0);
  for (const face of faces) {
    assert.match(face, /font-display:\s*swap/);
    assert.match(face, /unicode-range:/);
    for (const [, url] of face.matchAll(/url\('([^']+)'\)/g)) {
      assert.ok(!/^[a-z]+:|^\//i.test(url), url);
      assert.ok(fs.existsSync(path.join(SITE, url)), url);
    }
  }
  assert.ok(fs.existsSync(path.join(SITE, 'fonts', 'OFL.txt')));
  assert.match(css, /body\s*\{[^}]*font-family:\s*system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;/);
});

// F3 exception to C2: the production host may appear only in the content of the
// og:* / twitter:* meta tags of index.html (crawlers need absolute URLs).
const HOST = /slipytsp\.github\.io/i;
const SOCIAL_META = /<meta\s+(?:property="og:[a-z:_]+"|name="twitter:[a-z:_]+")\s+content="[^"]*"\s*>/gi;

test('the production host appears only in og:/twitter: meta of index.html', () => {
  const files = siteTextFiles();
  assert.ok(files.some((f) => f.rel === 'selector.js') && files.some((f) => f.rel === 'styles.css'));
  for (const { rel, text } of files) {
    const rest = rel === 'index.html' ? text.replace(SOCIAL_META, '') : text;
    assert.ok(!HOST.test(rest), rel);
  }
});

test('the exception is not a loophole: links, scripts and other meta are still caught', () => {
  const strip = (html) => html.replace(SOCIAL_META, '');
  for (const html of [
    '<a href="https://slipytsp.github.io/horror-calendar/">x</a>',
    '<link rel="canonical" href="https://slipytsp.github.io/horror-calendar/">',
    '<meta name="description" content="https://slipytsp.github.io/">',
    '<meta property="og:url" content="x"><script>"slipytsp.github.io"</script>',
  ]) {
    assert.ok(HOST.test(strip(html)), html);
  }
  assert.ok(!HOST.test(strip('<meta property="og:url" content="https://slipytsp.github.io/horror-calendar/">')));
});

test('Open Graph and Twitter meta point at the published og-image', () => {
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  const meta = (attr, name) => {
    const m = new RegExp(`<meta\\s+${attr}="${name}"\\s+content="([^"]*)"`).exec(html);
    return m ? m[1] : null;
  };
  assert.equal(meta('property', 'og:type'), 'website');
  assert.equal(meta('property', 'og:locale'), 'es_ES');
  assert.equal(meta('property', 'og:url'), 'https://slipytsp.github.io/horror-calendar/');
  assert.equal(meta('property', 'og:image'), 'https://slipytsp.github.io/horror-calendar/assets/og-image.png');
  assert.equal(meta('property', 'og:image:width'), '1200');
  assert.equal(meta('property', 'og:image:height'), '630');
  for (const name of ['og:site_name', 'og:title', 'og:description', 'og:image:alt']) {
    assert.ok(meta('property', name), name);
  }
  assert.equal(meta('name', 'twitter:card'), 'summary_large_image');
  assert.equal(meta('name', 'twitter:image'), meta('property', 'og:image'));
  for (const name of ['twitter:title', 'twitter:description', 'description']) {
    assert.ok(meta('name', name), name);
  }
  assert.ok(fs.existsSync(path.join(SITE, 'assets', 'og-image.png')));
});

test('PNG assets have the expected sizes and the og-image stays under 300 KB', () => {
  const size = (file) => {
    const buf = fs.readFileSync(path.join(SITE, 'assets', file));
    assert.equal(buf.toString('latin1', 1, 4), 'PNG', file);
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), colorType: buf[25], bytes: buf.length };
  };
  const og = size('og-image.png');
  assert.deepEqual([og.w, og.h], [1200, 630]);
  assert.ok(og.bytes < 300 * 1024, String(og.bytes));
  const touch = size('apple-touch-icon.png');
  assert.deepEqual([touch.w, touch.h], [180, 180]);
  assert.ok(touch.colorType !== 4 && touch.colorType !== 6, 'apple-touch-icon has no alpha channel');
});

test('head links to the favicon and touch icon with relative URLs', () => {
  const html = fs.readFileSync(path.join(SITE, 'index.html'), 'utf8');
  assert.match(html, /<link rel="icon" href="assets\/favicon\.svg" type="image\/svg\+xml">/);
  assert.match(html, /<link rel="apple-touch-icon" href="assets\/apple-touch-icon\.png">/);
  assert.match(html, /<meta name="theme-color" content="#0a0a0a">/);
  for (const [, href] of html.matchAll(/<(?:link|script|img|a)\s[^>]*(?:href|src)="([^"]+)"/g)) {
    if (/^https:\/\/(www\.themoviedb\.org|github\.com|www\.justwatch\.com)\//.test(href)) continue; // footer credits
    assert.ok(!/^[a-z]+:|^\/\//i.test(href), href);
  }
});
