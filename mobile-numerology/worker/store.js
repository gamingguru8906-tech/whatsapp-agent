// Lead storage. Postgres (Neon) is the source of truth; the Google Sheet gets each new row once.
// `run(text, params)` executes one SQL statement and resolves the result rows, so the same code runs on
// Neon's HTTP driver in production and on a local Postgres in tests.
import { pushRows } from './sheet.js';

const clean = s => String(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

// Same name, mobile, concern and date of birth (ignoring case, spacing and punctuation) = same lead.
export async function dedupeKey({ name, mobile, concern, dob }) {
  const raw = [clean(name), mobile, clean(concern), dob].join('|');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const istStamp = date => new Date(new Date(date).getTime() + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);

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
    `INSERT INTO numerology_leads (dedupe_key, name, mobile, dob, concern, planned, consent, wa_opt_in)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING ${COLUMNS}`,
    [key, lead.name, lead.mobile, lead.dob, lead.concern, (lead.planned ?? []).join(','), lead.consent === true, lead.waOptIn === true]);
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
  const { run, fetchImpl, sleep } = deps;
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
  const { run, fetchImpl, sleep } = deps;
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
