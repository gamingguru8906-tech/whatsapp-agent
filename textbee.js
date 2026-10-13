'use strict';

/**
 * SMS through textbee (https://textbee.dev): the textbee app on an Android phone sends each text from that
 * phone's own SIM, so there is no per-message fee. Used only where WhatsApp cannot reach someone yet (a caller
 * whose 24-hour window is closed). Without TEXTBEE_API_KEY nothing is sent and every send says so.
 */

const axios = require('axios');

const DEFAULT_BASE_URL = 'https://api.textbee.dev';

// Stored numbers are digits with the country code (919876543210); a bare 10-digit number is Indian.
function toE164(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 10) digits = `91${digits}`;
  return /^\d{11,15}$/.test(digits) ? `+${digits}` : '';
}

function errorText(error) {
  const body = error.response?.data;
  const detail = body?.error || body?.message;
  const text = Array.isArray(detail) ? detail.join(', ') : detail;
  if (text) return `${error.response.status} ${typeof text === 'string' ? text : JSON.stringify(text)}`;
  return error.message;
}

function createTextbee({ apiKey, baseUrl, deviceId, simSubscriptionId, http = axios } = {}) {
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const sim = Number.parseInt(simSubscriptionId, 10);
  return {
    enabled: Boolean(apiKey),
    // Resolves { ok: true, batchId } or { ok: false, error }; it never throws.
    async send(phone, message) {
      if (!apiKey) return { ok: false, error: 'textbee is not set up (TEXTBEE_API_KEY missing)' };
      const to = toE164(phone);
      if (!to) return { ok: false, error: `not a phone number: ${phone}` };
      const text = String(message || '').trim();
      if (!text) return { ok: false, error: 'empty message' };
      const body = { recipients: [to], message: text };
      if (deviceId) body.deviceId = deviceId;
      if (Number.isInteger(sim)) body.simSubscriptionId = sim;
      try {
        const res = await http.post(`${root}/api/v1/gateway/send-sms`, body, {
          headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
          timeout: 20000
        });
        return { ok: true, batchId: res.data?.data?.smsBatchId || null };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    }
  };
}

module.exports = { createTextbee, toE164 };
