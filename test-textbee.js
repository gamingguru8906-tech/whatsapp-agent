'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTextbee, toE164 } = require('./textbee');

function fakeHttp(respond) {
  const calls = [];
  return {
    calls,
    async post(url, body, options) {
      calls.push({ url, body, options });
      return respond(url, body, options);
    }
  };
}

test('stored WhatsApp numbers become E.164 for textbee; a bare 10-digit number is Indian', () => {
  assert.equal(toE164('919876543210'), '+919876543210');
  assert.equal(toE164('9876543210'), '+919876543210');
  assert.equal(toE164('+91 98765-43210'), '+919876543210');
  assert.equal(toE164('12345'), '');
  assert.equal(toE164(''), '');
});

test('without an API key nothing is sent', async () => {
  const http = fakeHttp(() => ({ data: {} }));
  const sms = createTextbee({ http });
  assert.equal(sms.enabled, false);
  const r = await sms.send('919876543210', 'Hello');
  assert.equal(r.ok, false);
  assert.match(r.error, /TEXTBEE_API_KEY/);
  assert.equal(http.calls.length, 0);
});

test('sends one recipient to the textbee send-sms endpoint with the API key header', async () => {
  const http = fakeHttp(() => ({ data: { data: { success: true, smsBatchId: 'batch123' } } }));
  const sms = createTextbee({ apiKey: 'key-1', http });
  const r = await sms.send('919876543210', '  Payment link: https://rzp.io/x  ');
  assert.deepEqual(r, { ok: true, batchId: 'batch123' });
  assert.equal(http.calls.length, 1);
  const [call] = http.calls;
  assert.equal(call.url, 'https://api.textbee.dev/api/v1/gateway/send-sms');
  assert.deepEqual(call.body, { recipients: ['+919876543210'], message: 'Payment link: https://rzp.io/x' });
  assert.equal(call.options.headers['x-api-key'], 'key-1');
});

test('device, SIM and a self-hosted server are passed through when set', async () => {
  const http = fakeHttp(() => ({ data: { data: {} } }));
  const sms = createTextbee({ apiKey: 'k', baseUrl: 'https://sms.example.com/', deviceId: 'dev9', simSubscriptionId: '2', http });
  const r = await sms.send('9876543210', 'Hi');
  assert.deepEqual(r, { ok: true, batchId: null });
  assert.equal(http.calls[0].url, 'https://sms.example.com/api/v1/gateway/send-sms');
  assert.deepEqual(http.calls[0].body, { recipients: ['+919876543210'], message: 'Hi', deviceId: 'dev9', simSubscriptionId: 2 });
});

test('bad numbers and empty texts are refused before calling textbee', async () => {
  const http = fakeHttp(() => ({ data: {} }));
  const sms = createTextbee({ apiKey: 'k', http });
  assert.equal((await sms.send('123', 'Hi')).ok, false);
  assert.equal((await sms.send('919876543210', '   ')).ok, false);
  assert.equal(http.calls.length, 0);
});

test('textbee errors come back as a short reason instead of throwing', async () => {
  const sms = createTextbee({
    apiKey: 'k',
    http: fakeHttp(() => {
      const error = new Error('Request failed with status code 400');
      error.response = { status: 400, data: { success: false, error: 'Device does not exist or is not enabled' } };
      throw error;
    })
  });
  assert.deepEqual(await sms.send('919876543210', 'Hi'), { ok: false, error: '400 Device does not exist or is not enabled' });

  const offline = createTextbee({ apiKey: 'k', http: fakeHttp(() => { throw new Error('timeout of 20000ms exceeded'); }) });
  assert.deepEqual(await offline.send('919876543210', 'Hi'), { ok: false, error: 'timeout of 20000ms exceeded' });
});
