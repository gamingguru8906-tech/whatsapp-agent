'use strict';

/**
 * Customer memory, customer IDs, consultation reminders and follow-ups.
 *
 * WhatsApp only allows free-form messages within 24 hours of the customer's
 * last message, so every scheduled message here is sent inside that window.
 */

const PAID_STATUSES = ['paid', 'gateway_test_paid'];
const CUSTOMER_ID_RE = /^VA\/\d{2}-\d{2}\/\d{2}-\d{3,}$/;

function isNewCustomerId(id) {
  return CUSTOMER_ID_RE.test(String(id || '').trim());
}

/** "VA/26-27/09-" for September 2026 (Indian financial year April-March, IST). */
function customerIdPrefix(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' })
    .formatToParts(date);
  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  const fyStart = month >= 4 ? year : year - 1;
  const yy = n => String(n % 100).padStart(2, '0');
  return `VA/${yy(fyStart)}-${yy(fyStart + 1)}/${String(month).padStart(2, '0')}-`;
}

/** Next ID for this month given every ID already issued (serial restarts monthly). */
function nextCustomerId(existingIds, date = new Date()) {
  const prefix = customerIdPrefix(date);
  let max = 0;
  for (const id of existingIds || []) {
    const s = String(id || '').trim();
    if (s.startsWith(prefix)) {
      const n = Number(s.slice(prefix.length));
      if (Number.isInteger(n) && n > max) max = n;
    }
  }
  return prefix + String(max + 1).padStart(3, '0');
}

