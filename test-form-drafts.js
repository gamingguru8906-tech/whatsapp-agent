'use strict';
// node test-form-drafts.js — the 2027 order form saved while people type.
const assert = require('assert/strict');
const test = require('node:test');
const fd = require('./form-drafts');

test('a half-typed form is kept field by field; only the visitor id is required', () => {
  assert.equal(fd.readDraft({ name: 'Ananya' }), null);
  assert.equal(fd.readDraft({ visitor: 'not-hex', name: 'Ananya' }), null);
  const d = fd.readDraft({ visitor: 'a1b2c3d4e5f6a7b8c9d0e1f2', name: '  Ananya   Iyer ', dob: '1995-07-2', tob: '6:5 PM', email: 'ana@', code: '91', mobile: '98765' });
  assert.equal(d.name, 'Ananya Iyer');
  assert.equal(d.dob, '');              // not a full date yet
  assert.equal(d.tob, '');
  assert.equal(d.email, 'ana@');        // what was typed is kept for the Sheet
  assert.equal(d.emailValid, false);    // but never saved as their email
  assert.equal(d.phone, '');            // 5 digits is not a number yet
  assert.equal(fd.readDraft({ visitor: 'a1b2c3d4e5f6a7b8c9d0e1f2', name: '12345' }).name, '');
});

test('WhatsApp numbers are read the same way as the order form', () => {
  assert.equal(fd.normalisePhone('91', '98765 43210'), '919876543210');
  assert.equal(fd.normalisePhone('91', '+91 98765 43210'), '919876543210');
  assert.equal(fd.normalisePhone('91', '098765 43210'), '919876543210');
  assert.equal(fd.normalisePhone('91', '5876543210'), '');
  assert.equal(fd.normalisePhone('971', '501234567'), '971501234567');
  assert.equal(fd.normalisePhone('', '9876543210'), '');
});

test('the follow-up uses the name and report when the form has them', () => {
  const named = fd.followUpText({ name: 'Ananya Iyer', report_name: 'Astro-Numero Blend' });
  assert.match(named, /^Namaste Ananya ji/);
  assert.match(named, /2027 Astro-Numero Blend report/);
  const general = fd.followUpText({ name: '', report_name: 'Classic' });
  assert.match(general, /^Namaste 🙏/);
  assert.doesNotMatch(general, /undefined|null/);
  assert.doesNotMatch(named + general, /Veshannastro/); // Kamala never names the brand in chat
});

test('Sheet rows show the number (or what was typed) and the follow-up state', () => {
  const base = { visitor: 'a1b2c3d4e5f6a7b8c9d0e1f2', last_at: '2026-10-24T10:00:00Z', first_at: '2026-10-24T09:58:00Z', saves: 4 };
  assert.equal(fd.sheetRow({ ...base, phone: '919876543210' }).whatsapp, '+919876543210');
  assert.equal(fd.sheetRow({ ...base, code: '91', mobile: '98765' }).whatsapp, '+91 98765 (incomplete)');
  const sent = fd.sheetRow({ ...base, phone: '919876543210', followup_status: 'sent', followup_at: '2026-10-24T10:25:00Z', stage: 'checkout' });
  assert.match(sent.followUp, /^Sent 24 Oct 2026/);
  assert.equal(sent.stage, 'Opened payment');
  assert.match(fd.sheetRow({ ...base, phone: '919876543210', followup_due_at: '2026-10-24T10:23:00Z' }).followUp, /^Due /);
});
