'use strict';

// Leads from the free mobile-numerology website (veshannastro-numerology). The website is a separate product with
// its own code; it only shares this database. It saves every unique lead in the `numerology_leads` table (and
// creates that table itself on its first lead), with a short summary of the reading it showed. Kamala only reads it:
//
// 1. When that person messages on WhatsApp, Kamala knows their reading and answers the query they came with.
//    The website's button sends "Reading ID: NM-xxxxxxxx" (the first 8 characters of the lead's key), which links
//    the exact reading even from a different phone; otherwise the WhatsApp number is matched to the mobile entered.
// 2. Owner command:
//   /numerology           counts + the latest 10 leads
//   /numerology 25        the latest 25 (up to 50)
//   /numerology rahul     search by name or concern
//   /numerology 98110     search by mobile number (4+ digits)
//   /numerology help      this list

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
const SEARCH_LIMIT = 20;
const MESSAGE_LIMIT = 3500; // WhatsApp allows 4096 characters per text; keep a margin

const HELP = `🔢 *Numerology leads* (from the free mobile numerology website)
/numerology — counts and the latest ${DEFAULT_LIMIT} leads
/numerology 25 — the latest 25 (up to ${MAX_LIMIT})
/numerology rahul — search by name or concern
/numerology 98110 — search by mobile number`;

const NO_TABLE = 'No numerology leads yet. The list starts when the first person submits the form on the website.';

