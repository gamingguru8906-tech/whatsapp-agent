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
  'Hot lead',
  'Report sent',
  'Report feedback'
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS owner_notes TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tags TEXT;
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
  let revoked = { at: 0, value: 0 }; // cached for 30 seconds; sign-out-everywhere updates it at once

  // Which websites may call this API from a browser. DASHBOARD_ORIGINS: comma-separated (e.g.
  // https://dash.veshannastro.co.in,https://kamala-dashboard.pages.dev). Unset: any site (the token is still required).
  app.use('/dash/api', (req, res, next) => {
    const origin = req.headers.origin;
    const allowed = String(process.env.DASHBOARD_ORIGINS || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean)
      .map(s => (/^https?:\/\//i.test(s) ? s : 'https://' + s).toLowerCase()); // "1980.example.in" means https://1980.example.in
    const ok = origin && (!allowed.length || allowed.includes(String(origin).toLowerCase()));
    if (ok) {
      res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Max-Age': '600' });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(ok ? 204 : 403);
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
    if (!revoked.at || Date.now() - revoked.at > 30000) revoked = { at: Date.now(), value: Number(await getSetting(deps.pool, 'dash_sessions_valid_after', '0')) };
    const revokedBefore = revoked.value;
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
    const now = Date.now();
    await setSetting(deps.pool, 'dash_sessions_valid_after', String(now));
    revoked = { at: now, value: now };
    json(res, 200, { ok: true });
  });

  app.get('/dash/api/me', guard, async (req, res) => {
    const [mode, goal] = await Promise.all([alertMode(deps.pool), getSetting(deps.pool, 'dash_daily_goal_paise', '0')]);
    json(res, 200, { ok: true, owner: `+${admin}`, alertMode: mode, dailyGoalRupees: (Number(goal) || 0) / 100 });
  });

  // ---------- analytics ----------
  const RANGES = { today: 1, '7d': 7, '30d': 30, '90d': 90 };
  app.get('/dash/api/summary', guard, async (req, res) => {
    try {
      const days = RANGES[req.query.range] || 30;
      // Start of the range: midnight IST, (days-1) days ago.
      const since = (await deps.pool.query(`SELECT ((NOW() AT TIME ZONE ${IST})::date - ($1::int - 1)) AT TIME ZONE ${IST} AS s`, [days])).rows[0].s;

      // All queries start together (each one is a trip to the database).
      const q1$ = deps.pool.query(`SELECT
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
        `, [since, admin]);
      const q2$ = deps.pool.query(`WITH d AS (
          SELECT generate_series((NOW() AT TIME ZONE ${IST})::date - ($1::int - 1), (NOW() AT TIME ZONE ${IST})::date, '1 day')::date AS day)
        SELECT to_char(d.day,'YYYY-MM-DD') AS day,
          (SELECT COUNT(*) FROM users u WHERE u.phone <> $2 AND (u.first_contact AT TIME ZONE ${IST})::date = d.day)::int AS new_people,
          (SELECT COUNT(DISTINCT m.phone) FROM wa_messages m WHERE m.role='user' AND m.phone <> $2 AND (m.created_at AT TIME ZONE ${IST})::date = d.day)::int AS chatting,
          (SELECT COUNT(*) FROM wa_payment_links l WHERE (l.created_at AT TIME ZONE ${IST})::date = d.day)::int AS invoices,
          (SELECT COUNT(*) FROM wa_payment_links l WHERE l.status='paid' AND (l.paid_at AT TIME ZONE ${IST})::date = d.day)::int AS payments,
          (SELECT COALESCE(SUM(l.amount_paise),0) FROM wa_payment_links l WHERE l.status='paid' AND (l.paid_at AT TIME ZONE ${IST})::date = d.day)::bigint AS revenue_paise
        FROM d ORDER BY d.day`, [Math.min(days, 90), admin]);
      const q3$ = deps.pool.query(`SELECT service_name AS service,
          COUNT(*)::int AS invoices,
          COUNT(*) FILTER (WHERE status='paid')::int AS paid,
          COALESCE(SUM(amount_paise) FILTER (WHERE status='paid'),0)::bigint AS revenue_paise
        FROM wa_payment_links WHERE created_at >= $1 GROUP BY service_name ORDER BY revenue_paise DESC, invoices DESC`, [since]);
      const q4$ = deps.pool.query(`SELECT COALESCE(lead_stage,'New') AS stage, COUNT(*)::int AS people
        FROM users WHERE phone <> $1 GROUP BY 1 ORDER BY 2 DESC`, [admin]);
      q1$.catch(() => {}); q2$.catch(() => {}); q3$.catch(() => {}); q4$.catch(() => {});
      const totals = (await q1$).rows[0];
      const daily = (await q2$).rows;
      const services = (await q3$).rows;
      const stages = (await q4$).rows;
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
      if (q) { params.push(`%${q.replace(/[%_\\]/g, m => '\\' + m)}%`); search = `(u.name ILIKE $${params.length} OR u.phone LIKE $${params.length} OR u.email ILIKE $${params.length})`; }
      const tag = String(req.query.tag || '').trim().toLowerCase().slice(0, 40);
      if (tag) { params.push(tag); search += ` AND $${params.length} = ANY (string_to_array(lower(COALESCE(u.tags,'')), ','))`; }
      const rows = (await deps.pool.query(`
        WITH p AS (SELECT phone, COUNT(*)::int AS invoices,
            COUNT(*) FILTER (WHERE status='paid')::int AS paid_count,
            COALESCE(SUM(amount_paise) FILTER (WHERE status='paid'),0)::bigint AS paid_paise,
            COUNT(*) FILTER (WHERE status='request_created')::int AS open_invoices,
            COUNT(*) FILTER (WHERE upi_claimed_at IS NOT NULL AND status IN ('request_created','expired'))::int AS upi_pending,
            MAX(created_at) AS last_invoice_at
          FROM wa_payment_links GROUP BY phone)
        SELECT u.phone, u.name, u.email, u.status, u.lead_stage, u.lead_score, u.is_paused, u.pause_reason, u.tags,
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
          marketing_opt_in, marketing_opt_out, owner_notes, tags, (last_inbound_at > NOW() - INTERVAL '24 hours') AS window_open
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
    report_to_deliver: "l.status = 'paid' AND l.delivery_kind = 'delivered' AND l.report_delivered_at IS NULL",
    lost: "l.status IN ('expired','gateway_test_expired','delivery_failed','discount10_offered') OR (l.status = 'request_created' AND l.created_at < NOW() - INTERVAL '12 hours')"
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

  // ---------- notes and tags (owner's own, never shown to the customer) ----------
  app.post('/dash/api/people/:phone/notes', guard, async (req, res) => {
    try {
      const phone = normalize(req.params.phone);
      const notes = String(req.body?.notes ?? '').slice(0, 4000);
      const tags = [...new Set((Array.isArray(req.body?.tags) ? req.body.tags : String(req.body?.tags || '').split(','))
        .map(t => String(t).trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').slice(0, 30)).filter(Boolean))].slice(0, 12);
      const r = await deps.pool.query('UPDATE users SET owner_notes=$2, tags=$3 WHERE phone=$1 RETURNING owner_notes, tags',
        [phone, notes, tags.join(',')]);
      if (!r.rows[0]) return json(res, 404, { ok: false, error: 'No such person' });
      json(res, 200, { ok: true, ...r.rows[0] });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  app.get('/dash/api/tags', guard, async (req, res) => {
    try {
      const rows = (await deps.pool.query(`SELECT t AS tag, COUNT(*)::int AS people FROM users,
        LATERAL unnest(string_to_array(COALESCE(tags,''), ',')) t WHERE t <> '' AND phone <> $1 GROUP BY t ORDER BY 2 DESC, 1`, [admin])).rows;
      json(res, 200, { ok: true, tags: rows });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
  });

  // ---------- insights: money lost, drop-off, sources, response quality, best hours, repeat buyers,
  // report delivery time, daily goal and the morning briefing ----------
  app.get('/dash/api/insights', guard, async (req, res) => {
    try {
      const db = deps.pool;
      const days = RANGES[req.query.range] || 30;
      const since = (await db.query(`SELECT ((NOW() AT TIME ZONE ${IST})::date - ($1::int - 1)) AT TIME ZONE ${IST} AS s`, [days])).rows[0].s;
      const LOST = INVOICE_FILTERS.lost;

      // All queries start together (each one is a trip to the database).
      const q1$ = db.query(`SELECT l.payment_link_id, l.request_invoice_number AS invoice_number, l.phone,
          COALESCE(NULLIF(l.customer_name,''), u.name) AS name, l.service_name, l.amount_paise, l.status, l.created_at,
          (u.last_inbound_at > NOW() - INTERVAL '24 hours') AS window_open
        FROM wa_payment_links l LEFT JOIN users u ON u.phone = l.phone
        WHERE (${LOST}) AND l.created_at >= $1
          AND NOT EXISTS (SELECT 1 FROM wa_payment_links p WHERE p.phone = l.phone AND p.status = 'paid'
            AND p.service_name = l.service_name AND p.created_at >= l.created_at)
        ORDER BY l.created_at DESC LIMIT 100`, [since]);
      const q2$ = db.query(`WITH c AS (SELECT DISTINCT phone FROM wa_messages WHERE role='user' AND phone <> $2 AND created_at >= $1)
        SELECT COUNT(*)::int AS chatted,
          COUNT(*) FILTER (WHERE COALESCE(u.core_concern, u.problem_category, u.pain_point) IS NOT NULL)::int AS shared_problem,
          COUNT(*) FILTER (WHERE u.asked_price_at IS NOT NULL)::int AS asked_price,
          COUNT(*) FILTER (WHERE u.dob IS NOT NULL AND u.dob <> '')::int AS gave_details,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=c.phone))::int AS got_invoice,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=c.phone AND l.status='paid'))::int AS paid
        FROM c JOIN users u ON u.phone = c.phone`, [since, admin]);
      const q3$ = db.query(`SELECT COALESCE(NULLIF(u.first_source,''),'Unknown') AS source, COUNT(*)::int AS people,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=u.phone))::int AS invoiced,
          COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM wa_payment_links l WHERE l.phone=u.phone AND l.status='paid'))::int AS paid,
          COALESCE(SUM((SELECT SUM(l.amount_paise) FROM wa_payment_links l WHERE l.phone=u.phone AND l.status='paid')),0)::bigint AS revenue_paise
        FROM users u WHERE u.phone <> $2 AND u.first_contact >= $1 GROUP BY 1 ORDER BY revenue_paise DESC, people DESC`, [since, admin]);
      const q4$ = db.query(`SELECT DISTINCT ON (m.phone) m.phone, m.role, m.text, m.created_at, u.name, u.is_paused
        FROM wa_messages m JOIN users u ON u.phone = m.phone
        WHERE m.phone <> $2 AND m.created_at >= $1 ORDER BY m.phone, m.id DESC`, [since, admin]);
      const q5$ = db.query(`SELECT 'msg' AS k, EXTRACT(HOUR FROM created_at AT TIME ZONE ${IST})::int AS h, COUNT(*)::int AS n
          FROM wa_messages WHERE role='user' AND phone <> $2 AND created_at >= $1 GROUP BY 2
        UNION ALL SELECT 'pay', EXTRACT(HOUR FROM paid_at AT TIME ZONE ${IST})::int, COUNT(*)::int
          FROM wa_payment_links WHERE status='paid' AND paid_at >= $1 GROUP BY 2`, [since, admin]);
      const q6$ = db.query(`SELECT l.phone, MAX(COALESCE(NULLIF(l.customer_name,''), u.name)) AS name, COUNT(*)::int AS purchases,
          SUM(l.amount_paise)::bigint AS paid_paise, MAX(l.paid_at) AS last_paid_at
        FROM wa_payment_links l LEFT JOIN users u ON u.phone=l.phone WHERE l.status='paid' AND l.phone <> $1
        GROUP BY l.phone HAVING COUNT(*) >= 2 ORDER BY paid_paise DESC LIMIT 30`, [admin]);
      const q7$ = db.query(`SELECT l.phone, MAX(COALESCE(NULLIF(l.customer_name,''), u.name)) AS name,
          string_agg(DISTINCT l.service_name, ', ') AS reports, MAX(l.paid_at) AS last_paid_at,
          BOOL_OR(u.last_inbound_at > NOW() - INTERVAL '24 hours') AS window_open
        FROM wa_payment_links l LEFT JOIN users u ON u.phone=l.phone
        WHERE l.status='paid' AND l.delivery_kind='delivered' AND l.phone <> $1
          AND NOT EXISTS (SELECT 1 FROM wa_payment_links x WHERE x.phone=l.phone AND x.status='paid' AND COALESCE(x.delivery_kind,'live') <> 'delivered')
        GROUP BY l.phone ORDER BY MAX(l.paid_at) DESC LIMIT 30`, [admin]);
      const q8$ = db.query(`SELECT
          ROUND(AVG(EXTRACT(EPOCH FROM (report_delivered_at - paid_at)) / 3600)::numeric, 1)::float AS avg_hours,
          COUNT(*) FILTER (WHERE report_delivered_at IS NOT NULL)::int AS delivered,
          COUNT(*) FILTER (WHERE report_delivered_at IS NULL)::int AS pending,
          ROUND(MAX(EXTRACT(EPOCH FROM (NOW() - paid_at)) / 3600) FILTER (WHERE report_delivered_at IS NULL)::numeric, 1)::float AS oldest_pending_hours
        FROM wa_payment_links WHERE status='paid' AND delivery_kind='delivered' AND paid_at >= $1`, [since]);
      const q9$ = getSetting(db, 'dash_daily_goal_paise', '0');
      const q10$ = db.query(`SELECT COALESCE(SUM(amount_paise),0) AS p FROM wa_payment_links
        WHERE status='paid' AND (paid_at AT TIME ZONE ${IST})::date = (NOW() AT TIME ZONE ${IST})::date`);
      const q11$ = db.query(`SELECT l.phone, COALESCE(NULLIF(l.customer_name,''), u.name) AS name, l.service_name, l.appointment_start, l.meet_link
        FROM wa_payment_links l LEFT JOIN users u ON u.phone=l.phone
        WHERE l.status IN ('paid','gateway_test_paid') AND (l.appointment_start AT TIME ZONE ${IST})::date = (NOW() AT TIME ZONE ${IST})::date
        ORDER BY l.appointment_start`);
      const q12$ = db.query(`SELECT phone, name, lead_score, lead_stage FROM users
        WHERE phone <> $1 AND lead_score >= 60 AND COALESCE(is_customer,false) = false AND last_inbound_at > NOW() - INTERVAL '3 days'
        ORDER BY lead_score DESC LIMIT 10`, [admin]);
      const q13$ = db.query(`SELECT
          (SELECT COUNT(*) FROM wa_payment_links WHERE status='paid' AND delivery_kind='delivered' AND report_delivered_at IS NULL)::int AS reports_to_deliver,
          (SELECT COUNT(*) FROM wa_payment_links WHERE upi_claimed_at IS NOT NULL AND status IN ('request_created','expired'))::int AS upi_to_check,
          (SELECT COUNT(*) FROM wa_payment_links WHERE (created_at AT TIME ZONE ${IST})::date = (NOW() AT TIME ZONE ${IST})::date - 1 AND status <> 'paid' AND status NOT LIKE 'gateway_test%')::int AS unpaid_yesterday,
          (SELECT COUNT(*) FROM users WHERE phone <> $1 AND is_paused = true)::int AS paused_chats`, [admin]);
      q1$.catch(() => {}); q2$.catch(() => {}); q3$.catch(() => {}); q4$.catch(() => {}); q5$.catch(() => {}); q6$.catch(() => {}); q7$.catch(() => {}); q8$.catch(() => {}); q9$.catch(() => {}); q10$.catch(() => {}); q11$.catch(() => {}); q12$.catch(() => {}); q13$.catch(() => {});
      // 1. Money lost: invoices that ran out or sat unpaid over 12 hours, and nobody paid later for the same service.
      const lostRows = (await q1$).rows;
      const lost = { count: lostRows.length, paise: lostRows.reduce((a, r) => a + Number(r.amount_paise || 0), 0), invoices: lostRows.slice(0, 30) };
      // 2. Where people drop off (people who chatted in the period).
      const funnel = (await q2$).rows[0];
      // 3. Lead sources that bring paying people, not just chats.
      const sources = (await q3$).rows;
      // 4. Response quality: Kamala asked and the customer went quiet (over 24h); the customer wrote last and got no reply (over 10 min).
      const last = (await q4$).rows;
      const now = Date.now();
      const wentQuiet = last.filter(r => r.role === 'model' && /\?/.test(r.text) && now - new Date(r.created_at) > 86400000);
      const unreplied = last.filter(r => r.role === 'user' && now - new Date(r.created_at) > 600000);
      const pick = r => ({ phone: r.phone, name: r.name, text: String(r.text).slice(0, 160), at: r.created_at, paused: r.is_paused });
      const response = { chats: last.length, went_quiet: wentQuiet.length, unreplied: unreplied.length,
        went_quiet_list: wentQuiet.slice(0, 20).map(pick), unreplied_list: unreplied.slice(0, 20).map(pick) };
      // 5. Best hours (IST) for customer messages and payments.
      const hourRows = (await q5$).rows;
      const hours = { messages: Array(24).fill(0), payments: Array(24).fill(0) };
      for (const r of hourRows) (r.k === 'msg' ? hours.messages : hours.payments)[r.h] = r.n;
      // 6. Repeat customers, and report buyers who never booked a live consultation (upsell list).
      const repeat = (await q6$).rows;
      const reportOnly = (await q7$).rows;
      // 7. Report delivery time.
      const delivery = (await q8$).rows[0];
      // 8. Daily goal.
      const goalPaise = Number(await q9$) || 0;
      const todayPaise = Number((await q10$).rows[0].p);
      // 9. Morning briefing: what needs you today.
      const consults = (await q11$).rows;
      const hot = (await q12$).rows;
      const counts = (await q13$).rows[0];
      json(res, 200, { ok: true, range: req.query.range || '30d', since, lost, funnel, sources, response, hours,
        repeat: { customers: repeat, report_only: reportOnly }, delivery,
        goal: { target_paise: goalPaise, today_paise: todayPaise },
        morning: { consults_today: consults, hot_leads: hot, ...counts } });
    } catch (e) {
      json(res, 500, { ok: false, error: e.message });
    }
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
      const out = {};
      if (req.body?.alertMode !== undefined) {
        const mode = req.body.alertMode;
        if (mode !== 'all' && mode !== 'important') return json(res, 400, { ok: false, error: "alertMode must be 'all' or 'important'" });
        await setSetting(deps.pool, 'dash_alert_mode', mode);
        out.alertMode = mode;
      }
      if (req.body?.dailyGoalRupees !== undefined) {
        const rupees = Number(req.body.dailyGoalRupees);
        if (!Number.isFinite(rupees) || rupees < 0 || rupees > 10000000) return json(res, 400, { ok: false, error: 'Daily goal must be a number of rupees' });
        await setSetting(deps.pool, 'dash_daily_goal_paise', String(Math.round(rupees * 100)));
        out.dailyGoalRupees = rupees;
      }
      if (!Object.keys(out).length) return json(res, 400, { ok: false, error: 'Nothing to change' });
      json(res, 200, { ok: true, ...out });
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
