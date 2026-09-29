'use strict';

/**
 * Growth tools for Kamala:
 * - lead source (Ref codes in the first WhatsApp message, Click-to-WhatsApp ad referrals)
 * - consent to updates (asked once, recorded with its wording and time)
 * - lead score and stage, with a same-day owner alert for hot leads
 * - nightly analytics tabs for Google Sheets
 * - opt-in template campaigns (/campaign) with delivery tracking
 * - paid bookings reported to Meta (Conversions API), when META_PIXEL_ID and META_CAPI_TOKEN are set
 */
const crypto = require('crypto');

const PAID = ['paid', 'gateway_test_paid'];
const MARKETING_PRICE_INR = Number(process.env.WA_MARKETING_PRICE_INR || 0.8631); // India marketing template, before GST
const GST = 1.18;
const OPTIN_TEXT = 'Kya aap chahenge ki hum aapko yahin festival muhurat reminders aur monthly updates bhejein? Agar haan, toh bas YES reply kar dijiye. (Kabhi bhi STOP likh kar band kar sakte hain.)';

// ---------- lead source ----------

// "(Ref: IG-DIWALI)", "ref:web-home", "Ref - YT" anywhere in a message.
const REF_RE = /\(?\s*\bref\s*[:#-]\s*([A-Za-z0-9][A-Za-z0-9_-]{1,29})\s*\)?/i;

function extractRef(text) {
  const s = String(text || '');
  const m = s.match(REF_RE);
  if (!m) return { ref: null, clean: s };
  const clean = (s.slice(0, m.index) + s.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').trim();
  return { ref: m[1].toUpperCase(), clean };
}

// Click-to-WhatsApp ads (and post links) arrive with msg.referral.
function sourceFromReferral(referral) {
  if (!referral || typeof referral !== 'object') return null;
  const type = String(referral.source_type || '').toLowerCase();
  const id = String(referral.source_id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  if (type === 'ad') return id ? `AD-${id}` : 'AD';
  if (type === 'post') return id ? `POST-${id}` : 'POST';
  return type ? type.toUpperCase().slice(0, 20) : null;
}

// Ad and referral sources: AD-<id> (Click-to-WhatsApp), GADS, REF-<name>, or any code ending in -AD / -ADS (e.g. IG-AD).
const PAID_SOURCE_RE = /^(AD|GADS|REF)(-|$)|-ADS?$/i;
const isPaidOrReferral = source => PAID_SOURCE_RE.test(String(source || ''));

const INTENT_RE = /\b(price|prices|pricing|cost|costs|fee|fees|charge|charges|kitna|kitne|kitni|rate|rates|slot|slots|book|booking|appointment|available|availability|kab\s+milega|timing|timings)\b/i;

async function migrate(pool) {
  if (!pool) return;
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS first_source TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_source TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ctwa_clid TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS asked_price_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS lead_score INTEGER;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS lead_stage TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS hot_alerted_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS optin_asked_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS optin_at TIMESTAMPTZ;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS optin_text TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
    CREATE TABLE IF NOT EXISTS wa_campaigns (
      id SERIAL PRIMARY KEY,
      template TEXT NOT NULL,
      segment TEXT NOT NULL,
      lang TEXT NOT NULL DEFAULT 'en',
      with_name BOOLEAN NOT NULL DEFAULT false,
      status TEXT NOT NULL DEFAULT 'draft',
      audience INTEGER NOT NULL DEFAULT 0,
      sent INTEGER NOT NULL DEFAULT 0,
      failed INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS wa_campaign_sends (
      campaign_id INTEGER NOT NULL,
      phone TEXT NOT NULL,
      wamid TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      error TEXT,
      sent_at TIMESTAMPTZ,
      delivered_at TIMESTAMPTZ,
      read_at TIMESTAMPTZ,
      PRIMARY KEY (campaign_id, phone)
    );
    CREATE INDEX IF NOT EXISTS wa_campaign_sends_wamid_idx ON wa_campaign_sends (wamid);
    CREATE INDEX IF NOT EXISTS wa_campaign_sends_phone_idx ON wa_campaign_sends (phone, sent_at DESC);
  `);
}

/** Saves where a lead came from (first source is never overwritten) and whether they asked about price or slots. */
async function recordInbound(pool, phone, { ref = null, referral = null, text = '' } = {}) {
  if (!pool || !phone) return;
  const source = ref || sourceFromReferral(referral);
  const clid = referral && referral.ctwa_clid ? String(referral.ctwa_clid).slice(0, 200) : null;
  await pool.query(`UPDATE users SET
      first_source = COALESCE(first_source, $2::text, CASE WHEN first_contact > NOW() - INTERVAL '15 minutes' THEN 'DIRECT' END),
      last_source = COALESCE($2::text, last_source),
      ctwa_clid = COALESCE($3::text, ctwa_clid),
      asked_price_at = CASE WHEN $4::boolean THEN COALESCE(asked_price_at, NOW()) ELSE asked_price_at END
    WHERE phone = $1`, [phone, source, clid, INTENT_RE.test(String(text || ''))]);
}

// ---------- lead score ----------

/**
 * Score 0-100 and stage from what we know. Pure, so it can be tested.
 * u: user row plus paid_count, open_links, expired_links.
 */
function scoreLead(u, now = new Date()) {
  const paid = Number(u.paid_count || 0);
  const stage = paid >= 2 ? 'Repeat'
    : paid === 1 ? 'Paid'
    : Number(u.open_links || 0) > 0 ? 'Link sent'
    : u.dob ? 'Qualified'
    : (u.core_concern || u.problem_category || u.pain_point) ? 'Engaged'
    : 'New';
  if (u.marketing_opt_out) return { score: 0, stage };
  let s = 0;
  if (u.core_concern || u.problem_category || u.pain_point) s += 20;
  if (u.asked_price_at) s += 20;
  if (u.dob) s += 15;
  if (Number(u.open_links || 0) > 0) s += 15;
  if (isPaidOrReferral(u.first_source)) s += 10;
  const last = u.last_inbound_at ? new Date(u.last_inbound_at).getTime() : 0;
  if (last && now.getTime() - last < 24 * 3600e3) s += 10;
  if (paid > 0) s += 25;
  if (Number(u.expired_links || 0) > 0) s -= 10;
  if (last && now.getTime() - last > 7 * 24 * 3600e3) s -= 15;
  return { score: Math.max(0, Math.min(100, s)), stage };
}

const LEAD_ROW_SQL = `SELECT u.*,
    COUNT(l.payment_link_id) FILTER (WHERE l.status = ANY($2)) AS paid_count,
    COUNT(l.payment_link_id) FILTER (WHERE l.status = 'request_created') AS open_links,
    COUNT(l.payment_link_id) FILTER (WHERE l.status IN ('expired','gateway_test_expired')) AS expired_links
  FROM users u LEFT JOIN wa_payment_links l ON l.phone = u.phone`;

/** Recomputes one lead's score after a message; alerts the owner once a day about a hot lead who has not paid. */
async function updateLeadScore(pool, phone, notifyOwner) {
  if (!pool || !phone) return null;
  const row = (await pool.query(`${LEAD_ROW_SQL} WHERE u.phone = $1 GROUP BY u.phone`, [phone, PAID])).rows[0];
  if (!row) return null;
  const { score, stage } = scoreLead(row);
  await pool.query('UPDATE users SET lead_score=$2, lead_stage=$3 WHERE phone=$1', [phone, score, stage]);
  const hot = score >= 70 && Number(row.paid_count) === 0 && !row.is_paused
    && (!row.hot_alerted_at || Date.now() - new Date(row.hot_alerted_at).getTime() > 24 * 3600e3);
  if (hot && notifyOwner) {
    const claimed = await pool.query(`UPDATE users SET hot_alerted_at=NOW() WHERE phone=$1
      AND (hot_alerted_at IS NULL OR hot_alerted_at < NOW() - INTERVAL '24 hours') RETURNING phone`, [phone]);
    if (claimed.rows[0]) {
      const concern = row.core_concern || row.pain_point || row.problem_category || 'not recorded yet';
      await notifyOwner(`🔥 Hot lead (score ${score}/100, ${stage}): ${row.name || 'name not given'}, +${phone}\n`
        + `Concern: ${String(concern).slice(0, 160)}\nSource: ${row.first_source || 'unknown'}\n`
        + `Kamala is handling the chat. A personal call from you could close this booking.`, `Hot lead: ${row.name || '+' + phone}`);
    }
  }
  return { score, stage };
}

// ---------- consent ----------

function optInMessage() { return OPTIN_TEXT; }

/** Whether the latest message Kamala sent was the opt-in question. */
function isOptInPrompt(text) { return /YES reply kar dijiye|reply\s+YES|monthly updates/i.test(String(text || '')); }

/** Asks once per person. sendText must return truthy when delivered. */
async function askOptIn(pool, phone, sendText) {
  if (!pool || !phone) return false;
  const claim = await pool.query(`UPDATE users SET optin_asked_at=NOW() WHERE phone=$1 AND optin_asked_at IS NULL
    AND marketing_opt_in = false AND COALESCE(marketing_opt_out,false) = false RETURNING phone`, [phone]);
  if (!claim.rows[0]) return false;
  const ok = await sendText(phone, OPTIN_TEXT);
  if (!ok) await pool.query('UPDATE users SET optin_asked_at=NULL WHERE phone=$1', [phone]);
  return Boolean(ok);
}

/** True when we asked this person in the last 7 days and they have not answered yet. */
async function optInPending(pool, phone) {
  if (!pool) return false;
  const r = await pool.query(`SELECT 1 FROM users WHERE phone=$1 AND optin_asked_at > NOW() - INTERVAL '7 days'
    AND marketing_opt_in = false AND COALESCE(marketing_opt_out,false) = false`, [phone]);
  return r.rowCount > 0;
}

async function recordOptIn(pool, phone) {
  if (!pool) return;
  await pool.query(`INSERT INTO users (phone, marketing_opt_in, marketing_opt_out, optin_at, optin_text) VALUES ($1, true, false, NOW(), $2)
    ON CONFLICT (phone) DO UPDATE SET marketing_opt_in=true, marketing_opt_out=false, optin_at=NOW(), optin_text=$2, last_contact=NOW()`, [phone, OPTIN_TEXT]);
}

// ---------- campaigns ----------

const SEGMENTS = {
  all: { label: 'everyone who opted in', where: '$1::text[] IS NOT NULL' },
  never_booked: { label: 'opted in, never booked', where: 'NOT EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=u.phone AND l.status = ANY($1))' },
  expired: { label: 'payment link expired, never paid', where: `EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=u.phone AND l.status IN ('expired','gateway_test_expired'))
    AND NOT EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=u.phone AND l.status = ANY($1))` },
  paid_once: { label: 'paid exactly once', where: '(SELECT COUNT(*) FROM wa_payment_links l WHERE l.phone=u.phone AND l.status = ANY($1)) = 1' },
  repeat: { label: 'paid two or more times', where: '(SELECT COUNT(*) FROM wa_payment_links l WHERE l.phone=u.phone AND l.status = ANY($1)) >= 2' },
  clients: { label: 'everyone who paid', where: 'EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=u.phone AND l.status = ANY($1))' }
};
const INTEREST_KEYWORDS = { numerology: 'numerolog', kundli: 'kundli|vedic|astrolog', palm: 'palm', relationship: 'divorce|separation|relationship|marriage|shaadi' };

function segmentSql(segment) {
  const key = String(segment || '').toLowerCase();
  let where; let label;
  if (SEGMENTS[key]) ({ where, label } = SEGMENTS[key]);
  else if (/^interest:/.test(key) && INTEREST_KEYWORDS[key.slice(9)]) {
    const re = INTEREST_KEYWORDS[key.slice(9)];
    label = `interested in ${key.slice(9)}`;
    where = `$1::text[] IS NOT NULL AND (COALESCE(u.pain_point,'') ~* '${re}' OR COALESCE(u.core_concern,'') ~* '${re}' OR COALESCE(u.problem_category,'') ~* '${re}'
      OR EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=u.phone AND l.service_name ~* '${re}'))`;
  } else return null;
  // Opted in, not paused, and no marketing message from us in the last 7 days.
  const sql = `SELECT u.phone, u.name FROM users u WHERE u.marketing_opt_in = true AND COALESCE(u.marketing_opt_out,false) = false
    AND COALESCE(u.is_paused,false) = false AND ${where}
    AND NOT EXISTS (SELECT 1 FROM wa_campaign_sends s WHERE s.phone=u.phone AND s.sent_at > NOW() - INTERVAL '7 days')
    ORDER BY u.last_contact DESC NULLS LAST`;
  return { sql, label };
}

const campaignHelp = () => `Campaign commands (owner only):
/campaign <template> <segment> [name] [lang]
  segments: all, never_booked, expired, paid_once, repeat, clients, interest:numerology, interest:kundli, interest:palm, interest:relationship
  add "name" if the template's only variable {{1}} is the first name; lang defaults to en (e.g. hi, en_US)
/campaign send <id>   start a previewed campaign
/campaign list        last 5 campaigns
Only people who replied YES to updates are included, at most one campaign per person per 7 days.`;

function estimateCostInr(count) { return Math.round(count * MARKETING_PRICE_INR * GST); }

/** Creates a draft campaign and returns the preview text. */
async function previewCampaign(pool, args) {
  const [template, segment, ...rest] = args;
  if (!template || !segment) return campaignHelp();
  if (!/^[a-z0-9_]{1,512}$/.test(template)) return 'Template names use lowercase letters, numbers and _ only, exactly as approved in WhatsApp Manager.';
  const seg = segmentSql(segment);
  if (!seg) return `Unknown segment "${segment}".\n\n${campaignHelp()}`;
  const withName = rest.map(s => s.toLowerCase()).includes('name');
  const lang = rest.find(s => /^[a-z]{2}(_[A-Z]{2})?$/.test(s)) || process.env.WA_TEMPLATE_LANGUAGE || 'en';
  const audience = (await pool.query(seg.sql, [PAID])).rows.length;
  const id = (await pool.query(`INSERT INTO wa_campaigns (template, segment, lang, with_name, audience) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [template, segment.toLowerCase(), lang, withName, audience])).rows[0].id;
  return `Campaign #${id} preview\nTemplate: ${template} (${lang})${withName ? ', first name as {{1}}' : ''}\nAudience: ${audience} people (${seg.label})\n`
    + `Estimated cost: about ₹${estimateCostInr(audience)} incl. GST (₹${MARKETING_PRICE_INR} per message before GST)\n\n`
    + (audience ? `To send, reply: /campaign send ${id}` : 'Nobody to send to yet. People join by replying YES to the updates question.');
}

