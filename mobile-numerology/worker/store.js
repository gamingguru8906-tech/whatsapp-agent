// Lead storage. Kamala's Postgres database (Neon) is the source of truth, in its own `numerology_leads` table;
// the "Numerology Leads" tab of Kamala's CRM Sheet gets each new row once.
// `run(text, params)` executes one SQL statement and resolves the result rows, so the same code runs on
// Neon's HTTP driver in production and on a local Postgres in tests.
import { pushRows } from './sheet.js';
import { SCHEMA_STATEMENTS } from '../db/schema.js';

// The table creates itself the first time a lead arrives, so no manual SQL step is needed. Two first leads at the
// same moment may both try; Postgres can then report the table (or its type) as already existing, which is fine.
async function createSchema(run) {
  for (const statement of SCHEMA_STATEMENTS) {
    try { await run(statement, []); } catch (e) { if (!['42P07', '23505', '42710'].includes(e.code)) throw e; }
  }
}

/** Creates the table (and any newer column or index) if missing. Safe to call any time. */
export const ensureTable = run => createSchema(run);

export function withSchema(run) {
  return async (text, params) => {
    try {
      return await run(text, params);
    } catch (e) {
      if (e.code !== '42P01' && e.code !== '42703') throw e; // table, or a newer column, does not exist yet
      await createSchema(run);
      return run(text, params);
    }
  };
}

