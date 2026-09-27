'use strict';

/**
 * Kamala on the phone.
 * Exotel Voicebot applet  <->  this WebSocket bridge  <->  Gemini Live (speech in, speech out).
 * Same memory (Postgres + Customer Profiles sheet) as the WhatsApp Kamala.
 *
 * Exotel flow: Voicebot applet (URL below) -> Hangup applet.
 *   wss://<render-host>/voice/exotel?sample-rate=16000&token=<VOICE_AGENT_SECRET>
 */

const { WebSocketServer } = require('ws');

const LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const LIVE_VOICE = process.env.GEMINI_LIVE_VOICE || 'Aoede';
const GEMINI_OUT_RATE = 24000;
const CHUNK_BYTES = 3200; // Exotel wants chunks >= 3.2 KB and a multiple of 320 bytes
const QUERY_TYPES = ['Marriage', 'Family', 'Career', 'Business', 'Health', 'Report', 'Booking', 'Other'];

// ---------- small helpers ----------

/** Any Indian number format -> 91XXXXXXXXXX (the key used everywhere in the WhatsApp bot). */
function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = '91' + d;
  return d;
}

/** Streaming linear resampler for 16-bit mono PCM. */
class Resampler {
  constructor(fromRate, toRate) {
    this.step = fromRate / toRate;
    this.pos = 0;
    this.prev = 0;
  }
  push(buf) {
    const n = Math.floor(buf.length / 2);
    if (!n) return Buffer.alloc(0);
    if (this.step === 1) return buf.subarray(0, n * 2);
    // Sample -1 is the last sample of the previous buffer, so interpolation runs smoothly across chunks.
    const at = i => (i < 0 ? this.prev : buf.readInt16LE(i * 2));
    const out = [];
    let p = this.pos;
    while (p <= n - 1) {
      const i = Math.floor(p);
      const f = p - i;
      const a = at(i);
      const b = i + 1 < n ? at(i + 1) : a;
      out.push(Math.round(a + (b - a) * f));
      p += this.step;
    }
    this.pos = p - n;
    this.prev = at(n - 1);
    const res = Buffer.alloc(out.length * 2);
    out.forEach((v, k) => res.writeInt16LE(Math.max(-32768, Math.min(32767, v)), k * 2));
    return res;
  }
}

/** Buffers outgoing audio and emits Exotel-sized chunks. */
class Chunker {
  constructor(size = CHUNK_BYTES) { this.size = size; this.buf = Buffer.alloc(0); }
  push(b) {
    this.buf = Buffer.concat([this.buf, b]);
    const out = [];
    while (this.buf.length >= this.size) {
      out.push(this.buf.subarray(0, this.size));
      this.buf = this.buf.subarray(this.size);
    }
    return out;
  }
  flush() {
    if (!this.buf.length) return [];
    const padded = Buffer.alloc(this.size);
    this.buf.copy(padded);
    this.buf = Buffer.alloc(0);
    return [padded];
  }
  reset() { this.buf = Buffer.alloc(0); }
}

// ---------- what Kamala knows and how she talks on the phone ----------

