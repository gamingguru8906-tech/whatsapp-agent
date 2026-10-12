// The 3D watch lives in both sites; the copies must stay identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const f of ['watch3d.js', 'Watch3D.jsx', 'watch3d-poster.webp', 'Brand.jsx', 'SiteNav.jsx', 'Mascot.jsx', 'Companion.jsx', 'HeroBackdrop.jsx']) {
  test(`${f} is the same in mobile-numerology and veshannastro-suite`, () => {
    const a = readFileSync(new URL(`../web/src/components/${f}`, import.meta.url));
    const b = readFileSync(new URL(`../../veshannastro-suite/web/src/components/${f}`, import.meta.url));
    assert.ok(a.equals(b), `${f} differs: copy mobile-numerology/web/src/components/${f} to veshannastro-suite`);
  });
}

test('motion.js is the same in mobile-numerology and veshannastro-suite', () => {
  const a = readFileSync(new URL('../web/src/motion.js', import.meta.url));
  const b = readFileSync(new URL('../../veshannastro-suite/web/src/motion.js', import.meta.url));
  assert.ok(a.equals(b), 'copy mobile-numerology/web/src/motion.js to veshannastro-suite');
});

for (const f of ['404.html', 'privacy.html', 'terms.html', 'favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'site.webmanifest', 'og-watch.jpg']) {
  test(`public/${f} is the same in both sites`, () => {
    const a = readFileSync(new URL(`../web/public/${f}`, import.meta.url));
    const b = readFileSync(new URL(`../../veshannastro-suite/web/public/${f}`, import.meta.url));
    assert.ok(a.equals(b), `copy mobile-numerology/web/public/${f} to veshannastro-suite`);
  });
}
