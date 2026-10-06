'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { paymentNudgeText, sendPaymentNudges } = require('./crm');

const link = {
  payment_link_id: 'plink_1',
  phone: '919900000001',
  customer_name: 'Ritu Sharma',
  service_name: 'Kundli Consultation',
  appointment_start: '2026-10-08T13:30:00Z', // 7:00 pm IST
  created_at: '2026-10-06T04:00:00Z',
  expires_at: '2026-10-06T13:30:00Z', // 7:00 pm IST
  payment_url: 'https://rzp.io/i/abc'
};

test('payment nudge names the held slot, when the link expires, and the link', () => {
  const text = paymentNudgeText(link);
  assert.match(text, /^Hi Ritu ji, aapke Kundli Consultation ke liye 8 Oct 2026, 7:00 pm IST wala slot abhi hold par hai\./);
  assert.match(text, /Payment link 6 Oct 2026, 7:00 pm IST tak valid hai: https:\/\/rzp\.io\/i\/abc/);
});

test('payment nudge for an older link without a saved URL or expiry falls back to 12 hours after it was sent', () => {
  const text = paymentNudgeText({ ...link, customer_name: '', payment_url: null, expires_at: null });
  assert.match(text, /^Hi, aapke /);
  assert.match(text, /Payment link 6 Oct 2026, 9:30 pm IST tak valid hai\.\n/);
});

test('payment nudge fallback expiry is 30 minutes before a slot that comes sooner than 12 hours', () => {
  const text = paymentNudgeText({ ...link, expires_at: null, appointment_start: '2026-10-06T10:30:00Z' }); // 4:00 pm IST
  assert.match(text, /Payment link 6 Oct 2026, 3:30 pm IST tak valid hai/);
});

test('each due link is claimed before it is sent, so it goes out once', async () => {
  const claimed = new Set();
  const pool = {
    async query(sql, params) {
      if (/^SELECT l\.payment_link_id/.test(sql)) return { rows: [{ payment_link_id: 'plink_1' }, { payment_link_id: 'plink_1' }] };
      if (/^UPDATE wa_payment_links SET nudge_sent_at=NOW\(\)/.test(sql)) {
        if (claimed.has(params[0])) return { rows: [] };
        claimed.add(params[0]);
        return { rows: [link] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }
  };
  const sent = [];
  const count = await sendPaymentNudges({ pool, sendCustomerText: async (phone, text) => { sent.push({ phone, text }); return true; } });
  assert.equal(count, 1);
  assert.deepEqual(sent.map(s => s.phone), ['919900000001']);
});
