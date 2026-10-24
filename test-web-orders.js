'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const webOrders = require('./web-orders');

const order = (over = {}) => ({
  id: 'order_AbCdEf123456', amount: 126300, currency: 'INR', receipt: 'r27_mvm6_1a2b3c4d', status: 'paid',
  notes: { product: 'r27', report: 'blend', report_name: 'Astro-Numero Blend', customer_name: 'Ananya Iyer', dob: '1995-07-20',
    tob: '6:54 PM', pob: 'Raipur', email: 'ananya@example.com', phone: '919876543210', referral: '', updates: 'yes', mrp: '1804' },
  ...over
});
const payment = (over = {}) => ({ id: 'pay_Zz12345678', order_id: 'order_AbCdEf123456', amount: 126300, currency: 'INR', status: 'captured', created_at: 1792830000, ...over });

test('a captured payment for the full order amount is accepted with every detail', () => {
  const r = webOrders.inspect(order(), payment());
  assert.equal(r.ok, true);
  assert.equal(r.details.amount, 1263);
  assert.equal(r.details.mrp, 1804);
  assert.equal(r.details.firstName, 'Ananya');
  assert.equal(r.details.dobText, '20 July 1995');
  assert.equal(r.details.service, '2027 Report: Astro-Numero Blend');
});

test('orders that are not 2027 website orders are ignored, never fulfilled', () => {
  assert.equal(webOrders.inspect(order({ receipt: 'wa_booking_1' }), payment()).notOurs, true);
  assert.equal(webOrders.inspect(order({ notes: { product: 'other' } }), payment()).notOurs, true);
  assert.equal(webOrders.inspect(null, payment()).notOurs, true);
});

test('a payment that is not captured is "not paid yet", not an error', () => {
  for (const status of ['created', 'authorized', 'failed', 'refunded']) {
    const r = webOrders.inspect(order(), payment({ status }));
    assert.equal(r.ok, false);
    assert.equal(r.notPaid, true, status);
  }
  assert.equal(webOrders.inspect(order(), null).notPaid, true);
});

test('wrong amount, wrong currency or another order\'s payment needs a manual check', () => {
  for (const p of [payment({ amount: 100 }), payment({ currency: 'USD' }), payment({ order_id: 'order_Other0000001' })]) {
    const r = webOrders.inspect(order(), p);
    assert.equal(r.ok, false);
    assert.ok(!r.notPaid && !r.notOurs, r.why);
  }
  const noPhone = webOrders.inspect(order({ notes: { ...order().notes, phone: '12' } }), payment());
  assert.equal(noPhone.ok, false);
});

test('the website signature is checked over the exact body, in constant time', () => {
  const body = Buffer.from(JSON.stringify({ order_id: 'order_AbCdEf123456', payment_id: 'pay_Zz12345678' }));
  const good = crypto.createHmac('sha256', 'shared').update(body).digest('hex');
  assert.equal(webOrders.signatureValid('shared', body, good), true);
  assert.equal(webOrders.signatureValid('shared', Buffer.from(body.toString() + ' '), good), false);
  assert.equal(webOrders.signatureValid('other', body, good), false);
  assert.equal(webOrders.signatureValid('', body, good), false);
  assert.equal(webOrders.signatureValid('shared', body, ''), false);
});

test('prices read the way customers see them', () => {
  assert.equal(webOrders.priceText(1263, 'INR'), '₹1,263');
  assert.equal(webOrders.priceText(30, 'USD'), 'US$30');
  assert.equal(webOrders.dobText('2007-07-20'), '20 July 2007');
});

test('the customer confirmation names the report, amount, invoice and delivery time', () => {
  const d = webOrders.inspect(order(), payment()).details;
  const text = webOrders.confirmationText(d, 'VA/26-27/10-012', '24 hours');
  assert.match(text, /Ananya ji/);
  assert.match(text, /₹1,263 for your Astro-Numero Blend 2027 report/);
  assert.match(text, /VA\/26-27\/10-012/);
  assert.match(text, /within 24 hours/);
  const owner = webOrders.ownerText(d, 'VA/26-27/10-012', 'sent (template)');
  assert.match(owner, /Birth time: 6:54 PM/);
  assert.match(owner, /Phone: \+919876543210/);
});

