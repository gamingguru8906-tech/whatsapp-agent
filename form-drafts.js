'use strict';
// The 2027 order form on the website, saved while the person is still typing (before they press anything).
//
// The website sends the form as it stands every few seconds (POST /web-draft, signed with WEB_ORDER_SECRET).
// Kamala keeps one row per browser (the website's visitor id) in web_form_drafts:
//   - the row goes to the "Website Forms" tab of the CRM Sheet within seconds (Apps Script target website_form_upsert,
//     apps-script/website-forms.gs), and again whenever it changes;
//   - a usable WhatsApp number also lands in users and web_leads (stage "typing"), so Kamala knows the person;
//   - 25 minutes after a WhatsApp number first appears, unless the person has paid or has written to Kamala since,
//     she sends one message: with their name (and report) when the form has a name, else a general one.
//     Inside WhatsApp's 24-hour window it is a normal message; outside it, an approved template.

const REPORTS = { blend: 'Astro-Numero Blend', classic: 'Classic' };
const FOLLOW_UP_AFTER_MIN = 25;   // lands inside the promised 30 minutes, with the scheduler's wake-up slack
const REPEAT_DAYS = 14;           // one follow-up per number in this many days, however many forms they start
const MAX_ATTEMPTS = 3;

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** WhatsApp number as digits with the country code (same rules as the website's order form), or ''. */
function normalisePhone(code, mobile) {
  const cc = String(code || '').replace(/\D/g, '');
  let m = String(mobile || '').replace(/\D/g, '');
  if (!/^\d{1,4}$/.test(cc) || !m) return '';
  if (m.startsWith('00' + cc)) m = m.slice(2 + cc.length);
  else if (m.length > 10 && m.startsWith(cc)) m = m.slice(cc.length);
  m = m.replace(/^0+/, '');
  if (cc === '91') return /^[6-9]\d{9}$/.test(m) ? cc + m : '';
  const full = cc + m;
  return m.length >= 6 && full.length >= 8 && full.length <= 15 ? full : '';
}

/**
 * The draft as the website sent it, checked field by field. A half-typed form is normal: nothing is required except
 * the visitor id, and a field that is not usable yet is simply left empty. Returns null only without a visitor id.
 */
function readDraft(input) {
  const i = input || {};
  const visitor = String(i.visitor || '').toLowerCase();
  if (!/^[a-f0-9]{16,40}$/.test(visitor)) return null;
  const name = clean(i.name, 80);
  const email = clean(i.email, 120).toLowerCase();
  const dob = /^\d{4}-\d{2}-\d{2}$/.test(String(i.dob || '')) ? String(i.dob) : '';
  const tob = /^(1[0-2]|[1-9]):[0-5]\d (AM|PM)$/.test(String(i.tob || '').toUpperCase()) ? String(i.tob).toUpperCase() : '';
  const code = String(i.code || '').replace(/\D/g, '').slice(0, 4);
  const mobile = String(i.mobile || '').replace(/\D/g, '').slice(0, 15);
  const report = REPORTS[i.report] ? i.report : '';
  return {
    visitor,
    name: /\p{L}/u.test(name) ? name : '',
    email,
    emailValid: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email),
    dob, tob,
    pob: clean(i.pob, 100),
    code, mobile,
    phone: normalisePhone(code, mobile),
    report, reportName: REPORTS[report] || '',
    referral: clean(i.referral, 40),
    page: clean(i.page, 120)
  };
}

const firstName = name => clean(name, 80).split(' ')[0] || '';

/** The message Kamala sends 25 minutes after the number was typed. Named when the form has a name. */
function followUpText(d) {
  const report = d.report_name ? `2027 ${d.report_name} report` : '2027 Personal Year Report';
  const first = firstName(d.name);
  return first
    ? `Namaste ${first} ji 🙏 Main Kamala, Shashank ji ki team se. Aapne abhi apni ${report} ka form bharna shuru kiya tha. Koi sawaal ho ya order poora karne mein madad chahiye, to yahin reply kijiye.`
    : `Namaste 🙏 Main Kamala, Shashank ji ki team se. Aapne abhi 2027 Personal Year Report ka form bharna shuru kiya tha. Koi sawaal ho ya order poora karne mein madad chahiye, to yahin reply kijiye.`;
}