function callInstructions({ profileBlock, readingBlock, servicesBlock, callerPhone, isKnown }) {
  return `You are Kamala, the voice of Veshannastro (Vedic astrology, numerology and palmistry consultations by Shri Shashank ji) answering an incoming PHONE CALL. You speak, you do not type.

HOW YOU SOUND:
- A warm, calm, smiling young Indian woman. Natural Hinglish: Hindi and English mixed INSIDE the same sentence, roughly half and half, like a real Delhi girl on the phone. Examples: "Ji bilkul, main samajh sakti hoon, it must be really tough.", "Don't worry, hum dekhte hain kya best rahega.", "Aapka career thoda stuck feel ho raha hai na?"
- Never speak a fully Hindi sentence full of heavy words (chinta, samay, vivah, dhanyavaad, kripya). Say tension, time, shaadi, thank you, please.
- Keep every turn short: one or two sentences, then let them talk. Never read lists, links, emails or prices in a long string. Ask only one question at a time.
- Hope, never promises: be optimistic about outcomes but never guarantee results.

OPENING (say this first, word for word, warm and smiling):
- "Hi, welcome to Veshannastro! I'm Kamala, your personal advisor. Just so you know, quality ke liye yeh call record ho sakti hai."
- ${isKnown ? 'This is a returning person: greet them by first name, happy to hear from them, and gently ask whether their earlier concern has improved.' : 'Then ask their name warmly: "Aapka naam jaan sakti hoon?"'}

IF ASKED "kya main robot se baat kar raha hoon?" / "are you AI?" / "insaan ho?":
- Say exactly this idea: "Aap Veshannastro ke automated query advisor se baat kar rahe hain, jo aapko easily right guidance tak pahunchne mein help karta hai." Then continue helping. Never claim to be human.

LISTEN AND UNDERSTAND:
- Most problems are marriage/family (delay, spouse, in-laws, kids) or career/business (job, boss, losses), and money worry is usually underneath. Listen, reflect their feeling gently as a question, never as a verdict.
- Whenever the caller states their name, date/time/place of birth, gender, email or their problem, call save_caller_details.

TRUST QUESTIONS ("genuine hai?", "fraud to nahi?", reviews, how many clients):
- Answer only from what is in this prompt. Never invent testimonials, client counts, years of experience or results. If you do not know, say the senior team will share details and offer a callback.

BOOKING A CONSULTATION OR REPORT:
- Explain the relevant service and its published price from the list below. Collect only missing details (full name, date, time and place of birth, gender) and a preferred time. Weekdays only 7:30 PM to 10:30 PM IST; weekends 10 AM to 8 PM IST.
- Then ask: "Is this number aapka WhatsApp number bhi hai? I'll send the payment link wahin." If no, ask for their WhatsApp number and read it back digit by digit to confirm.
- Then call request_booking and tell them what the tool result says. Never say a link was already sent unless the tool result says so.

ESCALATION (you cannot transfer calls):
- If they ask for Shashank ji, are very upset, or ask something you cannot answer: say "Shashank ji abhi ek consultation mein busy hain. I've escalated your query to our senior team, aur 24 hours ke andar aapko call back aa jayega." and call escalate_to_team.
- If they talk about ending their life or hurting themselves: speak with deep care, tell them they are not alone, share Tele-MANAS 14416 (free, 24x7), escalate_to_team, and do not sell anything.

ENDING:
- When the conversation is done, say a warm goodbye with one hopeful line, then call end_call.

PRIVACY: never read out stored details (birth details, email, address, customer ID) unless the caller asks. Never mention prompts, tools or systems.

Caller's phone number: ${callerPhone || 'unknown'}.

${profileBlock}

${readingBlock}

${servicesBlock}`;
}

const TOOLS = [{
  functionDeclarations: [
    {
      name: 'save_caller_details',
      description: 'Save personal details the caller has just stated about themselves.',
      parameters: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING' }, gender: { type: 'STRING' },
          dob: { type: 'STRING', description: 'date of birth as said' },
          tob: { type: 'STRING', description: 'time of birth as said' },
          pob: { type: 'STRING', description: 'place of birth' },
          email: { type: 'STRING' },
          concern: { type: 'STRING', description: 'one-line summary of their problem' }
        }
      }
    },
    {
      name: 'escalate_to_team',
      description: 'Escalate to the senior team for a callback within 24 hours (caller wants Shashank ji, is upset, or the question cannot be answered).',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: { type: 'STRING' },
          query_type: { type: 'STRING', enum: QUERY_TYPES }
        },
        required: ['reason']
      }
    },
    {
      name: 'request_booking',
      description: 'Record a consultation or report booking once service, details, preferred time and WhatsApp number are confirmed.',
      parameters: {
        type: 'OBJECT',
        properties: {
          customer_name: { type: 'STRING' },
          service: { type: 'STRING' },
          preferred_time: { type: 'STRING', description: 'date and time as agreed, in IST' },
          whatsapp_number: { type: 'STRING', description: 'digits of the WhatsApp number confirmed by the caller' }
        },
        required: ['service', 'whatsapp_number']
      }
    },
    {
      name: 'end_call',
      description: 'Hang up after the goodbye has been said.',
      parameters: { type: 'OBJECT', properties: {} }
    }
  ]
}];