test('handle() refuses to work without a database or Razorpay, and ignores bad ids', async () => {
  const noDb = webOrders.create({ pool: null, razorpay: {} });
  await assert.rejects(() => noDb.handle({ orderId: 'order_AbCdEf123456' }), /database/);
  const noRzp = webOrders.create({ pool: { query: async () => ({ rows: [] }) }, razorpay: null });
  await assert.rejects(() => noRzp.handle({ orderId: 'order_AbCdEf123456' }), /Razorpay/);
  const ok = webOrders.create({ pool: { query: async () => ({ rows: [] }) }, razorpay: {} });
  assert.deepEqual(await ok.handle({ orderId: 'not-an-order' }), { status: 'invalid' });
});

test('handle() asks Razorpay itself and skips orders already finished', async () => {
  let fetched = 0;
  const razorpay = { orders: { fetch: async () => { fetched++; return order(); }, fetchPayments: async () => ({ items: [] }) }, payments: { fetch: async () => payment() } };
  const done = webOrders.create({ razorpay, pool: { query: async () => ({ rows: [{ status: 'fulfilled' }] }) } });
  assert.deepEqual(await done.handle({ orderId: 'order_AbCdEf123456' }), { status: 'fulfilled' });
  assert.equal(fetched, 0);
});

test('a website form lead needs a real WhatsApp number and name; the rest is cleaned', () => {
  const l = webOrders.readLead({ phone: '+91 98765 43210', name: ' Ananya  Iyer ', email: 'A@Example.com', dob: '1995-07-20', tob: '6:54 PM',
    pob: 'Raipur, Chhattisgarh, India', report: 'blend', report_name: 'Astro-Numero Blend', price: '₹1,263', stage: 'whatsapp' });
  assert.equal(l.phone, '919876543210');
  assert.equal(l.name, 'Ananya Iyer');
  assert.equal(l.email, 'a@example.com');
  assert.equal(l.dob, '20 July 1995');
  assert.equal(l.stage, 'whatsapp');
  assert.equal(webOrders.readLead({ phone: '12345', name: 'Ananya' }), null);
  assert.equal(webOrders.readLead({ phone: '919876543210', name: '1' }), null);
  assert.equal(webOrders.readLead({ phone: '919876543210', name: 'Ananya', stage: 'paid' }).stage, 'form'); // only Razorpay marks paid
  assert.equal(webOrders.readLead({ phone: '919876543210', name: 'Ananya', tob: '25:99' }).tob, '');
});

test('Kamala is told what the person did on the website and greets a first-time visitor as one', () => {
  const crm = require('./crm');
  const line = webOrders.leadLine({ report_name: 'Astro-Numero Blend', price: '₹1,263', stage: 'form', last_at: '2026-10-24T12:11:00Z' });
  assert.match(line, /order form on veshannastro\.co\.in for the Astro-Numero Blend \(₹1,263\) on 24 Oct 2026/);
  assert.match(line, /has not paid yet/);
  const first = crm.profileContext({ name: 'Ananya Iyer', dob: '20 July 1995' }, [], null, line);
  assert.match(first, /- On the website: Filled the 2027/);
  assert.match(first, /WEBSITE VISITOR, FIRST CHAT/);
  const later = crm.profileContext({ name: 'Ananya Iyer' }, [], new Date(), line);
  assert.doesNotMatch(later, /WEBSITE VISITOR, FIRST CHAT/);
  assert.doesNotMatch(crm.profileContext({ name: 'Ravi' }, [], null, ''), /On the website/);
  assert.match(webOrders.leadLine({ report_name: 'Classic', stage: 'paid', last_at: new Date() }), /paid for it on the website/);
});
