// Sign in with WhatsApp and "My readings", against a real Postgres (TEST_DATABASE_URL).
// Kamala's side is simulated with the same SQL her verifyLogin runs (whatsapp-agent: numerology-leads.js).
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { handleReading, handleAccount } from '../worker/index.js';
import { watchFromConcern, tenDigits } from '../worker/account.js';

const DB = process.env.TEST_DATABASE_URL;
const skip = DB ? false : 'set TEST_DATABASE_URL to run the database tests';
let client;
const run = (text, params) => client.query(text, params).then(r => r.rows);
const env = { WHATSAPP_NUMBER: '917646952745' };
const call = (method, path, { token, body } = {}) => handleAccount(
  new Request(`https://site.test${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined }),
  env, new URL(`https://site.test${path}`), { run, year: 2026 }).then(async r => ({ status: r.status, ...(await r.json()) }));

// Kamala's verifyLogin, word for word.
const KAMALA_VERIFY = `UPDATE numerology_logins SET verified_at = now(), phone = $2
  WHERE code = $1 AND verified_at IS NULL AND created_at > now() - interval '15 minutes' RETURNING id`;
const kamalaReceives = (from, code) => run(KAMALA_VERIFY, [code, from]);

const save = body => handleReading(new Request('https://site.test/api/x', { method: 'POST', body: JSON.stringify({ consent: true, ...body }) }), {}, undefined,
  { run, year: 2026, ...(body.watch ? { segment: 'watch' } : {}) });

before(async () => { if (DB) { client = new pg.Client({ connectionString: DB }); await client.connect(); } });
beforeEach(async () => { if (DB) { await client.query('DROP TABLE IF EXISTS numerology_leads'); await client.query('DROP TABLE IF EXISTS numerology_logins'); } });
after(async () => { if (client) await client.end(); });

test('sign in: code, Kamala marks it sent from the number, the page is signed in; logout ends it', { skip }, async () => {
  const start = await call('POST', '/api/login');
  assert.match(start.code, /^\d{6}$/);
  assert.equal(start.whatsappNumber, '917646952745');
  assert.equal((await call('GET', '/api/login', { token: start.token })).state, 'waiting');
  assert.equal((await call('GET', '/api/my-readings', { token: start.token })).status, 401);
  assert.equal((await kamalaReceives('919811045672', '000000')).length, 0);   // wrong code: nothing happens
  assert.equal((await kamalaReceives('919811045672', start.code)).length, 1);
  assert.equal((await kamalaReceives('919999999999', start.code)).length, 0); // a used code cannot be used again
  const st = await call('GET', '/api/login', { token: start.token });
  assert.deepEqual([st.state, st.phone], ['signed-in', '9811045672']);
  const [row] = await run('SELECT token_hash FROM numerology_logins');
  assert.notEqual(row.token_hash, start.token); // only the hash is stored
  await call('DELETE', '/api/login', { token: start.token });
  assert.equal((await call('GET', '/api/login', { token: start.token })).state, 'expired');
});

test('an old code cannot be used; an unknown token is expired', { skip }, async () => {
  const start = await call('POST', '/api/login');
  await run("UPDATE numerology_logins SET created_at = now() - interval '16 minutes'");
  assert.equal((await kamalaReceives('919811045672', start.code)).length, 0);
  assert.equal((await call('GET', '/api/login', { token: start.token })).state, 'expired');
  assert.equal((await call('GET', '/api/login', { token: 'nope' })).state, 'expired');
});

test('My readings: only readings for the signed-in number, and each opens again (mobile and watch)', { skip }, async () => {
  await save({ name: 'Rahul Sharma', mobile: '9811045672', dob: '1988-10-29', concern: 'Paisa nahi tikta', planned: [] });
  await save({ name: 'Rahul Sharma', mobile: '9811045672', dob: '1988-10-29', watch: { dialColour: 'blue', dialShape: 'round', caseMetal: 'gold' } });
  await save({ name: 'Someone Else', mobile: '9876543210', dob: '1990-01-01', concern: 'career', planned: [] });
  await new Promise(r => setTimeout(r, 50));
  const start = await call('POST', '/api/login');
  await kamalaReceives('919811045672', start.code);
  const list = await call('GET', '/api/my-readings', { token: start.token });
  assert.equal(list.readings.length, 2);
  assert.deepEqual(list.readings.map(r => r.segment).sort(), ['mobile', 'watch']);
  assert.ok(list.readings.every(r => /^NM-[0-9a-f]{8}$/.test(r.id) && r.name === 'Rahul Sharma'));
  for (const r of list.readings) {
    const open = await call('POST', '/api/my-readings/open', { token: start.token, body: { id: r.id } });
    assert.equal(open.ok, true, JSON.stringify(open));
    assert.equal(open.segment, r.segment);
    assert.ok(open.sections.some(s => s.id === 'brain'));
    if (r.segment === 'watch') assert.equal(open.input.watch.caseMetal, 'gold');
    assert.ok(!JSON.stringify(open).includes('"source"'));
  }
  // Someone else's reading ID does not open
  const [other] = await run("SELECT dedupe_key FROM numerology_leads WHERE mobile = '9876543210'");
  assert.equal((await call('POST', '/api/my-readings/open', { token: start.token, body: { id: `NM-${other.dedupe_key.slice(0, 8)}` } })).status, 404);
});

test('helpers: WhatsApp number to 10 digits; watch details from an older lead', () => {
  assert.equal(tenDigits('919811045672'), '9811045672');
  assert.equal(tenDigits('14155550100'), null);
  assert.deepEqual(watchFromConcern('Wristwatch: dialColour=blue, goal=men+women'), { dialColour: 'blue', goal: ['men', 'women'] });
  assert.equal(watchFromConcern('career'), null);
});