async function migrate(pool) {
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS followup_sent_for TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_restored BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS meet_link TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS reminder_status TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS checkin_for TIMESTAMPTZ;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS checkin_sent_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS wa_messages (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS wa_messages_phone_idx ON wa_messages (phone, id DESC);
    CREATE TABLE IF NOT EXISTS wa_meta (key TEXT PRIMARY KEY, value TEXT);
  `);
}

// ---------- Conversation memory ----------

async function recordInbound(pool, phone) {
  if (!pool) return;
  await pool.query('UPDATE users SET last_inbound_at=NOW() WHERE phone=$1', [phone]);
}

async function saveTurn(pool, phone, role, text) {
  const clean = String(text || '').trim();
  if (!pool || !phone || !clean) return;
  await pool.query('INSERT INTO wa_messages (phone, role, text) VALUES ($1,$2,$3)',
    [String(phone), role === 'user' ? 'user' : 'model', clean.slice(0, 4000)]);
}

/** Last text turns in Gemini format, oldest first, always starting with a user turn. */
async function loadRecentTurns(pool, phone, limit = 16) {
  if (!pool) return [];
  const res = await pool.query('SELECT role, text, created_at FROM wa_messages WHERE phone=$1 ORDER BY id DESC LIMIT $2',
    [String(phone), limit]);
  const turns = res.rows.reverse();
  while (turns.length && turns[0].role !== 'user') turns.shift();
  return turns.map(t => ({ role: t.role, parts: [{ text: t.text }], createdAt: t.created_at }));
}

async function bookingHistory(pool, phone) {
  if (!pool) return [];
  const res = await pool.query(`SELECT service_name, appointment_start, status, customer_id FROM wa_payment_links
    WHERE phone=$1 AND status = ANY($2) ORDER BY appointment_start DESC LIMIT 5`, [phone, PAID_STATUSES]);
  return res.rows;
}

function istDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';
}

/** Everything we know about the person, for the system prompt. */
function profileContext(user, bookings = [], lastTurnAt = null) {
  const u = user || {};
  const v = x => (String(x || '').trim() || 'Not known yet');
  const lines = [
    `- Customer ID: ${isNewCustomerId(u.customer_id) ? u.customer_id : 'Not assigned yet (given at first booking)'}`,
    `- Name: ${v(u.name)}`,
    `- Gender: ${v(u.gender)}`,
    `- Date of birth: ${v(u.dob)}`,
    `- Time of birth: ${v(u.tob)}`,
    `- Place of birth: ${v(u.pob)}`,
    `- Email: ${v(u.email)}`,
    `- Billing address: ${v(u.billing_address)}`,
    `- Their concern / problem: ${v(u.pain_point)}`,
    `- Remedies prescribed earlier: ${v(u.remedies_prescribed)}`,
    `- First contact: ${u.first_contact ? istDateTime(u.first_contact) : 'Today'}`,
    `- Previous conversation: ${lastTurnAt === 'ongoing' ? 'Ongoing chat' : (lastTurnAt ? istDateTime(lastTurnAt) : 'None — first chat')}`
  ];
  if (bookings.length) {
    lines.push(`- Past bookings: ${bookings.map(b => `${b.service_name} on ${istDateTime(b.appointment_start)}${b.status === 'gateway_test_paid' ? ' (₹1 test)' : ''}`).join('; ')}`);
  } else {
    lines.push('- Past bookings: None');
  }
  const known = ['name', 'gender', 'dob', 'tob', 'pob', 'email'].filter(k => String(u[k] || '').trim());
  return `--- WHAT YOU ALREADY KNOW ABOUT THIS PERSON (saved from earlier chats) ---
${lines.join('\n')}
MEMORY RULES (PRIVATE — use silently, never recite):
- Everything above is for YOUR understanding only. Never read out, list or repeat the person's stored details (birth date/time/place, email, address, customer ID, past chats) unless they themselves ask for them.
- RETURNING PERSON: if a name is known and this is the start of a new conversation (previous conversation is not "Ongoing chat"), your FIRST reply must greet them warmly by first name, like an old friend who is happy to hear from them again, and gently ask whether their earlier concern has improved — mention the topic softly in one or two words (e.g. "career wali pareshani", "shaadi ki baat"), never details. Example: "Arre Priya ji, kitne dino baad! Kaise hain aap? Pichli baar aap career ko lekar thodi pareshan thin — ab kaisa chal raha hai?" If no concern is recorded, just ask how they have been.
- NEVER ask again for any detail listed above as known (${known.length ? known.join(', ') : 'none yet'}). Simply use it. Ask only for details that are still "Not known yet".`;
}

// ---------- Detail extraction ----------

const PROFILE_FIELDS = ['name', 'gender', 'dob', 'tob', 'pob', 'email', 'concern'];

function cleanExtracted(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || raw.about_self === false) return out;
  for (const key of PROFILE_FIELDS) {
    const val = String(raw[key] || '').trim();
    if (val && !/^(null|none|unknown|not provided|n\/a)$/i.test(val)) out[key] = val.slice(0, key === 'concern' ? 240 : 120);
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) delete out.email;
  return out;
}

/** Ask Gemini which personal details the customer stated about themselves in this message. */
async function extractProfileDetails(genAI, SchemaType, modelName, userText, lastAssistantText, media = null) {
  const text = String(userText || '').trim();
  if (!genAI || (!media && text.length < 2)) return {};
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          about_self: { type: SchemaType.BOOLEAN, description: 'false if the details are about someone else (child, spouse, friend)' },
          name: { type: SchemaType.STRING }, gender: { type: SchemaType.STRING },
          dob: { type: SchemaType.STRING, description: 'date of birth as written' },
          tob: { type: SchemaType.STRING, description: 'time of birth as written' },
          pob: { type: SchemaType.STRING, description: 'place of birth' },
          email: { type: SchemaType.STRING },
          concern: { type: SchemaType.STRING, description: 'one-line summary of the problem they want help with, only if they describe one' },
          transcript: { type: SchemaType.STRING, description: 'for a voice note: what the customer said, written out; otherwise empty' }
        }
      }
    }
  });
  const prompt = `A WhatsApp assistant asked: "${String(lastAssistantText || '').slice(0, 500)}"
The customer replied ${media ? 'with the attached voice note' : `: "${text.slice(0, 1500)}"`}
Return ONLY details the customer explicitly stated in this reply. Use empty strings for anything not stated. Never guess.`;
  const result = await model.generateContent(media ? [{ text: prompt }, media] : prompt);
  const raw = JSON.parse(result.response.text());
  const out = cleanExtracted(raw);
  if (media && raw && raw.transcript) out.transcript = String(raw.transcript).slice(0, 2000);
  return out;
}

/** Save newly stated details; returns the changed fields. */
async function applyProfileDetails(pool, phone, details) {
  const map = { name: 'name', gender: 'gender', dob: 'dob', tob: 'tob', pob: 'pob', email: 'email', concern: 'pain_point' };
  const current = (await pool.query('SELECT * FROM users WHERE phone=$1', [phone])).rows[0] || {};
  const changed = {};
  for (const [key, column] of Object.entries(map)) {
    if (details[key] && String(current[column] || '').trim() !== details[key]) changed[column] = details[key];
  }
  const cols = Object.keys(changed);
  if (!cols.length) return {};
  const sets = cols.map((c, i) => `${c}=$${i + 2}`).join(', ');
  await pool.query(`UPDATE users SET ${sets} WHERE phone=$1`, [phone, ...cols.map(c => changed[c])]);
  return changed;
}

function profilePayload(user, extra = {}) {
  const u = user || {};
  return {
    target: 'profile_upsert',
    phone: u.phone,
    customerId: isNewCustomerId(u.customer_id) ? u.customer_id : '',
    name: u.name || '', gender: u.gender || '', dob: u.dob || '', birthTime: u.tob || '', birthPlace: u.pob || '',
    email: u.email || '', billingAddress: u.billing_address || '', customerGstin: u.customer_gstin || '',
    concern: u.pain_point || '', remedies: u.remedies_prescribed || '',
    firstContact: u.first_contact ? istDateTime(u.first_contact) : '',
    lastContact: istDateTime(new Date()),
    source: 'WhatsApp',
    ...extra
  };
}

// ---------- Scheduled jobs ----------

const WINDOW_OPEN_SQL = "u.last_inbound_at > NOW() - INTERVAL '23 hours 58 minutes'";

const FOLLOWUP_ELIGIBLE_SQL = `
  u.last_inbound_at IS NOT NULL
  AND COALESCE(u.message_count,0) >= 1
  AND COALESCE(u.marketing_opt_out,false) = false
  AND u.followup_sent_for IS DISTINCT FROM u.last_inbound_at
  AND NOT EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=u.phone AND l.status = ANY($1)
    AND (l.appointment_start > NOW() OR l.updated_at > u.last_inbound_at - INTERVAL '7 days'))`;

const CHECKIN_ELIGIBLE_SQL = `
  l.status = ANY($1) AND l.reminder_sent_at IS NULL
  AND l.appointment_start > NOW() + INTERVAL '30 minutes'
  AND u.last_inbound_at IS NOT NULL
  AND u.last_inbound_at + INTERVAL '24 hours' < l.appointment_start - INTERVAL '30 minutes'
  AND l.checkin_for IS DISTINCT FROM u.last_inbound_at`;

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

async function sendReminders(deps) {
  const { pool, sendCustomerText, notifyOwner } = deps;
  const due = await pool.query(`SELECT l.payment_link_id FROM wa_payment_links l
    WHERE l.status = ANY($1) AND l.reminder_sent_at IS NULL
      AND l.appointment_start > NOW() - INTERVAL '10 minutes'
      AND l.appointment_start <= NOW() + INTERVAL '30 minutes'`, [PAID_STATUSES]);
  let sent = 0;
  for (const { payment_link_id: id } of due.rows) {
    const claimed = await pool.query(`UPDATE wa_payment_links l SET reminder_sent_at=NOW(), reminder_status='sending'
      FROM users u WHERE l.payment_link_id=$1 AND l.reminder_sent_at IS NULL AND u.phone=l.phone
      RETURNING l.*, u.last_inbound_at, (${WINDOW_OPEN_SQL}) AS window_open`, [id]);
    const b = claimed.rows[0];
    if (!b) continue;
    const when = istDateTime(b.appointment_start);
    const test = b.status === 'gateway_test_paid' ? ' (₹1 test booking)' : '';
    const msg = `Namaste ${firstName(b.customer_name)} ji, a gentle reminder: your ${b.service_name} consultation${test} starts at ${when}.`
      + (b.meet_link ? `\n\nJoin here: ${b.meet_link}` : '')
      + '\n\nPlease keep your birth details handy and join from a quiet place. See you soon.';
    let status = 'window_closed';
    if (b.window_open) status = (await sendCustomerText(b.phone, msg)) ? 'sent' : 'failed';
    await pool.query('UPDATE wa_payment_links SET reminder_status=$2 WHERE payment_link_id=$1', [id, status]);
    if (status === 'sent') sent++;
    else await notifyOwner(`Could not send the 30-min WhatsApp reminder to ${b.customer_name} (+${b.phone}) for ${when}: ${status === 'window_closed' ? "their last message was over 24 hours ago, so WhatsApp blocks it" : 'WhatsApp send failed'}. Please call or message them.`);
  }
  return sent;
}

async function sendCheckins(deps) {
  const { pool, sendCustomerText } = deps;
  const due = await pool.query(`SELECT l.payment_link_id, u.last_inbound_at FROM wa_payment_links l JOIN users u ON u.phone=l.phone
    WHERE ${CHECKIN_ELIGIBLE_SQL}
      AND NOW() >= u.last_inbound_at + INTERVAL '20 hours'
      AND NOW() < u.last_inbound_at + INTERVAL '23 hours 50 minutes'`, [PAID_STATUSES]);
  let sent = 0;
  for (const row of due.rows) {
    const claimed = await pool.query(`UPDATE wa_payment_links SET checkin_for=$2, checkin_sent_at=NOW()
      WHERE payment_link_id=$1 AND checkin_for IS DISTINCT FROM $2 RETURNING *`, [row.payment_link_id, row.last_inbound_at]);
    const b = claimed.rows[0];
    if (!b) continue;
    const msg = `Namaste ${firstName(b.customer_name)} ji, your ${b.service_name} consultation is on ${istDateTime(b.appointment_start)}.`
      + ' I will send you the Meet link here 30 minutes before it starts. Please just reply OK so the reminder can reach you on WhatsApp.';
    if (await sendCustomerText(b.phone, msg)) sent++;
  }
  return sent;
}

async function writeFollowup(deps, user) {
  const fallback = `Namaste${user.name ? ' ' + firstName(user.name) + ' ji' : ''}, main aapki baat ke baare mein soch rahi thi. Agar aap abhi bhi guidance chahte hain, toh main aapke liye consultation ka ek suitable time dekh sakti hoon. Bas reply kar dijiye.`;
  if (!deps.genAI) return fallback;
  try {
    const turns = await loadRecentTurns(deps.pool, user.phone, 12);
    const transcript = turns.map(t => `${t.role === 'user' ? 'Customer' : 'Assistant'}: ${t.parts[0].text}`).join('\n').slice(-3000);
    const model = deps.genAI.getGenerativeModel({ model: deps.modelName, generationConfig: { temperature: 0.6 } });
    const res = await model.generateContent(`You write one short WhatsApp follow-up (max 2 sentences, warm Hindi-English mix, no emojis, no bullet points) for a customer who chatted with an astrology consultation assistant yesterday but did not book.
Refer naturally to what they discussed and invite them to continue or pick a consultation time. Do not invent facts, predictions, discounts, deadlines or scarcity. Do not mention being an AI. Do not use their name more than once.
Customer name: ${user.name || 'unknown'}
Their concern: ${user.pain_point || 'unknown'}
Recent chat:
${transcript}`);
    const text = String(res.response.text() || '').trim();
    return text && text.length < 600 ? text : fallback;
  } catch (e) {
    return fallback;
  }
}

async function sendFollowups(deps) {
  const { pool, sendCustomerText, adminPhone } = deps;
  const due = await pool.query(`SELECT u.phone FROM users u WHERE ${FOLLOWUP_ELIGIBLE_SQL}
    AND NOW() >= u.last_inbound_at + INTERVAL '23 hours'
    AND NOW() < u.last_inbound_at + INTERVAL '23 hours 55 minutes'
    AND u.phone <> $2`, [PAID_STATUSES, String(adminPhone || '')]);
  let sent = 0;
  for (const { phone } of due.rows) {
    const claimed = await pool.query(`UPDATE users SET followup_sent_for=last_inbound_at, last_followup_at=NOW()
      WHERE phone=$1 AND followup_sent_for IS DISTINCT FROM last_inbound_at RETURNING *`, [phone]);
    const user = claimed.rows[0];
    if (!user) continue;
    if (await sendCustomerText(phone, await writeFollowup(deps, user))) sent++;
  }
  return sent;
}

// ---------- Daily 8 AM owner summary ----------

function istDayKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

/** 8:00 AM IST of the next summary still to be sent. */
async function nextSummaryAt(pool, now = new Date()) {
  const today = istDayKey(now);
  const row = (await pool.query("SELECT value FROM wa_meta WHERE key='owner_summary_date'")).rows[0];
  const eightToday = new Date(`${today}T08:00:00+05:30`);
  if (row?.value === today) return new Date(eightToday.getTime() + 24 * 3600 * 1000);
  return eightToday;
}

async function sendOwnerSummary(deps, now = new Date()) {
  const { pool, notifyOwner } = deps;
  if (now < await nextSummaryAt(pool, now)) return 0;
  const today = istDayKey(now);
  const claimed = await pool.query(`INSERT INTO wa_meta (key, value) VALUES ('owner_summary_date', $1)
    ON CONFLICT (key) DO UPDATE SET value=$1 WHERE wa_meta.value IS DISTINCT FROM $1 RETURNING key`, [today]);
  if (!claimed.rows.length) return 0;
  const start = new Date(`${today}T00:00:00+05:30`);
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const dayBefore = new Date(start.getTime() - 24 * 3600 * 1000);
  const consults = (await pool.query(`SELECT l.*, u.pain_point FROM wa_payment_links l LEFT JOIN users u ON u.phone=l.phone
    WHERE l.status = ANY($1) AND l.appointment_start >= $2 AND l.appointment_start < $3 ORDER BY l.appointment_start`,
  [PAID_STATUSES, start, end])).rows;
  const stats = (await pool.query(`SELECT
      (SELECT COUNT(*) FROM users WHERE first_contact >= $1 AND first_contact < $2) AS new_people,
      (SELECT COUNT(*) FROM users WHERE last_inbound_at >= $1 AND last_inbound_at < $2) AS active_people,
      (SELECT COUNT(*) FROM wa_payment_links WHERE status = ANY($3) AND updated_at >= $1 AND updated_at < $2) AS bookings`,
  [dayBefore, start, PAID_STATUSES])).rows[0];
  const time = d => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
  const list = consults.length ? consults.map((c, i) => `${i + 1}. ${time(c.appointment_start)} — ${c.customer_name}${c.status === 'gateway_test_paid' ? ' (₹1 test)' : ''}\n`
    + `   ${c.service_name} | ${c.customer_id || 'ID pending'} | +${c.phone}\n`
    + `   DOB ${c.dob || '-'}, ${c.tob || '-'}, ${c.pob || '-'}\n`
    + `   Concern: ${c.pain_point || 'Not recorded'}\n`
    + `   Meet: ${c.meet_link || 'in Calendar'}`).join('\n\n') : 'No consultations booked for today.';
  await notifyOwner(`🌅 Good morning! Your day — ${new Date(start).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'short' })}\n\n`
    + `📅 Today's consultations (${consults.length}):\n${list}\n\n`
    + `📊 Yesterday: ${stats.new_people} new people, ${stats.active_people} chatted, ${stats.bookings} bookings paid.`,
  `Today's consultations (${consults.length})`);
  return 1;
}

