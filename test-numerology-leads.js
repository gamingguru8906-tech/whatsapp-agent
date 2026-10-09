'use strict';

// /numerology owner command. The database tests run against a real Postgres when TEST_DATABASE_URL is set
// (skipped otherwise); the table is created exactly as the numerology website creates it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { report, parseArgs, formatDob, pack, NO_TABLE, MESSAGE_LIMIT,
  extractReadingId, migrate, rememberReading, findForPerson, fillProfile, promptContext } = require('./numerology-leads');

const DB = process.env.TEST_DATABASE_URL;
const skip = DB ? false : 'set TEST_DATABASE_URL to run the database tests';

// Same table as mobile-numerology/db/schema.sql (the website owns it).
const SCHEMA = `CREATE TABLE numerology_leads (
  id BIGSERIAL PRIMARY KEY, dedupe_key TEXT NOT NULL UNIQUE, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name TEXT NOT NULL, mobile TEXT NOT NULL, dob DATE NOT NULL, concern TEXT NOT NULL, planned TEXT NOT NULL DEFAULT '',
  consent BOOLEAN NOT NULL, wa_opt_in BOOLEAN NOT NULL DEFAULT false, sheet_synced BOOLEAN NOT NULL DEFAULT false,
  sheet_attempts INTEGER NOT NULL DEFAULT 0, sheet_error TEXT, reading_summary TEXT NOT NULL DEFAULT '')`;

let pool;
const addLead = (over = {}) => {
  const l = { key: Math.random().toString(16).slice(2), name: 'Rahul Sharma', mobile: '9811045672', dob: '1988-10-29',
    concern: 'Paisa nahi tikta', planned: '', waOptIn: true, at: new Date(), summary: '', ...over };
  return pool.query(`INSERT INTO numerology_leads (dedupe_key, name, mobile, dob, concern, planned, consent, wa_opt_in, created_at, reading_summary)
    VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9)`, [l.key, l.name, l.mobile, l.dob, l.concern, l.planned, l.waOptIn, l.at, l.summary]);
};

test.before(async () => { if (DB) pool = new Pool({ connectionString: DB }); });
test.beforeEach(async () => {
  if (!DB) return;
  await pool.query('DROP TABLE IF EXISTS numerology_leads');
  await pool.query('DROP TABLE IF EXISTS users');
  // The columns of Kamala's users table this feature touches.
  await pool.query('CREATE TABLE users (phone TEXT PRIMARY KEY, name TEXT, dob TEXT, pain_point TEXT)');
  await migrate(pool);
});
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

// ---------- Kamala answers the website query ----------

const KEY_A = 'a1b2c3d4' + 'e'.repeat(56);
const KEY_B = 'ffee0011' + '9'.repeat(56);
const SUMMARY = 'Their concern, in their words: "Paisa nahi tikta"\n- pair 5-6 / 6-5: You may be unable to ask for money, and that is why money gets stuck.';

test('the Reading ID is taken out of the message, wherever it sits', () => {
  const msg = "Hi, I'm Rahul. I just got my free mobile numerology reading and would like a consultation. Reading ID: NM-a1b2c3d4. (Ref: WEB-NUMEROLOGY)";
  assert.deepEqual(extractReadingId(msg), { id: 'a1b2c3d4', clean: "Hi, I'm Rahul. I just got my free mobile numerology reading and would like a consultation. (Ref: WEB-NUMEROLOGY)" });
  assert.equal(extractReadingId('my id is nm-A1B2C3D4').id, 'a1b2c3d4');
  assert.equal(extractReadingId('Reading ID: NM-a1b2c3d4').clean, '');
  assert.equal(extractReadingId('NM-12345 or NM-xyzxyzxy').id, null);
  assert.equal(extractReadingId(undefined).id, null);
});

test('no database, no website table yet, or an older one: Kamala carries on with nothing added', async () => {
  assert.deepEqual(await findForPerson(null, '919811045672'), { lead: null, others: [] });
  const noTable = { query: async () => { const e = new Error('missing'); e.code = '42P01'; throw e; } };
  assert.deepEqual(await findForPerson(noTable, '919811045672'), { lead: null, others: [] });
  assert.equal(promptContext({ lead: null, others: [] }, '919811045672'), '');
});

