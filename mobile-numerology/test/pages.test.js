// Each page has its own title, description and share picture; unknown addresses are not pages (they get the 404).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { PAGES, pageFor } from '../engine/pages.js';

test('addresses map to pages; anything else is not a page', () => {
  assert.equal(pageFor('/'), 'mobile');
  assert.equal(pageFor('/watch'), 'watch');
  assert.equal(pageFor('/watch/'), 'watch');
  assert.equal(pageFor('/watch/year'), 'wrist');
  assert.equal(pageFor('/my'), 'my');
  for (const p of ['/watch/nope', '/contact', '/watchyear', '/my/old']) assert.equal(pageFor(p), null, p);
});

test('every page has a distinct title and description of a sensible length, and its share picture exists', () => {
  const titles = new Set(), descs = new Set();
  for (const [k, p] of Object.entries(PAGES)) {
    assert.ok(p.title.length <= 65, `${k} title too long`);
    assert.ok(p.description.length >= 70 && p.description.length <= 160, `${k} description ${p.description.length} chars`);
    titles.add(p.title); descs.add(p.description);
    assert.ok(existsSync(new URL(`../web/public${p.image}`, import.meta.url)), `${k} share picture missing`);
  }
  assert.equal(titles.size, Object.keys(PAGES).length);
  assert.equal(descs.size, Object.keys(PAGES).length);
});
