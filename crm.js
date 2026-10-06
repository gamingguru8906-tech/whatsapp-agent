'use strict';

/**
 * Customer memory, invoice numbers, consultation reminders and follow-ups.
 *
 * WhatsApp only allows free-form messages within 24 hours of the customer's
 * last message, so every scheduled message here is sent inside that window.
 */

const PAID_STATUSES = ['paid', 'gateway_test_paid'];
// Invoice numbers look like VA/26-27/09-001: financial year, month, then a serial that restarts monthly.
// (This is the format that used to be the customer ID; customers are now tracked by invoice number only.)
const INVOICE_NO_RE = /^VA\/\d{2}-\d{2}\/\d{2}-\d{3,}$/;

function isInvoiceNumber(id) {
  return INVOICE_NO_RE.test(String(id || '').trim());
}

/** "VA/26-27/09-" for September 2026 (Indian financial year April-March, IST). */
function invoicePrefix(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit' })
    .formatToParts(date);
  const year = Number(parts.find(p => p.type === 'year').value);
  const month = Number(parts.find(p => p.type === 'month').value);
  const fyStart = month >= 4 ? year : year - 1;
  const yy = n => String(n % 100).padStart(2, '0');
  return `VA/${yy(fyStart)}-${yy(fyStart + 1)}/${String(month).padStart(2, '0')}-`;
}

