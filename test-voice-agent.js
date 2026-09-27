'use strict';

// Call logs are noisy and can garble the test runner's output stream; set VOICE_TEST_LOGS=1 to see them.
if (!process.env.VOICE_TEST_LOGS) console.log = () => {};

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { EventEmitter } = require('events');
const { WebSocket } = require('ws');
const {
  GREETING,
  ROBOT_ANSWER,
  ESCALATION_LINE,
  normalizeCallerNumber,
  pcmFromBase64,
  pcmToBuffer,
  StreamResampler,
  FrameQueue,
  exotelFrameBytes,
  candidateSlots,
  knowledgeLoader,
  buildCallPrompt,
  formatCallbackAlert,
  speakable,
  attach
} = require('./voice-agent');

function sine(samples, rate, hz = 400, amplitude = 8000) {
  const out = new Int16Array(samples);
  for (let i = 0; i < samples; i++) out[i] = Math.round(amplitude * Math.sin(2 * Math.PI * hz * i / rate));
  return out;
}

function peak(samples) {
  return samples.reduce((max, s) => Math.max(max, Math.abs(s)), 0);
}

async function waitFor(check, ms = 2000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error('Timed out waiting for condition');
    await new Promise(r => setTimeout(r, 10));
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

/** Stands in for Gemini Live: records what the bridge sends and lets the test play the server side. */
function fakeLive({ refuseModels = [] } = {}) {
  const sessions = [];
  const open = (apiKey, setup) => {
    const live = new EventEmitter();
    live.setup = setup;
    live.sent = [];
    live.closed = false;
    live.send = msg => live.sent.push(msg);
    live.close = () => { live.closed = true; };
    sessions.push(live);
    setImmediate(() => (refuseModels.includes(setup.model)
      ? live.emit('close', 1008, 'model not found')
      : live.emit('message', { setupComplete: {} })));
    return live;
  };
  return { open, sessions };
}

function startMessage(from = '09876543210') {
  return JSON.stringify({
    event: 'start',
    sequence_number: '1',
    stream_sid: 'MZ1',
    start: {
      stream_sid: 'MZ1', call_sid: 'CA1', account_sid: 'AC1', from, to: '01140000000',
      media_format: { encoding: 'audio/x-raw', sample_rate: '8000', bit_rate: '16' }
    }
  });
}

async function startServer(deps) {
  const server = http.createServer();
  const agent = attach(server, { apiKey: 'test-key', token: 'secret', ...deps });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, agent, url: `ws://127.0.0.1:${server.address().port}` };
}

test('Exotel caller numbers become WhatsApp numbers', () => {
  assert.equal(normalizeCallerNumber('09876543210'), '919876543210');
  assert.equal(normalizeCallerNumber('+91 98765 43210'), '919876543210');
  assert.equal(normalizeCallerNumber('9876543210'), '919876543210');
  assert.equal(normalizeCallerNumber('00919876543210'), '919876543210');
  assert.equal(normalizeCallerNumber('anonymous'), '');
  assert.equal(normalizeCallerNumber('12345'), '');
});

test('audio is resampled 8 kHz -> 16 kHz and 24 kHz -> 8 kHz without losing the voice', () => {
  const up = new StreamResampler(8000, 16000).push(sine(800, 8000));
  assert.ok(Math.abs(up.length - 1600) <= 2);
  assert.ok(peak(up) > 7000);

  const down = new StreamResampler(24000, 8000).push(sine(2400, 24000));
  assert.ok(Math.abs(down.length - 800) <= 2);
  assert.ok(peak(down) > 6000);
});

test('resampling in chunks matches resampling in one go (no clicks at chunk edges)', () => {
  const input = sine(4800, 24000);
  const whole = new StreamResampler(24000, 8000).push(input);
  const chunked = new StreamResampler(24000, 8000);
  const parts = [];
  for (let i = 0; i < input.length; i += 437) parts.push(...chunked.push(input.subarray(i, i + 437)));
  assert.equal(parts.length, whole.length);
  for (let i = 0; i < whole.length; i++) assert.ok(Math.abs(parts[i] - whole[i]) <= 1);
});

