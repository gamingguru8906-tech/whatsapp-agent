'use strict';

const crypto = require('crypto');

function secretsMatch(expected, supplied) {
  const exp = String(expected || '').trim();
  const sup = String(supplied || '').trim();
  if (!exp || !sup) return false;
  const expectedBytes = Buffer.from(exp);
  const suppliedBytes = Buffer.from(sup);
  return expectedBytes.length > 0
    && expectedBytes.length === suppliedBytes.length
    && crypto.timingSafeEqual(expectedBytes, suppliedBytes);
}

/**
 * A customer's message is never evidence of payment. Only a complete, paid
 * Razorpay Payment Link whose captured amount matches the link is accepted.
 */
function inspectPaymentLink(paymentLink) {
  const status = String(paymentLink?.status || '').toLowerCase();
  const expectedPaise = Number(paymentLink?.amount);
  const paidPaise = Number(paymentLink?.amount_paid);
  const amountMatches = Number.isSafeInteger(expectedPaise)
    && Number.isSafeInteger(paidPaise)
    && expectedPaise > 0
    && paidPaise === expectedPaise;

  return {
    paid: status === 'paid' && amountMatches,
    status,
    expectedPaise,
    paidPaise,
    amountMatches
  };
}

function isPaymentClaim(message, previousAssistantAskedForPayment) {
  const text = String(message || '').trim();
  const explicit = /\b(?:i\s*(?:have\s*|['’]ve\s*)?paid|(?:i\s*(?:(?:have|['’]ve)\s*)?)?done\s+(?:the\s+)?payment|payment\s*(?:is\s*)?(?:done|complete(?:d)?|success(?:ful)?|sent|made)|transaction\s*(?:is\s*)?(?:done|complete(?:d)?|success(?:ful)?)|paid\s*(?:it|successfully|already)|payment\s+(?:kar\s+diya|ho\s+gaya)|paise\s+(?:bhej\s+diye|transfer\s+kar\s+diye))\b/i.test(text);
  // Hinglish as people actually type it: "krdiya payment", "payment kr diya", "pay kar diya", "payment ho gya",
  // "paid kr diya", "paise bhej diye". A question ("payment kaise karu?", "kya payment ho gaya?") is not a claim.
  const isQuestion = /\?\s*$|^\s*(?:kya|kaise|kab|kaha|kahan|how|when|where|can|should|do i|did)\b/i.test(text);
  const hinglish = !isQuestion && (
    /\b(?:payment|pay|paisa|paise|amount|fees?|transfer|upi)\s*(?:bhi\s*)?(?:kar|kr)\s*(?:di(?:ya|a|ye)|dia)\b/i.test(text)
    || /\b(?:kar|kr)\s*(?:di(?:ya|a)|dia)\s*(?:hai\s*)?(?:payment|pay|paise|paisa)\b/i.test(text)
    || /\b(?:payment|pay)\s*(?:bhi\s*)?(?:ho\s*)?(?:gaya|gya|gyi|gayi|hogaya|hogya)\b/i.test(text)
    || /\bpaid\s*(?:kar|kr)\s*(?:di(?:ya|a)|dia)\b/i.test(text)
    || /\b(?:paise|paisa|amount|payment)\s*(?:bhej|send\s*kar|send\s*kr)\s*(?:di(?:ya|a|ye)|dia)\b/i.test(text));
  const shortClaim = /^(?:paid|done|payment done|payment complete|yes paid|ho gaya|ho gya|kar diya|kr diya|krdiya|kardiya)[.! ]*$/i.test(text);
  return explicit || hinglish || (Boolean(previousAssistantAskedForPayment) && shortClaim);
}

async function verifyPaymentLink(razorpayClient, paymentLinkId) {
  if (!razorpayClient?.paymentLink?.fetch) {
    throw new Error('Razorpay payment verification is not configured.');
  }
  if (!paymentLinkId) throw new Error('No active payment link is available to verify.');
  const paymentLink = await razorpayClient.paymentLink.fetch(paymentLinkId);
  return { paymentLink, ...inspectPaymentLink(paymentLink) };
}

function inspectCapturedPayment(payment, paymentId, expectedAmountPaise, currency = 'INR') {
  const amountPaise = Number(payment?.amount);
  const paymentCurrency = String(payment?.currency || '').toUpperCase();
  const expectedCurrency = String(currency || '').toUpperCase();
  const status = String(payment?.status || '').toLowerCase();
  const verified = payment?.id === paymentId
    && status === 'captured'
    && Number.isSafeInteger(amountPaise)
    && amountPaise === expectedAmountPaise
    && paymentCurrency === expectedCurrency
    && expectedCurrency === 'INR';

  return {
    verified,
    payment_id: String(payment?.id || paymentId),
    amount_paise: Number.isSafeInteger(amountPaise) ? amountPaise : null,
    currency: paymentCurrency,
    status
  };
}

async function verifyCapturedPayment(razorpayClient, paymentId, expectedAmountPaise, currency = 'INR') {
  if (!razorpayClient?.payments?.fetch) {
    throw new Error('Razorpay payment verification is not configured.');
  }
  if (!/^pay_[A-Za-z0-9]+$/.test(String(paymentId || ''))) {
    throw new Error('Invalid Razorpay payment ID.');
  }
  if (!Number.isSafeInteger(expectedAmountPaise) || expectedAmountPaise <= 0) {
    throw new Error('Invalid expected payment amount.');
  }
  if (String(currency || '').toUpperCase() !== 'INR') {
    throw new Error('Unsupported payment currency.');
  }

  const payment = await razorpayClient.payments.fetch(paymentId);
  return inspectCapturedPayment(payment, paymentId, expectedAmountPaise, currency);
}

async function verifyAndFulfillPaymentLink(razorpayClient, paymentLinkId, fulfill) {
  const verification = await verifyPaymentLink(razorpayClient, paymentLinkId);
  if (!verification.paid) return { ...verification, fulfilled: false };
  if (typeof fulfill !== 'function') throw new Error('A verified-payment fulfillment handler is required.');
  await fulfill(verification.paymentLink);
  return { ...verification, fulfilled: true };
}

module.exports = {
  inspectPaymentLink,
  inspectCapturedPayment,
  isPaymentClaim,
  secretsMatch,
  verifyPaymentLink,
  verifyCapturedPayment,
  verifyAndFulfillPaymentLink
};
