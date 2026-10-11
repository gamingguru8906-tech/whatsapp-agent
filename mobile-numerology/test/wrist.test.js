// "Which watch should I wear this year?": the answer, the wrist photo, the answers after the reading, the funnel.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { rulebook } from '../engine/rulebook.js';
import { wristRecommendation, parseWristReply, yearWatchChoice, wristSummary } from '../engine/wrist.js';
import { YEAR_WATCH } from '../engine/watch.js';
import { personalYear, parseDob } from '../engine/core.js';
import { handleReading, handleAnswer, handleEvent, handleStats, handlePhoto } from '../worker/index.js';
import { flushAnswers } from '../worker/store.js';

const person = over => ({ name: 'Rahul Sharma', mobile: '9811045672', dob: '1988-10-29', wrist: { size: 'slim', undertone: 'warm', style: 'casual' }, year: 2026, ...over });

test('the answer follows the personal year: 29 Oct 1988 in 2026 is year 4, a steel watch with a blue dial', () => {
  const r = wristRecommendation(rulebook, person());
  const a = r.sections.find(s => s.id === 'wrist-answer');
  assert.equal(a.personalYear, 4);
  assert.equal(a.answer, 'A steel watch with a blue dial, 38 to 40 mm across, on brown leather.');
  assert.equal(a.why[0].id, 'PY4-T03-f');
  assert.equal(r.sections.find(s => s.id === 'next-year').personalYear, 5);
});

test('every personal year gives a metal that its rule names, for every undertone', () => {
  for (let py = 1; py <= 9; py++) for (const undertone of ['warm', 'cool', 'neutral', undefined]) {
    const c = yearWatchChoice(py, { undertone });
    const allowed = YEAR_WATCH[py].parts.find(p => p.caseMetal).caseMetal.concat(YEAR_WATCH[py].or ? ['twoTone'] : []);
    assert.ok(allowed.includes(c.metal), `PY${py} ${undertone}: ${c.metal}`);
    assert.notEqual(c.metal, 'black');
  }
  // Where the year allows a choice, the undertone picks
  assert.equal(yearWatchChoice(3, { undertone: 'warm' }).metal, 'gold');
  assert.equal(yearWatchChoice(3, { undertone: 'cool' }).metal, 'twoTone');
  assert.equal(yearWatchChoice(7, { undertone: 'cool' }).metal, 'silver');
  // Where it does not, the year decides whatever the undertone
  assert.equal(yearWatchChoice(2, { undertone: 'warm' }).metal, 'silver');
  assert.equal(yearWatchChoice(9, { undertone: 'cool' }).metal, 'gold');
});

test('year 7 says white gold, not plain silver; metal-watch years get a metal bracelet', () => {
  // 1 Jan 1990 in 2026: 1 + 1 + 2026 -> 1+1+2+0+2+6 = 12 -> 3. Find a date with personal year 7 instead.
  const dob = ['1990-01-05', '1990-02-04', '1990-03-03'].find(d => personalYear(parseDob(d).value, 2026) === 7);
  const r = wristRecommendation(rulebook, person({ dob, wrist: { size: 'medium', undertone: 'cool', style: 'formal' } }));
  const a = r.sections[0];
  assert.match(a.answer, /^A white-gold or silver-toned watch, 40 to 42 mm across, on a solid metal bracelet\.$/);
});

test('no photo details: still a clear answer from the year alone, without a size', () => {
  const r = wristRecommendation(rulebook, person({ wrist: {} }));
  assert.equal(r.sections[0].answer, 'A steel watch with a blue dial, on brown or black leather.');
  assert.ok(!r.sections[0].why.some(w => w.id === 'WATCH-DS-4'));
  assert.match(wristSummary(r), /Wrist: not given/);
});

test('"Does this sound like you?" uses the birth number\'s own lines, never a care point', () => {
  const r = wristRecommendation(rulebook, person());
  const p = r.sections.find(s => s.id === 'profile');
  assert.equal(p.birthNumber, 2);
  assert.ok(p.items.length >= 1 && p.items.length <= 2);
  assert.ok(p.items.every(i => i.polarity !== 'care' && i.say.length > 20));
});

