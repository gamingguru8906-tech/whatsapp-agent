// The brain's reading: only approved rules with visitor wording, every line traceable, nothing undefined.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brainReading } from '../read.js';
import { cleanWatch, WATCH_ATTRIBUTES } from '../watch.js';
import { RULES } from '../rules/index.js';

const LIMITS = /\b(cure[sd]?|curing|death|die[sd]?|dying|killer|fatal|criminal|prison|jail|murder|guarantee[ds]?|never fail)\b/i;
const NAMES = /\b(kove|cheiro|sudhir|bharambe|the author|the book)\b/i;

test('every approved rule has visitor wording, a source quote found in its book (or the owner approved it), and stays inside the limits', () => {
  const approved = RULES.filter(r => r.status === 'approved');
  assert.ok(approved.length > 500);
  for (const r of approved) {
    assert.ok(r.say && r.say.length > 10, r.id);
    // Quotes read from a page image (tables) cannot be found in the text layer; those were approved by the owner.
    assert.ok(r.source.quoteFound === true || /approved by the owner/.test(r.reason ?? ''), r.id);
    assert.ok(!LIMITS.test(r.say), `${r.id}: ${r.say}`);
    assert.ok(!NAMES.test(r.say), `${r.id}: ${r.say}`);
    assert.ok(r.when, r.id);
  }
});

test('worked example: 29 Oct 1988, Rahul Sharma', () => {
  const r = brainReading({ dob: { y: 1988, m: 10, d: 29 }, name: 'Rahul Sharma', year: 2026, today: new Date('2026-10-10') });
  assert.equal(r.numbers.psychic.value, 2);
  assert.equal(r.numbers.destiny.value, 2);
  assert.equal(r.numbers.master.value, 11);         // 1 (Oct) + 2 (29) + 8 (1988 -> 26 -> 8)
  assert.equal(r.facts.personalYear, 4);            // 29 + 10 + (2+0+2+6) = 49 -> 4
  assert.equal(r.name.total, 33);                   // RAHUL 17 + SHARMA 16
  assert.equal(r.name.withBirth, 'neutral');        // row 2 of the friend chart: 6 is neutral
  assert.deepEqual(r.loshu.missing, [3, 4, 5, 6, 7]);
  assert.ok(r.loshu.items.planes.some(i => i.id === 'CHALDEAN-PLANES-002')); // 3-5-7 all missing
  assert.equal(r.timing.find(t => t.id === 'CHALDEAN-PSYCHIC-016').period.label, 'Jun, Jul');
});

test('a period that wraps the year end is "now" in January', () => {
  const r = brainReading({ dob: { y: 1990, m: 5, d: 2 }, year: 2027, today: new Date('2027-01-15') });
  const t = r.timing.find(x => x.id === 'CHALDEAN-PSYCHIC-017');
  assert.equal(t.period.now, true);
});

test('watch: unknown details are dropped and never read', () => {
  const w = cleanWatch({ dialColour: 'blue', dialShape: 'triangle', datePosition: '3', hacker: 'x' });
  assert.deepEqual(w, { dialColour: 'blue' }); // triangle unknown; date position needs a date window
  const r = brainReading({ dob: { y: 1990, m: 5, d: 2 }, watch: w });
  assert.deepEqual(r.watch.groups.map(g => g.key), ['dialColour']);
});

test('3,000 random people and watches: deterministic, nothing undefined, every line approved', () => {
  let seed = 3;
  const rnd = k => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
  const ok = new Set(RULES.filter(r => r.status === 'approved' && r.say).map(r => r.id));
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  for (let i = 0; i < 3000; i++) {
    const dob = { y: 1940 + rnd(80), m: 1 + rnd(12), d: 1 + rnd(28) };
    const name = Array.from({ length: 2 }, () => Array.from({ length: 3 + rnd(6) }, () => letters[rnd(26)]).join('')).join(' ');
    const watch = {};
    for (const a of WATCH_ATTRIBUTES) {
      const keys = Object.keys(a.options);
      if (rnd(3)) watch[a.key] = a.multi ? [keys[rnd(keys.length)]] : keys[rnd(keys.length)];
    }
    const input = { dob, name, year: 2026, today: new Date('2026-10-10'), watch: cleanWatch(watch) };
    const a = brainReading(input), b = brainReading(input);
    const s = JSON.stringify(a);
    assert.equal(s, JSON.stringify(b));
    assert.ok(!/undefined|NaN/.test(s));
    for (const id of s.match(/"id":"(?:CHALDEAN|NAMENUM|NUMNAME|LOSHU|WATCH)-[^"]+"/g) || []) assert.ok(ok.has(id.slice(6, -1)), id);
  }
});

test('Lo Shu lines are grouped digit by digit, without repeating the digit in each line', () => {
  const r = brainReading({ dob: { y: 1988, m: 10, d: 29 }, name: 'Rahul Sharma', year: 2026, today: new Date('2026-10-10') });
  assert.deepEqual(r.loshu.byDigit.map(g => [g.digit, g.times]), [[1, 2], [2, 1], [8, 2], [9, 2]]);
  for (const g of r.loshu.byDigit) for (const i of g.items) assert.ok(!/^With \d/.test(i.short), i.short);
  assert.ok(r.loshu.byDigit[0].items.some(i => i.id === 'LOSHU-LS-F1-2'));
});