test('PCM survives the base64 round trip', () => {
  const samples = Int16Array.from([0, 1, -1, 32767, -32768, 1234]);
  assert.deepEqual(Array.from(pcmFromBase64(pcmToBuffer(samples).toString('base64'))), Array.from(samples));
});

test('outgoing audio is cut into Exotel frames that are multiples of 320 bytes', () => {
  assert.equal(exotelFrameBytes(8000), 3200);
  assert.equal(exotelFrameBytes(16000), 3200);
  assert.equal(exotelFrameBytes(24000), 4800);
  const queue = new FrameQueue(3200);
  const frames = queue.push(Buffer.alloc(7000, 1));
  assert.deepEqual(frames.map(f => f.length), [3200, 3200]);
  const tail = queue.flush();
  assert.equal(tail.length, 640);
  assert.equal(tail[599], 1);
  assert.equal(tail[600], 0);
  assert.equal(queue.flush(), null);
});

test('slots follow consultation hours and skip times that are too soon', () => {
  const now = new Date('2026-09-28T20:05:00+05:30'); // Monday 8:05 PM, so 8:30 is too soon
  assert.deepEqual(candidateSlots('2026-09-28', now), ['2026-09-28T21:30:00+05:30']);
  assert.equal(candidateSlots('2026-10-03', now).length, 10); // Saturday 10 AM - 7 PM starts
  assert.equal(candidateSlots('2026-10-03', now)[0], '2026-10-03T10:00:00+05:30');
  assert.deepEqual(candidateSlots('2026-09-27', now), []);
  assert.deepEqual(candidateSlots('next monday', now), []);
});

test('the call prompt carries the agreed greeting, robot answer, escalation line and only approved facts', () => {
  const known = buildCallPrompt({
    callerPhone: '919876543210',
    user: { name: 'Priya Sharma', pain_point: 'career stuck after job loss' },
    knowledge: { faq: [{ question: 'Experience?', answer: '18 years' }], testimonials: [{ name: 'Anita', city: 'Pune', quote: 'He was spot on.' }] },
    services: 'CATEGORY: Consultations'
  });
  assert.ok(known.includes(GREETING));
  assert.ok(known.includes(ROBOT_ANSWER));
  assert.ok(known.includes(ESCALATION_LINE));
  assert.ok(known.includes('Arre Priya ji! How are you?'));
  assert.ok(known.includes('career stuck after job loss'));
  assert.ok(known.includes('A: 18 years'));
  assert.ok(known.includes('"He was spot on." (Anita, Pune)'));
  assert.ok(known.includes('+919876543210'));

  const stranger = buildCallPrompt({ callerPhone: '', user: {}, knowledge: { faq: [], testimonials: [] } });
  assert.ok(stranger.includes('Aapka naam jaan sakti hoon?'));
  assert.ok(stranger.includes('Do not describe any client experience.'));
  assert.ok(stranger.includes('hidden or unknown'));
});

test('FAQ and testimonials are cached and blank rows are ignored', async () => {
  let calls = 0;
  const load = knowledgeLoader(async () => {
    calls++;
    return { faq: [{ question: 'Q', answer: 'A' }, { question: 'Empty', answer: '' }], testimonials: [{ name: 'R', city: 'X', quote: '' }] };
  });
  const first = await load();
  const second = await load();
  assert.equal(calls, 1);
  assert.deepEqual(first, { faq: [{ question: 'Q', answer: 'A' }], testimonials: [] });
  assert.equal(second, first);
});

test('the callback alert matches the agreed WhatsApp format', () => {
  assert.equal(formatCallbackAlert({ name: 'Rahul Sharma', phone: '919876543210', queryType: 'marriage', summary: 'Wants a consultation' }),
    'Callback needed within 24 hours\nName: Rahul Sharma\nNumber: +919876543210\nQuery: Marriage\nSummary: Wants a consultation');
});