const istText = t => (t ? new Date(t).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '');

const STAGE_LABEL = { typing: 'Typing', form: 'Pressed Review', whatsapp: 'Sent order on WhatsApp', checkout: 'Opened payment', paid: 'Paid' };
const FOLLOW_UP_LABEL = {
  sending: 'Sending', sent: 'Sent', skipped_paid: 'Not sent: paid', skipped_chatting: 'Not sent: already chatting',
  skipped_repeat: 'Not sent: messaged recently', no_template: 'Not sent: template not set', failed: 'Failed'
};

/** One Sheet row for the "Website Forms" tab (website-forms.gs writes it by visitor id). */
function sheetRow(d) {
  const followUp = d.followup_status
    ? `${FOLLOW_UP_LABEL[d.followup_status] || d.followup_status}${d.followup_at ? ` ${istText(d.followup_at)}` : ''}`
    : (d.followup_due_at ? `Due ${istText(d.followup_due_at)}` : '');
  return {
    visitor: d.visitor,
    lastTyped: istText(d.last_at), firstSeen: istText(d.first_at),
    name: d.name || '', whatsapp: d.phone ? '+' + d.phone : (d.mobile ? `${d.code ? '+' + d.code + ' ' : ''}${d.mobile} (incomplete)` : ''),
    email: d.email || '', dob: d.dob || '', tob: d.tob || '', pob: d.pob || '',
    report: d.report_name || '', referral: d.referral || '', stage: STAGE_LABEL[d.stage] || 'Typing', followUp, saves: Number(d.saves) || 1
  };
}

/** For Kamala's notes about this person (added to the website line when they never finished the form). */
function draftLine(d) {
  if (!d) return '';
  const what = d.report_name ? ` for the ${d.report_name}` : '';
  const sent = d.followup_status === 'sent' ? ` Kamala messaged them ${istText(d.followup_at)} IST about it.` : '';
  return `Started typing the 2027 report order form on the website${what} on ${istText(d.first_at)} IST and did not finish it.${sent}`;
}

/**
 * deps: { pool, postAppsScript, sendText(phone, text) → bool, sendTemplate(phone, name, params) → bool,
 *         saveTurn(phone, text), notifyOwner(text, subject), namedTemplate, genericTemplate, now? }
 */
