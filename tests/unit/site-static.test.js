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