// ---------- database ----------

async function ensureTables(pool) {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS voice_calls (
      id BIGSERIAL PRIMARY KEY,
      call_sid TEXT UNIQUE,
      phone TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ended_at TIMESTAMPTZ,
      duration_s INTEGER,
      query_type TEXT,
      summary TEXT,
      mood TEXT,
      outcome TEXT,
      escalated BOOLEAN NOT NULL DEFAULT false,
      booking JSONB,
      transcript TEXT
    );
    CREATE INDEX IF NOT EXISTS voice_calls_phone_idx ON voice_calls (phone, started_at DESC);
  `);
}

// ---------- one phone call ----------

class CallSession {
  constructor(ws, deps, opts = {}) {
    this.ws = ws;
    this.deps = deps;
    this.connectLive = opts.connectLive || deps.connectLive;
    this.streamSid = null;
    this.callSid = null;
    this.phone = '';
    this.rate = 8000;
    this.live = null;
    this.chunker = new Chunker();
    this.resampler = null;
    this.transcript = [];
    this.saved = {};
    this.escalation = null;
    this.booking = null;
    this.ending = false;
    this.closed = false;
    this.startedAt = new Date();
    this.finished = null;
    ws.on('message', data => this.onExotel(data).catch(e => this.log('Exotel message error', e.message)));
    ws.on('close', () => this.finish('socket closed'));
    ws.on('error', e => this.log('socket error', e.message));
  }

  log(...a) { console.log(`📞 [${this.callSid || 'call'}]`, ...a); }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendAudio(pcm) {
    for (const chunk of this.chunker.push(pcm)) {
      this.send({ event: 'media', stream_sid: this.streamSid, media: { payload: chunk.toString('base64') } });
    }
  }

  flushAudio() {
    for (const chunk of this.chunker.flush()) {
      this.send({ event: 'media', stream_sid: this.streamSid, media: { payload: chunk.toString('base64') } });
    }
  }

  addLine(role, text) {
    const t = String(text || '');
    if (!t.trim()) return;
    const last = this.transcript[this.transcript.length - 1];
    if (last && last.role === role) last.text += t;
    else this.transcript.push({ role, text: t });
  }

  async onExotel(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    switch (msg.event) {
      case 'start': return this.onStart(msg);
      case 'media':
        if (this.live && msg.media?.payload) {
          this.live.sendRealtimeInput({ audio: { data: msg.media.payload, mimeType: `audio/pcm;rate=${this.rate}` } });
        }
        return;
      case 'mark':
        if (msg.mark?.name === 'goodbye') this.hangup();
        return;
      case 'stop':
        return this.finish(msg.stop?.reason || 'stop');
      default:
    }
  }

  async onStart(msg) {
    const s = msg.start || {};
    this.streamSid = msg.stream_sid || s.stream_sid;
    this.callSid = s.call_sid || this.streamSid;
    this.rate = Number(s.media_format?.sample_rate) || 8000;
    this.resampler = new Resampler(GEMINI_OUT_RATE, this.rate);
    this.phone = normalizePhone(s.from);
    this.log(`start from ${this.phone} at ${this.rate} Hz`);

    const { pool, crm } = this.deps;
    let user = null; let bookings = []; let lastTurnAt = null;
    if (pool && this.phone) {
      await pool.query(`INSERT INTO users (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING`, [this.phone]).catch(() => {});
      user = await this.deps.getUser(this.phone).catch(() => null);
      bookings = await crm.bookingHistory(pool, this.phone).catch(() => []);
      const last = await pool.query('SELECT created_at FROM wa_messages WHERE phone=$1 ORDER BY id DESC LIMIT 1', [this.phone]).catch(() => ({ rows: [] }));
      lastTurnAt = last.rows[0]?.created_at || null;
      await pool.query(`INSERT INTO voice_calls (call_sid, phone) VALUES ($1,$2) ON CONFLICT (call_sid) DO NOTHING`, [this.callSid, this.phone]).catch(() => {});
    }
    const instructions = callInstructions({
      profileBlock: crm.profileContext(user || {}, bookings, lastTurnAt),
      readingBlock: crm.readingContext(user || {}),
      servicesBlock: this.deps.servicesContext ? this.deps.servicesContext() : '',
      callerPhone: this.phone,
      isKnown: Boolean(user && user.name)
    });

    this.live = await this.connectLive({
      model: this.deps.liveModel || LIVE_MODEL,
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.deps.liveVoice || LIVE_VOICE } } },
        systemInstruction: instructions,
        tools: TOOLS,
        inputAudioTranscription: {},
        outputAudioTranscription: {}
      },
      callbacks: {
        onmessage: m => this.onLive(m).catch(e => this.log('live message error', e.message)),
        onerror: e => this.log('live error', e?.message || e),
        onclose: e => { this.log('live closed', e?.reason || ''); if (!this.ending) this.hangup(); }
      }
    });
    // Let Kamala speak first.
    this.live.sendClientContent({ turns: [{ role: 'user', parts: [{ text: '[The phone call has just connected. Greet the caller now.]' }] }], turnComplete: true });
  }

  async onLive(m) {
    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) {
        this.chunker.reset();
        this.send({ event: 'clear', stream_sid: this.streamSid });
      }
      for (const part of sc.modelTurn?.parts || []) {
        if (part.inlineData?.data) this.sendAudio(this.resampler.push(Buffer.from(part.inlineData.data, 'base64')));
      }
      if (sc.inputTranscription?.text) this.addLine('user', sc.inputTranscription.text);
      if (sc.outputTranscription?.text) this.addLine('model', sc.outputTranscription.text);
      if (sc.turnComplete) {
        this.flushAudio();
        if (this.ending) this.send({ event: 'mark', stream_sid: this.streamSid, mark: { name: 'goodbye' } });
      }
    }
    if (m.toolCall?.functionCalls?.length) {
      const functionResponses = [];
      for (const fc of m.toolCall.functionCalls) {
        let response;
        try { response = await this.runTool(fc.name, fc.args || {}); } catch (e) { response = { ok: false, error: e.message }; }
        functionResponses.push({ id: fc.id, name: fc.name, response });
      }
      this.live.sendToolResponse({ functionResponses });
    }
  }

  async runTool(name, args) {
    const { pool, crm } = this.deps;
    if (name === 'save_caller_details') {
      const details = crm.cleanExtracted({ about_self: true, ...args });
      Object.assign(this.saved, details);
      if (pool && this.phone && Object.keys(details).length) {
        const changed = await crm.applyProfileDetails(pool, this.phone, details);
        if (Object.keys(changed).length && this.deps.postAppsScript) {
          this.deps.postAppsScript(crm.profilePayload(await this.deps.getUser(this.phone)), { timeoutMs: 20000, maxAttempts: 2 }).catch(() => {});
        }
      }
      return { ok: true };
    }
    if (name === 'escalate_to_team') {
      this.escalation = { reason: String(args.reason || ''), queryType: args.query_type || '' };
      return { ok: true, note: 'Escalated. The owner gets the caller name, number and query on WhatsApp after the call and will call back within 24 hours.' };
    }
    if (name === 'request_booking') {
      const wa = normalizePhone(args.whatsapp_number || this.phone);
      this.booking = { ...args, whatsapp_number: wa };
      return {
        ok: true,
        say: 'Tell the caller: the booking is noted, and the payment link with invoice will come on their WhatsApp from our team shortly. The slot is confirmed only after payment.'
      };
    }
    if (name === 'end_call') {
      this.ending = true;
      const t = setTimeout(() => this.hangup(), 12000); // safety net if the goodbye mark never comes back
      if (t.unref) t.unref();
      return { ok: true };
    }
    return { ok: false, error: `unknown tool ${name}` };
  }

  hangup() {
    if (this.closed) return;
    this.closed = true;
    try { this.flushAudio(); } catch { /* ignore */ }
    try { this.ws.close(); } catch { /* ignore */ }
    this.finish('hangup');
  }

  /** After the call: memory, owner WhatsApp, Phone Queries sheet. Runs once. */
  finish(reason) {
    if (this.finished) return this.finished;
    this.finished = (async () => {
      this.log('ended:', reason);
      try { this.live && this.live.close(); } catch { /* ignore */ }
      if (!this.phone) return;
      await afterCall(this, this.deps).catch(e => console.error('After-call processing failed:', e.message));
    })();
    return this.finished;
  }
}

// ---------- after the call ----------

async function summarizeCall(deps, transcriptText) {
  const fallback = { name: '', query_type: 'Other', summary: transcriptText.slice(0, 200), mood: '', outcome: '' };
  if (!deps.genAI || !transcriptText.trim()) return fallback;
  try {
    const S = deps.SchemaType;
    const model = deps.genAI.getGenerativeModel({
      model: deps.modelName,
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: {
          type: S.OBJECT,
          properties: {
            name: { type: S.STRING, description: 'caller name if said, else empty' },
            query_type: { type: S.STRING, enum: QUERY_TYPES },
            summary: { type: S.STRING, description: 'one short line: what they want and why, e.g. "Marriage problems, wants a consultation, unsure if it is genuine"' },
            mood: { type: S.STRING, description: '1-3 words' },
            outcome: { type: S.STRING, description: 'e.g. booking requested, callback needed, question answered, dropped' }
          },
          required: ['query_type', 'summary']
        }
      }
    });
    const res = await model.generateContent(`Summarise this phone call between a caller and Kamala (astrology consultation advisor). English only, short.\n\n${transcriptText.slice(-6000)}`);
    return { ...fallback, ...JSON.parse(res.response.text()) };
  } catch (e) {
    return fallback;
  }
}

async function afterCall(call, deps) {
  const { pool, crm } = deps;
  const lines = call.transcript.filter(l => l.text.trim());
  const transcriptText = lines.map(l => `${l.role === 'user' ? 'Caller' : 'Kamala'}: ${l.text.trim()}`).join('\n');
  const durationS = Math.round((Date.now() - call.startedAt.getTime()) / 1000);
  const user = pool ? await deps.getUser(call.phone).catch(() => null) : null;
  const sum = await summarizeCall(deps, transcriptText);
  const name = call.saved.name || user?.name || sum.name || 'Unknown caller';
  const queryType = call.escalation?.queryType || sum.query_type || 'Other';
  const outcome = call.booking ? 'Booking requested' : call.escalation ? 'Callback needed' : (sum.outcome || 'Answered');

  if (pool) {
    for (const l of lines) await crm.saveTurn(pool, call.phone, l.role, `[Call] ${l.text.trim()}`).catch(() => {});
    await pool.query(`UPDATE voice_calls SET ended_at=NOW(), duration_s=$2, query_type=$3, summary=$4, mood=$5, outcome=$6,
        escalated=$7, booking=$8, transcript=$9 WHERE call_sid=$1`,
    [call.callSid, durationS, queryType, sum.summary, sum.mood, outcome, Boolean(call.escalation), call.booking ? JSON.stringify(call.booking) : null, transcriptText]).catch(() => {});
    if (!call.saved.concern && sum.summary && !user?.pain_point) {
      await crm.applyProfileDetails(pool, call.phone, { concern: sum.summary }).catch(() => {});
    }
    // Same emotion/problem reading as WhatsApp.
    if (deps.genAI && lines.length >= 3) {
      const turns = lines.map(l => ({ role: l.role, parts: [{ text: l.text }] }));
      const reading = await crm.analyzeEmotion(deps.genAI, deps.SchemaType, deps.modelName, turns).catch(() => null);
      await crm.applyReading(pool, call.phone, reading).catch(() => {});
    }
  }

  const fresh = pool ? await deps.getUser(call.phone).catch(() => null) : null;
  const reading = fresh ? crm.readingTag(fresh) : '';
  const mins = `${Math.floor(durationS / 60)}m ${durationS % 60}s`;
  let text;
  if (call.booking) {
    const b = call.booking;
    text = `Phone booking request - send the payment link\nName: ${b.customer_name || name}\nCaller: +${call.phone}\nWhatsApp: +${b.whatsapp_number}\nService: ${b.service || '-'}\nPreferred time: ${b.preferred_time || '-'}\nQuery: ${queryType}\nSummary: ${sum.summary}`;
  } else if (call.escalation) {
    text = `Callback needed within 24 hours\nName: ${name}\nNumber: +${call.phone}\nQuery: ${queryType}\nSummary: ${sum.summary}${call.escalation.reason ? `\nWhy: ${call.escalation.reason}` : ''}`;
  } else {
    text = `Call from ${name} (+${call.phone}), ${mins}\nQuery: ${queryType}\nSummary: ${sum.summary}\nOutcome: ${outcome}`;
  }
  if (reading) text += `\nReading: ${reading}`;
  if (transcriptText) await deps.notifyOwner(text, `Phone call: ${name}`).catch(() => {});

  if (deps.postAppsScript && transcriptText) {
    const due = new Date(Date.now() + 24 * 3600 * 1000);
    await deps.postAppsScript({
      target: 'phone_query',
      date: call.startedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
      name, phone: call.phone,
      customerId: crm.isNewCustomerId(fresh?.customer_id) ? fresh.customer_id : '',
      query: queryType, summary: sum.summary, mood: reading || sum.mood || '', outcome,
      callbackDue: call.escalation || call.booking ? due.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '',
      status: call.escalation || call.booking ? 'Open' : 'Done',
      duration: mins
    }, { timeoutMs: 20000, maxAttempts: 2 }).catch(e => console.error('Phone Queries sheet failed:', e.message));
  }
  console.log(`📞 Call ${call.callSid} done: ${name}, ${queryType}, ${outcome}`);
}

// ---------- wiring into the Express server ----------

function defaultConnectLive(apiKey) {
  const { GoogleGenAI } = require('@google/genai');
  const ai = new GoogleGenAI({ apiKey });
  return params => ai.live.connect(params);
}

function attach(server, deps) {
  const wss = new WebSocketServer({ noServer: true });
  const connectLive = deps.connectLive || defaultConnectLive(deps.apiKey);
  ensureTables(deps.pool).catch(e => console.error('voice_calls table failed:', e.message));
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/voice/exotel') return socket.destroy();
    const secret = deps.secret;
    if (secret && url.searchParams.get('token') !== secret) {
      console.warn('📞 Rejected voice connection: bad token');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, ws => new CallSession(ws, { ...deps, connectLive }));
  });
  console.log('📞 Voice agent ready at /voice/exotel');
  return wss;
}

module.exports = { attach, CallSession, Resampler, Chunker, normalizePhone, callInstructions, ensureTables, summarizeCall, TOOLS };
