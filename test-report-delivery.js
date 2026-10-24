'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rd = require('./report-delivery');
const webOrders = require('./web-orders');

const summary = {
  first: 'Ananya', year: 2027, personal_year: 2, theme: 'Build, partner, nurture.',
  dos: ['Follow a fixed routine: show up even when motivation is low.', 'Help someone going through hardship', 'Begin the day with a compliment to yourself.'],
  best_months: ['March', 'June', 'July'], lucky_numbers: [1, 5], colour: 'White, light blue and pink.'
};

test('the voice note says only what the report says, in Hinglish, in about a minute', () => {
  const s = rd.voiceScript(summary, 'Ananya Iyer');
  assert.match(s, /^Namaste Ananya ji, main Kamala, Veshannastro se\./);
  assert.match(s, /2027 ka theme hai: Build, partner, nurture\./);
  assert.match(s, /Pehli, Follow a fixed routine/);
  assert.match(s, /Doosri, Help someone going through hardship\./); // a missing full stop is added
  assert.match(s, /March, June aur July/);
  assert.match(s, /lucky numbers hain 1 aur 5, aur pehenne ke liye colours: White, light blue and pink\./);
  const words = s.split(/\s+/).length;
  assert.ok(words >= 90 && words <= 175, `about a minute of speech, got ${words} words`);
  assert.doesNotMatch(s, /undefined|null|NaN/);
});

test('the voice note copes with a thin summary', () => {
  const s = rd.voiceScript({ year: 2027, theme: 'Move, meet, expand.' }, '');
  assert.match(s, /Namaste ji/);
  assert.doesNotMatch(s, /undefined|null|NaN|cheezein/);
});

test('a clarity rating is read however people type it, and nothing else counts as one', () => {
  for (const [text, want] of [['4', 4], ['5/5', 5], ['3 stars', 3], ['Rating: 2', 2], ['⭐⭐⭐⭐', 4], ['chaar', 4], ['5 hai', 5], ['4 🙏', 4], [' 1. ', 1]]) {
    assert.equal(rd.parseRating(text), want, text);
  }
  for (const text of ['6', '0', '45', 'when will my blend report come?', 'thank you', '2027', '', 'I give 10']) {
    assert.equal(rd.parseRating(text), null, text);
  }
});

test('the second answer is any short reply that is not a question', () => {
  assert.equal(rd.looksLikeAnswer('Maine March ke liye plan banaya'), true);
  assert.equal(rd.looksLikeAnswer('kab aayega blend report?'), false);
  assert.equal(rd.looksLikeAnswer('x'), false);
  assert.equal(rd.looksLikeAnswer('a'.repeat(401)), false);
});

test('a report hand-over must name the job, a real WhatsApp number and an https PDF link', () => {
  const r = rd.create({ pool: null });
  const ok = r.read({ job_id: 'wa-20261024-1530-ab12', phone: '919876543210', name: 'Ananya Iyer', title: '2027 Forecast Year Report',
    filename: 'VeshannAstro_2027_Forecast_Ananya_Iyer.pdf', pdf_url: 'https://reports.example/files/x/pdf?sig=1', card_url: 'https://reports.example/files/x/card?sig=1', summary });
  assert.equal(ok.phone, '919876543210');
  assert.equal(ok.cardUrl, 'https://reports.example/files/x/card?sig=1');
  assert.equal(r.read({ job_id: 'x', phone: '919876543210', pdf_url: 'https://a/b' }), null);
  assert.equal(r.read({ job_id: 'wa-1234', phone: '98765', pdf_url: 'https://a/b' }), null);
  assert.equal(r.read({ job_id: 'wa-1234', phone: '919876543210', pdf_url: 'http://insecure/b' }), null);
  assert.equal(r.read({ job_id: 'wa-1234', phone: '919876543210', pdf_url: 'https://a/b', filename: '../../etc/passwd' }).filename, 'Report.pdf');
});

test('website activity becomes one sentence for Kamala', () => {
  const line = webOrders.activityLine([
    { kind: 'add_payment_info', detail: {}, at: '2026-10-24T09:12:00Z' },
    { kind: 'select_item', detail: { item_name: 'Classic' }, at: '2026-10-24T09:10:00Z' },
    { kind: 'personal_year_calculated', detail: { personal_year: 2 }, at: '2026-10-24T09:05:00Z' },
    { kind: 'visit', path: '/blog/personal-year-2-in-2027.html', detail: { title: 'Personal Year 2 in 2027' }, at: '2026-10-24T09:00:00Z' },
    { kind: 'visit', path: '/blog/mulank-predictions-2027.html', detail: {}, at: '2026-10-23T09:00:00Z' },
    { kind: 'visit', path: '/2027-numerology-report/', detail: {}, at: '2026-10-23T08:00:00Z' }
  ]);
  assert.match(line, /^Website activity: 3 visits over 2 days \(last 24 Oct 2026/);
  assert.match(line, /read Personal Year 2 in 2027, Mulank Predictions 2027/);
  assert.match(line, /Personal Year calculator \(Personal Year 2\)/);
  assert.match(line, /last looked at the Classic/);
  assert.match(line, /opened the payment window without paying/);
  assert.equal(webOrders.activityLine([]), '');
});