/** Earliest moment any job becomes due (null if nothing is scheduled). */
async function nextDueAt(pool, adminPhone = '') {
  const summary = await nextSummaryAt(pool).catch(() => null);
  const other = await nextJobAt(pool, adminPhone);
  if (!summary) return other;
  return other && other < summary ? other : summary;
}

async function nextJobAt(pool, adminPhone = '') {
  const res = await pool.query(`SELECT MIN(t) AS next FROM (
      SELECT l.appointment_start - INTERVAL '30 minutes' AS t FROM wa_payment_links l
        WHERE l.status = ANY($1) AND l.reminder_sent_at IS NULL AND l.appointment_start > NOW()
      UNION ALL
      SELECT u.last_inbound_at + INTERVAL '20 hours' FROM wa_payment_links l JOIN users u ON u.phone=l.phone
        WHERE ${CHECKIN_ELIGIBLE_SQL} AND u.last_inbound_at + INTERVAL '23 hours 50 minutes' > NOW()
      UNION ALL
      SELECT u.last_inbound_at + INTERVAL '23 hours' FROM users u
        WHERE ${FOLLOWUP_ELIGIBLE_SQL} AND u.last_inbound_at + INTERVAL '23 hours 55 minutes' > NOW() AND u.phone <> $2
    ) x`, [PAID_STATUSES, String(adminPhone || '')]);
  return res.rows[0]?.next ? new Date(res.rows[0].next) : null;
}

