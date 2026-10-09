'use strict';

// Owner command /numerology: leads from the free mobile-numerology website (veshannastro-numerology).
// The website is a separate product with its own code; it only shares this database. It saves every unique lead
// in the `numerology_leads` table (and creates that table itself on its first lead). Kamala only reads it here.
//
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

module.exports = { report, parseArgs, formatLead, formatDob, pack, HELP, NO_TABLE, MESSAGE_LIMIT };