test('without a token, only calls from the configured Exotel account are accepted', async () => {
  const server = http.createServer();
  const gemini = fakeLive();
  const done = [];
  const agent = attach(server, { apiKey: 'test-key', token: '', exotelAccountSid: 'veshannastro1', openLive: gemini.open, notifyOwner: async t => { done.push(t); return true; } });
  assert.ok(agent.enabled);
  await new Promise(r => server.listen(0, r));
  const url = `ws://127.0.0.1:${server.address().port}`;
  try {
    const intruder = await connect(`${url}/voice/exotel`);
    const closed = new Promise(r => intruder.on('close', r));
    intruder.send(JSON.stringify({ event: 'start', stream_sid: 'X', start: { stream_sid: 'X', call_sid: 'X', account_sid: 'someone-else', from: '+919000000000', media_format: { sample_rate: '8000' } } }));
    await closed;
    const exotel = await connect(`${url}/voice/exotel`);
    let closedEarly = false; exotel.on('close', () => { closedEarly = true; });
    exotel.send(JSON.stringify({ event: 'start', stream_sid: 'Y', start: { stream_sid: 'Y', call_sid: 'Y', account_sid: 'veshannastro1', from: '', media_format: { sample_rate: '8000' } } }));
    await new Promise(r => setTimeout(r, 300));
    assert.strictEqual(closedEarly, false, 'a call from our own Exotel account stays open');
    assert.strictEqual(gemini.sessions.length, 1, 'only the verified call reaches Gemini');
    exotel.terminate();
    await new Promise(r => setTimeout(r, 300)); // let both sessions wrap up before the test ends
  } finally {
    server.close();
  }
});

test('the stream refuses wrong tokens and other paths', async () => {
  const { server, url } = await startServer({ openLive: fakeLive().open });
  try {
    await assert.rejects(connect(`${url}/voice/exotel?token=nope`), /HTTP 401/);
    await assert.rejects(connect(`${url}/voice/exotel`), /HTTP 401/);
    await assert.rejects(connect(`${url}/other?token=secret`), /HTTP 404/);
  } finally {
    server.close();
  }
});