/** What the owner asked for: help, the latest N, or a search. */
function parseArgs(args = []) {
  const text = args.join(' ').trim();
  if (!text) return { mode: 'latest', limit: DEFAULT_LIMIT };
  if (/^(help|\?)$/i.test(text)) return { mode: 'help' };
  if (/^\d{1,3}$/.test(text)) return { mode: 'latest', limit: Math.min(Math.max(Number(text), 1), MAX_LIMIT) };
  const digits = text.replace(/[\s+()-]/g, '');
  if (/^\d{4,}$/.test(digits)) {
    // A full WhatsApp number (91XXXXXXXXXX) matches the 10-digit mobile the website stores.
    return { mode: 'mobile', digits: digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits.replace(/^0(?=\d{10}$)/, '') };
  }
  if (text.length < 2) return { mode: 'help' };
  return { mode: 'text', query: text.slice(0, 60) };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "1988-10-29" -> "29 Oct 1988", without any time-zone shift.
function formatDob(dob) {
  const m = String(dob || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(dob || '');
}

function formatWhen(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatLead(lead, n) {
  const mobile = String(lead.mobile || '');
  const concern = String(lead.concern || '').replace(/\s+/g, ' ').trim();
  const planned = String(lead.planned || '').split(',').map(s => s.trim()).filter(Boolean);
  const lines = [
    `${n}. *${String(lead.name || '').trim() || 'No name'}* · ${mobile}`,
    `   DOB ${formatDob(lead.dob)} · ${formatWhen(lead.created_at)}`,
    `   Concern: ${concern.length > 300 ? `${concern.slice(0, 297)}...` : concern}`
  ];
  if (planned.length) lines.push(`   Planned: ${planned.join(', ')}`);
  lines.push(`   WhatsApp updates: ${lead.wa_opt_in ? 'Yes' : 'No'} · Chat: wa.me/91${mobile}`);
  return lines.join('\n');
}

/** Splits into WhatsApp-sized messages without cutting a lead in half. */
function pack(header, blocks, footer) {
  const messages = [];
  let current = header;
  for (const block of blocks) {
    if (current.length + block.length + 2 > MESSAGE_LIMIT) { messages.push(current); current = block; } else current += `\n\n${block}`;
  }
  if (footer) {
    if (current.length + footer.length + 2 > MESSAGE_LIMIT) { messages.push(current); current = footer; } else current += `\n\n${footer}`;
  }
  messages.push(current);
  return messages;
}

const LEAD_COLUMNS = 'id, name, mobile, dob::text AS dob, concern, planned, wa_opt_in, created_at';

/** Builds the reply for /numerology. Always resolves to one or more messages, never throws. */
async function report(pool, args = []) {
  const ask = parseArgs(args);
  if (ask.mode === 'help') return [HELP];
  if (!pool) return ['Database not connected.'];
  try {
    if (ask.mode === 'latest') {
      const counts = (await pool.query(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS today,
        count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS week,
        count(*) FILTER (WHERE wa_opt_in)::int AS opted_in,
        count(*) FILTER (WHERE planned <> '')::int AS planned
        FROM numerology_leads`)).rows[0];
      if (!counts.total) return [NO_TABLE];
      const leads = (await pool.query(`SELECT ${LEAD_COLUMNS} FROM numerology_leads ORDER BY created_at DESC, id DESC LIMIT $1`, [ask.limit])).rows;
      const header = `🔢 *Numerology leads*
Total ${counts.total} · Today ${counts.today} · Last 7 days ${counts.week}
WhatsApp opt-in: ${counts.opted_in} · Checked a new number: ${counts.planned}

*Latest ${leads.length}:*`;
      const footer = leads.length < counts.total ? `More: /numerology ${Math.min(ask.limit * 2, MAX_LIMIT)} · Search: /numerology rahul or /numerology 98110` : '';
      return pack(header, leads.map((l, i) => formatLead(l, i + 1)), footer);
    }

    let leads;
    let label;
    if (ask.mode === 'mobile') {
      label = `mobile containing ${ask.digits}`;
      leads = (await pool.query(`SELECT ${LEAD_COLUMNS} FROM numerology_leads WHERE mobile LIKE $1
        ORDER BY created_at DESC, id DESC LIMIT $2`, [`%${ask.digits}%`, SEARCH_LIMIT])).rows;
    } else {
      label = `"${ask.query}"`;
      const pattern = `%${ask.query.replace(/[\\%_]/g, c => `\\${c}`)}%`;
      leads = (await pool.query(`SELECT ${LEAD_COLUMNS} FROM numerology_leads WHERE name ILIKE $1 OR concern ILIKE $1
        ORDER BY created_at DESC, id DESC LIMIT $2`, [pattern, SEARCH_LIMIT])).rows;
    }
    if (!leads.length) return [`No numerology leads match ${label}.`];
    const header = `🔢 *Numerology leads matching ${label}:* ${leads.length}${leads.length === SEARCH_LIMIT ? ` (latest ${SEARCH_LIMIT} shown)` : ''}`;
    return pack(header, leads.map((l, i) => formatLead(l, i + 1)), '');
  } catch (e) {
    if (e.code === '42P01') return [NO_TABLE]; // the website has not saved its first lead yet
    console.error('Numerology leads lookup failed:', e.message);
    return [`❌ Could not read numerology leads: ${e.message}`];
  }
}

// ---------- Kamala answers the website query ----------

// "Reading ID: NM-1a2b3c4d." anywhere in the message (as the website's WhatsApp button writes it).
const READING_ID_RE = /(?:\breading\s*id\s*[:#-]?\s*)?\bNM-([0-9a-f]{8})\b\.?/i;

function extractReadingId(text) {
  const s = String(text || '');
  const m = s.match(READING_ID_RE);
  if (!m) return { id: null, clean: s };
  const clean = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
  return { id: m[1].toLowerCase(), clean };
}

async function migrate(pool) {
  if (!pool) return;
  // Which website reading this person came from (8 hex characters of numerology_leads.dedupe_key).
  await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS numerology_ref TEXT');
}

async function rememberReading(pool, phone, id) {
  if (!pool || !/^[0-9a-f]{8}$/.test(String(id || ''))) return false;
  await pool.query('UPDATE users SET numerology_ref = $2 WHERE phone = $1', [phone, id]);
  return true;
}

// WhatsApp sends 91XXXXXXXXXX; the website stores the 10-digit Indian mobile.
const localMobile = phone => {
  const d = String(phone || '').replace(/\D/g, '');
  return d.length === 12 && d.startsWith('91') ? d.slice(2) : null;
};

/**
 * The person's website reading: the linked one (Reading ID) first, otherwise the latest for their WhatsApp number.
 * Returns { lead, others } where others are their other website entries (other concerns). Never throws.
 */
async function findForPerson(pool, phone) {
  const none = { lead: null, others: [] };
  if (!pool || !phone) return none;
  try {
    const ref = (await pool.query('SELECT numerology_ref FROM users WHERE phone = $1', [phone])).rows[0]?.numerology_ref || null;
    const mobile = localMobile(phone);
    if (!ref && !mobile) return none;
    const rows = (await pool.query(`SELECT ${LEAD_COLUMNS}, dedupe_key, reading_summary, COALESCE(dedupe_key LIKE $1 || '%', false) AS linked
      FROM numerology_leads
      WHERE ($1::text IS NOT NULL AND dedupe_key LIKE $1 || '%') OR mobile = $2
      ORDER BY linked DESC, created_at DESC LIMIT 4`, [ref, mobile || ''])).rows;
    if (!rows.length) return none;
    return { lead: rows[0], others: rows.slice(1) };
  } catch (e) {
    if (e.code !== '42P01' && e.code !== '42703') console.error('Numerology reading lookup failed:', e.message);
    return none; // no website table (yet), or an older one: Kamala carries on as usual
  }
}

/**
 * Fills only the profile details Kamala does not have yet (name, date of birth, concern), and only when the number
 * checked on the website is the one they are writing from: a reading for another number may be a family member's.
 * True if anything changed.
 */
async function fillProfile(pool, phone, user, lead) {
  if (!pool || !lead) return false;
  if (String(lead.mobile || '') !== localMobile(phone)) return false;
  const u = user || {};
  const empty = v => !String(v || '').trim();
  const name = empty(u.name) ? String(lead.name || '').trim() : '';
  const dob = empty(u.dob) ? formatDob(lead.dob) : '';
  const concern = empty(u.pain_point) ? String(lead.concern || '').trim().slice(0, 240) : '';
  if (!name && !dob && !concern) return false;
  await pool.query(`UPDATE users SET name = COALESCE(NULLIF(name, ''), NULLIF($2, '')), dob = COALESCE(NULLIF(dob, ''), NULLIF($3, '')),
    pain_point = COALESCE(NULLIF(pain_point, ''), NULLIF($4, '')) WHERE phone = $1`, [phone, name, dob, concern]);
  return true;
}

/**
 * Private system-prompt block. Empty when the person has no website reading.
 * firstChat: no earlier WhatsApp conversation. Their name may then be known only from the website form, which must
 * not trigger profileContext's RETURNING PERSON greeting.
 */
function promptContext(found, phone, { firstChat = false } = {}) {
  const lead = found?.lead;
  if (!lead) return '';
  const mobile = String(lead.mobile || '');
  const own = mobile === localMobile(phone);
  const planned = String(lead.planned || '').split(',').map(x => x.trim()).filter(Boolean);
  const others = (found.others || []).map(o => `"${String(o.concern || '').replace(/\s+/g, ' ').trim().slice(0, 120)}"`);
  const summary = String(lead.reading_summary || '').trim();
  return `--- THEIR FREE MOBILE NUMEROLOGY READING FROM OUR WEBSITE (PRIVATE) ---
They checked a mobile number on Veshannastro's free numerology page on ${formatWhen(lead.created_at)} and then came to WhatsApp. This reading and their concern are the query they came with.
- Name they entered: ${String(lead.name || '').trim() || 'Not given'}
- Date of birth they entered: ${formatDob(lead.dob)}
- Mobile number they checked: ${mobile} (${own ? 'the same number they are writing from' : 'not the number they are writing from; it may be a family member\'s'})
- Their concern, in their own words: "${String(lead.concern || '').replace(/\s+/g, ' ').trim().slice(0, 300)}"
- New numbers they were thinking of buying: ${planned.length ? planned.join(', ') : 'none'}${others.length ? `\n- Other concerns they also entered on the website: ${others.join('; ')}` : ''}
WHAT THE WEBSITE SHOWED THEM (Shri Shashank ji's rulebook, word for word; these are your ONLY numerology facts):
${summary || '(The summary is not available. Use only the concern above.)'}
HOW TO USE THIS:${firstChat ? `
- This is their FIRST chat with you. Their name and birth date came from the website form, not from an earlier chat, so this overrides the RETURNING PERSON rule: greet them as someone new who has just seen their reading, never as an old friend ("kitne time baad" is wrong here).` : ''}
- Their concern is the question they came with. In your first reply, greet them by first name, tell them warmly that you have their reading in front of you, and speak to their concern with one or two points above that relate to it, in simple Hinglish. Do not read out the whole reading; they have already seen it.
${own ? '- Never ask again for their name, date of birth, mobile number or concern.'
    : `- The number they checked is not the one they are writing from, so these details may be a family member's. Before using the name, gently confirm whose reading it is (for example: "Yeh reading aapke liye thi ya family mein kisi ke liye?"). Never ask again for that reading's date of birth, number or concern.`}
- Use only the points above. Never invent a meaning, a yoga, a remedy, a lucky or "good" number, and never work anything out about a number yourself. If they ask something these points do not cover (which new number to take, which digits to change, timing, their full chart), say that this needs Shri Shashank ji's personal analysis and offer the matching consultation from the LIVE SERVICES DATA.
- If they were comparing new numbers, the counts above are all the website showed; choosing the right number is part of the consultation.
- Health points are guidance, not a diagnosis; for anything about health, also gently suggest seeing a doctor.
- The reading is guidance, not a guarantee. Stay hopeful: every concern has a way forward, and the consultation is where it is worked out.`;
}

// Sign in on the numerology website ("My readings"). The page shows a 6-digit code and a WhatsApp button that sends
// "LOGIN 123456" here. The code is marked as sent from this WhatsApp number, which signs the page in; the website
// owns the numerology_logins table (mobile-numerology/db/schema.js). Only the exact message is taken, so a
// birth date or a number in a normal chat is never mistaken for a code.
const LOGIN_RE = /^\s*login\s*[:#-]?\s*(\d{6})\s*\.?\s*$/i;
const extractLoginCode = text => (String(text || '').match(LOGIN_RE) || [])[1] || null;

const LOGIN_REPLY = {
  ok: '✅ You are signed in on the Veshannastro website. Go back to the page: your readings will appear there in a moment.',
  bad: 'That sign-in code has expired or was already used. Please tap "Sign in with WhatsApp" on the website again to get a new code.',
  foreign: 'Sign-in on the website works with Indian (+91) WhatsApp numbers only. You can still message us here for your reading or a consultation.'
};

/** Marks a website sign-in code as sent from this WhatsApp number. Returns 'ok' | 'bad' | 'foreign'. Never throws. */
async function verifyLogin(pool, phone, code) {
  if (!localMobile(phone)) return 'foreign';
  if (!pool || !/^\d{6}$/.test(String(code || ''))) return 'bad';
  try {
    const { rows } = await pool.query(`UPDATE numerology_logins SET verified_at = now(), phone = $2
      WHERE code = $1 AND verified_at IS NULL AND created_at > now() - interval '15 minutes' RETURNING id`, [code, phone]);
    return rows.length ? 'ok' : 'bad';
  } catch (e) {
    if (e.code !== '42P01') console.error('Website sign-in failed:', e.message); // 42P01: no sign-in has been made yet
    return 'bad';
  }
}

module.exports = {
  extractLoginCode, verifyLogin, LOGIN_REPLY,
  report, parseArgs, formatLead, formatDob, pack, HELP, NO_TABLE, MESSAGE_LIMIT,
  extractReadingId, migrate, rememberReading, findForPerson, fillProfile, promptContext, localMobile
};
