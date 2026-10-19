'use strict';

/**
 * Owner dashboard: the API behind the Kamala dashboard (every chat, every invoice, live analytics, replying to a
 * customer from the business number). Everything is under /dash/api and needs the owner's sign-in.
 *
 * Sign-in: the owner's password (DASHBOARD_PASSWORD) gives a signed token valid for 30 days (see mount()).
 *
 * Real time: GET /dash/api/stream is a Server-Sent Events stream of new messages, invoices, payments and alerts.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');

const events = new EventEmitter();
events.setMaxListeners(50);

const SESSION_DAYS = 30;
const IST = "'Asia/Kolkata'";
const PAID = ['paid', 'gateway_test_paid'];

// Alerts the owner can read on the dashboard instead of getting a WhatsApp each time (when "important only" is on).
// Anything not listed here (payments, UPI to check, crises, failures, reports to prepare) always goes to WhatsApp.
const LOW_PRIORITY_SUBJECTS = new Set([
  'Customer would like to talk to you',
  'Message from a customer waiting for you',
  'Automated sender ignored',
  'Hot lead'
]);
function isLowPriority(subject, text) {
  if (LOW_PRIORITY_SUBJECTS.has(String(subject || ''))) return true;
  return /^🔥 Hot lead/.test(String(text || ''));
}

async function migrate(pool) {
  if (!pool) return;
  await pool.query(`
    ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS sender TEXT;
    CREATE TABLE IF NOT EXISTS wa_alerts (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      subject TEXT,
      text TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'important',
      whatsapp_sent BOOLEAN NOT NULL DEFAULT false
    );
    CREATE INDEX IF NOT EXISTS wa_alerts_created_idx ON wa_alerts (created_at DESC);
    CREATE INDEX IF NOT EXISTS wa_payment_links_created_idx ON wa_payment_links (created_at DESC);
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS payment_url TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS report_delivered_at TIMESTAMPTZ;
  `);
}

async function getSetting(pool, key, fallback) {
  if (!pool) return fallback;
  const r = await pool.query('SELECT value FROM wa_meta WHERE key=$1', [key]).catch(() => ({ rows: [] }));
  return r.rows[0]?.value ?? fallback;
}
async function setSetting(pool, key, value) {
  await pool.query('INSERT INTO wa_meta (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, String(value)]);
}

// "important" (default): low-priority alerts only on the dashboard. "all": every alert also on WhatsApp.
async function alertMode(pool) {
  const v = await getSetting(pool, 'dash_alert_mode', 'important');
  return v === 'all' ? 'all' : 'important';
}

// Records every owner alert for the dashboard and says whether it should still go to WhatsApp.
async function recordAlert(pool, subject, text) {
  const low = isLowPriority(subject, text);
  const sendWhatsApp = !low || (await alertMode(pool)) === 'all';
  let id = null;
  if (pool) {
    const r = await pool.query('INSERT INTO wa_alerts (subject,text,priority,whatsapp_sent) VALUES ($1,$2,$3,$4) RETURNING id, created_at',
      [String(subject || '').slice(0, 200), String(text || '').slice(0, 4000), low ? 'low' : 'important', sendWhatsApp])
      .catch(e => { console.error('Alert record failed:', e.message); return { rows: [] }; });
    if (r.rows[0]) {
      id = r.rows[0].id;
      events.emit('event', { type: 'alert', alert: { id, created_at: r.rows[0].created_at, subject, text, priority: low ? 'low' : 'important' } });
    }
  }
  return { sendWhatsApp, id };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

/**
 * deps: { pool, adminPhone, normalize, sendTextMessage, saveTurn, setPaused, confirmUpiPayment, invoicePdf, receiptPdf }
 * Sign-in is a password (DASHBOARD_PASSWORD in Render's environment). A correct password returns a signed token that
 * the dashboard page keeps and sends as "Authorization: Bearer <token>". No cookies, so the page can live on any
 * domain (Cloudflare) while this API stays on Render. Changing the password signs every device out.
 */
