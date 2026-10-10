// Wristwatch segment: the year-watch match, input checks, and random readings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchReading, yearMatch, watchSummary } from '../engine/watch.js';
import { rulebook } from '../engine/rulebook.js';
import attrs from '../../brain/data/watch-attributes.json' with { type: 'json' };

const base = { name: 'Rahul Sharma', mobile: '9811045672', dob: '1988-10-29', year: 2026 };

test('the watch named for each personal year (T03) is matched exactly', () => {
  assert.equal(yearMatch({ caseMetal: 'steel', dialColour: 'blue' }, 4), 'full');
  assert.equal(yearMatch({ caseMetal: 'gold', dialColour: 'blue' }, 4), 'partly');
  assert.equal(yearMatch({ caseMetal: 'gold', dialColour: 'black' }, 4), 'different');
  assert.equal(yearMatch({ dialColour: 'blue' }, 4), 'unknown');           // metal not given: never guessed
  assert.equal(yearMatch({ caseMetal: 'gold' }, 1), 'full');
  assert.equal(yearMatch({ caseMetal: 'twoTone', dialColour: 'black' }, 6), 'full'); // "or silver-and-gold"
  assert.equal(yearMatch({ caseMetal: 'plastic', dialColour: 'green' }, 5), 'partly'); // not a metal watch
  assert.equal(yearMatch({ caseMetal: 'gold', dialColour: 'gold' }, 9), 'full');
});

test('the worked example: personal year 4 in 2026, 5 in 2027', () => {
  const r = watchReading(rulebook, { ...base, watch: { dialColour: 'blue', dialShape: 'round', caseMetal: 'steel' } });
  assert.ok(r.ok);
  const yw = r.sections.find(s => s.id === 'year-watch').items;
  assert.deepEqual(yw.map(y => [y.year, y.personalYear, y.match]), [[2026, 4, 'full'], [2027, 5, 'partly']]);
  assert.equal(r.sections.find(s => s.id === 'bracelet').bracelet.name, 'White Moonstone Bracelet');
  assert.match(watchSummary(r), /Watch named for 2026 \(personal year 4\): A steel watch with a blue dial/);
});

test('bad input is refused; unknown watch values are ignored', () => {
  assert.equal(watchReading(rulebook, { ...base, watch: {} }).ok, false);
  assert.equal(watchReading(rulebook, { ...base, mobile: '123', watch: { dialColour: 'blue', dialShape: 'round' } }).errors.mobile !== undefined, true);
  const r = watchReading(rulebook, { ...base, watch: { dialColour: 'blue', dialShape: 'round', strapMaterial: 'diamonds!' } });
  assert.equal(r.input.watch.strapMaterial, undefined);
});

test('2,000 random watches: no errors, nothing undefined, counts add up', () => {
  let seed = 9;
  const rnd = k => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  for (let i = 0; i < 2000; i++) {
    const watch = {};
    for (const a of attrs.attributes) { const ks = Object.keys(a.options); if (rnd(2) || ['dialColour', 'dialShape'].includes(a.key)) watch[a.key] = a.multi ? [ks[rnd(ks.length)]] : ks[rnd(ks.length)]; }
    const dob = `${1950 + rnd(60)}-${String(1 + rnd(12)).padStart(2, '0')}-${String(1 + rnd(28)).padStart(2, '0')}`;
    const r = watchReading(rulebook, { ...base, dob, watch });
    assert.ok(r.ok, JSON.stringify(r.errors));
    const s = JSON.stringify(r);
    assert.ok(!/undefined|NaN/.test(s));
    const a = r.sections[0];
    assert.ok(a.strengths + a.care + a.mixed <= a.total);
    assert.ok(watchSummary(r).length <= 3800);
  }
});