test('wrist photo: only known choices; not a wrist; unsure left out', () => {
  assert.deepEqual(parseWristReply({ isWrist: true, size: 'slim', undertone: 'unsure', style: 'party' }), { ok: true, wrist: { size: 'slim' }, filled: ['size'] });
  assert.equal(parseWristReply({ isWrist: false }).error, 'not-a-wrist');
  assert.equal(parseWristReply('no').error, 'unreadable');
});

test('/api/wrist-photo answers with the wrist details', async () => {
  const jpg = 'data:image/jpeg;base64,' + Buffer.from('x').toString('base64');
  const ai = { run: async (model, input) => {
    assert.match(input.messages[0].content, /undertone/);
    return { response: { isWrist: true, size: 'broad', undertone: 'cool', style: 'formal' } };
  } };
  const res = await handlePhoto(new Request('https://x/api/wrist-photo', { method: 'POST', body: JSON.stringify({ image: jpg }) }), {}, { ai, kind: 'wrist' });
  assert.deepEqual((await res.json()).wrist, { size: 'broad', undertone: 'cool', style: 'formal' });
});

// ---------- With the database ----------
const DB = process.env.TEST_DATABASE_URL;
const skip = DB ? false : 'set TEST_DATABASE_URL to run the database tests';
let client;
const run = (text, params) => client.query(text, params).then(r => r.rows);
const env = { SHEET_WEBAPP_URL: 'https://script.test/exec', SHEET_SECRET: 'sheet-secret', OWNER_KEY: 'owner-key' };

// Behaves like apps-script/numerology-leads.gs: appends new keys, and fills answers on an existing row for op "update".
function fakeSheet() {
  const rows = new Map();
  const sheet = { rows, calls: 0 };
  sheet.fetch = async (url, init) => {
    sheet.calls++;
    const body = JSON.parse(init.body);
    const results = {};
    for (const r of body.rows) {
      if (r.op === 'update') { if (rows.has(r.key)) { Object.assign(rows.get(r.key), r); results[r.key] = 'updated'; } else results[r.key] = 'missing'; }
      else if (rows.has(r.key)) results[r.key] = 'exists';
      else { rows.set(r.key, { ...r }); results[r.key] = 'added'; }
    }
    return new Response(JSON.stringify({ ok: true, results }));
  };
  return sheet;
}
let sheet;
const deps = () => ({ run, fetchImpl: sheet.fetch, sleep: async () => {}, year: 2026 });
const req = (path, body) => new Request(`https://site.test${path}`, { method: 'POST', body: JSON.stringify(body) });

before(async () => { if (DB) { client = new pg.Client({ connectionString: DB }); await client.connect(); } });
beforeEach(async () => {
  sheet = fakeSheet();
  if (DB) for (const t of ['numerology_leads', 'numerology_events', 'numerology_logins']) await client.query(`DROP TABLE IF EXISTS ${t}`);
});
after(async () => { if (client) await client.end(); });