/**
 * Sends a draft campaign in paced batches. sendTemplate(phone, template, lang, params) must resolve to
 * { ok, id, error }. Stops early if more than a fifth of the first 50 fail.
 */
async function runCampaign(pool, id, { sendTemplate, report, pauseMs = 300 }) {
  const c = (await pool.query(`UPDATE wa_campaigns SET status='sending', started_at=NOW() WHERE id=$1 AND status='draft' RETURNING *`, [id])).rows[0];
  if (!c) return report(`Campaign #${id} is not a draft (it may have been sent already). Use /campaign list.`);
  const seg = segmentSql(c.segment);
  const people = (await pool.query(seg.sql, [PAID])).rows;
  await report(`Campaign #${id} started: ${people.length} people. I'll message you when it finishes.`);
  let sent = 0; let failed = 0; let stopped = false;
  for (const p of people) {
    const claim = await pool.query(`INSERT INTO wa_campaign_sends (campaign_id, phone) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING phone`, [id, p.phone]);
    if (!claim.rows[0]) continue;
    const first = String(p.name || '').trim().split(/\s+/)[0] || 'ji';
    const r = await sendTemplate(p.phone, c.template, c.lang, c.with_name ? [first] : []).catch(e => ({ ok: false, error: e.message }));
    if (r && r.ok) {
      sent++;
      await pool.query(`UPDATE wa_campaign_sends SET status='sent', wamid=$3, sent_at=NOW() WHERE campaign_id=$1 AND phone=$2`, [id, p.phone, r.id || null]);
    } else {
      failed++;
      await pool.query(`UPDATE wa_campaign_sends SET status='failed', error=$3, sent_at=NOW() WHERE campaign_id=$1 AND phone=$2`, [id, p.phone, String(r?.error || 'failed').slice(0, 300)]);
    }
    if (sent + failed >= 50 && failed / (sent + failed) > 0.2) { stopped = true; break; }
    await new Promise(res => setTimeout(res, pauseMs));
  }
  await pool.query(`UPDATE wa_campaigns SET status=$2, sent=$3, failed=$4, finished_at=NOW() WHERE id=$1`, [id, stopped ? 'stopped' : 'done', sent, failed]);
  await report(stopped
    ? `⚠️ Campaign #${id} stopped early: ${failed} of ${sent + failed} failed. Check the template in WhatsApp Manager before trying again.`
    : `✅ Campaign #${id} finished: ${sent} sent, ${failed} failed. Delivery, reads, replies and bookings appear in the Campaigns tab tonight.`);
  return { sent, failed, stopped };
}

