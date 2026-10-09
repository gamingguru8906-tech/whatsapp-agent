'use strict';

// /numerology owner command. The database tests run against a real Postgres when TEST_DATABASE_URL is set
// (skipped otherwise); the table is created exactly as the numerology website creates it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { report, parseArgs, formatDob, pack, NO_TABLE, MESSAGE_LIMIT } = require('./numerology-leads');

const DB = process.env.TEST_DATABASE_URL;
const skip = DB ? false : 'set TEST_DATABASE_URL to run the database tests';

// Same table as mobile-numerology/db/schema.sql (the website owns it).
const SCHEMA = `CREATE TABLE numerology_leads (
  id BIGSERIAL PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name TEXT NOT NULL, mobile TEXT NOT NULL, dob DATE NOT NULL, concern TEXT NOT NULL, planned TEXT NOT NULL DEFAULT '',
  consent BOOLEAN NOT NULL, wa_opt_in BOOLEAN NOT NULL DEFAULT false, sheet_synced BOOLEAN NOT NULL DEFAULT false,
  sheet_attempts INTEGER NOT NULL DEFAULT 0, sheet_error TEXT)`;

let pool;
const addLead = (over = {}) => {
  const l = { key: Math.random().toString(16).slice(2), name: 'Rahul Sharma', mobile: '9811045672', dob: '1988-10-29',
    concern: 'Paisa nahi tikta', planned: '', waOptIn: true, at: new Date(), ...over };
  return pool.query(`INSERT INTO numerology_leads (dedupe_key, name, mobile, dob, concern, planned, consent, wa_opt_in, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8)`, [l.key, l.name, l.mobile, l.dob, l.concern, l.planned, l.waOptIn, l.at]);
};

test.before(async () => { if (DB) pool = new Pool({ connectionString: DB }); });
test.beforeEach(async () => { if (DB) await pool.query('DROP TABLE IF EXISTS numerology_leads'); });
test.after(async () => { if (pool) await pool.end(); });

test('arguments: latest, a count, a mobile number, a name, help', () => {
  assert.deepEqual(parseArgs([]), { mode: 'latest', limit: 10 });
  assert.deepEqual(parseArgs(['25']), { mode: 'latest', limit: 25 });
  assert.deepEqual(parseArgs(['500']), { mode: 'latest', limit: 50 });
  assert.deepEqual(parseArgs(['0']), { mode: 'latest', limit: 1 });
  assert.deepEqual(parseArgs(['98110']), { mode: 'mobile', digits: '98110' });
  assert.deepEqual(parseArgs(['+91', '98110', '45672']), { mode: 'mobile', digits: '9811045672' });
  assert.deepEqual(parseArgs(['919811045672']), { mode: 'mobile', digits: '9811045672' });
  assert.deepEqual(parseArgs(['09811045672']), { mode: 'mobile', digits: '9811045672' });
  assert.deepEqual(parseArgs(['Rahul', 'Sharma']), { mode: 'text', query: 'Rahul Sharma' });
  assert.deepEqual(parseArgs(['help']), { mode: 'help' });
  assert.deepEqual(parseArgs(['x']), { mode: 'help' });
});

test('date of birth shows without a time-zone shift', () => {
  assert.equal(formatDob('1988-10-29'), '29 Oct 1988');
  assert.equal(formatDob('2001-01-01'), '1 Jan 2001');
});

test('long lists split into WhatsApp-sized messages without cutting a lead', () => {
  const block = 'x'.repeat(400);
  const out = pack('header', Array.from({ length: 30 }, () => block), 'footer');
  assert.ok(out.length > 1);
  for (const m of out) assert.ok(m.length <= MESSAGE_LIMIT, `message of ${m.length} characters`);
  assert.equal(out.join('').split(block).length - 1, 30);
  assert.ok(out[out.length - 1].endsWith('footer'));
});

test('no database or no table yet: a clear message, never an error', async () => {
  assert.deepEqual(await report(null, []), ['Database not connected.']);
  const noTable = { query: async () => { const e = new Error('relation "numerology_leads" does not exist'); e.code = '42P01'; throw e; } };
  assert.deepEqual(await report(noTable, []), [NO_TABLE]);
  assert.deepEqual(await report(noTable, ['rahul']), [NO_TABLE]);
  const broken = { query: async () => { throw new Error('connection reset'); } };
  assert.match((await report(broken, []))[0], /Could not read numerology leads: connection reset/);
});

test('the website has not created the table yet', { skip }, async () => {
  assert.deepEqual(await report(pool, []), [NO_TABLE]);
});

test('counts and the latest leads, newest first, with every detail the website saved', { skip }, async () => {
  await pool.query(SCHEMA);
  await addLead({ name: 'Old Lead', mobile: '9000000001', at: new Date(Date.now() - 10 * 86400e3), waOptIn: false });
  await addLead({ name: 'Priya Verma', mobile: '9876500295', dob: '1995-03-05', concern: 'Shaadi mein deri', planned: '9123456789,9988776655', waOptIn: true });
  const [msg] = await report(pool, []);
  assert.match(msg, /Total 2 · Today 1 · Last 7 days 1/);
  assert.match(msg, /WhatsApp opt-in: 1 · Checked a new number: 1/);
  assert.ok(msg.indexOf('Priya Verma') < msg.indexOf('Old Lead'), 'newest first');
  assert.match(msg, /\*Priya Verma\* · 9876500295/);
  assert.match(msg, /DOB 5 Mar 1995/);
  assert.match(msg, /Concern: Shaadi mein deri/);
  assert.match(msg, /Planned: 9123456789, 9988776655/);
  assert.match(msg, /WhatsApp updates: Yes · Chat: wa\.me\/919876500295/);
  assert.match(msg, /WhatsApp updates: No/);
});

test('/numerology 2 shows two and offers more; 60 leads come back in several messages', { skip }, async () => {
  await pool.query(SCHEMA);
  for (let i = 0; i < 60; i++) await addLead({ name: `Lead ${i}`, mobile: `98${String(i).padStart(8, '0')}`, concern: 'Career growth '.repeat(10), at: new Date(Date.now() - i * 60e3) });
  const two = await report(pool, ['2']);
  assert.equal(two.length, 1);
  assert.match(two[0], /\*Latest 2:\*/);
  assert.match(two[0], /More: \/numerology 4/);
  const fifty = await report(pool, ['50']);
  assert.ok(fifty.length > 1);
  assert.equal(fifty.join('\n').match(/^\d+\. \*/gm).length, 50);
  for (const m of fifty) assert.ok(m.length <= MESSAGE_LIMIT);
});

test('search by name, concern or mobile; % and _ are taken literally', { skip }, async () => {
  await pool.query(SCHEMA);
  await addLead({ name: 'Rahul Sharma', mobile: '9811045672', concern: 'Paisa nahi tikta' });
  await addLead({ name: 'Anita Rao', mobile: '9123456789', concern: 'Job change 100% sure?' });
  assert.match((await report(pool, ['rahul']))[0], /matching "rahul":\* 1[\s\S]*Rahul Sharma/);
  assert.match((await report(pool, ['PAISA']))[0], /Rahul Sharma/);
  assert.match((await report(pool, ['919123456789']))[0], /Anita Rao/);
  assert.match((await report(pool, ['45672']))[0], /Rahul Sharma/);
  assert.match((await report(pool, ['100%']))[0], /Anita Rao/);
  assert.equal((await report(pool, ['_']))[0], (await report(pool, ['help']))[0], 'one character is too short to search');
  assert.match((await report(pool, ['nobody']))[0], /No numerology leads match "nobody"/);
});
