'use strict';
// 2027 Personal Year Report orders paid on the website (veshannastro.co.in/2027-numerology-report/).
//
// An order reaches Kamala three ways, all safe to repeat:
//   1. the website's hand-off right after payment (POST /web-order, signed with WEB_ORDER_SECRET),
//   2. Razorpay's own order.paid webhook (/razorpay-webhook),
//   3. a sweep every 10 minutes of the last three days' paid orders, in case both of the above were missed.
// Whatever arrives, Kamala asks Razorpay for the order and payment herself and acts only on what Razorpay says.
// Each step (invoice number, records, Sheet, WhatsApp, owner alert) runs once and is remembered in web_orders.steps,
// so a retry after a crash or a Google hiccup carries on where it stopped and never sends anything twice.

const crypto = require('crypto');

const RECEIPT_PREFIX = 'r27_';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MAX_ATTEMPTS = 6;

function priceText(amount, currency) {
  const n = Number(amount);
  return currency === 'INR'
    ? '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 2 })
    : (currency === 'USD' ? 'US$' : currency + ' ') + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function dobText(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(iso || '');
}

/** Constant-time check of the website's signature over the raw request body. */
function signatureValid(secret, rawBody, signature) {
  if (!secret || !rawBody || !signature) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'));
  const got = Buffer.from(String(signature));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}

const isOurs = order => Boolean(order) && String(order.receipt || '').startsWith(RECEIPT_PREFIX) && (order.notes || {}).product === 'r27';

/**
 * Checks Razorpay's order and payment against each other. Returns
 * { ok: true, details } or { ok: false, why, notOurs?, notPaid? }.
 */
function inspect(order, payment) {
  if (!isOurs(order)) return { ok: false, notOurs: true, why: 'not a 2027 website order' };
  if (!payment) return { ok: false, notPaid: true, why: 'no payment yet' };
  if (payment.order_id !== order.id) return { ok: false, why: `payment ${payment.id} belongs to another order` };
  if (payment.status !== 'captured') return { ok: false, notPaid: true, why: `payment is ${payment.status}` };
  if (Number(payment.amount) !== Number(order.amount) || payment.currency !== order.currency) {
    return { ok: false, why: `paid ${payment.amount} ${payment.currency}, order is ${order.amount} ${order.currency}` };
  }
  const n = order.notes || {};
  const phone = String(n.phone || '').replace(/\D/g, '');
  const name = String(n.customer_name || '').trim();
  if (!/^\d{11,15}$/.test(phone) || !name) return { ok: false, why: 'the order has no usable name or WhatsApp number' };
  const amount = Number(order.amount) / 100;
  return {
    ok: true,
    details: {
      orderId: order.id, paymentId: payment.id, receipt: order.receipt,
      report: String(n.report || ''), reportName: String(n.report_name || '2027 report'),
      service: `2027 Report: ${String(n.report_name || 'Personal Year')}`,
      name, firstName: name.split(/\s+/)[0], phone, email: String(n.email || ''),
      dob: String(n.dob || ''), dobText: dobText(n.dob), tob: String(n.tob || ''), pob: String(n.pob || ''),
      referral: String(n.referral || ''), updates: n.updates === 'yes',
      amount, currency: order.currency, mrp: Number(n.mrp) || amount,
      paidAt: new Date((Number(payment.created_at) || Math.floor(Date.now() / 1000)) * 1000).toISOString()
    }
  };
}

const LEAD_STAGES = ['form', 'whatsapp', 'checkout'];
const cleanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

/** The website's lead, checked again here: a usable WhatsApp number and name are required, the rest is optional. */
function readLead(input) {
  const i = input || {};
  const phone = String(i.phone || '').replace(/\D/g, '');
  const name = cleanText(i.name, 80);
  if (!/^\d{11,15}$/.test(phone) || !/^[\p{L}\p{M}][\p{L}\p{M} .'-]{1,79}$/u.test(name)) return null;
  const email = cleanText(i.email, 120).toLowerCase();
  return {
    phone, name,
    email: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) ? email : '',
    dob: /^\d{4}-\d{2}-\d{2}$/.test(String(i.dob || '')) ? dobText(i.dob) : '',
    tob: /^(1[0-2]|[1-9]):[0-5]\d (AM|PM)$/.test(String(i.tob || '')) ? String(i.tob) : '',
    pob: cleanText(i.pob, 100),
    report: cleanText(i.report, 20), reportName: cleanText(i.report_name, 60), price: cleanText(i.price, 20),
    referral: cleanText(i.referral, 40),
    stage: LEAD_STAGES.includes(i.stage) ? i.stage : 'form'
  };
}

/** One line for Kamala's notes about this person: what they did on the website. */
function leadLine(lead) {
  if (!lead) return '';
  const when = new Date(lead.last_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';
  const what = `${lead.report_name || '2027 report'}${lead.price ? ` (${lead.price})` : ''}`;
  const stage = lead.stage === 'paid' ? 'paid for it on the website'
    : lead.stage === 'checkout' ? 'opened the payment window but did not finish paying'
    : lead.stage === 'whatsapp' ? 'chose to send the order on WhatsApp'
    : 'filled the order form but has not paid yet';
  return `Filled the 2027 Personal Year Report order form on veshannastro.co.in for the ${what} on ${when}, and ${stage}. Their name and birth details above came from that form.`;
}

const titleFromPath = p => {
  const slug = String(p || '').replace(/^\/blog\//, '').replace(/\.html$/, '').replace(/\/$/, '');
  return slug ? slug.split('-').map(w => (/^\d+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ') : '';
};

/** What someone did on the website, most recent first, in one sentence for Kamala's notes. */
function activityLine(events) {
  const ev = Array.isArray(events) ? events : [];
  if (!ev.length) return '';
  const visits = ev.filter(e => e.kind === 'visit');
  const days = new Set(visits.map(e => new Date(e.at).toISOString().slice(0, 10)));
  const last = ev.reduce((m, e) => (new Date(e.at) > m ? new Date(e.at) : m), new Date(0));
  const read = [];
  for (const e of visits) {
    if (!/^\/blog\/./.test(e.path || '')) continue;
    const t = String((e.detail && e.detail.title) || titleFromPath(e.path)).slice(0, 80);
    if (t && !read.includes(t)) read.push(t);
  }
  const pys = [...new Set(ev.filter(e => e.kind === 'personal_year_calculated' && e.detail && e.detail.personal_year).map(e => e.detail.personal_year))];
  const chose = ev.find(e => e.kind === 'select_item' && e.detail && e.detail.item_name);
  const has = k => ev.some(e => e.kind === k);
  const bits = [`${visits.length || 1} visit${visits.length === 1 ? '' : 's'}${days.size > 1 ? ` over ${days.size} days` : ''} (last ${last.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} IST)`];
  if (read.length) bits.push(`read ${read.slice(0, 4).join(', ')}`);
  if (pys.length) bits.push(`used the Personal Year calculator (Personal Year ${pys.slice(0, 3).join(', ')})`);
  if (chose) bits.push(`last looked at the ${chose.detail.item_name}`);
  if (has('whatsapp_click')) bits.push('tapped a WhatsApp button');
  if (has('purchase')) bits.push('paid online');
  else if (has('payment_failed')) bits.push('a payment attempt failed');
  else if (has('add_payment_info')) bits.push('opened the payment window without paying');
  return `Website activity: ${bits.join('; ')}.`;
}

function confirmationText(d, invoiceNumber, delivery) {
  return `✅ Payment received, ${d.firstName} ji! Razorpay has verified ${priceText(d.amount, d.currency)} for your ${d.reportName} 2027 report.\n\n`
    + `🧾 Invoice No.: ${invoiceNumber} (receipt attached)\n`
    + `📄 Your report is being prepared and will reach you here${d.email ? ` and on ${d.email}` : ''} within ${delivery}.\n\n`
    + 'Thank you for trusting Veshannastro 🙏';
}

function ownerText(d, invoiceNumber, delivered) {
  return `📄 New paid 2027 report (website): ${d.reportName}\n`
    + `Customer: ${d.name}\nPhone: +${d.phone}\nEmail: ${d.email || 'Not provided'}\nInvoice No.: ${invoiceNumber}\n`
    + `DOB: ${d.dobText || 'Not provided'}\nBirth time: ${d.tob || 'Not needed (Classic)'}\nBirth place: ${d.pob || 'Not provided'}\n`
    + (d.referral ? `Referral code: ${d.referral}\n` : '')
    + `Amount received: ${priceText(d.amount, d.currency)} (Razorpay ${d.paymentId})\nOrder: ${d.orderId}\n`
    + `WhatsApp confirmation: ${delivered}\n`
    + 'Please prepare and send the report within 24 hours.';
}

/**
 * deps: { pool, razorpay, allocateInvoiceNumber, generateInvoice, uploadMedia, deliver, sendTemplate, notifyOwner,
 *         postAppsScript, emit, reportPurchase, delivery, templateName, thanks: { template, mediaUrl, mediaType } }
 * pool and razorpay may be getters (they can be missing until the server is configured).
 */
function create(deps) {
  const db = () => deps.pool;

  async function migrate(pool) {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS web_orders (
        order_id TEXT PRIMARY KEY,
        payment_id TEXT,
        phone TEXT,
        status TEXT NOT NULL DEFAULT 'processing',
        steps JSONB NOT NULL DEFAULT '{}'::jsonb,
        details JSONB,
        invoice_number TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        via TEXT,
        paid_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS web_orders_status_idx ON web_orders (status, updated_at);
      CREATE TABLE IF NOT EXISTS web_leads (
        phone TEXT PRIMARY KEY,
        name TEXT, email TEXT, dob TEXT, tob TEXT, pob TEXT,
        report TEXT, report_name TEXT, price TEXT, referral TEXT,
        stage TEXT NOT NULL DEFAULT 'form',
        times INTEGER NOT NULL DEFAULT 1,
        first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      -- What people do on the website (written by the website's own functions, veshannastro6/api/r27/_db.js).
      CREATE TABLE IF NOT EXISTS web_visitors (
        visitor TEXT PRIMARY KEY,
        phone TEXT,
        first_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS web_events (
        id BIGSERIAL PRIMARY KEY,
        visitor TEXT,
        phone TEXT,
        kind TEXT NOT NULL,
        detail JSONB NOT NULL DEFAULT '{}'::jsonb,
        path TEXT,
        at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS web_events_phone_idx ON web_events (phone, at DESC);
      CREATE INDEX IF NOT EXISTS web_events_visitor_idx ON web_events (visitor, at DESC);
    `);
  }

  // Razorpay's word on the order: the paid payment (captured, or authorized and then captured for the exact amount).
  async function fetchPaid(orderId, paymentId) {
    const rz = deps.razorpay;
    const order = await rz.orders.fetch(orderId);
    if (!isOurs(order)) return { order, payment: null };
    let payment = null;
    if (paymentId) payment = await rz.payments.fetch(paymentId);
    if (!payment || payment.order_id !== order.id || !['captured', 'authorized'].includes(payment.status)) {
      const list = await rz.orders.fetchPayments(orderId);
      const items = Array.isArray(list && list.items) ? list.items : [];
      payment = items.find(p => p.status === 'captured') || items.find(p => p.status === 'authorized') || payment;
    }
    if (payment && payment.status === 'authorized' && payment.order_id === order.id && Number(payment.amount) === Number(order.amount)) {
      payment = await rz.payments.capture(payment.id, payment.amount, payment.currency);
    }
    return { order, payment };
  }

  /**
   * Checks an order with Razorpay and, if it is a paid 2027 order not yet handled, claims it and starts fulfilment.
   * Returns { status, job } where job is the running fulfilment (callers may await it or not).
   */
  async function handle({ orderId, paymentId = null, via = 'website' }) {
    const pool = db();
    if (!pool) throw new Error('No database: website orders need once-only tracking.');
    if (!deps.razorpay) throw new Error('Razorpay keys are not set on Kamala.');
    if (!/^order_[A-Za-z0-9]{6,40}$/.test(String(orderId || ''))) return { status: 'invalid' };
    const known = (await pool.query('SELECT status FROM web_orders WHERE order_id=$1', [orderId])).rows[0];
    if (known && (known.status === 'fulfilled' || known.status === 'manual_review')) return { status: known.status };

    const { order, payment } = await fetchPaid(orderId, paymentId);
    const check = inspect(order, payment);
    if (!check.ok) {
      if (check.notOurs) return { status: 'ignored' };
      if (check.notPaid) return { status: 'not_paid' };
      // A mismatch never fixes itself on retry: park it and tell the owner once.
      const parked = await pool.query(`INSERT INTO web_orders (order_id, payment_id, phone, status, last_error, via)
        VALUES ($1,$2,$3,'manual_review',$4,$5) ON CONFLICT (order_id) DO NOTHING RETURNING order_id`,
      [orderId, payment ? payment.id : null, String((order.notes || {}).phone || ''), check.why, via]);
      if (parked.rows.length) {
        await deps.notifyOwner(`⚠️ Website 2027 order ${orderId} needs a manual check: ${check.why}. Nothing was sent to the customer. Please check Razorpay.`, 'Website order needs a manual check').catch(() => {});
      }
      return { status: 'manual_review' };
    }

    const d = check.details;
    const claim = await pool.query(`
      INSERT INTO web_orders (order_id, payment_id, phone, status, details, paid_at, attempts, via)
      VALUES ($1,$2,$3,'processing',$4::jsonb,$5,1,$6)
      ON CONFLICT (order_id) DO UPDATE SET status='processing', payment_id=EXCLUDED.payment_id, details=EXCLUDED.details,
        attempts=web_orders.attempts+1, updated_at=NOW()
      WHERE web_orders.status NOT IN ('fulfilled','manual_review')
        AND (web_orders.status <> 'processing' OR web_orders.updated_at < NOW() - INTERVAL '10 minutes')
        AND web_orders.attempts < ${MAX_ATTEMPTS}
      RETURNING order_id`, [orderId, d.paymentId, d.phone, JSON.stringify(d), d.paidAt, via]);
    if (!claim.rows.length) return { status: 'busy' };
    console.log(`🛒 Website order ${orderId} (${d.reportName}, ${priceText(d.amount, d.currency)}) via ${via}.`);
    const job = run(orderId);
    if (deps.track) deps.track(job);
    return { status: 'started', job };
  }

  async function run(orderId) {
    try {
      await fulfil(orderId);
      return 'fulfilled';
    } catch (e) {
      console.error(`Website order ${orderId} fulfilment error:`, e.message);
      const r = (await db().query(`UPDATE web_orders SET status='failed', last_error=$2, updated_at=NOW()
        WHERE order_id=$1 AND status <> 'fulfilled' RETURNING attempts`, [orderId, String(e.message || e).slice(0, 500)]).catch(() => ({ rows: [] }))).rows[0];
      const attempts = r ? r.attempts : 0;
      await db().query(`UPDATE wa_payment_fulfillments SET status='failed', updated_at=NOW() WHERE payment_link_id=$1 AND status <> 'fulfilled'`, [orderId]).catch(() => {});
      if (attempts === 1) {
        await deps.notifyOwner(`A website 2027 order was paid, but finishing it hit a problem: ${e.message}\nOrder: ${orderId}. Kamala retries on her own; you will hear again only if it still fails.`, 'Website order retrying').catch(() => {});
      } else if (attempts >= MAX_ATTEMPTS) {
        await deps.notifyOwner(`⚠️ Website 2027 order ${orderId} is paid but could not be finished after ${attempts} tries (${e.message}). Please check Razorpay and send the customer their receipt yourself.`, 'Website order needs you').catch(() => {});
      }
      return 'failed';
    }
  }

  async function fulfil(orderId) {
    const pool = db();
    const row = (await pool.query('SELECT * FROM web_orders WHERE order_id=$1', [orderId])).rows[0];
    if (!row || !row.details) throw new Error('Order details are missing.');
    const d = row.details;
    const steps = row.steps || {};
    const once = async (name, fn) => {
      if (Object.prototype.hasOwnProperty.call(steps, name)) return steps[name];
      const value = await fn();
      steps[name] = value === undefined ? true : value;
      await pool.query(`UPDATE web_orders SET steps = COALESCE(steps,'{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb), updated_at=NOW()
        WHERE order_id=$1`, [orderId, name, JSON.stringify(steps[name])]);
      return steps[name];
    };
    const paidAt = new Date(d.paidAt);
    const paidText = paidAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) + ' IST';

    // 1. One invoice number per order, in the same VA/26-27/MM-NNN series as WhatsApp orders.
    const invoiceNumber = await once('invoice_number', () => deps.allocateInvoiceNumber());
    if (row.invoice_number !== invoiceNumber) await pool.query('UPDATE web_orders SET invoice_number=$2 WHERE order_id=$1', [orderId, invoiceNumber]);

    // 2. The person: known to Kamala as a customer, with their birth details, so she never asks again.
    await once('customer', async () => {
      await pool.query(`INSERT INTO users (phone, is_customer, status, name, email, dob, tob, pob, conversion_date, first_contact, last_contact, first_source)
        VALUES ($1, true, 'converted', $2, $3, $4, $5, $6, NOW(), NOW(), NOW(), 'website')
        ON CONFLICT (phone) DO UPDATE SET is_customer=true, status='converted', conversion_date=COALESCE(users.conversion_date, NOW()),
          name=COALESCE(NULLIF(users.name,''), EXCLUDED.name), email=COALESCE(NULLIF(users.email,''), EXCLUDED.email),
          dob=COALESCE(NULLIF(users.dob,''), EXCLUDED.dob), tob=COALESCE(NULLIF(users.tob,''), EXCLUDED.tob),
          pob=COALESCE(NULLIF(users.pob,''), EXCLUDED.pob)`,
      [d.phone, d.name, d.email, d.dobText, d.tob, d.pob]);
      await pool.query(`INSERT INTO web_leads (phone, name, email, dob, tob, pob, report, report_name, price, referral, stage)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'paid')
        ON CONFLICT (phone) DO UPDATE SET stage='paid', report=EXCLUDED.report, report_name=EXCLUDED.report_name, price=EXCLUDED.price, last_at=NOW()`,
      [d.phone, d.name, d.email, d.dobText, d.tob, d.pob, d.report, d.reportName, priceText(d.amount, d.currency), d.referral || null]);
      return true;
    });

    // 3. On the owner dashboard with every other paid report (rupee orders; dollar orders stay out of rupee revenue).
    if (d.currency === 'INR') {
      await once('ledger', async () => {
        await pool.query(`INSERT INTO wa_payment_links (payment_link_id, phone, calendar_event_id, amount_paise, customer_name, email, dob, tob, pob,
            service_name, normal_rate_paise, website_discount_paise, additional_discount_paise, service_total_paise, request_invoice_number,
            razorpay_payment_id, status, delivery_kind, paid_by, paid_at, created_at, updated_at)
          VALUES ($1,$2,'',$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$3,$12,$13,'paid','delivered','website',$14,$14,NOW())
          ON CONFLICT (payment_link_id) DO NOTHING`,
        [orderId, d.phone, Math.round(d.amount * 100), d.name, d.email, d.dobText, d.tob, d.pob, d.service,
          Math.round(d.mrp * 100), Math.max(0, Math.round((d.mrp - d.amount) * 100)), invoiceNumber, d.paymentId, paidAt]);
        await pool.query(`INSERT INTO wa_payment_fulfillments (payment_link_id, status) VALUES ($1,'processing') ON CONFLICT (payment_link_id) DO NOTHING`, [orderId]);
        return true;
      });
      await once('dashboard', () => {
        deps.emit({ type: 'payment', phone: d.phone, payment_link_id: orderId, service: d.service, amount_paise: Math.round(d.amount * 100), status: 'paid' });
        return true;
      });
    }

    // 4. The receipt (rebuilt on each try from fixed details, so it is always the same document).
    const receiptName = `Receipt_${String(invoiceNumber).replace(/[^A-Za-z0-9-]/g, '-')}.pdf`;
    const pdf = await deps.generateInvoice({
      invoiceNumber, customerName: d.name, email: d.email, phone: '+' + d.phone, serviceName: d.service,
      amountPaid: d.amount, basePrice: d.amount, currency: d.currency, delivered: true, paymentId: d.paymentId, date: paidText
    });

    // 5. Google Sheet: the "Premium Reports" tab (what the team works from) and the customer's profile.
    await once('sheet', () => deps.postAppsScript({
      target: 'report', name: d.name, phone: d.phone, email: d.email,
      dob: d.dobText, birthTime: d.tob, birthPlace: d.pob, service: d.service,
      query: d.referral ? `Referral code: ${d.referral}` : '',
      source: 'Website: 2027 report', paymentStatus: 'Paid',
      amountPaid: d.currency === 'INR' ? d.amount : priceText(d.amount, d.currency), sessionDate: '',
      notes: `Invoice ${invoiceNumber} | Payment ${d.paymentId} | Order ${orderId} | ${priceText(d.amount, d.currency)}`
    }).then(() => true));
    await once('customer_sheet', () => deps.postAppsScript({
      target: 'customer_update', invoiceNumber, name: d.name, phone: d.phone, email: d.email,
      dob: d.dobText, tob: d.tob, pob: d.pob, birthTime: d.tob, birthPlace: d.pob, gender: '', billingAddress: '', concern: '',
      service: d.service, bookingDate: paidText, countBooking: true
    }).then(() => true));

    // 6. WhatsApp: the confirmation with the receipt. A website buyer has usually never messaged us, so this goes as the
    //    approved template (header: the receipt). If the template is not approved yet, it waits for their first message.
    const delivery = await once('whatsapp', async () => {
      const mediaId = await deps.uploadMedia(pdf, receiptName, 'application/pdf');
      if (!mediaId) throw new Error('The receipt could not be uploaded to WhatsApp.');
      return deps.deliver(d.phone, {
        mediaId, filename: receiptName, body: confirmationText(d, invoiceNumber, deps.delivery || '24 hours'),
        template: [d.firstName, priceText(d.amount, d.currency), `${d.reportName} 2027 report`, invoiceNumber],
        templateName: deps.templateName || 'r27_order_confirmed',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      });
    });
    const wentOut = delivery === 'sent' || delivery === 'sent_template';

    // 7. Optional thank-you photo or video (its own approved template with an image or video header).
    const t = deps.thanks || {};
    if (wentOut && t.template && t.mediaUrl) {
      await once('thanks', async () => (await deps.sendTemplate(d.phone, t.template, [d.firstName], { type: t.mediaType || 'image', link: t.mediaUrl })) ? 'sent' : 'failed');
    }

    // 8. The owner hears about every paid order, with everything needed to make the report.
    const deliveredText = delivery === 'sent' ? 'sent in the open chat' : delivery === 'sent_template' ? 'sent (template)'
      : 'NOT sent yet: the order template is not approved or failed. It goes out when they first message; you may want to message them';
    await once('owner_alert', () => deps.notifyOwner(ownerText(d, invoiceNumber, deliveredText), `2027 report to prepare: ${d.name}`).then(() => true));

    // 9. Tell Meta about the sale (only once META_CAPI_TOKEN is set; rupee orders).
    if (d.currency === 'INR' && deps.reportPurchase) {
      await once('meta_capi', () => deps.reportPurchase({ paymentLinkId: orderId, phone: d.phone, email: d.email, amountInr: d.amount, serviceName: d.service })
        .catch(e => { console.error('Meta purchase event failed:', e.message); return 'failed'; }));
    }

    await pool.query(`UPDATE web_orders SET status='fulfilled', last_error=NULL, updated_at=NOW() WHERE order_id=$1`, [orderId]);
    if (d.currency === 'INR') {
      await pool.query(`INSERT INTO wa_payment_fulfillments (payment_link_id, status) VALUES ($1,'fulfilled')
        ON CONFLICT (payment_link_id) DO UPDATE SET status='fulfilled', updated_at=NOW()`, [orderId]).catch(() => {});
    }
    console.log(`✅ Website order ${orderId} fulfilled (invoice ${invoiceNumber}, WhatsApp ${delivery}).`);
  }

  // Retries orders whose fulfilment failed or was cut off (crash, restart, sleep).
  let recovering = false;
  async function recover() {
    const pool = db();
    if (!pool || recovering) return 0;
    recovering = true;
    let done = 0;
    try {
      const due = await pool.query(`SELECT order_id FROM web_orders WHERE attempts < ${MAX_ATTEMPTS} AND details IS NOT NULL
        AND ((status='failed' AND updated_at < NOW() - INTERVAL '2 minutes') OR (status='processing' AND updated_at < NOW() - INTERVAL '10 minutes'))
        ORDER BY updated_at LIMIT 5`);
      for (const { order_id: id } of due.rows) {
        const claimed = await pool.query(`UPDATE web_orders SET status='processing', attempts=attempts+1, updated_at=NOW()
          WHERE order_id=$1 AND ((status='failed' AND updated_at < NOW() - INTERVAL '2 minutes') OR (status='processing' AND updated_at < NOW() - INTERVAL '10 minutes'))
          RETURNING order_id`, [id]);
        if (!claimed.rows[0]) continue;
        console.log(`🔁 Finishing website order ${id}.`);
        const job = run(id);
        if (deps.track) deps.track(job);
        if ((await job) === 'fulfilled') done++;
      }
    } catch (e) {
      console.error('Website order recovery failed:', e.message);
    } finally {
      recovering = false;
    }
    return done;
  }

  // Safety net: paid 2027 orders from the last three days that Kamala has never seen.
  let lastSweep = 0;
  async function sweep() {
    const pool = db();
    if (!pool || !deps.razorpay || Date.now() - lastSweep < 10 * 60 * 1000) return 0;
    lastSweep = Date.now();
    let started = 0;
    try {
      const list = await deps.razorpay.orders.all({ from: Math.floor(Date.now() / 1000) - 3 * 24 * 3600, count: 100, authorized: 1 });
      const ours = (list.items || []).filter(o => isOurs(o) && o.status === 'paid');
      if (!ours.length) return 0;
      const seen = new Set((await pool.query('SELECT order_id FROM web_orders WHERE order_id = ANY($1)', [ours.map(o => o.id)])).rows.map(r => r.order_id));
      for (const o of ours.filter(o => !seen.has(o.id))) {
        const r = await handle({ orderId: o.id, via: 'sweep' }).catch(e => ({ status: 'error: ' + e.message }));
        if (r.job) { started++; await r.job; }
      }
    } catch (e) {
      console.error('Website order sweep failed:', e.message);
    }
    return started;
  }

  // Someone filled the 2027 order form on the website (and ticked the terms and privacy box). Kamala keeps their
  // details against their WhatsApp number, so when they message she already knows them and never asks again.
  // Details she already has (from chats or an earlier order) are never overwritten.
  async function saveLead(input) {
    const pool = db();
    if (!pool) throw new Error('No database');
    const l = readLead(input);
    if (!l) return { status: 'invalid' };
    await pool.query(`INSERT INTO users (phone, name, email, dob, tob, pob, first_source, first_contact, last_contact)
      VALUES ($1,$2,$3,$4,$5,$6,'website',NOW(),NOW())
      ON CONFLICT (phone) DO UPDATE SET
        name=COALESCE(NULLIF(users.name,''), EXCLUDED.name), email=COALESCE(NULLIF(users.email,''), EXCLUDED.email),
        dob=COALESCE(NULLIF(users.dob,''), EXCLUDED.dob), tob=COALESCE(NULLIF(users.tob,''), NULLIF(EXCLUDED.tob,'')),
        pob=COALESCE(NULLIF(users.pob,''), EXCLUDED.pob), first_source=COALESCE(users.first_source, 'website')`,
    [l.phone, l.name, l.email, l.dob, l.tob, l.pob]);
    const r = await pool.query(`INSERT INTO web_leads (phone, name, email, dob, tob, pob, report, report_name, price, referral, stage)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (phone) DO UPDATE SET name=EXCLUDED.name, email=EXCLUDED.email, dob=EXCLUDED.dob, tob=COALESCE(NULLIF(EXCLUDED.tob,''), web_leads.tob),
        pob=EXCLUDED.pob, report=EXCLUDED.report, report_name=EXCLUDED.report_name, price=EXCLUDED.price,
        referral=COALESCE(NULLIF(EXCLUDED.referral,''), web_leads.referral),
        stage=CASE WHEN web_leads.stage='paid' THEN 'paid' ELSE EXCLUDED.stage END,
        times=web_leads.times + 1, last_at=NOW()
      RETURNING times`,
    [l.phone, l.name, l.email, l.dob, l.tob, l.pob, l.report, l.reportName, l.price, l.referral, l.stage]);
    return { status: 'saved', times: r.rows[0] ? r.rows[0].times : 1 };
  }

  async function leadFor(phone) {
    const pool = db();
    if (!pool) return null;
    return (await pool.query('SELECT * FROM web_leads WHERE phone=$1', [String(phone || '')]).catch(() => ({ rows: [] }))).rows[0] || null;
  }

  // The website and the chat in one line for Kamala's notes: the order form, then what they did on the site.
  async function websiteLineFor(phone) {
    const pool = db();
    if (!pool || !phone) return '';
    const lead = await leadFor(phone);
    const events = (await pool.query('SELECT kind, detail, path, at FROM web_events WHERE phone=$1 ORDER BY at DESC LIMIT 300', [String(phone)])
      .catch(() => ({ rows: [] }))).rows;
    return [leadLine(lead), activityLine(events)].filter(Boolean).join(' ');
  }

  return { migrate, handle, run, recover, sweep, saveLead, leadFor, websiteLineFor };
}

module.exports = { create, inspect, signatureValid, priceText, dobText, confirmationText, ownerText, isOurs, readLead, leadLine, activityLine, RECEIPT_PREFIX };
