// Watch photo: the model's answer is only ever turned into the form's own choices, and the visitor checks them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePhotoReply, checkPhoto, photoSchema, PHOTO_KEYS } from '../engine/photo.js';
import { handlePhoto } from '../worker/index.js';

const jpg = 'data:image/jpeg;base64,' + Buffer.from('fake').toString('base64');
const req = body => new Request('https://x/api/watch-photo', { method: 'POST', body: JSON.stringify(body), headers: { 'cf-connecting-ip': '1.2.3.4' } });

test('keeps only known choices, drops "unsure", made-up values and brand text', () => {
  const r = parsePhotoReply(JSON.stringify({ isWatch: true, dialShape: 'round', dialColour: 'teal', caseMetal: 'unsure', markers: 'roman',
    dateWindow: 'none', datePosition: '3', dialArt: ['text', 'compass', 'dragon'] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.watch, { dialShape: 'round', markers: 'roman', dateWindow: 'none', dialArt: ['compass'] });
  assert.deepEqual(r.filled, ['dialShape', 'markers', 'dateWindow', 'dialArt']);
});

test('a smartwatch never gets hour marks; date position only with a window', () => {
  const r = parsePhotoReply({ isWatch: true, watchType: 'smart', hands: 'digital', markers: 'arabic', dateWindow: 'date', datePosition: '3' });
  assert.equal(r.watch.markers, undefined);
  assert.equal(r.watch.datePosition, '3');
});

test('not a watch, nothing seen, or unreadable', () => {
  assert.equal(parsePhotoReply({ isWatch: false }).error, 'not-a-watch');
  assert.equal(parsePhotoReply({ isWatch: true, dialShape: 'unsure' }).error, 'nothing-seen');
  assert.equal(parsePhotoReply('sorry').error, 'unreadable');
});

test('schema offers exactly the form choices plus "unsure"', () => {
  const s = photoSchema();
  for (const k of PHOTO_KEYS) assert.ok(s.properties[k], k);
  assert.ok(s.properties.dialColour.enum.includes('unsure'));
  assert.ok(!('wrist' in s.properties));
});

test('photo checks: type and size', () => {
  assert.equal(checkPhoto(jpg), null);
  assert.match(checkPhoto('data:image/gif;base64,AAAA'), /JPG, PNG or WebP/);
  assert.match(checkPhoto('data:image/jpeg;base64,' + 'A'.repeat(2_100_000)), /too large/);
});

test('/api/watch-photo returns the filled choices, and a helpful message when it cannot', async () => {
  const ai = { run: async () => ({ response: { isWatch: true, dialShape: 'square', dialColour: 'white', caseMetal: 'steel' } }) };
  const ok = await (await handlePhoto(req({ image: jpg }), {}, { ai })).json();
  assert.deepEqual(ok.watch, { dialShape: 'square', dialColour: 'white', caseMetal: 'steel' });
  const no = await handlePhoto(req({ image: jpg }), {}, { ai: { run: async () => ({ response: { isWatch: false } }) } });
  assert.equal(no.status, 422);
  assert.match((await no.json()).error, /could not find a watch/);
  const down = await handlePhoto(req({ image: jpg }), {}, { ai: { run: async () => { throw new Error('x'); } } });
  assert.equal(down.status, 503);
  const off = await handlePhoto(req({ image: jpg }), {});
  assert.equal(off.status, 503);
  const bad = await handlePhoto(req({ image: 'hello' }), {}, { ai });
  assert.equal(bad.status, 400);
});