async function listCampaigns(pool) {
  const rows = (await pool.query('SELECT * FROM wa_campaigns ORDER BY id DESC LIMIT 5')).rows;
  if (!rows.length) return 'No campaigns yet.\n\n' + campaignHelp();
  return rows.map(c => `#${c.id} ${c.template} → ${c.segment}: ${c.status}, ${c.sent}/${c.audience} sent, ${c.failed} failed`).join('\n');
}

/** Delivery receipts from the WhatsApp webhook (entry.changes[].value.statuses[]). */
async function recordStatuses(pool, statuses) {
  if (!pool || !Array.isArray(statuses)) return;
  for (const s of statuses) {
    if (!s || !s.id) continue;
    if (s.status === 'delivered') {
      await pool.query(`UPDATE wa_campaign_sends SET delivered_at=COALESCE(delivered_at, NOW()),
        status=CASE WHEN status='read' THEN status ELSE 'delivered' END WHERE wamid=$1`, [s.id]);
    } else if (s.status === 'read') {
      await pool.query(`UPDATE wa_campaign_sends SET read_at=COALESCE(read_at, NOW()), delivered_at=COALESCE(delivered_at, NOW()),
        status='read' WHERE wamid=$1`, [s.id]);
    } else if (s.status === 'failed') {
      const err = (s.errors && s.errors[0]) ? `${s.errors[0].code} ${s.errors[0].title || ''}`.trim() : 'failed';
      await pool.query(`UPDATE wa_campaign_sends SET status='failed', error=$2 WHERE wamid=$1`, [s.id, err.slice(0, 300)]);
    }
  }
}