test('a full call: audio both ways, barge-in, escalation, goodbye, owner summary and sheet row', async () => {
  const live = fakeLive();
  const owner = [];
  const appsScript = [];
  const postAppsScript = async payload => {
    appsScript.push(payload);
    return payload.target === 'voice_knowledge' ? { faq: [{ question: 'Experience?', answer: '18 years' }], testimonials: [] } : {};
  };
  const { server, url } = await startServer({
    openLive: live.open,
    notifyOwner: async text => { owner.push(text); return true; },
    postAppsScript,
    loadKnowledge: knowledgeLoader(postAppsScript),
    servicesContext: () => 'CATEGORY: Consultations'
  });
  try {
    const exotel = await connect(`${url}/voice/exotel?token=secret`);
    const received = [];
    exotel.on('message', data => received.push(JSON.parse(data.toString())));
    exotel.send(JSON.stringify({ event: 'connected' }));
    exotel.send(startMessage());

    await waitFor(() => live.sessions.length === 1 && live.sessions[0].sent.length >= 1);
    const gemini = live.sessions[0];
    assert.equal(gemini.setup.model, 'models/gemini-3.8-live');
    assert.deepEqual(gemini.setup.generationConfig.responseModalities, ['AUDIO']);
    assert.equal(gemini.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Aoede');
    assert.ok(gemini.setup.systemInstruction.parts[0].text.includes(GREETING));
    assert.ok(gemini.setup.systemInstruction.parts[0].text.includes('A: 18 years'));
    assert.deepEqual(gemini.setup.inputAudioTranscription, {});
    const toolNames = gemini.setup.tools[0].functionDeclarations.map(f => f.name);
    assert.deepEqual(toolNames, ['find_free_slots', 'create_booking_and_send_link', 'send_service_link', 'escalate_to_owner', 'read_the_person', 'end_call']);
    assert.match(gemini.sent[0].realtimeInput.text, /call has just connected/);

    // Caller audio reaches Gemini as 16 kHz PCM.
    exotel.send(JSON.stringify({ event: 'media', stream_sid: 'MZ1', media: { chunk: '1', timestamp: '100', payload: pcmToBuffer(sine(800, 8000)).toString('base64') } }));
    await waitFor(() => gemini.sent.some(m => m.realtimeInput?.audio));
    const audioIn = gemini.sent.find(m => m.realtimeInput?.audio).realtimeInput.audio;
    assert.equal(audioIn.mimeType, 'audio/pcm;rate=16000');
    assert.ok(Math.abs(Buffer.from(audioIn.data, 'base64').length - 3200) <= 4);

    // Kamala's 24 kHz voice reaches Exotel as 8 kHz frames in multiples of 320 bytes.
    const halfSecond = pcmToBuffer(sine(12000, 24000)).toString('base64');
    gemini.emit('message', { serverContent: { outputTranscription: { text: 'Hi, welcome to Veshannastro!' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: halfSecond } }] } } });
    gemini.emit('message', { serverContent: { turnComplete: true } });
    await waitFor(() => received.filter(m => m.event === 'media').length >= 3);
    const media = received.filter(m => m.event === 'media');
    assert.ok(media.every(m => m.stream_sid === 'MZ1' && Buffer.from(m.media.payload, 'base64').length % 320 === 0));
    const bytes = media.reduce((sum, m) => sum + Buffer.from(m.media.payload, 'base64').length, 0);
    assert.ok(bytes >= 8000 && bytes <= 8320);

    // The caller talks over Kamala: Exotel is told to drop queued audio.
    gemini.emit('message', { serverContent: { inputTranscription: { text: 'Mujhe Shashank ji se baat karni hai' } } });
    gemini.emit('message', { serverContent: { interrupted: true } });
    await waitFor(() => received.some(m => m.event === 'clear'));

    // Escalation: owner alert in the agreed format, tool answer carries the call id.
    gemini.emit('message', { toolCall: { functionCalls: [{ id: 'fc1', name: 'escalate_to_owner', args: {
      reason: 'Asked for Shashank ji', query_type: 'Marriage', summary: 'Marriage problems, unsure if it is genuine', caller_name: 'Rahul Sharma'
    } }] } });
    await waitFor(() => gemini.sent.some(m => m.toolResponse));
    const answer = gemini.sent.find(m => m.toolResponse).toolResponse.functionResponses[0];
    assert.equal(answer.id, 'fc1');
    assert.equal(answer.name, 'escalate_to_owner');
    assert.equal(answer.response.status, 'owner_alerted');
    assert.equal(owner[0], 'Callback needed within 24 hours\nName: Rahul Sharma\nNumber: +919876543210\nQuery: Marriage\nSummary: Marriage problems, unsure if it is genuine');

    // Goodbye: end_call, the goodbye plays, a mark goes out, Exotel echoes it, the call closes.
    gemini.emit('message', { toolCall: { functionCalls: [{ id: 'fc2', name: 'end_call', args: { outcome: 'escalated' } }] } });
    gemini.emit('message', { serverContent: { outputTranscription: { text: 'Take care, Rahul ji.' }, modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: halfSecond } }] } } });
    gemini.emit('message', { serverContent: { turnComplete: true } });
    await waitFor(() => received.some(m => m.event === 'mark'));
    const mark = received.find(m => m.event === 'mark');
    const closed = new Promise(resolve => exotel.once('close', resolve));
    exotel.send(JSON.stringify({ event: 'mark', stream_sid: 'MZ1', mark: { name: mark.mark.name } }));
    await closed;

    await waitFor(() => owner.length >= 2 && appsScript.some(p => p.target === 'phone_query'));
    assert.equal(gemini.closed, true);
    const row = appsScript.find(p => p.target === 'phone_query');
    assert.equal(row.phone, '+919876543210');
    assert.equal(row.name, 'Rahul Sharma');
    assert.equal(row.query, 'Marriage');
    assert.equal(row.status, 'Callback pending');
    assert.equal(row.callSid, 'CA1');
    assert.ok(row.callbackDue);
    assert.match(owner[1], /^📞 Call from Rahul Sharma \(\+919876543210\)/);
    assert.match(owner[1], /Outcome: Callback needed/);
  } finally {
    server.close();
  }
});