test('the full flow: lead saved and in the Sheet, then "sounds like you" and the opt-in reach the same row with times', { skip }, async () => {
  const res = await handleReading(req('/api/wrist', { name: 'Rahul Sharma', mobile: '9811045672', dob: '1988-10-29', consent: true,
    wrist: { size: 'slim', undertone: 'warm', style: 'casual' } }), env, undefined, { ...deps(), segment: 'wrist' });
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.match(body.leadKey, /^[0-9a-f]{64}$/);
  assert.equal(body.leadRef, `NM-${body.leadKey.slice(0, 8)}`);
  const [lead] = await run('SELECT concern, wa_opt_in, inputs, sheet_synced FROM numerology_leads');
  assert.equal(lead.concern, 'Watch for the year: size=slim, undertone=warm, style=casual');
  assert.equal(lead.wa_opt_in, false); // asked at the end, not in the form
  assert.deepEqual(lead.inputs, { segment: 'wrist', wrist: { size: 'slim', undertone: 'warm', style: 'casual' } });
  assert.equal(lead.sheet_synced, true);
  assert.equal(sheet.rows.get(body.leadKey).mobile, '9811045672');

  assert.equal((await handleAnswer(req('/api/answer', { key: body.leadKey, feedback: 'partly' }), env, undefined, deps())).status, 200);
  assert.equal((await handleAnswer(req('/api/answer', { key: body.leadKey, optIn: true }), env, undefined, deps())).status, 200);
  const row = sheet.rows.get(body.leadKey);
  assert.equal(row.soundsLikeYou, 'Partly');
  assert.equal(row.waOptIn, 'Yes');
  assert.match(row.optInAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(row.answeredAt, /^\d{4}-\d{2}-\d{2} /);
  const [after] = await run('SELECT feedback, wa_opt_in, opt_in_at, sheet_update_pending FROM numerology_leads');
  assert.deepEqual([after.feedback, after.wa_opt_in, after.opt_in_at !== null, after.sheet_update_pending], ['partly', true, true, false]);

  // An unknown key or a bad answer changes nothing
  assert.equal((await handleAnswer(req('/api/answer', { key: 'f'.repeat(64), feedback: 'yes' }), env, undefined, deps())).status, 404);
  assert.equal((await handleAnswer(req('/api/answer', { key: 'nope', feedback: 'yes' }), env, undefined, deps())).status, 400);
});

test('an answer for a lead the Sheet does not have yet waits, and the catch-up sends it', { skip }, async () => {
  const res = await handleReading(req('/api/wrist', { name: 'Meera Iyer', mobile: '9822012345', dob: '1995-03-07', consent: true, wrist: {} }),
    {}, undefined, { ...deps(), segment: 'wrist' }); // no Sheet configured: the lead stays unsynced
  const { leadKey } = await res.json();
  await handleAnswer(req('/api/answer', { key: leadKey, optIn: false }), {}, undefined, deps());
  assert.equal((await run('SELECT sheet_update_pending FROM numerology_leads'))[0].sheet_update_pending, true);
  sheet.rows.set(leadKey, { key: leadKey });
  await run('UPDATE numerology_leads SET sheet_synced = true');
  assert.deepEqual(await flushAnswers(env, deps()), { answers: 1 });
  assert.equal(sheet.rows.get(leadKey).waOptIn, 'No');
});

test('funnel: events per step, answers per page; bad events are ignored; owner key needed', { skip }, async () => {
  const sid = 'abcdef1234567890';
  for (const event of ['view', 'photo_added', 'photo_read', 'form_sent', 'result_shown', 'feedback', 'opt_in']) {
    assert.equal((await handleEvent(req('/api/event', { sid, page: 'wrist', event }), env, undefined, { run })).status, 204);
  }
  await handleEvent(req('/api/event', { sid: 'zzzzzzzzzzzz9', page: 'wrist', event: 'view' }), env, undefined, { run });
  await handleEvent(req('/api/event', { sid, page: 'wrist', event: 'hack' }), env, undefined, { run });
  await handleEvent(req('/api/event', { sid: 'x', page: 'wrist', event: 'view' }), env, undefined, { run });
  const res = await handleReading(req('/api/wrist', { name: 'Rahul Sharma', mobile: '9811045672', dob: '1988-10-29', consent: true, wrist: {} }), env, undefined, { ...deps(), segment: 'wrist' });
  await handleAnswer(req('/api/answer', { key: (await res.json()).leadKey, feedback: 'yes', optIn: true }), env, undefined, deps());

  assert.equal((await handleStats(new URL('https://x/api/stats'), env, { run })).status, 404);
  const s = await (await handleStats(new URL('https://x/api/stats?key=owner-key'), env, { run })).json();
  assert.equal(s.pages.wrist.steps.view, 2);
  assert.equal(s.pages.wrist.steps.photo_read, 1);
  assert.equal(s.pages.wrist.leads, 1);
  assert.deepEqual(s.pages.wrist.feedback, { yes: 1, partly: 0, no: 0 });
  assert.equal(s.pages.wrist.optedIn, 1);
  assert.equal((await run('SELECT count(*)::int AS n FROM numerology_events'))[0].n, 8);
  assert.ok(!JSON.stringify(s).includes('9811045672'));
});
