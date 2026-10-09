// Server tests against a real Postgres (set TEST_DATABASE_URL; skipped when it is not set) and a fake Sheet
// that behaves like apps-script/numerology-leads.gs: it refuses a key it already has.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import worker, { handleReading } from '../worker/index.js';
import { flushUnsynced, dedupeKey } from '../worker/store.js';

const DB = process.env.TEST_DATABASE_URL;
const skip = DB ? false : 'set TEST_DATABASE_URL to run the database tests';
let client;
const run = (text, params) => client.query(text, params).then(r => r.rows);

function fakeSheet() {
  const rows = new Map();
  const sheet = { rows, calls: 0, failNext: 0, loseNext: 0 };
  sheet.fetch = async (url, init) => {
    sheet.calls++;
    if (sheet.failNext > 0) { sheet.failNext--; throw new Error('network down'); }
    if (sheet.loseNext > 0) { sheet.loseNext--; return new Response(JSON.stringify({ ok: true, service: 'numerology-leads' })); }
    const body = JSON.parse(init.body);
    if (body.secret !== 'sheet-secret') return new Response(JSON.stringify({ ok: false, error: 'unauthorised' }));
    const results = {};
    for (const r of body.rows) { if (rows.has(r.key)) results[r.key] = 'exists'; else { rows.set(r.key, r); results[r.key] = 'added'; } }
    return new Response(JSON.stringify({ ok: true, results }));
  };
  return sheet;
}

const env = { SHEET_WEBAPP_URL: 'https://script.test/exec', SHEET_SECRET: 'sheet-secret', OWNER_KEY: 'owner-key' };
const form = over => ({ name: 'Rahul Sharma', mobile: '9811045672', dob: '1988-10-29', concern: 'Paisa nahi tikta', planned: [], consent: true, waOptIn: true, ...over });
const post = (body, headers = {}) => new Request('https://site.test/api/reading', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
let sheet;
const submit = (body, extra = {}) => handleReading(post(body, extra.headers), { ...env, ...extra.env }, undefined,
  { run: extra.run ?? run, fetchImpl: sheet.fetch, sleep: async () => {}, year: 2026 });
const count = async () => (await run('SELECT count(*)::int AS n FROM numerology_leads'))[0].n;

before(async () => {
  if (!DB) return;
  client = new pg.Client({ connectionString: DB });
  await client.connect();
  await client.query('DROP TABLE IF EXISTS numerology_leads');
  await client.query(readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8'));
});
beforeEach(async () => { sheet = fakeSheet(); if (DB) await client.query('TRUNCATE numerology_leads'); });
after(async () => { if (client) await client.end(); });

test('a new lead is stored once in the database and once in the Sheet, and the reading comes back', { skip }, async () => {
  const res = await submit(form());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.sections.some(s => s.id === 'decoded'));
  const [row] = await run('SELECT * FROM numerology_leads');
  assert.equal(row.sheet_synced, true);
  assert.equal(row.wa_opt_in, true);
  assert.equal(sheet.rows.size, 1);
  const sent = [...sheet.rows.values()][0];
  assert.equal(sent.mobile, '9811045672');
  assert.equal(sent.dob, '1988-10-29');
  assert.equal(sent.waOptIn, 'Yes');
});

test('the same person, number, concern and birth date again adds no row (case, spaces, +91 and punctuation ignored)', { skip }, async () => {
  await submit(form());
  await submit(form({ name: '  rahul   SHARMA ', mobile: '+91 98110 45672', concern: 'paisa nahi tikta!' }));
  assert.equal(await count(), 1);
  assert.equal(sheet.rows.size, 1);
});

test('a different name, number, concern or birth date is a new row', { skip }, async () => {
  await submit(form());
  await submit(form({ concern: 'Marriage delay' }));
  await submit(form({ dob: '1988-10-30' }));
  await submit(form({ name: 'Rahul Verma' }));
  await submit(form({ mobile: '9811045673' }));
  assert.equal(await count(), 5);
  assert.equal(sheet.rows.size, 5);
});

test('a different planned number alone adds no row, and the first planned numbers are kept', { skip }, async () => {
  await submit(form({ planned: ['9876500295'] }));
  await submit(form({ planned: ['9123456789'] }));
  const rows = await run('SELECT planned FROM numerology_leads');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].planned, '9876500295');
  assert.equal([...sheet.rows.values()][0].planned1, '9876500295');
});