// ---------- Meta Conversions API ----------

const sha = v => crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex');

function purchaseEvent({ paymentLinkId, phone, email, amountInr, serviceName, eventTime = new Date() }) {
  const user_data = { ph: [sha(String(phone).replace(/\D/g, ''))], country: [sha('in')] };
  if (email && /@/.test(email)) user_data.em = [sha(email)];
  return {
    event_name: 'Purchase',
    event_time: Math.floor(new Date(eventTime).getTime() / 1000),
    event_id: String(paymentLinkId),
    action_source: 'chat',
    user_data,
    custom_data: { value: Number(amountInr), currency: 'INR', content_name: String(serviceName || '').slice(0, 100), content_type: 'product' }
  };
}

/** Sends one Purchase event to Meta; skipped (returns 'skipped') until META_PIXEL_ID and META_CAPI_TOKEN are set. */
async function reportPurchase(axios, details) {
  const pixel = process.env.META_PIXEL_ID; const token = process.env.META_CAPI_TOKEN;
  if (!pixel || !token) return 'skipped';
  const body = { data: [purchaseEvent(details)] };
  if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;
  await axios.post(`https://graph.facebook.com/v19.0/${pixel}/events`, body, { params: { access_token: token }, timeout: 15000 });
  return 'sent';
}

