'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { generateInvoice, generatePaymentRequestInvoice } = require('./invoice-generator');

const paymentRequest = {
  invoiceNumber: 'PR-2026-TEST1234',
  issueDate: '25 Sep 2026',
  customerId: 'VA-TEST123456',
  customerName: 'Test Customer',
  email: 'test@example.com',
  phone: '917000000000',
  billingAddress: 'Test Street, Raipur, Chhattisgarh 492001',
  serviceName: 'Vedic Kundli Consultation',
  appointmentDate: '27 Sep 2026, 7:30 pm IST',
  normalRate: 2999,
  websiteDiscount: 750,
  additionalDiscount: 0,
  serviceTotal: 2249,
  linkAmount: 1,
  isGatewayTest: true,
  paymentUrl: 'https://rzp.io/i/testLink123'
};

test('pre-payment invoice generates separately with amount reconciliation and QR', async () => {
  const pdf = await generatePaymentRequestInvoice(paymentRequest);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 3000);
});

test('pre-payment invoice rejects inconsistent discount arithmetic', async () => {
  await assert.rejects(
    generatePaymentRequestInvoice({ ...paymentRequest, serviceTotal: 2248 }),
    /does not reconcile/
  );
});

test('existing paid receipt generator remains callable with the original contract', async () => {
  const pdf = await generateInvoice({
    invoiceNumber: 'PAYMENT-TEST', customerName: 'Test Customer', serviceName: 'Test consultation',
    amountPaid: 1, basePrice: 2249, isGatewayTest: true, date: '25/09/2026'
  });
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 1000);
});