/** Next number for this month given every number already issued (serial restarts monthly). */
function nextInvoiceNumber(existingIds, date = new Date()) {
  const prefix = invoicePrefix(date);
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

/** Hands out the next invoice number from the database, one per invoice, safe under concurrent bookings. */
async function allocateInvoiceNumber(pool, date = new Date()) {
  const prefix = invoicePrefix(date);
  const res = await pool.query(`INSERT INTO invoice_counters (prefix, last_no) VALUES ($1, 1)
    ON CONFLICT (prefix) DO UPDATE SET last_no = invoice_counters.last_no + 1 RETURNING last_no`, [prefix]);
  return prefix + String(res.rows[0].last_no).padStart(3, '0');
}

async function migrate(pool) {
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS followup_sent_for TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_restored BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS problem_category TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS problem_subtype TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS money_pressure BOOLEAN;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS emotional_state TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS emotion_intensity TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS core_concern TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS unspoken_question TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reading_confidence TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS reading_updated_at TIMESTAMPTZ;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS meet_link TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS reminder_status TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS checkin_for TIMESTAMPTZ;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS checkin_sent_at TIMESTAMPTZ;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS payment_url TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
    -- Links that already existed when this column arrived count as nudged (the old in-memory nudge may have gone out).
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS nudge_sent_at TIMESTAMPTZ DEFAULT NOW();
    ALTER TABLE wa_payment_links ALTER COLUMN nudge_sent_at DROP DEFAULT;
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

// Removes copy-paste repetition from a reply: the whole message repeated back to back
// ("Got it... ?Got it... ?Got it... ?") or the same sentence said twice in one message.
function collapseRepeats(text) {
  let s = String(text == null ? '' : text).trim();
  if (s.length < 20) return s;
  const whole = s.match(/^([\s\S]{10,}?)(?:\s*\1)+$/);
  if (whole) s = whole[1].trim();
  const pieces = s.match(/[^.!?\u0964\n]+(?:[.!?\u0964]+|\n+|$)\s*/g) || [s];
  const seen = new Set();
  const kept = [];
  let dropped = false;
  for (const piece of pieces) {
    const key = piece.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (key.length >= 20 && seen.has(key)) { dropped = true; continue; }
    if (key.length >= 20) seen.add(key);
    const prev = kept[kept.length - 1];
    // After a dropped copy, keep a space between the sentences either side of it.
    kept.push(dropped && prev && !/\s$/.test(prev) ? ' ' + piece : piece);
    dropped = false;
  }
  return kept.join('').trim();
}

/** Last text turns in Gemini format, oldest first, always starting with a user turn. */
async function loadRecentTurns(pool, phone, limit = 16) {
  if (!pool) return [];
  const res = await pool.query('SELECT role, text, created_at FROM wa_messages WHERE phone=$1 ORDER BY id DESC LIMIT $2',
    [String(phone), limit]);
  const turns = res.rows.reverse();
  while (turns.length && turns[0].role !== 'user') turns.shift();
  const out = [];
  for (const t of turns) {
    const text = t.role === 'model' ? collapseRepeats(t.text) : t.text;
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role && prev.parts[0].text === text) continue; // same reply stored twice
    out.push({ role: t.role, parts: [{ text }], createdAt: t.created_at });
  }
  return out;
}

async function bookingHistory(pool, phone) {
  if (!pool) return [];
  const res = await pool.query(`SELECT service_name, appointment_start, status, request_invoice_number FROM wa_payment_links
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
- Everything above is for YOUR understanding only. Never read out, list or repeat the person's stored details (birth date/time/place, email, address, invoice numbers, past chats) unless they themselves ask for them.
- RETURNING PERSON: if a name is known and this is the start of a new conversation (previous conversation is not "Ongoing chat"), your FIRST reply must greet them warmly by first name, like an old friend who is happy to hear from them again, and gently ask whether their earlier concern has improved — mention the topic softly in one or two words (e.g. "career wali pareshani", "shaadi ki baat"), never details. Example: "Arre Priya ji, kitne time baad! How have you been? Last time aap career ko lekar thoda worried thin — ab kaisa chal raha hai?" If no concern is recorded, just ask how they have been.
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

// ---------- Reading the person: problem type + emotional state ----------

const CATEGORY_LABELS = { marriage_family: 'Marriage/Family', career_business: 'Career/Business', other: 'Other', unclear: 'Unclear' };
const CONFIDENCE_RANK = { low: 1, medium: 2, high: 3 };

/** Run a reading from the 2nd message on, every message up to the 10th, then every 4th. */
function shouldReadEmotion(messageCount) {
  const n = Number(messageCount) || 0;
  return n >= 2 && (n <= 10 || n % 4 === 0);
}

function cleanReading(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (v, allowed, dflt) => (allowed.includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : dflt);
  const str = (v, max) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const out = {
    category: pick(raw.category, Object.keys(CATEGORY_LABELS), 'unclear'),
    subtype: str(raw.subtype, 80),
    money_pressure: raw.money_pressure === true,
    emotion: str(raw.emotion, 60),
    intensity: pick(raw.intensity, ['low', 'medium', 'high'], 'low'),
    core_concern: str(raw.core_concern, 240),
    unspoken_question: str(raw.unspoken_question, 160),
    confidence: pick(raw.confidence, ['low', 'medium', 'high'], 'low')
  };
  if (out.category === 'unclear' && !out.emotion) return null;
  return out;
}

/** Reads the last few turns and returns what the person is really going through. */
async function analyzeEmotion(genAI, SchemaType, modelName, turns) {
  const lines = (turns || []).map(t => `${t.role === 'user' ? 'Person' : 'Kamala'}: ${String(t.parts?.[0]?.text || t.text || '').slice(0, 600)}`);
  if (!genAI || lines.filter(l => l.startsWith('Person:')).length < 2) return null;
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          category: { type: SchemaType.STRING, enum: ['marriage_family', 'career_business', 'other', 'unclear'] },
          subtype: { type: SchemaType.STRING, description: 'short, e.g. delayed marriage, fights with spouse, in-laws, kids, job culture/boss, job loss, business losses, debt' },
          money_pressure: { type: SchemaType.BOOLEAN, description: 'true if money worry is present or clearly underneath' },
          emotion: { type: SchemaType.STRING, description: '1-3 plain words for how they feel, e.g. anxious, stuck, hurt, exhausted, hopeless, angry, lonely' },
          intensity: { type: SchemaType.STRING, enum: ['low', 'medium', 'high'] },
          core_concern: { type: SchemaType.STRING, description: 'one line: the deeper worry beneath what they said' },
          unspoken_question: { type: SchemaType.STRING, description: 'the question in their heart, in their own language, e.g. "Kya meri shaadi kabhi hogi?"' },
          confidence: { type: SchemaType.STRING, enum: ['low', 'medium', 'high'] }
        },
        required: ['category', 'emotion', 'intensity', 'confidence']
      }
    }
  });
  const prompt = `You help an Indian astrology consultant understand a person who messaged on WhatsApp.
In this practice nearly every problem falls in one of two groups:
- marriage_family: marriage delay, spouse, relationship, divorce, in-laws, kids, parents, family peace.
- career_business: job, job culture, boss, promotion, job loss, studies for a career, business, sales, debts, losses.
Money is underneath most problems (about 99%): set money_pressure true when money worry is stated or clearly implied (EMIs, salary, losses, dowry, cost of a divorce, providing for family).
Read the chat below. Judge from what the person actually wrote and how they wrote it (word choice, length, punctuation, repetition, time of day hints). Do not invent facts they did not give.
Use confidence "low" when there are too few clues; "medium" when the signs point one way; "high" only when they said it plainly.

Chat (oldest first):
${lines.join('\n').slice(-5000)}`;
  const result = await model.generateContent(prompt);
  return cleanReading(JSON.parse(result.response.text()));
}

/** Saves a reading unless it is weaker than one we already hold for this person. */
async function applyReading(pool, phone, reading) {
  if (!reading) return false;
  const current = (await pool.query('SELECT problem_category, reading_confidence, reading_updated_at FROM users WHERE phone=$1', [phone])).rows[0];
  if (!current) return false;
  const fresh = !current.reading_updated_at || (Date.now() - new Date(current.reading_updated_at).getTime()) > 30 * 24 * 3600 * 1000;
  const weaker = (CONFIDENCE_RANK[reading.confidence] || 0) < (CONFIDENCE_RANK[current.reading_confidence] || 0);
  if (!fresh && (weaker || reading.category === 'unclear') && current.problem_category) return false;
  await pool.query(`UPDATE users SET problem_category=$2, problem_subtype=$3, money_pressure=$4, emotional_state=$5,
      emotion_intensity=$6, core_concern=$7, unspoken_question=$8, reading_confidence=$9, reading_updated_at=NOW() WHERE phone=$1`,
  [phone, reading.category, reading.subtype, reading.money_pressure, reading.emotion, reading.intensity,
    reading.core_concern, reading.unspoken_question, reading.confidence]);
  return true;
}

/** Short tag for the owner and the sheet, e.g. "Career/Business (job culture) · money pressure · anxious (high)". */
function readingTag(user) {
  const u = user || {};
  if (!u.problem_category || u.problem_category === 'unclear') return '';
  return [
    `${CATEGORY_LABELS[u.problem_category] || u.problem_category}${u.problem_subtype ? ` (${u.problem_subtype})` : ''}`,
    u.money_pressure ? 'money pressure' : '',
    u.emotional_state ? `${u.emotional_state}${u.emotion_intensity ? ` (${u.emotion_intensity})` : ''}` : ''
  ].filter(Boolean).join(' · ');
}

/** Private prompt block that lets Kamala make the person feel understood. */
function readingContext(user) {
  const u = user || {};
  if (!u.problem_category || u.problem_category === 'unclear' || u.reading_confidence === 'low') {
    return `--- READING THE PERSON (PRIVATE) ---
- Not clear yet what is really troubling them. Keep listening warmly. With one soft question, find out whether it is more about family/marriage or about work/business — and how long it has been weighing on them.`;
  }
  return `--- READING THE PERSON (PRIVATE — never label it, never call it an analysis) ---
- What it is really about: ${readingTag(u)}
- The worry under the words: ${u.core_concern || 'not clear yet'}
- The question in their heart: ${u.unspoken_question || 'not clear yet'}
- How sure this reading is: ${u.reading_confidence}
HOW TO USE THIS:
- Make them feel deeply understood, as if you can see what they have not said yet. Once, at a natural moment (usually your 3rd or 4th reply), gently name their feeling and the worry underneath as a soft question, never as a verdict. Example: "Mujhe lag raha hai it's not just about the job... andar kahin money ki tension bhi chal rahi hai, right?"
- Use their own words for feelings. Never use clinical labels (depression, anxiety disorder, trauma) and never say you "analysed" or "predicted" anything.
- ${u.reading_confidence === 'high' ? 'They said this plainly, so you can reflect it with warmth and confidence.' : 'This is a gentle guess: phrase it softly. If they say no, accept it warmly and ask what it really is.'}
- Money is usually under the surface. Touch it softly and never make them feel judged or small.
- ${u.emotion_intensity === 'high' ? 'Their feelings are strong right now: comfort first, slow down, and do not sell in this reply.' : 'After they feel understood, move forward with care.'}
- Do not repeat the same reflection twice in a conversation.`;
}

function profilePayload(user, extra = {}) {
  const u = user || {};
  return {
    target: 'profile_upsert',
    phone: u.phone,
    name: u.name || '', gender: u.gender || '', dob: u.dob || '', birthTime: u.tob || '', birthPlace: u.pob || '',
    email: u.email || '', billingAddress: u.billing_address || '', customerGstin: u.customer_gstin || '',
    concern: [u.pain_point || u.core_concern || '', readingTag(u) ? `[${readingTag(u)}]` : ''].filter(Boolean).join(' '),
    remedies: u.remedies_prescribed || '',
    firstContact: u.first_contact ? istDateTime(u.first_contact) : '',
    lastContact: istDateTime(new Date()),
    source: 'WhatsApp',
    ...extra
  };
}

// ---------- Scheduled jobs ----------

const WINDOW_OPEN_SQL = "u.last_inbound_at > NOW() - INTERVAL '23 hours 58 minutes'";

// When the day-after follow-up goes out: 23 hours after their last message, or, if that falls at night
// in India (before 9 AM / after 9 PM), at 8:30 PM IST the evening before, still inside WhatsApp's 24h window.
const FOLLOWUP_AT_SQL = `(CASE
  WHEN EXTRACT(HOUR FROM (u.last_inbound_at + INTERVAL '23 hours') AT TIME ZONE 'Asia/Kolkata') BETWEEN 9 AND 20
    THEN u.last_inbound_at + INTERVAL '23 hours'
  ELSE (date_trunc('day', (u.last_inbound_at + INTERVAL '23 hours' - INTERVAL '9 hours') AT TIME ZONE 'Asia/Kolkata')
    + INTERVAL '20 hours 30 minutes') AT TIME ZONE 'Asia/Kolkata'
END)`;

const FOLLOWUP_ELIGIBLE_SQL = `
  u.last_inbound_at IS NOT NULL
  AND COALESCE(u.is_paused,false) = false
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

// One nudge for an unpaid payment link: 2 hours after it was sent and 30 minutes after the customer's last message,
// or at 9 AM IST if that falls at night. It goes only while the link has 15+ minutes left and WhatsApp's 24-hour
// window allows a free message. Kept in the database so it survives the server sleeping or restarting.
const NUDGE_BASE_SQL = "GREATEST(l.created_at + INTERVAL '2 hours', u.last_inbound_at + INTERVAL '30 minutes')";
const NUDGE_AT_SQL = `(CASE
  WHEN EXTRACT(HOUR FROM ${NUDGE_BASE_SQL} AT TIME ZONE 'Asia/Kolkata') BETWEEN 9 AND 20 THEN ${NUDGE_BASE_SQL}
  ELSE (date_trunc('day', (${NUDGE_BASE_SQL} AT TIME ZONE 'Asia/Kolkata') + INTERVAL '3 hours') + INTERVAL '9 hours') AT TIME ZONE 'Asia/Kolkata'
END)`;
const NUDGE_DEADLINE_SQL = `LEAST(
  COALESCE(l.expires_at, LEAST(l.created_at + INTERVAL '12 hours', l.appointment_start - INTERVAL '30 minutes')) - INTERVAL '15 minutes',
  u.last_inbound_at + INTERVAL '23 hours 58 minutes')`;
const NUDGE_ELIGIBLE_SQL = `
  l.status = 'request_created' AND l.nudge_sent_at IS NULL
  AND u.last_inbound_at IS NOT NULL
  AND COALESCE(u.is_paused,false) = false
  AND COALESCE(u.marketing_opt_out,false) = false
  AND ${NUDGE_AT_SQL} < ${NUDGE_DEADLINE_SQL}
  AND NOW() < ${NUDGE_DEADLINE_SQL}`;

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

/** The slot really is held until the link expires, so the nudge says until when and gives the link again. */
function paymentNudgeText(link) {
  const name = firstName(link.customer_name);
  const expires = link.expires_at ? new Date(link.expires_at) : new Date(Math.min(
    new Date(link.created_at).getTime() + 12 * 3600 * 1000,
    new Date(link.appointment_start).getTime() - 30 * 60 * 1000));
  return `Hi${name ? ` ${name} ji` : ''}, aapke ${link.service_name} ke liye ${istDateTime(link.appointment_start)} wala slot abhi hold par hai.`
    + ` Payment link ${istDateTime(expires)} tak valid hai${link.payment_url ? `: ${link.payment_url}` : '.'}`
    + '\n\nLink mein koi help chahiye ho ya time badalna ho toh bas yahin bata dijiye.';
}

async function sendPaymentNudges(deps) {
  const { pool, sendCustomerText } = deps;
  const due = await pool.query(`SELECT l.payment_link_id FROM wa_payment_links l JOIN users u ON u.phone=l.phone
    WHERE ${NUDGE_ELIGIBLE_SQL} AND NOW() >= ${NUDGE_AT_SQL}`);
  let sent = 0;
  for (const { payment_link_id: id } of due.rows) {
    const claimed = await pool.query(`UPDATE wa_payment_links SET nudge_sent_at=NOW()
      WHERE payment_link_id=$1 AND nudge_sent_at IS NULL AND status='request_created' RETURNING *`, [id]);
    const link = claimed.rows[0];
    if (!link) continue;
    if (await sendCustomerText(link.phone, paymentNudgeText(link))) sent++;
  }
  return sent;
}

async function writeFollowup(deps, user) {
  const fallback = `Hi${user.name ? ' ' + firstName(user.name) + ' ji' : ''}, main aapke baare mein hi soch rahi thi. If you still want some clarity, main aapke liye consultation ka ek suitable time dekh sakti hoon. Just reply kar dijiye.`;
  if (!deps.genAI) return fallback;
  try {
    const turns = await loadRecentTurns(deps.pool, user.phone, 12);
    const transcript = turns.map(t => `${t.role === 'user' ? 'Customer' : 'Assistant'}: ${t.parts[0].text}`).join('\n').slice(-3000);
    const model = deps.genAI.getGenerativeModel({ model: deps.modelName, generationConfig: { temperature: 0.6 } });
    const res = await model.generateContent(`You write one short WhatsApp follow-up (max 2 sentences, warm Hinglish with Hindi and English mixed inside the same sentence, Hindi in Roman letters, never fully Hindi, no emojis, no bullet points) for a customer who chatted with an astrology consultation assistant yesterday but did not book.
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
    AND NOW() >= ${FOLLOWUP_AT_SQL}
    AND NOW() < u.last_inbound_at + INTERVAL '23 hours 55 minutes'
    AND u.phone <> $2`, [PAID_STATUSES, String(adminPhone || '')]);
  let sent = 0;
  for (const { phone } of due.rows) {
    const claimed = await pool.query(`UPDATE users SET followup_sent_for=last_inbound_at, last_followup_at=NOW()
      WHERE phone=$1 AND followup_sent_for IS DISTINCT FROM last_inbound_at RETURNING *`, [phone]);
    const user = claimed.rows[0];
    if (!user) continue;
    if (await sendCustomerText(phone, await writeFollowup(deps, user))) {
      sent++;
      // Leads are asked once, right after the follow-up, whether they want festival reminders and updates.
      if (deps.afterFollowup) await deps.afterFollowup(phone).catch(e => console.error('Opt-in ask failed:', e.message));
    }
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
  const consults = (await pool.query(`SELECT l.*, u.pain_point, u.problem_category, u.problem_subtype, u.money_pressure, u.emotional_state, u.emotion_intensity FROM wa_payment_links l LEFT JOIN users u ON u.phone=l.phone
    WHERE l.status = ANY($1) AND l.appointment_start >= $2 AND l.appointment_start < $3 ORDER BY l.appointment_start`,
  [PAID_STATUSES, start, end])).rows;
  const stats = (await pool.query(`SELECT
      (SELECT COUNT(*) FROM users WHERE first_contact >= $1 AND first_contact < $2) AS new_people,
      (SELECT COUNT(*) FROM users WHERE last_inbound_at >= $1 AND last_inbound_at < $2) AS active_people,
      (SELECT COUNT(*) FROM wa_payment_links WHERE status = ANY($3) AND updated_at >= $1 AND updated_at < $2) AS bookings`,
  [dayBefore, start, PAID_STATUSES])).rows[0];
  const time = d => new Date(d).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' });
  const list = consults.length ? consults.map((c, i) => `${i + 1}. ${time(c.appointment_start)} — ${c.customer_name}${c.status === 'gateway_test_paid' ? ' (₹1 test)' : ''}\n`
    + `   ${c.service_name} | ${c.request_invoice_number || 'Invoice pending'} | +${c.phone}\n`
    + `   DOB ${c.dob || '-'}, ${c.tob || '-'}, ${c.pob || '-'}\n`
    + `   Concern: ${c.pain_point || 'Not recorded'}\n`
    + (readingTag(c) ? `   Reading: ${readingTag(c)}\n` : '')
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
      SELECT ${FOLLOWUP_AT_SQL} FROM users u
        WHERE ${FOLLOWUP_ELIGIBLE_SQL} AND u.last_inbound_at + INTERVAL '23 hours 55 minutes' > NOW() AND u.phone <> $2
      UNION ALL
      SELECT ${NUDGE_AT_SQL} FROM wa_payment_links l JOIN users u ON u.phone=l.phone WHERE ${NUDGE_ELIGIBLE_SQL}
    ) x`, [PAID_STATUSES, String(adminPhone || '')]);
  return res.rows[0]?.next ? new Date(res.rows[0].next) : null;
}

let jobsRunning = false;
async function runDueJobs(deps) {
  if (!deps.pool || jobsRunning) return null;
  jobsRunning = true;
  try {
    const result = { reminders: 0, checkins: 0, nudges: 0, followups: 0, summary: 0 };
    result.reminders = await sendReminders(deps).catch(e => { console.error('Reminder job failed:', e.message); return 0; });
    result.checkins = await sendCheckins(deps).catch(e => { console.error('Check-in job failed:', e.message); return 0; });
    result.nudges = await sendPaymentNudges(deps).catch(e => { console.error('Payment nudge job failed:', e.message); return 0; });
    result.followups = await sendFollowups(deps).catch(e => { console.error('Follow-up job failed:', e.message); return 0; });
    result.summary = await sendOwnerSummary(deps).catch(e => { console.error('Owner summary failed:', e.message); return 0; });
    if (result.reminders || result.checkins || result.nudges || result.followups || result.summary) console.log('⏰ Scheduled messages sent:', JSON.stringify(result));
    return result;
  } finally {
    jobsRunning = false;
  }
}

module.exports = {
  PAID_STATUSES,
  isInvoiceNumber,
  invoicePrefix,
  nextInvoiceNumber,
  allocateInvoiceNumber,
  isNewCustomerId: isInvoiceNumber, // old name, kept so a partly deployed server keeps working
  migrate,
  recordInbound,
  saveTurn,
  collapseRepeats,
  loadRecentTurns,
  bookingHistory,
  profileContext,
  cleanExtracted,
  extractProfileDetails,
  applyProfileDetails,
  profilePayload,
  shouldReadEmotion,
  cleanReading,
  analyzeEmotion,
  applyReading,
  readingTag,
  readingContext,
  istDateTime,
  runDueJobs,
  nextDueAt,
  sendReminders,
  sendCheckins,
  paymentNudgeText,
  sendPaymentNudges,
  sendFollowups,
  sendOwnerSummary,
  nextSummaryAt
};
