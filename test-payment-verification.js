'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inspectCapturedPayment,
  inspectPaymentLink,
  isPaymentClaim,
  secretsMatch,
  verifyCapturedPayment,
  verifyPaymentLink,
  verifyAndFulfillPaymentLink
} = require('./payment-verification');

test('verification endpoint secret comparison fails closed and accepts only the exact shared secret', () => {
  assert.equal(secretsMatch('', ''), false);
  assert.equal(secretsMatch('secret-a', 'secret-b'), false);
  assert.equal(secretsMatch('shared-secret', 'shared-secret'), true);
});

test('captured Razorpay payment requires matching ID, exact amount and INR', () => {
  const valid = inspectCapturedPayment({
    id: 'pay_captured123', status: 'captured', amount: 100, currency: 'INR'
  }, 'pay_captured123', 100);
  assert.equal(valid.verified, true);
  assert.equal(inspectCapturedPayment({
    id: 'pay_captured123', status: 'authorized', amount: 100, currency: 'INR'
  }, 'pay_captured123', 100).verified, false);
  assert.equal(inspectCapturedPayment({
    id: 'pay_captured123', status: 'captured', amount: 99, currency: 'INR'
  }, 'pay_captured123', 100).verified, false);
  assert.equal(inspectCapturedPayment({
    id: 'pay_other123', status: 'captured', amount: 100, currency: 'INR'
  }, 'pay_captured123', 100).verified, false);
  assert.equal(inspectCapturedPayment({
    id: 'pay_captured123', status: 'captured', amount: 100, currency: 'USD'
  }, 'pay_captured123', 100).verified, false);
});

test('Razorpay API is queried for the exact payment ID supplied by Apps Script', async () => {
  let fetchedId;
  const result = await verifyCapturedPayment({ payments: { fetch: async id => {
    fetchedId = id;
    return { id, status: 'captured', amount: 100, currency: 'INR' };
  } } }, 'pay_captured123', 100);
  assert.equal(fetchedId, 'pay_captured123');
  assert.equal(result.verified, true);
});

test('payment claims are detected without treating an unpaid statement as a claim', () => {
  assert.equal(isPaymentClaim('I have paid'), true);
  assert.equal(isPaymentClaim("I've done the payment"), true);
  assert.equal(isPaymentClaim('Payment kar diya'), true);
  assert.equal(isPaymentClaim('done', true), true);
  assert.equal(isPaymentClaim('done', false), false);
  assert.equal(isPaymentClaim("I haven't paid yet"), false);
});

test("a customer's claim cannot turn an unpaid link into a paid one", async () => {
  let fetchedId;
  const result = await verifyPaymentLink({
    paymentLink: { fetch: async id => {
      fetchedId = id;
      return { id, status: 'created', amount: 100, amount_paid: 0 };
    } }
  }, 'plink_unpaid');

  assert.equal(fetchedId, 'plink_unpaid');
  assert.equal(result.paid, false);
  assert.equal(result.status, 'created');
});

test('an unpaid claim never enters invoice, email, Calendar, or Sheet fulfillment', async () => {
  let fulfillmentCalls = 0;
  const result = await verifyAndFulfillPaymentLink({
    paymentLink: { fetch: async () => ({ id: 'plink_unpaid', status: 'created', amount: 100, amount_paid: 0 }) }
  }, 'plink_unpaid', async () => { fulfillmentCalls += 1; });

  assert.equal(result.paid, false);
  assert.equal(result.fulfilled, false);
  assert.equal(fulfillmentCalls, 0);
});

test('a fully paid link runs fulfillment exactly once', async () => {
  let fulfillmentCalls = 0;
  const result = await verifyAndFulfillPaymentLink({
    paymentLink: { fetch: async () => ({ id: 'plink_paid', status: 'paid', amount: 100, amount_paid: 100 }) }
  }, 'plink_paid', async link => {
    assert.equal(link.id, 'plink_paid');
    fulfillmentCalls += 1;
  });

  assert.equal(result.paid, true);
  assert.equal(result.fulfilled, true);
  assert.equal(fulfillmentCalls, 1);
});

test('a partially paid link is not accepted as a completed payment', () => {
  assert.equal(inspectPaymentLink({ status: 'partially_paid', amount: 100, amount_paid: 50 }).paid, false);
});

test('a paid status with a mismatched captured amount is rejected', () => {
  const result = inspectPaymentLink({ status: 'paid', amount: 100, amount_paid: 99 });
  assert.equal(result.paid, false);
  assert.equal(result.amountMatches, false);
});

test('a fully paid link with the exact captured amount is accepted', () => {
  const result = inspectPaymentLink({
    id: 'plink_paid', status: 'paid', amount: 100, amount_paid: 100
  });
  assert.equal(result.paid, true);
  assert.equal(result.amountMatches, true);
});

test('missing or malformed Razorpay amounts fail closed', () => {
  assert.equal(inspectPaymentLink({ status: 'paid', amount: 100 }).paid, false);
  assert.equal(inspectPaymentLink({ status: 'paid', amount: 'NaN', amount_paid: 100 }).paid, false);
});
