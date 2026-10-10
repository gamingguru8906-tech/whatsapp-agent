// Sign in with WhatsApp, and "My readings".
// 1. The page asks for a code (startLogin). It shows the code and a WhatsApp button that sends "LOGIN <code>" to
//    Kamala's number. The browser keeps a random token; only its SHA-256 is stored.
// 2. Kamala receives the message and marks that code as sent from that WhatsApp number (numerology-leads.js
//    verifyLogin in whatsapp-agent). Proof of the number = the person sent the code from it.
// 3. The page checks (loginStatus) until the code is verified. From then on the token opens the readings saved
//    for that number (any reading where the mobile entered is that WhatsApp number).

export const CODE_MINUTES = 15;      // a code must be sent within this time
export const SESSION_DAYS = 90;      // a verified sign-in lasts this long
const MAX_READINGS = 50;

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
export const hashToken = async token => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token))));

function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 900000;
  return String(100000 + n);
}
function randomToken() {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

// "919811045672" -> "9811045672" (how the readings store a mobile number).
export const tenDigits = phone => {
  const d = String(phone ?? '').replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? d.slice(2) : d.length === 10 ? d : null;
};

export async function startLogin(run) {
  // Codes that were never sent are cleared, so a code number is free again after its time is up.
  await run(`DELETE FROM numerology_logins WHERE verified_at IS NULL AND created_at < now() - make_interval(mins => $1)`, [CODE_MINUTES]);
  for (let i = 0; i < 5; i++) {
    const code = randomCode(), token = randomToken();
    try {
      await run('INSERT INTO numerology_logins (code, token_hash) VALUES ($1, $2)', [code, await hashToken(token)]);
      return { code, token, minutes: CODE_MINUTES };
    } catch (e) {
      if (e.code !== '23505') throw e; // the same code is waiting for someone else: pick another
    }
  }
  throw new Error('No free sign-in code');
}

// The signed-in WhatsApp number for a token: { state: 'signed-in', phone } | { state: 'waiting' } | { state: 'expired' }.
export async function loginStatus(run, token) {
  if (!token || typeof token !== 'string' || token.length > 200) return { state: 'expired' };
  const [row] = await run(`SELECT verified_at, phone, created_at,
      (verified_at IS NOT NULL AND verified_at > now() - make_interval(days => $2)) AS live,
      (verified_at IS NULL AND created_at > now() - make_interval(mins => $3)) AS open
    FROM numerology_logins WHERE token_hash = $1`, [await hashToken(token), SESSION_DAYS, CODE_MINUTES]);
  if (!row) return { state: 'expired' };
  if (row.live && tenDigits(row.phone)) return { state: 'signed-in', phone: tenDigits(row.phone) };
  return row.open ? { state: 'waiting' } : { state: 'expired' };
}

export async function logout(run, token) {
  if (token) await run('DELETE FROM numerology_logins WHERE token_hash = $1', [await hashToken(token)]);
}

// "Wristwatch: dialColour=blue, caseMetal=gold, goal=men+women" -> the watch details (for readings saved before
// the inputs column existed).
export function watchFromConcern(concern) {
  const m = String(concern ?? '').match(/^Wristwatch:\s*(.*)$/);
  if (!m) return null;
  const w = {};
  for (const part of m[1].split(',')) {
    const [k, v] = part.split('=').map(x => x?.trim());
    if (k && v) w[k] = v.includes('+') ? v.split('+') : v;
  }
  return w;
}

const segmentOf = row => (row.inputs?.segment === 'watch' || /^Wristwatch:/.test(row.concern ?? '') ? 'watch' : 'mobile');

export async function myReadings(run, phone) {
  const rows = await run(`SELECT id, dedupe_key, created_at, name, dob::text AS dob, concern, inputs
    FROM numerology_leads WHERE mobile = $1 ORDER BY created_at DESC LIMIT ${MAX_READINGS}`, [phone]);
  return rows.map(r => ({
    id: `NM-${r.dedupe_key.slice(0, 8)}`, segment: segmentOf(r), name: r.name, dob: r.dob.slice(0, 10),
    createdAt: new Date(r.created_at).toISOString(),
    about: segmentOf(r) === 'watch' ? null : r.concern
  }));
}

// The inputs needed to show one saved reading again (with this year's timing), or null if it is not theirs.
export async function savedInputs(run, phone, id) {
  const m = String(id ?? '').match(/^NM-([0-9a-f]{8})$/);
  if (!m) return null;
  const [r] = await run(`SELECT name, mobile, dob::text AS dob, concern, planned, inputs FROM numerology_leads
    WHERE mobile = $1 AND dedupe_key LIKE $2 ORDER BY created_at DESC LIMIT 1`, [phone, `${m[1]}%`]);
  if (!r) return null;
  const base = { name: r.name, mobile: r.mobile, dob: r.dob.slice(0, 10) };
  if (segmentOf(r) === 'watch') return { segment: 'watch', ...base, watch: r.inputs?.watch ?? watchFromConcern(r.concern) ?? {} };
  return { segment: 'mobile', ...base, concern: r.concern, planned: r.planned ? r.planned.split(',').filter(Boolean) : [] };
}