const clean = s => String(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// Same name, mobile, concern and date of birth (ignoring case, spacing and punctuation) = same lead.
// Its first 8 characters are the Reading ID ("NM-xxxxxxxx") the visitor sends Kamala from the WhatsApp button.
export async function dedupeKey({ name, mobile, concern, dob }) {
  const raw = [clean(name), mobile, clean(concern), dob].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const istStamp = date => new Date(new Date(date).getTime() + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);

export const readingId = key => `NM-${String(key).slice(0, 8)}`;

export function sheetRow(lead) {
  const planned = lead.planned ? String(lead.planned).split(',').filter(Boolean) : [];
  return {
    key: lead.dedupe_key, date: istStamp(lead.created_at), name: lead.name, mobile: lead.mobile,
    dob: typeof lead.dob === 'string' ? lead.dob.slice(0, 10) : new Date(lead.dob).toISOString().slice(0, 10),
    concern: lead.concern, planned1: planned[0] ?? '', planned2: planned[1] ?? '', planned3: planned[2] ?? '',
    consent: lead.consent ? 'Yes' : 'No', waOptIn: lead.wa_opt_in ? 'Yes' : 'No'
  };
}

const COLUMNS = 'id, dedupe_key, created_at, name, mobile, dob::text AS dob, concern, planned, consent, wa_opt_in';

// Inserts the lead unless the same one exists. Returns the new row, or null for a repeat.
export async function insertLead(run, lead) {
  const key = await dedupeKey(lead);
  const rows = await run(
    `INSERT INTO numerology_leads (dedupe_key, name, mobile, dob, concern, planned, consent, wa_opt_in, reading_summary, inputs)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING ${COLUMNS}`,
    [key, lead.name, lead.mobile, lead.dob, lead.concern, (lead.planned ?? []).join(','), lead.consent === true, lead.waOptIn === true,
      String(lead.readingSummary ?? ''), lead.inputs ? JSON.stringify(lead.inputs) : null]);
  return rows[0] ?? null;
}

async function markSynced(run, results) {
  const done = Object.entries(results).filter(([, r]) => r === 'added' || r === 'exists').map(([k]) => k);
  if (done.length) await run('UPDATE numerology_leads SET sheet_synced = true, sheet_error = NULL WHERE dedupe_key = ANY($1::text[])', [done]);
  return done.length;
}

async function markFailed(run, keys, error) {
  if (keys.length) await run('UPDATE numerology_leads SET sheet_attempts = sheet_attempts + 1, sheet_error = $2 WHERE dedupe_key = ANY($1::text[])', [keys, String(error).slice(0, 500)]);
}

// Called after the reading is sent. A repeat lead writes nothing anywhere.
export async function saveLead(env, lead, deps) {
  const { fetchImpl, sleep } = deps;
  const run = withSchema(deps.run);
  let row;
  try {
    row = await insertLead(run, lead);
  } catch (e) {
    // Database unreachable: send the lead straight to the Sheet, which refuses a key it already has.
    console.error('Database insert failed, writing to the Sheet directly:', e.message);
    const key = await dedupeKey(lead);
    await pushRows(env, [sheetRow({ ...lead, dedupe_key: key, created_at: new Date(), planned: (lead.planned ?? []).join(','), wa_opt_in: lead.waOptIn })], { fetchImpl, sleep });
    return { stored: 'sheet-only' };
  }
  if (!row) return { stored: 'repeat' };
  try {
    const results = await pushRows(env, [sheetRow(row)], { fetchImpl, sleep });
    await markSynced(run, results);
    return { stored: 'new', synced: true };
  } catch (e) {
    await markFailed(run, [row.dedupe_key], e.message);
    return { stored: 'new', synced: false };
  }
}

// Scheduled catch-up: rows the Sheet has not confirmed yet (older than 2 minutes, so it never races the
// push that follows a new lead). The Sheet's own key check makes a resend harmless.
export async function flushUnsynced(env, deps, limit = 50) {
  const { fetchImpl, sleep } = deps;
  const run = withSchema(deps.run);
  const rows = await run(
    `SELECT ${COLUMNS} FROM numerology_leads
     WHERE NOT sheet_synced AND created_at < now() - interval '2 minutes'
     ORDER BY created_at LIMIT $1`, [limit]);
  if (!rows.length) return { pending: 0, synced: 0 };
  try {
    const results = await pushRows(env, rows.map(sheetRow), { fetchImpl, sleep });
    return { pending: rows.length, synced: await markSynced(run, results) };
  } catch (e) {
    await markFailed(run, rows.map(r => r.dedupe_key), e.message);
    return { pending: rows.length, synced: 0, error: e.message };
  }
}

// ---------- After the reading: "Does this sound like you?" and the WhatsApp opt-in ----------
export const FEEDBACK = ['yes', 'partly', 'no'];

// Saves an answer on the visitor's own lead (they hold its full key). Returns the row, or null if the key is unknown.
export async function saveAnswer(run, key, { feedback, optIn }) {
  const sets = [], params = [key];
  if (FEEDBACK.includes(feedback)) { params.push(feedback); sets.push(`feedback = $${params.length}, feedback_at = now()`); }
  if (typeof optIn === 'boolean') { params.push(optIn); sets.push(`wa_opt_in = $${params.length}, opt_in_at = now()`); }
  if (!sets.length) return null;
  const rows = await run(`UPDATE numerology_leads SET ${sets.join(', ')}, sheet_update_pending = true WHERE dedupe_key = $1
    RETURNING dedupe_key, sheet_synced, feedback, feedback_at, wa_opt_in, opt_in_at`, [...params]);
  return rows[0] ?? null;
}

export const answerRow = r => ({
  op: 'update', key: r.dedupe_key,
  soundsLikeYou: r.feedback ? r.feedback.charAt(0).toUpperCase() + r.feedback.slice(1) : '',
  answeredAt: r.feedback_at ? istStamp(r.feedback_at) : '',
  waOptIn: r.opt_in_at ? (r.wa_opt_in ? 'Yes' : 'No') : '',
  optInAt: r.opt_in_at ? istStamp(r.opt_in_at) : ''
});

// Sends answers to rows the Sheet already has (a lead not in the Sheet yet gets them when the catch-up runs).
export async function pushAnswers(env, run, rows, deps = {}) {
  const ready = rows.filter(r => r.sheet_synced);
  if (!ready.length) return 0;
  const results = await pushRows(env, ready.map(answerRow), deps);
  const done = Object.entries(results).filter(([, v]) => v === 'updated').map(([k]) => k);
  if (done.length) await run('UPDATE numerology_leads SET sheet_update_pending = false WHERE dedupe_key = ANY($1::text[])', [done]);
  return done.length;
}

export async function flushAnswers(env, deps, limit = 50) {
  const run = withSchema(deps.run);
  const rows = await run(`SELECT dedupe_key, sheet_synced, feedback, feedback_at, wa_opt_in, opt_in_at FROM numerology_leads
    WHERE sheet_update_pending AND sheet_synced ORDER BY created_at LIMIT $1`, [limit]);
  if (!rows.length) return { answers: 0 };
  try { return { answers: await pushAnswers(env, run, rows, deps) }; } catch (e) { return { answers: 0, error: e.message }; }
}

// ---------- Funnel events ----------
export const PAGES = ['mobile', 'watch', 'wrist', 'my'];
export const EVENTS = ['view', 'photo_added', 'photo_read', 'photo_failed', 'details_changed', 'form_sent', 'result_shown',
  'feedback', 'opt_in', 'whatsapp_click', 'shop_click', 'sign_in'];

export async function saveEvent(run, { sid, page, event, leadKey, detail }) {
  if (!/^[a-z0-9]{12,40}$/.test(String(sid ?? '')) || !PAGES.includes(page) || !EVENTS.includes(event)) return false;
  const d = detail && typeof detail === 'object' ? JSON.stringify(detail).slice(0, 300) : null;
  // At most 60 events per tab, so a script cannot flood the table.
  const rows = await run(`INSERT INTO numerology_events (sid, page, event, lead_key, detail)
    SELECT $1, $2, $3, $4, $5::jsonb WHERE (SELECT count(*) FROM numerology_events WHERE sid = $1) < 60 RETURNING id`,
  [sid, page, event, /^[0-9a-f]{64}$/.test(leadKey ?? '') ? leadKey : null, d && d.endsWith('}') ? d : null]);
  return rows.length > 0;
}

// Owner funnel: for each page, how many tabs reached each step, and the answers given after the reading.
export async function funnel(run, days = 30) {
  const steps = await run(`SELECT page, event, count(DISTINCT sid)::int AS visitors FROM numerology_events
    WHERE at > now() - make_interval(days => $1) GROUP BY page, event`, [days]);
  const answers = await run(`SELECT
      CASE WHEN inputs->>'segment' = 'wrist' THEN 'wrist' WHEN concern LIKE 'Wristwatch:%' THEN 'watch' ELSE 'mobile' END AS page,
      count(*)::int AS leads,
      count(*) FILTER (WHERE feedback = 'yes')::int AS yes,
      count(*) FILTER (WHERE feedback = 'partly')::int AS partly,
      count(*) FILTER (WHERE feedback = 'no')::int AS no,
      count(*) FILTER (WHERE opt_in_at IS NOT NULL AND wa_opt_in)::int AS opted_in,
      count(*) FILTER (WHERE opt_in_at IS NOT NULL AND NOT wa_opt_in)::int AS declined
    FROM numerology_leads WHERE created_at > now() - make_interval(days => $1) GROUP BY 1`, [days]);
  const out = {};
  for (const p of PAGES) out[p] = { steps: Object.fromEntries(EVENTS.map(e => [e, 0])), leads: 0, feedback: { yes: 0, partly: 0, no: 0 }, optedIn: 0, declined: 0 };
  for (const s of steps) if (out[s.page]) out[s.page].steps[s.event] = s.visitors;
  for (const a of answers) if (out[a.page]) Object.assign(out[a.page], { leads: a.leads, feedback: { yes: a.yes, partly: a.partly, no: a.no }, optedIn: a.opted_in, declined: a.declined });
  return { days, pages: out };
}