test('with a Sarvam key, Kamala speaks in the Indian voice: Gemini decides the words, Sarvam says them', async () => {
  assert.equal(speakable('Welcome to **Veshannastro**!'), 'Welcome to   वी shan Astro  !');
  assert.equal(speakable('Hey, welcome to Vishan Astro!'), 'Hey, welcome to वी shan Astro!');
  const live = fakeLive();
  const voices = [];
  const openTts = (key, opts) => {
    const tts = new EventEmitter();
    tts.key = key; tts.opts = opts; tts.texts = []; tts.flushes = 0; tts.closed = false;
    tts.send = t => tts.texts.push(t);
    tts.flush = () => { tts.flushes++; };
    tts.close = () => { tts.closed = true; };
    voices.push(tts);
    return tts;
  };
  const owner = [];
  const { server, url } = await startServer({
    openLive: live.open, openTts, sarvamApiKey: 'sk-test', sarvamSpeaker: 'ritu',
    notifyOwner: async text => { owner.push(text); return true; }
  });
  try {
    const exotel = await connect(`${url}/voice/exotel?token=secret`);
    const received = [];
    exotel.on('message', data => received.push(JSON.parse(data.toString())));
    exotel.send(startMessage());
    // voices[0] pre-records the opening line when the server starts; voices[1] is this call's voice.
    await waitFor(() => live.sessions.length === 1 && voices.length === 2);
    assert.deepEqual(voices[0].texts, [GREETING]);
    const gemini = live.sessions[0];
    const voice = voices[1];
    assert.equal(voice.key, 'sk-test');
    assert.equal(voice.opts.rate, 8000);
    assert.equal(voice.opts.speaker, 'ritu');

    // The opening line is spoken the moment the call connects, before Gemini is even ready.
    assert.deepEqual(voice.texts, [GREETING]);
    assert.equal(voice.flushes, 1);
    // Gemini replies in text (no waiting for its own audio) with quick turn detection, told the greeting was played.
    assert.deepEqual(gemini.setup.generationConfig.responseModalities, ['TEXT']);
    assert.equal(gemini.setup.outputAudioTranscription, undefined);
    assert.equal(gemini.setup.realtimeInputConfig.automaticActivityDetection.endOfSpeechSensitivity, 'END_SENSITIVITY_HIGH');
    assert.match(gemini.setup.systemInstruction.parts[0].text, /played to the caller automatically/);
    await waitFor(() => gemini.sent.length >= 1);
    assert.match(gemini.sent[0].realtimeInput.text, /already been played/);

    // Each finished sentence goes to the Indian voice straight away; the turn end flushes the rest.
    gemini.emit('message', { serverContent: { inputTranscription: { text: 'Hello?' } } });
    gemini.emit('message', { serverContent: { modelTurn: { parts: [{ text: 'Main Kamala bol rahi hoon. ' }] } } });
    gemini.emit('message', { serverContent: { modelTurn: { parts: [{ text: 'Aapka naam', thought: true }, { text: 'Aapka naam jaan sakti hoon' }] } } });
    gemini.emit('message', { serverContent: { turnComplete: true } });
    await waitFor(() => voice.flushes === 3);
    assert.deepEqual(voice.texts.slice(1), ['Main Kamala bol rahi hoon. ', 'Aapka naam jaan sakti hoon']);
    assert.equal(received.filter(m => m.event === 'media').length, 0);
    const halfSecond = pcmToBuffer(sine(12000, 24000)).toString('base64');

    // Sarvam's 8 kHz audio goes to Exotel in 320-byte multiples; the tail is flushed on "final".
    voice.emit('audio', pcmToBuffer(sine(4000, 8000)));
    voice.emit('final');
    await waitFor(() => received.filter(m => m.event === 'media').length >= 3);
    const bytes = received.filter(m => m.event === 'media').reduce((n, m) => n + Buffer.from(m.media.payload, 'base64').length, 0);
    assert.ok(bytes >= 8000 && bytes <= 8320);
    assert.ok(received.filter(m => m.event === 'media').every(m => Buffer.from(m.media.payload, 'base64').length % 320 === 0));

    // Barge-in: Exotel is cleared and a fresh voice stream replaces the old one.
    gemini.emit('message', { serverContent: { interrupted: true } });
    await waitFor(() => voices.length === 3);
    assert.ok(voice.closed);
    await waitFor(() => received.some(m => m.event === 'clear'));
    voice.emit('audio', pcmToBuffer(sine(4000, 8000)));
    const before = received.filter(m => m.event === 'media').length;
    await new Promise(r => setTimeout(r, 50));
    assert.equal(received.filter(m => m.event === 'media').length, before, 'audio from the old stream is dropped');

    // If the Indian voice fails, the call carries on in Gemini's voice.
    voices[2].emit('error', new Error('401'));
    gemini.emit('message', { serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: halfSecond } }] } } });
    await waitFor(() => received.filter(m => m.event === 'media').length > before);
    exotel.close();
    await waitFor(() => owner.length >= 1); // let the call wrap up before the test ends
  } finally {
    server.close();
  }
});