function create(deps) {
  const db = () => deps.pool;
  const now = () => (deps.now ? deps.now() : new Date());

  async function migrate(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS web_form_drafts (
        visitor TEXT PRIMARY KEY,
        name TEXT, email TEXT, dob TEXT, tob TEXT, pob TEXT,
        code TEXT, mobile TEXT, phone TEXT,
        report TEXT, report_name TEXT, referral TEXT, page TEXT,
        stage TEXT NOT NULL DEFAULT 'typing',
        saves INTEGER NOT NULL DEFAULT 1,
        first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        phone_at TIMESTAMPTZ,
        followup_due_at TIMESTAMPTZ,
        followup_status TEXT,
        followup_at TIMESTAMPTZ,
        followup_kind TEXT,
        followup_attempts INTEGER NOT NULL DEFAULT 0,
        sheet_synced_at TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS web_form_drafts_due_idx ON web_form_drafts (followup_due_at) WHERE followup_status IS NULL;
      CREATE INDEX IF NOT EXISTS web_form_drafts_phone_idx ON web_form_drafts (phone);
    `);
  }

  // Saves the draft. A field the person cleared keeps its last typed value (what was typed is what the Sheet shows);
  // a number, once usable, stays. The follow-up is set the first time a usable number appears.
  async function save(input) {
    const pool = db();
    if (!pool) throw new Error('No database');
    const d = readDraft(input);
    if (!d) return { status: 'invalid' };
    const r = await pool.query(`INSERT INTO web_form_drafts (visitor, name, email, dob, tob, pob, code, mobile, phone, report, report_name, referral, page,
        phone_at, followup_due_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULLIF($9,''),$10,$11,$12,$13,
        CASE WHEN $9 <> '' THEN NOW() END, CASE WHEN $9 <> '' THEN NOW() + make_interval(mins => $14) END)
      ON CONFLICT (visitor) DO UPDATE SET
        name=COALESCE(NULLIF(EXCLUDED.name,''), web_form_drafts.name),
        email=COALESCE(NULLIF(EXCLUDED.email,''), web_form_drafts.email),
        dob=COALESCE(NULLIF(EXCLUDED.dob,''), web_form_drafts.dob),
        tob=COALESCE(NULLIF(EXCLUDED.tob,''), web_form_drafts.tob),
        pob=COALESCE(NULLIF(EXCLUDED.pob,''), web_form_drafts.pob),
        code=COALESCE(NULLIF(EXCLUDED.code,''), web_form_drafts.code),
        mobile=COALESCE(NULLIF(EXCLUDED.mobile,''), web_form_drafts.mobile),
        phone=COALESCE(EXCLUDED.phone, web_form_drafts.phone),
        report=COALESCE(NULLIF(EXCLUDED.report,''), web_form_drafts.report),
        report_name=COALESCE(NULLIF(EXCLUDED.report_name,''), web_form_drafts.report_name),
        referral=COALESCE(NULLIF(EXCLUDED.referral,''), web_form_drafts.referral),
        page=COALESCE(NULLIF(EXCLUDED.page,''), web_form_drafts.page),
        phone_at=COALESCE(web_form_drafts.phone_at, EXCLUDED.phone_at),
        followup_due_at=COALESCE(web_form_drafts.followup_due_at, EXCLUDED.followup_due_at),
        saves=web_form_drafts.saves + 1, last_at=NOW()
      RETURNING *`,
    [d.visitor, d.name, d.email, d.dob, d.tob, d.pob, d.code, d.mobile, d.phone, d.report, d.reportName, d.referral, d.page, FOLLOW_UP_AFTER_MIN]);
    const row = r.rows[0];
    if (row.phone) await rememberPerson(row, d.emailValid);
    return { status: 'saved', row, phone: row.phone || '' };
  }

  // The person behind a usable number: Kamala's users table (details she already has are never overwritten) and
  // web_leads at stage "typing" (a later stage from the finished form or a payment is never lowered).
  async function rememberPerson(row, emailValid) {
    const pool = db();
    const dobText = row.dob ? new Date(row.dob + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
    await pool.query(`INSERT INTO users (phone, name, email, dob, tob, pob, first_source, first_contact, last_contact)
      VALUES ($1,NULLIF($2,''),NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),'website',NOW(),NOW())
      ON CONFLICT (phone) DO UPDATE SET
        name=COALESCE(NULLIF(users.name,''), EXCLUDED.name), email=COALESCE(NULLIF(users.email,''), EXCLUDED.email),
        dob=COALESCE(NULLIF(users.dob,''), EXCLUDED.dob), tob=COALESCE(NULLIF(users.tob,''), EXCLUDED.tob),
        pob=COALESCE(NULLIF(users.pob,''), EXCLUDED.pob), first_source=COALESCE(users.first_source, 'website')`,
    [row.phone, row.name || '', emailValid ? row.email : '', dobText, row.tob || '', row.pob || '']);
    await pool.query(`INSERT INTO web_leads (phone, name, email, dob, tob, pob, report, report_name, referral, stage)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'typing')
      ON CONFLICT (phone) DO UPDATE SET
        name=COALESCE(NULLIF(EXCLUDED.name,''), web_leads.name), email=COALESCE(NULLIF(EXCLUDED.email,''), web_leads.email),
        dob=COALESCE(NULLIF(EXCLUDED.dob,''), web_leads.dob), tob=COALESCE(NULLIF(EXCLUDED.tob,''), web_leads.tob),
        pob=COALESCE(NULLIF(EXCLUDED.pob,''), web_leads.pob), report=COALESCE(NULLIF(EXCLUDED.report,''), web_leads.report),
        report_name=COALESCE(NULLIF(EXCLUDED.report_name,''), web_leads.report_name),
        referral=COALESCE(NULLIF(EXCLUDED.referral,''), web_leads.referral), last_at=NOW()`,
    [row.phone, row.name || '', emailValid ? row.email : '', dobText, row.tob || '', row.pob || '', row.report || '', row.report_name || '', row.referral || '']);
    // What this browser did on the site (web_events, written by the website) now belongs to this number too.
    await pool.query(`INSERT INTO web_visitors (visitor, phone) VALUES ($1,$2)
      ON CONFLICT (visitor) DO UPDATE SET phone=EXCLUDED.phone, last_at=NOW()`, [row.visitor, row.phone]).catch(() => {});
    await pool.query(`UPDATE web_events SET phone=$2 WHERE visitor=$1 AND phone IS NULL`, [row.visitor, row.phone]).catch(() => {});
  }

  // Rows changed since they were last written to the Sheet go in one call (oldest first). Safe to repeat: the
  // Apps Script writes each row by visitor id, so a row sent twice is just written twice.
  let syncing = false;
  let pauseUntil = 0; // after a refusal (e.g. the Apps Script part is not installed yet), wait before trying again
  async function syncSheet(limit = 40) {
    const pool = db();
    if (!pool || syncing || !deps.postAppsScript || Date.now() < pauseUntil) return 0;
    syncing = true;
    try {
      // The database's clock marks what was sent: a save landing while the Sheet call runs is newer, so it goes next time.
      const stamp = (await pool.query('SELECT NOW() AS t')).rows[0].t;
      // The stage comes from web_leads when the person got further (pressed Review, opened payment, paid).
      const r = await pool.query(`SELECT d.*, COALESCE(l.stage, d.stage) AS stage FROM web_form_drafts d
          LEFT JOIN web_leads l ON l.phone = d.phone
        WHERE d.sheet_synced_at IS NULL OR d.sheet_synced_at < d.last_at
          OR (d.followup_at IS NOT NULL AND d.sheet_synced_at < d.followup_at)
          OR (l.last_at IS NOT NULL AND d.sheet_synced_at < l.last_at AND l.last_at > NOW() - INTERVAL '3 days')
        ORDER BY d.last_at LIMIT $1`, [limit]);
      if (!r.rows.length) return 0;
      try {
        await deps.postAppsScript({ target: 'website_form_upsert', rows: r.rows.map(sheetRow) });
      } catch (e) {
        pauseUntil = Date.now() + (/unknown request target/i.test(e.message) ? 15 : 2) * 60 * 1000;
        throw e;
      }
      await pool.query(`UPDATE web_form_drafts SET sheet_synced_at=$2 WHERE visitor = ANY($1)`, [r.rows.map(x => x.visitor), stamp]);
      return r.rows.length;
    } finally {
      syncing = false;
    }
  }

  // A burst of saves becomes one Sheet call a few seconds after the last one.
  let syncTimer = null;
  function syncSoon(ms = 4000) {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncSheet().catch(e => console.error('Website Forms Sheet update failed:', e.message));
    }, ms);
    if (syncTimer.unref) syncTimer.unref();
  }

  async function nextDueAt() {
    const pool = db();
    if (!pool) return null;
    const r = await pool.query(`SELECT MIN(followup_due_at) AS t FROM web_form_drafts WHERE followup_status IS NULL AND phone IS NOT NULL`)
      .catch(() => ({ rows: [] }));
    // Only follow-ups wake a sleeping server: Sheet rows are written while it is awake anyway (each save wakes it).
    return r.rows[0] && r.rows[0].t ? new Date(r.rows[0].t) : null;
  }

  // Why the follow-up should not go, or '' when it should.
  async function reasonToSkip(d) {
    const pool = db();
    const paid = await pool.query(`SELECT 1 FROM web_leads WHERE phone=$1 AND stage='paid'
        UNION ALL SELECT 1 FROM web_orders WHERE phone=$1 AND created_at > NOW() - INTERVAL '3 days'
        UNION ALL SELECT 1 FROM wa_payment_links WHERE phone=$1 AND status='paid' AND updated_at > $2::timestamptz - INTERVAL '1 day'
        LIMIT 1`, [d.phone, d.first_at]).catch(() => ({ rows: [] }));
    if (paid.rows.length) return 'skipped_paid';
    const u = (await pool.query('SELECT last_inbound_at FROM users WHERE phone=$1', [d.phone]).catch(() => ({ rows: [] }))).rows[0];
    if (u && u.last_inbound_at && new Date(u.last_inbound_at) >= new Date(d.first_at)) return 'skipped_chatting';
    const repeat = await pool.query(`SELECT 1 FROM web_form_drafts WHERE phone=$1 AND visitor<>$2 AND followup_status='sent'
        AND followup_at > NOW() - make_interval(days => $3) LIMIT 1`, [d.phone, d.visitor, REPEAT_DAYS]).catch(() => ({ rows: [] }));
    if (repeat.rows.length) return 'skipped_repeat';
    return '';
  }

  // Sends the follow-ups that are due (claimed one by one, so two workers never send the same message).
  async function runDue(limit = 10) {
    const pool = db();
    if (!pool) return 0;
    let done = 0;
    let handled = 0;
    for (let n = 0; n < limit; n++) {
      const claim = await pool.query(`UPDATE web_form_drafts SET followup_status='sending', followup_attempts=followup_attempts+1
        WHERE visitor = (SELECT visitor FROM web_form_drafts WHERE followup_status IS NULL AND phone IS NOT NULL AND followup_due_at <= NOW()
          ORDER BY followup_due_at LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`);
      const d = claim.rows[0];
      if (!d) break;
      handled++;
      let status = await reasonToSkip(d);
      let kind = null;
      if (!status) {
        const text = followUpText(d);
        const u = (await pool.query(`SELECT last_inbound_at > NOW() - INTERVAL '23 hours 58 minutes' AS open FROM users WHERE phone=$1`, [d.phone])
          .catch(() => ({ rows: [] }))).rows[0];
        let ok = false;
        if (u && u.open) {
          ok = await deps.sendText(d.phone, text);
          kind = 'text';
        } else {
          const first = firstName(d.name);
          const template = first ? deps.namedTemplate : deps.genericTemplate;
          if (!template) {
            status = 'no_template';
          } else {
            ok = await deps.sendTemplate(d.phone, template, first ? [first, d.report_name ? `2027 ${d.report_name} report` : '2027 Personal Year Report'] : []);
            kind = first ? 'named' : 'generic';
            if (ok && deps.saveTurn) await deps.saveTurn(d.phone, text);
          }
        }
        if (!status) status = ok ? 'sent' : (d.followup_attempts >= MAX_ATTEMPTS ? 'failed' : null);
      }
      if (status === null) {
        // Meta refused this time: try again in 10 minutes (up to MAX_ATTEMPTS).
        await pool.query(`UPDATE web_form_drafts SET followup_status=NULL, followup_due_at=NOW() + INTERVAL '10 minutes' WHERE visitor=$1`, [d.visitor]);
        continue;
      }
      await pool.query(`UPDATE web_form_drafts SET followup_status=$2, followup_kind=$3, followup_at=NOW() WHERE visitor=$1`, [d.visitor, status, kind]);
      if (status === 'sent') {
        done++;
        if (deps.notifyOwner) {
          await deps.notifyOwner(`📝 Website form follow-up sent to +${d.phone}${d.name ? ` (${d.name})` : ''}${d.report_name ? `, ${d.report_name}` : ''}. They typed the 2027 form but did not pay.`,
            'Website form follow-up').catch(() => {});
        }
      } else if (status === 'no_template' && deps.notifyOwner) {
        await deps.notifyOwner(`Website form follow-up for +${d.phone} was not sent: the WhatsApp template is not set (WA_FORM_FOLLOWUP_NAMED_TEMPLATE / WA_FORM_FOLLOWUP_TEMPLATE).`,
          'Website form follow-up').catch(() => {});
      }
    }
    if (handled) syncSoon(1000);
    return done;
  }

  async function latestFor(phone) {
    const pool = db();
    if (!pool || !phone) return null;
    return (await pool.query(`SELECT * FROM web_form_drafts WHERE phone=$1 ORDER BY last_at DESC LIMIT 1`, [String(phone)])
      .catch(() => ({ rows: [] }))).rows[0] || null;
  }

  return { migrate, save, syncSheet, syncSoon, nextDueAt, runDue, latestFor };
}

module.exports = { create, readDraft, normalisePhone, followUpText, sheetRow, draftLine, FOLLOW_UP_AFTER_MIN };