// ---------- nightly analytics ----------

const IST = `'Asia/Kolkata'`;
const inr = paise => Math.round(Number(paise || 0)) / 100;
const pct = (a, b) => (Number(b) ? Math.round((Number(a) / Number(b)) * 1000) / 10 : 0);

/** Builds every analytics tab as { name: { header, rows } }. Values are plain strings and numbers. */
async function buildAnalytics(pool) {
  const q = (sql, params = []) => pool.query(sql, params).then(r => r.rows);
  const paidAt = `COALESCE(l.paid_at, l.updated_at)`;

  const daily = await q(`WITH days AS (
      SELECT generate_series((NOW() AT TIME ZONE ${IST})::date - 59, (NOW() AT TIME ZONE ${IST})::date, '1 day')::date AS d)
    SELECT to_char(d,'YYYY-MM-DD') AS day,
      (SELECT COUNT(*) FROM users u WHERE (u.first_contact AT TIME ZONE ${IST})::date = d) AS new_leads,
      (SELECT COUNT(DISTINCT m.phone) FROM wa_messages m WHERE m.role='user' AND (m.created_at AT TIME ZONE ${IST})::date = d) AS chats,
      (SELECT COUNT(*) FROM wa_payment_links l WHERE (l.created_at AT TIME ZONE ${IST})::date = d) AS links_sent,
      (SELECT COUNT(*) FROM wa_payment_links l WHERE l.status='paid' AND (${paidAt} AT TIME ZONE ${IST})::date = d) AS paid,
      (SELECT COUNT(*) FROM wa_payment_links l WHERE l.status='gateway_test_paid' AND (${paidAt} AT TIME ZONE ${IST})::date = d) AS test_paid,
      (SELECT COALESCE(SUM(l.amount_paise),0) FROM wa_payment_links l WHERE l.status='paid' AND (${paidAt} AT TIME ZONE ${IST})::date = d) AS revenue_paise,
      (SELECT COUNT(*) FROM users u WHERE (u.optin_at AT TIME ZONE ${IST})::date = d) AS opt_ins
    FROM days ORDER BY d DESC`);

  const sources = await q(`WITH leads AS (
      SELECT u.phone, COALESCE(u.first_source,'UNKNOWN') AS source, to_char(u.first_contact AT TIME ZONE ${IST}, 'YYYY-MM') AS month
      FROM users u WHERE u.first_contact > NOW() - INTERVAL '6 months')
    SELECT month, source, COUNT(*) AS leads,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=leads.phone AND l.status = ANY($1))) AS payers,
      COALESCE((SELECT COUNT(*) FROM wa_payment_links l JOIN leads x ON x.phone=l.phone WHERE x.month=leads.month AND x.source=leads.source AND l.status='paid'),0) AS bookings,
      COALESCE((SELECT SUM(l.amount_paise) FROM wa_payment_links l JOIN leads x ON x.phone=l.phone WHERE x.month=leads.month AND x.source=leads.source AND l.status='paid'),0) AS revenue_paise
    FROM leads GROUP BY month, source ORDER BY month DESC, leads DESC`, [PAID]);

  const funnel = await q(`WITH people AS (
      SELECT u.*, date_trunc('week', u.first_contact AT TIME ZONE ${IST})::date AS wk FROM users u WHERE u.first_contact > NOW() - INTERVAL '12 weeks')
    SELECT to_char(wk,'YYYY-MM-DD') AS week, COUNT(*) AS new_people,
      COUNT(*) FILTER (WHERE core_concern IS NOT NULL OR problem_category IS NOT NULL OR pain_point IS NOT NULL) AS engaged,
      COUNT(*) FILTER (WHERE dob IS NOT NULL) AS qualified,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=people.phone)) AS link_sent,
      COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=people.phone AND l.status = ANY($1))) AS paid
    FROM people GROUP BY wk ORDER BY wk DESC`, [PAID]);

  const services = await q(`SELECT to_char(l.created_at AT TIME ZONE ${IST}, 'YYYY-MM') AS month, COALESCE(l.service_name,'(unknown)') AS service,
      COUNT(*) AS links_sent, COUNT(*) FILTER (WHERE l.status='paid') AS paid, COUNT(*) FILTER (WHERE l.status='gateway_test_paid') AS test_paid,
      COALESCE(SUM(l.amount_paise) FILTER (WHERE l.status='paid'),0) AS revenue_paise,
      COUNT(*) FILTER (WHERE l.status IN ('expired','gateway_test_expired')) AS expired
    FROM wa_payment_links l WHERE l.created_at > NOW() - INTERVAL '6 months' GROUP BY 1,2 ORDER BY 1 DESC, 3 DESC`);

  const campaigns = await q(`SELECT c.*,
      (SELECT COUNT(*) FROM wa_campaign_sends s WHERE s.campaign_id=c.id AND s.delivered_at IS NOT NULL) AS delivered,
      (SELECT COUNT(*) FROM wa_campaign_sends s WHERE s.campaign_id=c.id AND s.read_at IS NOT NULL) AS read,
      (SELECT COUNT(DISTINCT s.phone) FROM wa_campaign_sends s JOIN wa_messages m ON m.phone=s.phone AND m.role='user'
        AND m.created_at > s.sent_at AND m.created_at < s.sent_at + INTERVAL '7 days' WHERE s.campaign_id=c.id AND s.status<>'failed') AS replies,
      (SELECT COUNT(*) FROM wa_campaign_sends s JOIN wa_payment_links l ON l.phone=s.phone AND l.status = ANY($1)
        AND l.created_at > s.sent_at AND l.created_at < s.sent_at + INTERVAL '7 days' WHERE s.campaign_id=c.id) AS bookings,
      (SELECT COALESCE(SUM(l.amount_paise),0) FROM wa_campaign_sends s JOIN wa_payment_links l ON l.phone=s.phone AND l.status='paid'
        AND l.created_at > s.sent_at AND l.created_at < s.sent_at + INTERVAL '7 days' WHERE s.campaign_id=c.id) AS revenue_paise
    FROM wa_campaigns c WHERE c.status <> 'draft' ORDER BY c.id DESC LIMIT 200`, [PAID]);

  const clients = await q(`SELECT u.name, u.phone, COALESCE(u.first_source,'UNKNOWN') AS source,
      to_char(u.first_contact AT TIME ZONE ${IST}, 'YYYY-MM-DD') AS first_contact,
      to_char(MIN(${paidAt}) AT TIME ZONE ${IST}, 'YYYY-MM-DD') AS first_paid,
      COUNT(*) FILTER (WHERE l.status='paid') AS bookings, COUNT(*) FILTER (WHERE l.status='gateway_test_paid') AS test_bookings,
      COALESCE(SUM(l.amount_paise) FILTER (WHERE l.status='paid'),0) AS revenue_paise,
      string_agg(DISTINCT l.request_invoice_number, ', ') AS invoices,
      to_char(u.last_contact AT TIME ZONE ${IST}, 'YYYY-MM-DD') AS last_contact, u.marketing_opt_in AS opted_in
    FROM users u JOIN wa_payment_links l ON l.phone=u.phone AND l.status = ANY($1)
    GROUP BY u.phone ORDER BY MAX(${paidAt}) DESC LIMIT 2000`, [PAID]);

  const leads = await q(`SELECT u.name, u.phone, u.lead_score, u.lead_stage, COALESCE(u.first_source,'UNKNOWN') AS source,
      LEFT(COALESCE(u.core_concern, u.pain_point, u.problem_category, ''), 160) AS concern,
      to_char(u.last_inbound_at AT TIME ZONE ${IST}, 'YYYY-MM-DD HH24:MI') AS last_message, u.marketing_opt_in AS opted_in
    FROM users u WHERE COALESCE(u.is_customer,false) = false AND COALESCE(u.marketing_opt_out,false) = false AND u.lead_score IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=u.phone AND l.status = ANY($1))
    ORDER BY u.lead_score DESC, u.last_inbound_at DESC NULLS LAST LIMIT 100`, [PAID]);

  const n = v => Number(v || 0);
  return {
    Daily: {
      header: ['Date', 'New leads', 'People chatting', 'Payment links sent', 'Paid bookings', 'Test (₹1) bookings', 'Revenue (₹)', 'New opt-ins'],
      rows: daily.map(r => [r.day, n(r.new_leads), n(r.chats), n(r.links_sent), n(r.paid), n(r.test_paid), inr(r.revenue_paise), n(r.opt_ins)])
    },
    Sources: {
      header: ['Month (lead joined)', 'Source (Ref code)', 'Leads', 'Leads who paid', 'Lead → paid %', 'Paid bookings', 'Revenue (₹)'],
      rows: sources.map(r => [r.month, r.source, n(r.leads), n(r.payers), pct(r.payers, r.leads), n(r.bookings), inr(r.revenue_paise)])
    },
    Funnel: {
      header: ['Week starting', 'New people', 'Shared a concern', 'Gave birth details', 'Got a payment link', 'Paid', 'Overall %'],
      rows: funnel.map(r => [r.week, n(r.new_people), n(r.engaged), n(r.qualified), n(r.link_sent), n(r.paid), pct(r.paid, r.new_people)])
    },
    Services: {
      header: ['Month', 'Service', 'Payment links sent', 'Paid', 'Test (₹1) paid', 'Expired unpaid', 'Revenue (₹)', 'Average paid (₹)'],
      rows: services.map(r => [r.month, r.service, n(r.links_sent), n(r.paid), n(r.test_paid), n(r.expired), inr(r.revenue_paise), n(r.paid) ? Math.round(inr(r.revenue_paise) / n(r.paid)) : 0])
    },
    Campaigns: {
      header: ['#', 'Started', 'Template', 'Segment', 'Status', 'Audience', 'Sent', 'Delivered', 'Read', 'Failed', 'Replied (7 days)', 'Bookings (7 days)', 'Est. cost (₹)', 'Revenue (₹)'],
      rows: campaigns.map(c => [c.id, c.started_at ? new Date(c.started_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '', c.template, c.segment, c.status,
        n(c.audience), n(c.sent), n(c.delivered), n(c.read), n(c.failed), n(c.replies), n(c.bookings), estimateCostInr(n(c.sent)), inr(c.revenue_paise)])
    },
    Clients: {
      header: ['Name', 'Phone', 'First source', 'First contact', 'First paid', 'Paid bookings', 'Test bookings', 'Total paid (₹)', 'Invoice numbers', 'Last contact', 'Opted in to updates'],
      rows: clients.map(r => [r.name || '', `'+${r.phone}`, r.source, r.first_contact, r.first_paid, n(r.bookings), n(r.test_bookings), inr(r.revenue_paise), r.invoices || '', r.last_contact, r.opted_in ? 'Yes' : 'No'])
    },
    'Hot Leads': {
      header: ['Name', 'Phone', 'Score', 'Stage', 'Source', 'Concern', 'Last message', 'Opted in to updates'],
      rows: leads.map(r => [r.name || '', `'+${r.phone}`, n(r.lead_score), r.lead_stage || '', r.source, r.concern || '', r.last_message || '', r.opted_in ? 'Yes' : 'No'])
    }
  };
}

/** Rescore every lead, build the tabs and hand them to Apps Script. */
async function publishAnalytics(pool, postAppsScript) {
  const rows = (await pool.query(`${LEAD_ROW_SQL.replace('ANY($2)', 'ANY($1)')} GROUP BY u.phone`, [PAID])).rows;
  for (const r of rows) {
    const { score, stage } = scoreLead(r);
    if (r.lead_score !== score || r.lead_stage !== stage) await pool.query('UPDATE users SET lead_score=$2, lead_stage=$3 WHERE phone=$1', [r.phone, score, stage]);
  }
  const tabs = await buildAnalytics(pool);
  const updatedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  await postAppsScript({ target: 'analytics', updatedAt, tabs }, { timeoutMs: 120000, maxAttempts: 1 });
  return Object.fromEntries(Object.entries(tabs).map(([k, v]) => [k, v.rows.length]));
}

module.exports = {
  extractRef, sourceFromReferral, isPaidOrReferral, INTENT_RE,
  migrate, recordInbound, scoreLead, updateLeadScore,
  optInMessage, isOptInPrompt, askOptIn, optInPending, recordOptIn,
  segmentSql, previewCampaign, runCampaign, listCampaigns, recordStatuses, campaignHelp, estimateCostInr,
  purchaseEvent, reportPurchase, buildAnalytics, publishAnalytics
};