test('booking on a call uses the confirmed WhatsApp number and passes "send Hi" back to Kamala', async () => {
  const live = fakeLive();
  const bookings = [];
  const { server, url } = await startServer({
    openLive: live.open,
    createCallBooking: async request => { bookings.push(request); return { status: 'awaiting_hi', serviceName: 'Career Consultation', appointmentDate: '3 Oct 2026, 7:30 pm IST' }; },
    notifyOwner: async () => true
  });
  try {
    const exotel = await connect(`${url}/voice/exotel?token=secret`);
    exotel.send(startMessage());
    await waitFor(() => live.sessions.length === 1 && live.sessions[0].sent.length >= 1);
    const gemini = live.sessions[0];
    gemini.emit('message', { toolCall: { functionCalls: [{ id: 'b1', name: 'create_booking_and_send_link', args: {
      customer_name: 'Priya Sharma', dob: '12-03-1994', tob: '06:40', pob: 'Jaipur', service_name: 'Career Consultation',
      preferred_time_slot: '2026-10-03T19:30:00+05:30', whatsapp_number: '98290 12345'
    } }] } });
    await waitFor(() => gemini.sent.some(m => m.toolResponse));
    const answer = gemini.sent.find(m => m.toolResponse).toolResponse.functionResponses[0].response;
    assert.equal(answer.status, 'awaiting_hi');
    assert.equal(bookings[0].whatsappPhone, '919829012345');
    assert.equal(bookings[0].callerPhone, '919876543210');

    gemini.emit('message', { toolCall: { functionCalls: [{ id: 'b2', name: 'create_booking_and_send_link', args: {} }] } });
    await waitFor(() => gemini.sent.filter(m => m.toolResponse).length === 2);
    assert.equal(gemini.sent.filter(m => m.toolResponse)[1].toolResponse.functionResponses[0].response.status, 'already_sent');
    assert.equal(bookings.length, 1);
    exotel.close();
  } finally {
    server.close();
  }
});

test('if the first Live model is refused before setup, the next one is tried', async () => {
  const live = fakeLive({ refuseModels: ['models/gemini-3.8-live'] });
  const { server, url } = await startServer({ openLive: live.open, notifyOwner: async () => true });
  try {
    const exotel = await connect(`${url}/voice/exotel?token=secret`);
    exotel.send(startMessage());
    await waitFor(() => live.sessions.length === 2 && live.sessions[1].sent.length >= 1);
    assert.equal(live.sessions[1].setup.model, 'models/gemini-3.1-flash-live-preview');
    assert.match(live.sessions[1].sent[0].realtimeInput.text, /call has just connected/);
    exotel.close();
  } finally {
    server.close();
  }
});
