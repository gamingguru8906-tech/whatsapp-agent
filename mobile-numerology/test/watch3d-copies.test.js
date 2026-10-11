// The 3D watch lives in both sites; the copies must stay identical.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const f of ['watch3d.js', 'Watch3D.jsx', 'watch3d-poster.webp']) {
  test(`${f} is the same in mobile-numerology and veshannastro-suite`, () => {
    const a = readFileSync(new URL(`../web/src/components/${f}`, import.meta.url));
    const b = readFileSync(new URL(`../../veshannastro-suite/web/src/components/${f}`, import.meta.url));
    assert.ok(a.equals(b), `${f} differs: copy mobile-numerology/web/src/components/${f} to veshannastro-suite`);
  });
}