let jobsRunning = false;
async function runDueJobs(deps) {
  if (!deps.pool || jobsRunning) return null;
  jobsRunning = true;
  try {
    const result = { reminders: 0, checkins: 0, followups: 0, summary: 0 };
    result.reminders = await sendReminders(deps).catch(e => { console.error('Reminder job failed:', e.message); return 0; });
    result.checkins = await sendCheckins(deps).catch(e => { console.error('Check-in job failed:', e.message); return 0; });
    result.followups = await sendFollowups(deps).catch(e => { console.error('Follow-up job failed:', e.message); return 0; });
    result.summary = await sendOwnerSummary(deps).catch(e => { console.error('Owner summary failed:', e.message); return 0; });
    if (result.reminders || result.checkins || result.followups || result.summary) console.log('⏰ Scheduled messages sent:', JSON.stringify(result));
    return result;
  } finally {
    jobsRunning = false;
  }
}

module.exports = {
  PAID_STATUSES,
  isNewCustomerId,
  customerIdPrefix,
  nextCustomerId,
  migrate,
  recordInbound,
  saveTurn,
  loadRecentTurns,
  bookingHistory,
  profileContext,
  cleanExtracted,
  extractProfileDetails,
  applyProfileDetails,
  profilePayload,
  istDateTime,
  runDueJobs,
  nextDueAt,
  sendReminders,
  sendCheckins,
  sendFollowups,
  sendOwnerSummary,
  nextSummaryAt
};
