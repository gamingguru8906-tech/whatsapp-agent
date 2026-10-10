// Every expected value below is printed in a source (page given), so these tests check the brain against the books.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as c from '../calc.js';
import relations from '../data/relations.json' with { type: 'json' };

const dob = iso => c.parseDob(iso).value;

test('name totals match the books\' worked examples (Chaldean)', () => {
  const t = c.nameNumbers('THOMAS R. VINCENT'); // B-NAMENUM p. 2: 24 + 2 + 29 = 55
  assert.deepEqual(t.parts.map(p => p.total), [24, 2, 29]);
  assert.equal(t.total, 55);
  assert.equal(t.root, 1);
  assert.equal(c.nameNumbers('Singh').total, 17);      // B-NAMENUM p. 101
  assert.equal(c.nameNumbers('Hitler').total, 20);     // B-NAMENUM p. 24
  assert.equal(c.nameNumbers('PQRLSTOX').total, 33);   // B-NAMENUM p. 110
  assert.equal(c.nameNumbers('CHAND').total, 18);      // B-NUMNAME p. 1
  assert.equal(c.nameNumbers('CHANDRA').total, 21);    // B-NUMNAME p. 1
});

test('every letter has a value, none is 9, titles are left out, punctuation ignored', () => {
  for (const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') assert.ok(c.letterValue(l) >= 1 && c.letterValue(l) <= 8, l);
  assert.equal(c.nameNumbers('Dr. Rahul Sharma').total, c.nameNumbers('Rahul Sharma').total);
  assert.equal(c.nameNumbers('  rahul   sharma ').total, c.nameNumbers('RAHUL SHARMA').total);
  assert.equal(c.nameNumbers('राम'), null);
  assert.equal(c.nameNumbers('Rahul Sharma').firstLetter, 'R');
});

test('birth, destiny, master destiny and personal year', () => {
  const d = dob('2001-09-18'); // T01: birth 9, destiny 3
  assert.equal(c.birthNumber(d), 9);
  assert.equal(c.destinyNumber(d), 3);
  assert.equal(c.masterDestiny(dob('1970-05-18')), 22); // B-CHALDEAN p. 50: 5 + 9 + 8 = 22
  assert.equal(c.masterDestiny(d), null);
  assert.equal(c.personalYear(d, 2025), c.reduce(18 + 9 + 9));
  assert.equal(c.karmicDebtDay(dob('1990-03-13')), 13);
  assert.equal(c.karmicDebtDay(dob('1990-03-12')), null);
});

test('Lo Shu: 12.07.1965 is missing 3, 4 and 8 and its Thought plane is empty (B-LOSHU pp. 4-5)', () => {
  const cnt = c.counts(c.dobDigits(dob('1965-07-12')));
  assert.deepEqual(c.missingDigits(cnt), [3, 4, 8]);
  assert.equal(cnt[1], 2);
  const planes = Object.fromEntries(c.loShuPlanes(cnt).map(p => [p.name, p.state]));
  assert.equal(planes.Thought, 'missing');
  assert.equal(planes.Will, 'full');
  assert.equal(c.loShuPlanes(cnt).length, 8);
});

test('the Lo Shu layout is a magic square and is not the Vedic grid', () => {
  const g = c.LOSHU_GRID;
  for (const row of g) assert.equal(row.reduce((s, n) => s + n, 0), 15);
  for (let i = 0; i < 3; i++) assert.equal(g[0][i] + g[1][i] + g[2][i], 15);
  assert.notDeepEqual(g, c.VEDIC_GRID);
});

test('the friend and enemy chart covers every pair exactly once (B-CHALDEAN p. 31)', () => {
  for (const [own, row] of Object.entries(relations.rows)) {
    const all = [...row.friend, ...row.neutral, ...row.enemy, ...row.mixed].sort();
    assert.deepEqual(all, [1, 2, 3, 4, 5, 6, 7, 8, 9], `row ${own}`);
  }
  assert.equal(c.relation(1, 8), 'enemy');
  assert.equal(c.relation(1, 4), 'neutral');
  assert.equal(c.relation(4, 1), 'friend'); // the chart is read by the person's own row
  assert.equal(c.relation(4, 8), 'mixed');
  assert.equal(c.relation(5, 9), 'neutral');
});

test('maturity and personality numbers', () => {
  assert.equal(c.maturityNumber(3, 1), 4);
  assert.equal(c.maturityNumber(9, 9), 9);
  const p = c.personalityNumber('THOMAS'); // consonants T H M S = 4 + 5 + 4 + 3 = 16 -> 7
  assert.equal(p, 7);
});