test('ten identical submissions at the same moment give one row', { skip }, async () => {
  const clients = await Promise.all(Array.from({ length: 10 }, async () => { const c = new pg.Client({ connectionString: DB }); await c.connect(); return c; }));
  try {
    await Promise.all(clients.map(c => submit(form(), { run: (t, p) => c.query(t, p).then(r => r.rows) })));
  } finally { await Promise.all(clients.map(c => c.end())); }
  assert.equal(await count(), 1);
  assert.equal(sheet.rows.size, 1);
});

test('Sheet down: the lead waits in the database and the catch-up job sends it exactly once', { skip }, async () => {
  sheet.failNext = 4;
  await submit(form());
  let [row] = await run('SELECT sheet_synced, sheet_attempts, sheet_error FROM numerology_leads');
  assert.equal(row.sheet_synced, false);
  assert.equal(row.sheet_attempts, 1);
  assert.match(row.sheet_error, /network down/);
  assert.equal(sheet.rows.size, 0);
  // the catch-up job only takes rows older than 2 minutes
  assert.deepEqual(await flushUnsynced(env, { run, fetchImpl: sheet.fetch, sleep: async () => {} }), { pending: 0, synced: 0 });
  await run("UPDATE numerology_leads SET created_at = now() - interval '5 minutes'");
  const r = await flushUnsynced(env, { run, fetchImpl: sheet.fetch, sleep: async () => {} });
  assert.deepEqual(r, { pending: 1, synced: 1 });
  [row] = await run('SELECT sheet_synced, sheet_error FROM numerology_leads');
  assert.equal(row.sheet_synced, true);
  assert.equal(row.sheet_error, null);
  assert.equal(sheet.rows.size, 1);
  assert.deepEqual(await flushUnsynced(env, { run, fetchImpl: sheet.fetch, sleep: async () => {} }), { pending: 0, synced: 0 });
});

test('a request Google drops on its redirect is sent again', { skip }, async () => {
  sheet.loseNext = 1;
  await submit(form());
  const [row] = await run('SELECT sheet_synced FROM numerology_leads');
  assert.equal(row.sheet_synced, true);
  assert.equal(sheet.calls, 2);
  assert.equal(sheet.rows.size, 1);
});

test('database down: the lead goes straight to the Sheet, and a repeat is still refused there', { skip }, async () => {
  const down = async () => { throw new Error('connection refused'); };
  const r1 = await submit(form(), { run: down });
  assert.equal(r1.status, 200, 'the visitor still gets the reading');
  await submit(form(), { run: down });
  assert.equal(sheet.rows.size, 1);
  assert.equal(sheet.rows.keys().next().value, await dedupeKey({ name: 'Rahul Sharma', mobile: '9811045672', concern: 'Paisa nahi tikta', dob: '1988-10-29' }));
});

test('spam and bad input store nothing', { skip }, async () => {
  assert.equal((await submit(form({ website: 'http://spam' }))).status, 400);
  assert.equal((await submit(form({ consent: false }))).status, 400);
  const bad = await submit(form({ mobile: '12345' }));
  assert.equal(bad.status, 400);
  assert.ok((await bad.json()).errors.mobile);
  assert.equal((await submit(form({ planned: ['9811045672'] }))).status, 400, 'planned number same as current');
  assert.equal(await count(), 0);
  assert.equal(sheet.rows.size, 0);
});

test('visitors never receive rule sources; the owner key shows them', { skip }, async () => {
  const pub = await (await submit(form())).text();
  assert.ok(!pub.includes('"source"'));
  const own = await (await submit(form(), { headers: { 'x-owner-key': 'owner-key' } })).json();
  assert.equal(own.owner, true);
  assert.ok(JSON.stringify(own).includes('"source"'));
});

test('Turnstile and the rate limit are enforced when configured', async () => {
  sheet = fakeSheet();
  const failing = async () => new Response(JSON.stringify({ success: false }));
  const t = await handleReading(post(form({ turnstileToken: 'x' })), { TURNSTILE_SECRET: 'ts' }, undefined, { fetchImpl: failing, year: 2026 });
  assert.equal(t.status, 400);
  const limited = { RATE_LIMITER: { limit: async () => ({ success: false }) } };
  assert.equal((await handleReading(post(form()), limited, undefined, { year: 2026 })).status, 429);
});

test('routes: config, unknown API path, wrong method', async () => {
  const cfg = await worker.fetch(new Request('https://site.test/api/config'), { WHATSAPP_NUMBER: '919999999999', TURNSTILE_SITE_KEY: 'site' }, {});
  assert.deepEqual(await cfg.json(), { turnstileSiteKey: 'site', whatsappNumber: '919999999999' });
  assert.equal((await worker.fetch(new Request('https://site.test/api/nope'), {}, {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://site.test/api/reading'), {}, {})).status, 405);
});