function mount(app, deps) {
  const { normalize } = deps;
  const admin = normalize(deps.adminPhone || '');
  const password = () => String(process.env.DASHBOARD_PASSWORD || '');
  let secret = null;
  const failures = { list: [], lockedUntil: 0 };

  // Which websites may call this API from a browser. DASHBOARD_ORIGINS: comma-separated (e.g.
  // https://dash.veshannastro.co.in,https://kamala-dashboard.pages.dev). Unset: any site (the token is still required).
  app.use('/dash/api', (req, res, next) => {
    const origin = req.headers.origin;
    const allowed = String(process.env.DASHBOARD_ORIGINS || '').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
    if (origin && (!allowed.length || allowed.includes(origin))) {
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '600' });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(origin && (!allowed.length || allowed.includes(origin)) ? 204 : 403);
    next();
  });

  async function sessionSecret() {
    if (secret) return secret;
    let v = await getSetting(deps.pool, 'dash_session_secret', null);
    if (!v) {
      v = crypto.randomBytes(32).toString('hex');
      await deps.pool.query(`INSERT INTO wa_meta (key,value) VALUES ('dash_session_secret',$1) ON CONFLICT (key) DO NOTHING`, [v]);
      v = await getSetting(deps.pool, 'dash_session_secret', v);
    }
    secret = v;
    return secret;
  }
  // The password is part of the signing key: a new password makes every old token invalid.
  async function sign(payload) {
    const key = crypto.createHash('sha256').update(`${await sessionSecret()}|${password()}`).digest();
    return crypto.createHmac('sha256', key).update(payload).digest('hex');
  }
  async function makeToken() {
    const expires = Date.now() + SESSION_DAYS * 86400000;
    const payload = `${expires}.${crypto.randomBytes(8).toString('hex')}`;
    return `${payload}.${await sign(payload)}`;
  }
  async function validToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || !password()) return false;
    const [expires, nonce, mac] = parts;
    if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;
    const revokedBefore = Number(await getSetting(deps.pool, 'dash_sessions_valid_after', '0'));
    if (Number(expires) - SESSION_DAYS * 86400000 < revokedBefore) return false;
    return safeEqual(mac, await sign(`${expires}.${nonce}`));
  }
  const bearer = req => (String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i) || [])[1]
    || (req.path === '/dash/api/stream' && req.method === 'GET' ? String(req.query.token || '') : '');

  const json = (res, status, body) => res.status(status).set('Cache-Control', 'no-store').json(body);

  async function guard(req, res, next) {
    try {
      if (!deps.pool) return json(res, 503, { ok: false, error: 'Database not connected' });
      if (!password()) return json(res, 503, { ok: false, error: 'Dashboard password is not set (DASHBOARD_PASSWORD in Render).' });
      if (!(await validToken(bearer(req)))) return json(res, 401, { ok: false, error: 'Not signed in' });
      next();
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  }

  // ---------- sign-in ----------
  // 5 wrong passwords within 15 minutes lock sign-in for 15 minutes; the owner gets one WhatsApp about it.
  app.post('/dash/api/login', async (req, res) => {
    if (!deps.pool) return json(res, 503, { ok: false, error: 'Database not connected' });
    if (!password()) return json(res, 503, { ok: false, error: 'Dashboard password is not set (DASHBOARD_PASSWORD in Render).' });
    const now = Date.now();
    if (now < failures.lockedUntil) return json(res, 429, { ok: false, error: `Too many wrong passwords. Try again in ${Math.ceil((failures.lockedUntil - now) / 60000)} minutes.` });
    const given = String(req.body?.password || '');
    const ok = safeEqual(crypto.createHash('sha256').update(given).digest('hex'), crypto.createHash('sha256').update(password()).digest('hex'));
    if (!ok) {
      failures.list = failures.list.filter(t => now - t < 15 * 60000);
      failures.list.push(now);
      if (failures.list.length >= 5) {
        failures.lockedUntil = now + 15 * 60000;
        failures.list = [];
        if (deps.notify) deps.notify('⚠️ 5 wrong passwords were tried on the Kamala dashboard. Sign-in is locked for 15 minutes. If this was not you, change DASHBOARD_PASSWORD in Render.', 'Dashboard sign-in attempts').catch(() => {});
      }
      await new Promise(r => setTimeout(r, 400));
      return json(res, 401, { ok: false, error: 'Wrong password.' });
    }
    failures.list = [];
    json(res, 200, { ok: true, token: await makeToken(), expiresInDays: SESSION_DAYS });
  });

  // Signs out every device (e.g. a lost phone).
  app.post('/dash/api/logout-everywhere', guard, async (req, res) => {
    await setSetting(deps.pool, 'dash_sessions_valid_after', String(Date.now()));
    json(res, 200, { ok: true });
  });

  app.get('/dash/api/me', guard, async (req, res) => json(res, 200, { ok: true, owner: `+${admin}`, alertMode: await alertMode(deps.pool) }));

  // ---------- analytics ----------
  const RANGES = { today: 1, '7d': 7, '30d': 30, '90d': 90 };
  app.get('/dash/api/summary', guard, async (req, res) => {
    try {
      const days = RANGES[req.query.range] || 30;
      // Start of the range: midnight IST, (days-1) days ago.
      const since = (await deps.pool.query(`SELECT ((NOW() AT TIME ZONE ${IST})::date - ($1::int - 1)) AT TIME ZONE ${IST} AS s`, [days])).rows[0].s;
      const totals = (await deps.pool.query(`SELECT
          (SELECT COUNT(*) FROM users WHERE phone <> $2)::int AS people_total,
          (SELECT COUNT(*) FROM users WHERE phone <> $2 AND first_contact >= $1)::int AS people_new,
          (SELECT COUNT(DISTINCT phone) FROM wa_messages WHERE role='user' AND phone <> $2 AND created_at >= $1)::int AS people_chatting,
          (SELECT COUNT(*) FROM wa_messages WHERE phone <> $2 AND created_at >= $1)::int AS messages,
          (SELECT COUNT(*) FROM wa_payment_links WHERE created_at >= $1)::int AS invoices,
          (SELECT COALESCE(SUM(amount_paise),0) FROM wa_payment_links WHERE created_at >= $1)::bigint AS invoiced_paise,
          (SELECT COUNT(*) FROM wa_payment_links WHERE status='paid' AND paid_at >= $1)::int AS payments,
          (SELECT COALESCE(SUM(amount_paise),0) FROM wa_payment_links WHERE status='paid' AND paid_at >= $1)::bigint AS revenue_paise,
          (SELECT COUNT(*) FROM wa_payment_links WHERE status='gateway_test_paid' AND paid_at >= $1)::int AS test_payments,
          (SELECT COUNT(*) FROM wa_payment_links WHERE status='request_created')::int AS open_invoices,
          (SELECT COALESCE(SUM(amount_paise),0) FROM wa_payment_links WHERE status='request_created')::bigint AS open_paise,
          (SELECT COUNT(*) FROM wa_payment_links WHERE status IN ('expired','gateway_test_expired') AND created_at >= $1)::int AS expired_invoices,
          (SELECT COUNT(*) FROM wa_payment_links WHERE upi_claimed_at IS NOT NULL AND status IN ('request_created','expired'))::int AS upi_to_check,
          (SELECT COUNT(*) FROM users WHERE phone <> $2 AND is_paused = true)::int AS paused_chats,
          (SELECT COUNT(*) FROM wa_payment_links WHERE status='paid' AND delivery_kind='delivered' AND report_delivered_at IS NULL)::int AS reports_to_deliver,
          (SELECT COUNT(*) FROM wa_payment_links WHERE status='request_created' AND created_at >= $1 AND created_at < NOW() - INTERVAL '2 hours')::int AS invoices_waiting_2h,
          (SELECT COUNT(DISTINCT phone) FROM wa_payment_links WHERE created_at >= $1)::int AS people_invoiced,
          (SELECT COUNT(DISTINCT phone) FROM wa_payment_links WHERE status='paid' AND paid_at >= $1)::int AS people_paid,
          (SELECT COUNT(*) FROM (SELECT DISTINCT m.phone FROM wa_messages m WHERE m.role='user' AND m.phone <> $2 AND m.created_at >= $1
              AND NOT EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=m.phone AND l.status='paid')) x)::int AS chatting_not_paid
        `, [since, admin])).rows[0];
      const daily = (await deps.pool.query(`WITH d AS (
          SELECT generate_series((NOW() AT TIME ZONE ${IST})::date - ($1::int - 1), (NOW() AT TIME ZONE ${IST})::date, '1 day')::date AS day)
        SELECT to_char(d.day,'YYYY-MM-DD') AS day,
          (SELECT COUNT(*) FROM users u WHERE u.phone <> $2 AND (u.first_contact AT TIME ZONE ${IST})::date = d.day)::int AS new_people,
          (SELECT COUNT(DISTINCT m.phone) FROM wa_messages m WHERE m.role='user' AND m.phone <> $2 AND (m.created_at AT TIME ZONE ${IST})::date = d.day)::int AS chatting,
          (SELECT COUNT(*) FROM wa_payment_links l WHERE (l.created_at AT TIME ZONE ${IST})::date = d.day)::int AS invoices,
          (SELECT COUNT(*) FROM wa_payment_links l WHERE l.status='paid' AND (l.paid_at AT TIME ZONE ${IST})::date = d.day)::int AS payments,
          (SELECT COALESCE(SUM(l.amount_paise),0) FROM wa_payment_links l WHERE l.status='paid' AND (l.paid_at AT TIME ZONE ${IST})::date = d.day)::bigint AS revenue_paise
        FROM d ORDER BY d.day`, [Math.min(days, 90), admin])).rows;
      const services = (await deps.pool.query(`SELECT service_name AS service,
          COUNT(*)::int AS invoices,
          COUNT(*) FILTER (WHERE status='paid')::int AS paid,
          COALESCE(SUM(amount_paise) FILTER (WHERE status='paid'),0)::bigint AS revenue_paise
        FROM wa_payment_links WHERE created_at >= $1 GROUP BY service_name ORDER BY revenue_paise DESC, invoices DESC`, [since])).rows;
      const stages = (await deps.pool.query(`SELECT COALESCE(lead_stage,'New') AS stage, COUNT(*)::int AS people
        FROM users WHERE phone <> $1 GROUP BY 1 ORDER BY 2 DESC`, [admin])).rows;
      json(res, 200, { ok: true, range: req.query.range || '30d', since, totals, daily, services, stages });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  // ---------- people (every person Kamala chatted with) ----------
  const FILTERS = {
    all: 'TRUE',
    customers: 'COALESCE(p.paid_count,0) > 0',
    invoiced_unpaid: 'COALESCE(p.invoices,0) > 0 AND COALESCE(p.paid_count,0) = 0',
    chatting_no_invoice: 'COALESCE(p.invoices,0) = 0',
    paused: 'u.is_paused = true',
    upi_to_check: 'COALESCE(p.upi_pending,0) > 0'
  };
  app.get('/dash/api/people', guard, async (req, res) => {
    try {
      const filter = FILTERS[req.query.filter] ? req.query.filter : 'all';
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const q = String(req.query.q || '').trim().slice(0, 80);
      const params = [admin, limit, offset];
      let search = 'TRUE';
      if (q) { params.push(`%${q.replace(/[%_\\]/g, m => '\\' + m)}%`); search = `(u.name ILIKE $4 OR u.phone LIKE $4 OR u.email ILIKE $4)`; }
      const rows = (await deps.pool.query(`
        WITH p AS (SELECT phone, COUNT(*)::int AS invoices,
            COUNT(*) FILTER (WHERE status='paid')::int AS paid_count,
            COALESCE(SUM(amount_paise) FILTER (WHERE status='paid'),0)::bigint AS paid_paise,
            COUNT(*) FILTER (WHERE status='request_created')::int AS open_invoices,
            COUNT(*) FILTER (WHERE upi_claimed_at IS NOT NULL AND status IN ('request_created','expired'))::int AS upi_pending,
            MAX(created_at) AS last_invoice_at
          FROM wa_payment_links GROUP BY phone)
        SELECT u.phone, u.name, u.email, u.status, u.lead_stage, u.lead_score, u.is_paused, u.pause_reason,
          u.first_contact, u.last_inbound_at, u.first_source, u.pain_point,
          lm.text AS last_text, lm.role AS last_role, lm.sender AS last_sender, lm.created_at AS last_at,
          COALESCE(p.invoices,0) AS invoices, COALESCE(p.paid_count,0) AS paid_count, COALESCE(p.paid_paise,0) AS paid_paise,
          COALESCE(p.open_invoices,0) AS open_invoices, COALESCE(p.upi_pending,0) AS upi_pending, p.last_invoice_at,
          (u.last_inbound_at > NOW() - INTERVAL '24 hours') AS window_open,
          COUNT(*) OVER() AS total
        FROM users u
        LEFT JOIN p ON p.phone = u.phone
        LEFT JOIN LATERAL (SELECT text, role, sender, created_at FROM wa_messages m WHERE m.phone = u.phone ORDER BY id DESC LIMIT 1) lm ON TRUE
        WHERE u.phone <> $1 AND ${search} AND ${FILTERS[filter]}
        ORDER BY COALESCE(lm.created_at, u.last_contact) DESC NULLS LAST
        LIMIT $2 OFFSET $3`, params)).rows;
      json(res, 200, { ok: true, filter, total: rows[0] ? Number(rows[0].total) : 0, people: rows.map(({ total, ...r }) => r) });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  app.get('/dash/api/people/:phone', guard, async (req, res) => {
    try {
      const phone = normalize(req.params.phone);
      const u = (await deps.pool.query(`SELECT phone, name, email, dob, tob, pob, gender, billing_address, status, lead_stage, lead_score,
          is_paused, pause_reason, first_contact, last_inbound_at, last_contact, first_source, pain_point, message_count,
          marketing_opt_in, marketing_opt_out, (last_inbound_at > NOW() - INTERVAL '24 hours') AS window_open
        FROM users WHERE phone=$1`, [phone])).rows[0];
      if (!u) return json(res, 404, { ok: false, error: 'No such person' });
      const invoices = (await deps.pool.query(`SELECT l.payment_link_id, l.request_invoice_number AS invoice_number, l.service_name, l.amount_paise,
          l.status, l.created_at, l.paid_at, l.paid_by, l.delivery_kind, l.appointment_start, l.meet_link, l.razorpay_payment_id,
          l.upi_claimed_at, l.report_delivered_at, f.status AS fulfilment
        FROM wa_payment_links l LEFT JOIN wa_payment_fulfillments f ON f.payment_link_id = l.payment_link_id
        WHERE l.phone=$1 ORDER BY l.created_at DESC LIMIT 50`, [phone])).rows;
      json(res, 200, { ok: true, person: u, invoices });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  // ---------- chats ----------
  app.get('/dash/api/chats/:phone/messages', guard, async (req, res) => {
    try {
      const phone = normalize(req.params.phone);
      const before = /^\d+$/.test(String(req.query.before || '')) ? req.query.before : null;
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
      const rows = (await deps.pool.query(`SELECT id, role, COALESCE(sender, CASE WHEN role='user' THEN 'customer' ELSE 'kamala' END) AS sender,
          text, created_at FROM wa_messages WHERE phone=$1 AND ($2::bigint IS NULL OR id < $2::bigint) ORDER BY id DESC LIMIT $3`,
      [phone, before, limit])).rows;
      json(res, 200, { ok: true, phone, messages: rows.reverse(), more: rows.length === limit });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  // The owner replies from the business number. WhatsApp only allows free text within 24 hours of the customer's
  // last message (outside it the page offers a call instead). Kamala keeps replying unless pauseKamala is true.
  app.post('/dash/api/chats/:phone/send', guard, async (req, res) => {
    try {
      const phone = normalize(req.params.phone);
      const text = String(req.body?.text || '').trim();
      if (!phone || phone === admin) return json(res, 400, { ok: false, error: 'Invalid number' });
      if (!text) return json(res, 400, { ok: false, error: 'Empty message' });
      if (text.length > 4000) return json(res, 400, { ok: false, error: 'Message too long (max 4000 characters)' });
      const u = (await deps.pool.query(`SELECT (last_inbound_at > NOW() - INTERVAL '24 hours') AS open FROM users WHERE phone=$1`, [phone])).rows[0];
      if (!u) return json(res, 404, { ok: false, error: 'No such person' });
      if (!u.open) return json(res, 409, { ok: false, error: "WhatsApp's 24-hour window is closed: they have not messaged in the last 24 hours, so WhatsApp will not deliver a normal message. Wait for them to write, or reach them by call." });
      if (!(await deps.sendTextMessage(phone, text))) return json(res, 502, { ok: false, error: 'WhatsApp did not accept the message. Try again.' });
      await deps.saveTurn(phone, 'model', text, 'owner');
      const pause = req.body?.pauseKamala === true;
      if (pause) await deps.setPaused(phone, true);
      json(res, 200, { ok: true, sent: true, kamalaPaused: pause });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  app.post('/dash/api/chats/:phone/pause', guard, async (req, res) => {
    try {
      const phone = normalize(req.params.phone);
      const paused = req.body?.paused !== false;
      await deps.setPaused(phone, paused);
      events.emit('event', { type: 'person', phone, is_paused: paused });
      json(res, 200, { ok: true, phone, paused });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  // ---------- invoices ----------
  const INVOICE_FILTERS = {
    all: 'TRUE',
    paid: "l.status = 'paid'",
    unpaid: "l.status = 'request_created'",
    closed: "l.status NOT IN ('paid','request_created') AND l.status NOT LIKE 'gateway_test%'",
    upi_to_check: "l.upi_claimed_at IS NOT NULL AND l.status IN ('request_created','expired')",
    test: "l.status LIKE 'gateway_test%'",
    report_to_deliver: "l.status = 'paid' AND l.delivery_kind = 'delivered' AND l.report_delivered_at IS NULL"
  };
  app.get('/dash/api/invoices', guard, async (req, res) => {
    try {
      const filter = INVOICE_FILTERS[req.query.filter] ? req.query.filter : 'all';
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
      const rows = (await deps.pool.query(`SELECT l.payment_link_id, l.request_invoice_number AS invoice_number, l.phone,
          COALESCE(NULLIF(l.customer_name,''), u.name) AS name, l.service_name, l.amount_paise, l.status, l.created_at, l.paid_at,
          l.paid_by, l.delivery_kind, l.appointment_start, l.upi_claimed_at, l.report_delivered_at, f.status AS fulfilment, COUNT(*) OVER() AS total
        FROM wa_payment_links l
        LEFT JOIN wa_payment_fulfillments f ON f.payment_link_id = l.payment_link_id
        LEFT JOIN users u ON u.phone = l.phone
        WHERE ${INVOICE_FILTERS[filter]}
        ORDER BY l.created_at DESC LIMIT $1 OFFSET $2`, [limit, offset])).rows;
      json(res, 200, { ok: true, filter, total: rows[0] ? Number(rows[0].total) : 0, invoices: rows.map(({ total, ...r }) => r) });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  const linkRow = async id => (await deps.pool.query('SELECT * FROM wa_payment_links WHERE payment_link_id=$1', [String(id || '')])).rows[0];

  // The exact invoice (sent with the link) or receipt (after payment) as a PDF.
  app.get('/dash/api/invoices/:id/pdf', guard, async (req, res) => {
    try {
      const row = await linkRow(req.params.id);
      if (!row) return json(res, 404, { ok: false, error: 'No such invoice' });
      const kind = req.query.kind === 'receipt' ? 'receipt' : 'invoice';
      const pdf = await deps.rebuildInvoicePdf(row, kind);
      const name = `${kind === 'receipt' ? 'Receipt' : 'Invoice'}_${String(row.request_invoice_number || row.payment_link_id).replace(/[^A-Za-z0-9-]/g, '-')}.pdf`;
      res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${name}"`, 'Cache-Control': 'no-store' }).send(pdf);
    } catch (e) {
      json(res, 400, { ok: false, error: e.message });
    }
  });

  // The owner saw a report's UPI payment in his UPI app: same as "/paid", for this invoice.
  app.post('/dash/api/invoices/:id/confirm-upi', guard, async (req, res) => {
    try {
      const row = await linkRow(req.params.id);
      if (!row) return json(res, 404, { ok: false, error: 'No such invoice' });
      const message = await deps.confirmUpiPayment(row.phone, row.payment_link_id);
      const after = await linkRow(req.params.id);
      json(res, 200, { ok: after.status === 'paid', status: after.status, message });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message || e.error?.description });
    }
  });

  // Tracks which paid reports have been sent to the customer.
  app.post('/dash/api/invoices/:id/delivered', guard, async (req, res) => {
    try {
      const row = await linkRow(req.params.id);
      if (!row) return json(res, 404, { ok: false, error: 'No such invoice' });
      if (row.delivery_kind !== 'delivered' || row.status !== 'paid') return json(res, 400, { ok: false, error: 'Only paid reports can be marked delivered.' });
      const delivered = req.body?.delivered !== false;
      const r = await deps.pool.query('UPDATE wa_payment_links SET report_delivered_at=$2 WHERE payment_link_id=$1 RETURNING report_delivered_at',
        [row.payment_link_id, delivered ? new Date() : null]);
      events.emit('event', { type: 'invoice_update', payment_link_id: row.payment_link_id, report_delivered_at: r.rows[0].report_delivered_at });
      json(res, 200, { ok: true, report_delivered_at: r.rows[0].report_delivered_at });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  // How far the Google Sheet copy of chats and people has got.
  app.get('/dash/api/sheet-sync', guard, async (req, res) => {
    try { json(res, 200, { ok: true, ...(await deps.sheetSyncStatus()) }); } catch (e) { json(res, 500, { ok: false, error: e.message }); }
  });

  // ---------- alerts and settings ----------
  app.get('/dash/api/alerts', guard, async (req, res) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      const rows = (await deps.pool.query('SELECT id, created_at, subject, text, priority, whatsapp_sent FROM wa_alerts ORDER BY id DESC LIMIT $1', [limit])).rows;
      json(res, 200, { ok: true, alerts: rows });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  app.post('/dash/api/settings', guard, async (req, res) => {
    try {
      const mode = req.body?.alertMode;
      if (mode !== 'all' && mode !== 'important') return json(res, 400, { ok: false, error: "alertMode must be 'all' or 'important'" });
      await setSetting(deps.pool, 'dash_alert_mode', mode);
      json(res, 200, { ok: true, alertMode: mode });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  // ---------- live updates ----------
  let streams = 0;
  app.get('/dash/api/stream', guard, (req, res) => {
    if (streams >= 20) return json(res, 429, { ok: false, error: 'Too many open dashboard tabs' });
    streams++;
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    res.write('retry: 3000\n\n');
    const send = ev => { res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`); };
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    events.on('event', send);
    req.on('close', () => { clearInterval(ping); events.off('event', send); streams--; });
  });
}

module.exports = { mount, migrate, events, recordAlert, isLowPriority };