test('found by the WhatsApp number: their reading, other concerns, and the rules for using it', { skip }, async () => {
  await pool.query(SCHEMA);
  await pool.query("INSERT INTO users (phone) VALUES ('919811045672')");
  await addLead({ key: KEY_A, summary: SUMMARY, planned: '9876500295', at: new Date(Date.now() - 60e3) });
  await addLead({ key: KEY_B, concern: 'Shaadi kab hogi', at: new Date(Date.now() - 3600e3) });
  await addLead({ mobile: '9000000000', concern: 'someone else' });
  const found = await findForPerson(pool, '919811045672');
  assert.equal(found.lead.dedupe_key, KEY_A, 'latest first');
  assert.equal(found.others.length, 1);
  const p = promptContext(found, '919811045672');
  assert.match(p, /THEIR FREE MOBILE NUMEROLOGY READING FROM OUR WEBSITE/);
  assert.match(p, /Name they entered: Rahul Sharma/);
  assert.match(p, /Date of birth they entered: 29 Oct 1988/);
  assert.match(p, /9811045672 \(the same number they are writing from\)/);
  assert.match(p, /Their concern, in their own words: "Paisa nahi tikta"/);
  assert.match(p, /New numbers they were thinking of buying: 9876500295/);
  assert.match(p, /Other concerns they also entered on the website: "Shaadi kab hogi"/);
  assert.ok(p.includes(SUMMARY), 'the website summary, word for word');
  assert.match(p, /these are your ONLY numerology facts/);
  assert.match(p, /Never invent a meaning/);
  assert.match(p, /Never ask again for their name, date of birth, mobile number or concern/);
  assert.ok(!p.includes('someone else'));
  assert.ok(!p.includes('FIRST chat'), 'no first-chat note for someone already chatting');
  assert.match(promptContext(found, '919811045672', { firstChat: true }), /This is their FIRST chat with you[\s\S]*overrides the RETURNING PERSON rule/);
});

test('found by the Reading ID from a different phone, and the linked reading beats a newer one on their own number', { skip }, async () => {
  await pool.query(SCHEMA);
  await pool.query("INSERT INTO users (phone) VALUES ('919123456780')");
  await addLead({ key: KEY_A, mobile: '9811045672', name: 'Rahul Sharma', summary: SUMMARY, at: new Date(Date.now() - 3600e3) });
  await addLead({ key: KEY_B, mobile: '9123456780', name: 'Rahul S', concern: 'Job change', at: new Date() });
  assert.equal((await findForPerson(pool, '919123456780')).lead.dedupe_key, KEY_B, 'before the ID: matched by phone');
  assert.equal(await rememberReading(pool, '919123456780', 'a1b2c3d4'), true);
  const found = await findForPerson(pool, '919123456780');
  assert.equal(found.lead.dedupe_key, KEY_A);
  assert.equal(found.lead.linked, true);
  const p = promptContext(found, '919123456780');
  assert.match(p, /9811045672 \(not the number they are writing from; it may be a family member's\)/);
  assert.match(p, /gently confirm whose reading it is/);
  assert.ok(!p.includes('Never ask again for their name'));
  assert.equal(await fillProfile(pool, '919123456780', {}, found.lead), false, 'a reading for another number never fills their profile');
  assert.equal(await rememberReading(pool, '919123456780', "x'; DROP TABLE users; --"), false);
});

test('the Reading ID is remembered even if the website saves the lead a moment later', { skip }, async () => {
  await pool.query(SCHEMA);
  await pool.query("INSERT INTO users (phone) VALUES ('447700900123')");
  await rememberReading(pool, '447700900123', 'a1b2c3d4');
  assert.equal((await findForPerson(pool, '447700900123')).lead, null);
  await addLead({ key: KEY_A, summary: SUMMARY });
  assert.equal((await findForPerson(pool, '447700900123')).lead.dedupe_key, KEY_A, 'a non-Indian WhatsApp number still links by ID');
});

test('profile: only empty details are filled, and only from their own reading', { skip }, async () => {
  await pool.query(SCHEMA);
  await pool.query("INSERT INTO users (phone, name) VALUES ('919811045672', 'Rahul ji'), ('919000000001', NULL)");
  await addLead({ key: KEY_A });
  const own = (await findForPerson(pool, '919811045672')).lead;
  assert.equal(await fillProfile(pool, '919811045672', { name: 'Rahul ji' }, own), true);
  const [u] = (await pool.query("SELECT name, dob, pain_point FROM users WHERE phone='919811045672'")).rows;
  assert.deepEqual(u, { name: 'Rahul ji', dob: '29 Oct 1988', pain_point: 'Paisa nahi tikta' });
  assert.equal(await fillProfile(pool, '919811045672', u, own), false, 'nothing left to fill');
  // Someone else's lead (not linked, different number) never fills this person's profile.
  assert.equal(await fillProfile(pool, '919000000001', {}, { ...own, linked: false }), false);
  const [other] = (await pool.query("SELECT name, dob FROM users WHERE phone='919000000001'")).rows;
  assert.deepEqual(other, { name: null, dob: null });
});

