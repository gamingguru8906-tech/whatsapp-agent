'use strict';

/**
 * Kamala on the phone.
 *
 * Exotel's Voicebot applet streams each call over a WebSocket (16-bit mono PCM,
 * base64, 8 kHz by default). This bridge passes the caller's audio to Gemini Live,
 * plays Kamala's voice back, and lets Gemini use the same tools as the WhatsApp
 * bot: caller memory, Calendar slots, the Razorpay link + invoice on WhatsApp and
 * owner alerts. When the call ends the transcript is saved as [Call] turns, the
 * owner gets a WhatsApp summary and a row lands in the "Phone Queries" sheet.
 *
 * Exotel flow: Voicebot applet with URL
 *   wss://<render host>/voice/exotel?token=<VOICE_STREAM_TOKEN>
 * followed by a Hangup applet. Closing the socket ends the Voicebot step.
 */

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocket, WebSocketServer } = require('ws');

const STREAM_PATH = '/voice/exotel';
const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
const LIVE_MODELS = [...new Set([process.env.GEMINI_LIVE_MODEL, 'gemini-3.8-live', 'gemini-3.1-flash-live-preview'].filter(Boolean))];
const LIVE_VOICE = process.env.GEMINI_LIVE_VOICE || process.env.GEMINI_TTS_VOICE || 'Aoede';
const GEMINI_INPUT_RATE = 16000;
const GEMINI_OUTPUT_RATE = 24000;
const QUERY_TYPES = ['Marriage', 'Career', 'Business', 'Report', 'Other'];
const GOODBYE_MARK = 'kamala-goodbye';

const GREETING = 'Hi, welcome to Veshannastro! Just to let you know, quality ke liye yeh call record ho sakti hai.';
const ROBOT_ANSWER = 'Aap Veshannastro ke automated query advisor se baat kar rahe hain, jo aapko easily right guidance tak pahunchne mein help karta hai.';
const ESCALATION_LINE = "Shashank ji abhi ek consultation mein busy hain. I've escalated your query to our senior team, aur 24 hours ke andar aapko call back aa jayega.";
const OPENING_CUE = '[System note, not the caller: the call has just connected. Speak first now, starting with the opening line exactly as instructed.]';
const WRAP_UP_CUE = '[System note, not the caller: the call time limit is nearly reached. Wrap up warmly in one or two short lines now, then call end_call.]';
const EMPTY_KNOWLEDGE = Object.freeze({ faq: [], testimonials: [] });

// ---------- Numbers, audio and slots ----------

/** Exotel numbers ("09876543210", "+919876543210") -> WhatsApp form ("919876543210"). */
function normalizeCallerNumber(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : '';
}

function pcmFromBase64(b64) {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  const out = new Int16Array(buf.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

function pcmToBuffer(samples) {
  const buf = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(samples[i], i * 2);
  return buf;
}

/** Linear-interpolation resampler that keeps its place between chunks, so chunk edges do not click. */
class StreamResampler {
  constructor(fromRate, toRate) {
    this.step = fromRate / toRate;
    // Moving-average low-pass before downsampling (24 kHz -> 8 kHz averages 3 samples).
    this.taps = fromRate > toRate ? Math.max(1, Math.round(this.step)) : 1;
    this.history = [];
    this.prev = 0;
    this.pos = 1;
  }

  push(input) {
    if (this.step === 1) return Int16Array.from(input);
    const n = input.length;
    const buf = new Float64Array(n + 1);
    buf[0] = this.prev;
    for (let i = 0; i < n; i++) {
      if (this.taps > 1) {
        this.history.push(input[i]);
        if (this.history.length > this.taps) this.history.shift();
        buf[i + 1] = this.history.reduce((a, b) => a + b, 0) / this.history.length;
      } else {
        buf[i + 1] = input[i];
      }
    }
    const out = [];
    let pos = this.pos;
    while (pos <= n) {
      const i = Math.floor(pos);
      const a = buf[i];
      const b = i < n ? buf[i + 1] : a;
      out.push(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * (pos - i)))));
      pos += this.step;
    }
    this.pos = pos - n;
    this.prev = buf[n];
    return Int16Array.from(out);
  }
}

/** Exotel wants chunks in multiples of 320 bytes; 100 ms frames, never under 3.2 KB. */
function exotelFrameBytes(rate) {
  return Math.ceil(Math.max(3200, rate / 5) / 320) * 320;
}

class FrameQueue {
  constructor(frameBytes) {
    this.frameBytes = frameBytes;
    this.pending = Buffer.alloc(0);
  }

  push(buf) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, buf]) : buf;
    const frames = [];
    while (this.pending.length >= this.frameBytes) {
      frames.push(this.pending.subarray(0, this.frameBytes));
      this.pending = this.pending.subarray(this.frameBytes);
    }
    return frames;
  }

  /** Last partial frame, padded with silence to a multiple of 320 bytes. */
  flush() {
    if (!this.pending.length) return null;
    const frame = Buffer.alloc(Math.ceil(this.pending.length / 320) * 320);
    this.pending.copy(frame);
    this.pending = Buffer.alloc(0);
    return frame;
  }

  clear() {
    this.pending = Buffer.alloc(0);
  }
}

/** One-hour consultation starts (India time) on a YYYY-MM-DD date, at least 30 minutes from now. */
function candidateSlots(date, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return [];
  const noon = new Date(`${date}T12:00:00+05:30`);
  if (!Number.isFinite(noon.getTime())) return [];
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short' }).format(noon);
  const weekend = weekday === 'Sat' || weekday === 'Sun';
  const starts = weekend
    ? ['10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00', '18:00', '19:00']
    : ['19:30', '20:30', '21:30'];
  const earliest = now.getTime() + 30 * 60 * 1000;
  return starts.map(t => `${date}T${t}:00+05:30`).filter(iso => new Date(iso).getTime() >= earliest);
}

function spokenTime(iso) {
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
}

function istNow(date = new Date()) {
  return date.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function normalizeQueryType(value) {
  const v = String(value || '').trim().toLowerCase();
  return QUERY_TYPES.find(t => t.toLowerCase() === v) || 'Other';
}

function clean(value, max) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function tokensMatch(expected, supplied) {
  const a = Buffer.from(String(expected || '').trim());
  const b = Buffer.from(String(supplied || '').trim());
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- What Kamala knows and says ----------

function cleanKnowledge(raw) {
  const faq = (Array.isArray(raw?.faq) ? raw.faq : [])
    .map(f => ({ question: clean(f.question, 300), answer: clean(f.answer, 1200) }))
    .filter(f => f.question && f.answer).slice(0, 40);
  const testimonials = (Array.isArray(raw?.testimonials) ? raw.testimonials : [])
    .map(t => ({ name: clean(t.name, 40), city: clean(t.city, 40), quote: clean(t.quote, 600) }))
    .filter(t => t.quote).slice(0, 20);
  return { faq, testimonials };
}

/** Reads the About & FAQ and Testimonials sheets, cached for 10 minutes; serves the old copy while refreshing. */
function knowledgeLoader(postAppsScript, ttlMs = 10 * 60 * 1000) {
  let cache = null;
  let loadedAt = 0;
  let inflight = null;
  return function loadKnowledge() {
    if (!postAppsScript) return Promise.resolve(EMPTY_KNOWLEDGE);
    if (cache && Date.now() - loadedAt < ttlMs) return Promise.resolve(cache);
    if (!inflight) {
      inflight = postAppsScript({ target: 'voice_knowledge' }, { timeoutMs: 10000, maxAttempts: 1 })
        .then(result => { cache = cleanKnowledge(result); loadedAt = Date.now(); return cache; })
        .catch(e => { console.warn('Voice FAQ/testimonials not loaded:', e.message); return cache || EMPTY_KNOWLEDGE; })
        .finally(() => { inflight = null; });
    }
    return cache ? Promise.resolve(cache) : inflight;
  };
}

function knowledgeBlock(knowledge) {
  const { faq, testimonials } = knowledge || EMPTY_KNOWLEDGE;
  const faqText = faq.length
    ? faq.map(f => `Q: ${f.question}\nA: ${f.answer}`).join('\n')
    : 'Nothing has been filled in yet.';
  const quoteText = testimonials.length
    ? testimonials.map(t => `"${t.quote}" (${[t.name, t.city].filter(Boolean).join(', ') || 'client'})`).join('\n')
    : 'Nothing has been filled in yet. Do not describe any client experience.';
  return `--- ABOUT & FAQ (approved by Shri Shashank ji; the ONLY source for who he is, experience, his book, trust, process, refunds) ---
${faqText}

--- TESTIMONIALS (real clients; quote word for word with first name and city only; never add or change any) ---
${quoteText}`;
}

function concernHint(user) {
  const u = user || {};
  if (u.pain_point) return clean(u.pain_point, 160);
  if (u.core_concern) return clean(u.core_concern, 160);
  if (u.problem_category === 'marriage_family') return 'marriage/family';
  if (u.problem_category === 'career_business') return 'career/work';
  return '';
}

function recentConversation(turns) {
  const lines = (turns || []).slice(-8)
    .map(t => `${t.role === 'user' ? 'Them' : 'Kamala'}: ${clean(t.parts?.[0]?.text || t.text, 240)}`);
  return lines.length ? lines.join('\n') : 'None.';
}

function buildCallPrompt(ctx) {
  const u = ctx.user || {};
  const first = firstName(u.name);
  const concern = concernHint(u);
  const upcoming = ctx.upcoming
    ? `${ctx.upcoming.service_name} on ${spokenTime(ctx.upcoming.appointment_start)}${ctx.upcoming.status === 'gateway_test_paid' ? ' (₹1 test booking)' : ''}. The Meet link ${ctx.upcoming.meet_link ? 'was sent on WhatsApp' : 'comes on WhatsApp'}, and a reminder with it goes out 30 minutes before.`
    : 'None.';
  const personalGreeting = first
    ? `This caller is known: ${first}. Right after that line, greet them like an old friend who is happy to hear from them: "Arre ${first} ji! How are you?"${concern ? ` Then softly ask how things are going now with what they shared last time (${concern}), naming the topic in one or two words only, e.g. "Last time career ko lekar baat hui thi, ab things kaise chal rahe hain?"` : ''}`
    : 'This is a new caller. Right after that line say: "Main Kamala bol rahi hoon. Aapka naam jaan sakti hoon?"';
  const whatsappHi = ctx.businessWhatsApp
    ? `send "Hi" on WhatsApp to ${ctx.businessWhatsApp}`
    : 'send "Hi" on our WhatsApp number';
  const gatewayNote = ctx.gatewayTest
    ? '\n- Right now the WhatsApp link is a ₹1 payment-system test. It does not pay for or confirm the consultation. Quote the published price from SERVICES; never call ₹1 the fee.'
    : '';

  return `You are Kamala, answering phone calls for Veshannastro, Shri Shashank ji's astrology practice. You are a warm, caring young woman from Jaipur. This is a live phone call: everything you say is heard, not read.

HOW YOU SOUND
- Natural spoken Hinglish: Hindi and English mixed inside the same sentence, the way young urban Indians talk ("Haan ji, main samajh sakti hoon, it's been a tough time na?", "Don't worry, hum mil ke dekhte hain"). Never fully Hindi and never formal words like chinta, samay, vivah, dhanyavaad, kripya. If the caller speaks mostly English, speak mostly English with a little Hindi.
- Short turns: one or two short sentences, then let them talk. Only one question at a time. Small natural acknowledgements ("haan ji", "achha", "samajh gayi").
- Calm, kind, unhurried. Never read out lists, links, emails or IDs. Never say "as an AI", "I understand your query" or "I can help with that". No astrology jargon like "7th house".
- Hope, never promises: "clarity milegi", "sahi direction mil jayega". Never "100% ho jayega", "pakka", "guaranteed".
- Once in a while (not every turn), one tiny caring touch that fits their mood: "ek glass paani pee lijiye, thoda saans lijiye", "aaj raat ek diya jala dijiye".
- Use "Shri Shashank ji" rarely, only when it fits (his schedule, his consultations).

OPENING
- Your very first words: "${GREETING}"
- ${personalGreeting}

IF ASKED "ROBOT HO?", "AI HO?" OR "REAL PERSON HO?"
- Say exactly: "${ROBOT_ANSWER}" Then carry on helping. Never claim to be a human and never deny being automated.

WHAT YOU DO ON THIS CALL
1. Listen first. Let them tell you what is going on. Gently find out whether it is more about marriage/family or career/business/money, and how long it has been weighing on them.
2. After the caller has spoken three or four times, call read_the_person once and use what it returns silently: once, at a natural moment, softly name their feeling and the worry underneath as a question, never a verdict ("Mujhe lag raha hai it's not just the job... andar kahin money ki tension bhi hai, right?"). Never say you analysed anything.
3. Questions about Shri Shashank ji, trust, reviews, how consultations work, refunds or prices: answer ONLY from ABOUT & FAQ, TESTIMONIALS and SERVICES below. If the answer is not there, do not guess: offer a call back from the team (escalation).
4. Offer the right service when they are ready, and book it (BOOKING). For a report or any other service they want to order themselves, call send_service_link.
5. Close with one warm, hopeful line, then call end_call.

BOOKING A CONSULTATION ON THE PHONE
- Consultation hours (India time, one hour): Monday to Friday only 7:30 PM to 10:30 PM; Saturday and Sunday 10:00 AM to 8:00 PM. Call find_free_slots for the day they want and offer at most two times. Never invent availability.
- You need: full name, date of birth, time of birth, place of birth, the service (exact name from SERVICES) and the agreed time. Gender and email only if they come up naturally; the Meet link reaches them on WhatsApp anyway. Ask only for what is not already known, one detail at a time, and never ask twice.
- Before sending anything ask: "Is this number aapka WhatsApp number bhi hai? I'll send the payment link wahin." Yes: use the calling number. No: ask for their WhatsApp number, read it back digit by digit in small groups, and wait for a yes.
- Then call create_booking_and_send_link. Say the link is sent only after the tool says "sent". If it says "awaiting_hi", ask them to ${whatsappHi} and tell them the link will come right after that.${gatewayNote}
- After that, payment, receipt, Meet link and reminders all happen on WhatsApp. Never say on the call that the booking is paid or confirmed.

ESCALATION (you cannot transfer the call)
- If they ask for Shri Shashank ji, are very upset or angry, or ask something you cannot answer from the material below: call escalate_to_owner with a short summary, then say: "${ESCALATION_LINE}" Close warmly and call end_call.
- If they talk about ending their life or hurting themselves: sell nothing. Speak with deep care, tell them they are not alone, share Tele-MANAS 14416 (free, 24x7, India), ask them to reach someone they trust right now, and call escalate_to_owner.

PRIVACY
- Use what you know about the caller silently. Never read out their stored birth details, email, address, customer ID or past chats unless they ask.

--- REAL-TIME CONTEXT (PRIVATE) ---
- Now (India): ${ctx.now || istNow()}
- Calling number: ${ctx.callerPhone ? `+${ctx.callerPhone}` : 'hidden or unknown (ask for their WhatsApp number before booking)'}
- Upcoming consultation: ${upcoming}

${ctx.profileBlock || ''}

${ctx.readingBlock || ''}

--- RECENT CONVERSATION WITH THIS PERSON (WhatsApp or earlier calls, oldest first, private) ---
${recentConversation(ctx.turns)}

${knowledgeBlock(ctx.knowledge)}

${ctx.services || 'No live services loaded. Do not quote prices; offer a call back instead.'}`;
}

const CALL_TOOLS = [{
  functionDeclarations: [
    {
      name: 'find_free_slots',
      description: 'Free one-hour consultation start times on a date (India time). Call before offering times.',
      parameters: {
        type: 'OBJECT',
        properties: { date: { type: 'STRING', description: 'The date the caller wants, YYYY-MM-DD' } },
        required: ['date']
      }
    },
    {
      name: 'create_booking_and_send_link',
      description: 'Holds the agreed slot and sends the payment link and invoice to the caller on WhatsApp. Call only after the time and the WhatsApp number are confirmed.',
      parameters: {
        type: 'OBJECT',
        properties: {
          customer_name: { type: 'STRING', description: 'Full name' },
          dob: { type: 'STRING', description: 'Date of birth' },
          tob: { type: 'STRING', description: 'Time of birth' },
          pob: { type: 'STRING', description: 'Place of birth' },
          gender: { type: 'STRING', description: 'Only if known' },
          email: { type: 'STRING', description: 'Only if the caller gave it and confirmed the spelling' },
          service_name: { type: 'STRING', description: 'Exact service name from SERVICES' },
          preferred_time_slot: { type: 'STRING', description: 'Agreed start, ISO-8601 with +05:30, e.g. 2026-10-03T19:30:00+05:30' },
          whatsapp_number: { type: 'STRING', description: 'The confirmed WhatsApp number, digits only; empty to use the calling number' },
          customer_pain_points_summary: { type: 'STRING', description: 'Two or three sentences on what they are going through' }
        },
        required: ['customer_name', 'dob', 'tob', 'pob', 'service_name', 'preferred_time_slot']
      }
    },
    {
      name: 'send_service_link',
      description: 'Sends the website link for a service or report to the caller on WhatsApp so they can order it.',
      parameters: {
        type: 'OBJECT',
        properties: {
          service_name: { type: 'STRING', description: 'Exact service name from SERVICES' },
          whatsapp_number: { type: 'STRING', description: 'The confirmed WhatsApp number, digits only; empty to use the calling number' }
        },
        required: ['service_name']
      }
    },
    {
      name: 'escalate_to_owner',
      description: 'Alerts Shri Shashank ji on WhatsApp to call this person back within 24 hours.',
      parameters: {
        type: 'OBJECT',
        properties: {
          reason: { type: 'STRING', description: 'Why a call back is needed' },
          query_type: { type: 'STRING', enum: QUERY_TYPES, description: 'One word for the topic' },
          summary: { type: 'STRING', description: 'One or two sentences on what they need' },
          caller_name: { type: 'STRING', description: 'Name if known' }
        },
        required: ['reason', 'query_type', 'summary']
      }
    },
    {
      name: 'read_the_person',
      description: 'Returns a private reading of what the caller is really going through (problem type, money pressure, feeling). Call once after they have spoken three or four times.'
    },
    {
      name: 'end_call',
      description: 'Ends the call after your goodbye line has been spoken.',
      parameters: {
        type: 'OBJECT',
        properties: { outcome: { type: 'STRING', description: 'A few words on how the call ended' } }
      }
    }
  ]
}];

// ---------- Owner messages ----------

function formatCallbackAlert({ name, phone, queryType, summary }) {
  return `Callback needed within 24 hours
Name: ${name || 'Not given'}
Number: ${phone ? `+${phone}` : 'Hidden'}
Query: ${normalizeQueryType(queryType)}
Summary: ${summary || 'Not recorded'}`;
}

function callOutcome(session) {
  const { booking, escalation, links } = session.tools;
  const parts = [];
  if (escalation) parts.push('Callback needed');
  if (booking?.status === 'awaiting_hi') parts.push('Booking link waiting for "Hi" on WhatsApp');
  else if (booking) parts.push('Booking link sent on WhatsApp');
  if (links.length) parts.push('Service link on WhatsApp');
  if (!parts.length) parts.push(session.turns.some(t => t.role === 'user') ? 'Questions answered' : 'No conversation');
  return parts.join('; ');
}

function formatCallSummary({ name, phone, seconds, queryType, mood, outcome, summary, nextStep, problem }) {
  const length = seconds < 60 ? `${seconds} sec` : `${Math.round(seconds / 60)} min`;
  return [
    `📞 Call from ${name || 'unknown caller'} (${phone ? `+${phone}` : 'hidden number'}) · ${length}`,
    problem ? `⚠️ ${problem}` : '',
    `Query: ${queryType}`,
    mood ? `Mood: ${mood}` : '',
    `Outcome: ${outcome}`,
    `Summary: ${summary}`,
    nextStep && !/^none\.?$/i.test(nextStep) ? `Next step: ${nextStep}` : ''
  ].filter(Boolean).join('\n');
}

async function summarizeCall(deps, transcript) {
  const fallback = {
    caller_name: '', query_type: 'Other', mood: '', next_step: '',
    summary: transcript ? 'Transcript saved; summary unavailable.' : 'No conversation (the caller did not speak or the call dropped).'
  };
  if (!deps.genAI || !deps.SchemaType || !transcript) return fallback;
  const S = deps.SchemaType;
  try {
    const model = deps.genAI.getGenerativeModel({
      model: deps.modelName,
      generationConfig: {
        temperature: 0.2,
        responseMimeType: 'application/json',
        responseSchema: {
          type: S.OBJECT,
          properties: {
            caller_name: { type: S.STRING, description: 'Only if the caller said it' },
            query_type: { type: S.STRING, enum: QUERY_TYPES },
            summary: { type: S.STRING, description: 'One or two plain English sentences: what they wanted and what happened' },
            mood: { type: S.STRING, description: '1-3 words for how they felt' },
            next_step: { type: S.STRING, description: 'What the owner should do next, or None' }
          },
          required: ['query_type', 'summary']
        }
      }
    });
    const res = await model.generateContent(`Summarise this phone call between Kamala (the phone assistant of an Indian astrology practice) and a caller, for the owner.
query_type: Marriage (marriage, relationship, family), Career (job, studies), Business (business, money, debts), Report (wants a report), Other.
Use only what was said. Transcript:
${transcript.slice(-8000)}`);
    const raw = JSON.parse(res.response.text());
    return {
      caller_name: clean(raw.caller_name, 60),
      query_type: normalizeQueryType(raw.query_type),
      summary: clean(raw.summary, 400) || fallback.summary,
      mood: clean(raw.mood, 60),
      next_step: clean(raw.next_step, 200)
    };
  } catch (e) {
    console.warn('Call summary failed:', e.message);
    return fallback;
  }
}

// ---------- Caller context ----------

function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise(resolve => { timer = setTimeout(() => resolve(fallback), ms); })
  ]).finally(() => clearTimeout(timer));
}

async function loadCallerContext(deps, phone) {
  const { pool, crm } = deps;
  if (pool && phone) {
    await pool.query(`INSERT INTO users (phone, last_contact) VALUES ($1, NOW())
      ON CONFLICT (phone) DO UPDATE SET last_contact=NOW()`, [phone]).catch(e => console.warn('Caller record failed:', e.message));
  }
  let user = phone && deps.getUser ? await deps.getUser(phone).catch(() => null) : null;
  if (phone && deps.restoreProfile && !user?.name) user = (await withTimeout(deps.restoreProfile(phone), 2500, null)) || user;
  const memory = Boolean(pool && crm && phone);
  const [bookings, upcoming, turns, knowledge] = await Promise.all([
    memory ? crm.bookingHistory(pool, phone).catch(() => []) : [],
    memory ? pool.query(`SELECT service_name, appointment_start, meet_link, status FROM wa_payment_links
      WHERE phone=$1 AND status = ANY($2) AND appointment_start > NOW() - INTERVAL '1 hour'
      ORDER BY appointment_start LIMIT 1`, [phone, crm.PAID_STATUSES]).then(r => r.rows[0] || null).catch(() => null) : null,
    memory ? crm.loadRecentTurns(pool, phone, 12).catch(() => []) : [],
    withTimeout(deps.loadKnowledge ? deps.loadKnowledge() : EMPTY_KNOWLEDGE, 2500, EMPTY_KNOWLEDGE)
  ]);
  return { user: user || { phone }, bookings, upcoming, turns, knowledge };
}

// ---------- Gemini Live ----------

/** Opens a Gemini Live session; the setup message goes first, as the API requires. */
function openGeminiLive(apiKey, setup) {
  const ws = new WebSocket(`${LIVE_URL}?key=${encodeURIComponent(apiKey)}`);
  const live = new EventEmitter();
  ws.on('open', () => ws.send(JSON.stringify({ setup })));
  ws.on('message', data => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (_) { return; }
    live.emit('message', msg);
  });
  ws.on('error', err => live.emit('error', err));
  ws.on('close', (code, reason) => live.emit('close', code, String(reason || '')));
  live.send = msg => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };
  live.close = () => { try { ws.close(); } catch (_) { /* already closed */ } };
  return live;
}

// ---------- One phone call ----------

class CallSession {
  constructor(exotel, deps) {
    this.exotel = exotel;
    this.deps = deps;
    this.startedAt = Date.now();
    this.callSid = `call_${crypto.randomUUID()}`;
    this.streamSid = '';
    this.phone = '';
    this.rate = 8000;
    this.turns = [];
    this.userText = '';
    this.modelText = '';
    this.live = null;
    this.liveReady = false;
    this.everReady = false;
    this.modelIndex = 0;
    this.resumeHandle = null;
    this.reconnects = 0;
    this.tools = { booking: null, links: [], escalation: null };
    this.reading = null;
    this.readingPromise = null;
    this.ending = false;
    this.hungUp = false;
    this.finished = false;
    this.problem = '';
    this.playbackEndsAt = 0;
    this.timers = [];
    this.frames = new FrameQueue(exotelFrameBytes(this.rate));
  }

  onExotel(msg) {
    switch (msg?.event) {
      case 'start':
        this.begin(msg.start || {}, msg.stream_sid).catch(e => {
          console.error(`Call setup failed: ${e.message}`);
          this.problem = 'Kamala could not start this call. Please call them back.';
          this.hangUp('setup failed');
        });
        break;
      case 'media':
        this.fromCaller(msg.media?.payload);
        break;
      case 'mark':
        if (msg.mark?.name === GOODBYE_MARK) this.hangUp('goodbye played');
        break;
      case 'stop':
        this.finish('caller hung up');
        break;
      default:
        break;
    }
  }

  async begin(start, streamSid) {
    this.streamSid = start.stream_sid || streamSid || '';
    this.callSid = start.call_sid || this.callSid;
    this.rate = Number(start.media_format?.sample_rate) || 8000;
    this.phone = normalizeCallerNumber(start.from);
    this.toGemini = new StreamResampler(this.rate, GEMINI_INPUT_RATE);
    this.frames = new FrameQueue(exotelFrameBytes(this.rate));
    console.log(`📞 Call ${this.callSid} from ${this.phone ? `+${this.phone}` : 'a hidden number'} (${this.rate} Hz)`);

    const maxMinutes = Math.max(2, Number(this.deps.maxCallMinutes) || 15);
    this.timers.push(
      setTimeout(() => this.sendLive({ realtimeInput: { text: WRAP_UP_CUE } }), (maxMinutes - 1) * 60 * 1000),
      setTimeout(() => this.hangUp('time limit'), maxMinutes * 60 * 1000)
    );

    this.context = await loadCallerContext(this.deps, this.phone);
    const { crm } = this.deps;
    const lastTurnAt = this.context.turns.length ? this.context.turns[this.context.turns.length - 1].createdAt : null;
    this.prompt = buildCallPrompt({
      now: istNow(),
      callerPhone: this.phone,
      user: this.context.user,
      upcoming: this.context.upcoming,
      turns: this.context.turns,
      knowledge: this.context.knowledge,
      profileBlock: crm ? crm.profileContext(this.context.user, this.context.bookings, lastTurnAt) : '',
      readingBlock: crm ? crm.readingContext(this.context.user) : '',
      services: this.deps.servicesContext ? this.deps.servicesContext() : '',
      businessWhatsApp: this.deps.businessWhatsApp,
      gatewayTest: this.deps.gatewayTest
    });
    if (!this.finished) this.connectLive();
  }

  connectLive() {
    const setup = {
      model: `models/${LIVE_MODELS[this.modelIndex]}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        temperature: 0.7,
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOICE } } }
      },
      systemInstruction: { parts: [{ text: this.prompt }] },
      tools: CALL_TOOLS,
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: this.resumeHandle ? { handle: this.resumeHandle } : {}
    };
    const live = (this.deps.openLive || openGeminiLive)(this.deps.apiKey, setup);
    this.live = live;
    this.liveReady = false;
    live.on('message', msg => this.onLive(live, msg));
    live.on('error', e => console.error(`Gemini Live error on ${this.callSid}:`, e.message));
    live.on('close', (code, reason) => this.onLiveClosed(live, code, reason));
  }

  onLiveClosed(live, code, reason) {
    if (live !== this.live || this.finished) return;
    this.live = null;
    this.liveReady = false;
    if (!this.everReady && this.modelIndex < LIVE_MODELS.length - 1) {
      console.warn(`Gemini Live ${LIVE_MODELS[this.modelIndex]} closed before setup (${code} ${reason}); trying ${LIVE_MODELS[this.modelIndex + 1]}.`);
      this.modelIndex++;
      this.connectLive();
      return;
    }
    if (this.everReady && this.resumeHandle && this.reconnects < 3 && !this.ending) {
      this.reconnects++;
      console.log(`Gemini Live resuming ${this.callSid} (${code} ${reason})`);
      this.connectLive();
      return;
    }
    console.error(`Gemini Live closed for ${this.callSid}: ${code} ${reason}`);
    if (!this.ending) this.problem = `Kamala's voice connection dropped (${code}${reason ? ` ${reason}` : ''}). Please call them back.`;
    this.hangUp('voice connection closed');
  }

  onLive(live, msg) {
    if (live !== this.live || this.finished) return;
    if (msg.setupComplete) {
      this.liveReady = true;
      if (!this.everReady) {
        this.everReady = true;
        console.log(`🎙️ ${this.callSid} connected to ${LIVE_MODELS[this.modelIndex]}`);
        this.sendLive({ realtimeInput: { text: OPENING_CUE } });
      }
      return;
    }
    const update = msg.sessionResumptionUpdate;
    if (update?.resumable && update.newHandle) this.resumeHandle = update.newHandle;
    if (msg.goAway) console.log(`Gemini Live goAway on ${this.callSid}: ${msg.goAway.timeLeft || ''}`);
    if (msg.toolCall?.functionCalls?.length) this.runTools(msg.toolCall.functionCalls);

    const content = msg.serverContent;
    if (!content) return;
    if (content.inputTranscription?.text) {
      if (this.modelText) this.commit('model');
      this.userText += content.inputTranscription.text;
    }
    if (content.outputTranscription?.text) {
      if (this.userText) this.commit('user');
      this.modelText += content.outputTranscription.text;
    }
    if (content.interrupted) {
      this.frames.clear();
      this.playbackEndsAt = Date.now();
      this.sendExotel({ event: 'clear', stream_sid: this.streamSid });
      this.commit('model');
    }
    for (const part of content.modelTurn?.parts || []) {
      if (part.inlineData?.data && /audio/i.test(part.inlineData.mimeType || 'audio')) this.toCaller(part.inlineData);
    }
    if (content.turnComplete) {
      this.commit('user');
      this.commit('model');
      const tail = this.frames.flush();
      if (tail) this.sendAudio(tail);
      if (this.ending) this.afterEndingTurn();
    }
  }

  fromCaller(payload) {
    // Audio before Gemini is ready is dropped so the greeting always comes first.
    if (!payload || !this.toGemini || !this.liveReady) return;
    const pcm = this.toGemini.push(pcmFromBase64(payload));
    this.sendLive({ realtimeInput: { audio: { data: pcmToBuffer(pcm).toString('base64'), mimeType: `audio/pcm;rate=${GEMINI_INPUT_RATE}` } } });
  }

  toCaller(inline) {
    const rate = Number((String(inline.mimeType || '').match(/rate=(\d+)/) || [])[1]) || GEMINI_OUTPUT_RATE;
    if (!this.fromGemini || this.fromGeminiRate !== rate) {
      this.fromGemini = new StreamResampler(rate, this.rate);
      this.fromGeminiRate = rate;
    }
    const pcm = this.fromGemini.push(pcmFromBase64(inline.data));
    for (const frame of this.frames.push(pcmToBuffer(pcm))) this.sendAudio(frame);
  }

  sendAudio(frame) {
    const ms = (frame.length / 2 / this.rate) * 1000;
    this.playbackEndsAt = Math.max(this.playbackEndsAt, Date.now()) + ms;
    if (this.ending) this.spokeSinceEnding = true;
    this.sendExotel({ event: 'media', stream_sid: this.streamSid, media: { payload: frame.toString('base64') } });
  }

  sendExotel(msg) {
    if (this.exotel.readyState === WebSocket.OPEN) this.exotel.send(JSON.stringify(msg));
  }

  sendLive(msg) {
    if (this.live && this.liveReady) this.live.send(msg);
  }

  commit(role) {
    const key = role === 'user' ? 'userText' : 'modelText';
    const text = this[key].replace(/\s+/g, ' ').trim();
    this[key] = '';
    if (!text) return;
    this.turns.push({ role, text });
    if (role === 'user') {
      const spoken = this.turns.filter(t => t.role === 'user').length;
      if (spoken >= 2 && spoken <= 8 && spoken % 2 === 0) this.refreshReading();
    }
  }

  // ----- tools -----

  async runTools(calls) {
    const functionResponses = await Promise.all(calls.map(async call => {
      let response;
      try {
        response = await this.tool(call.name, call.args || {});
      } catch (e) {
        console.error(`Call tool ${call.name} failed on ${this.callSid}:`, e.message);
        response = { status: 'error', error: clean(e.message, 300) };
      }
      return { id: call.id, name: call.name, response };
    }));
    this.sendLive({ toolResponse: { functionResponses } });
  }

  tool(name, args) {
    switch (name) {
      case 'find_free_slots': return this.findFreeSlots(args.date);
      case 'create_booking_and_send_link': return this.book(args);
      case 'send_service_link': return this.sendServiceLink(args);
      case 'escalate_to_owner': return this.escalate(args);
      case 'read_the_person': return this.readPerson();
      case 'end_call':
        this.ending = true;
        return { status: 'ok', next: 'If you have not said goodbye yet, say one short warm goodbye line now. The call ends right after.' };
      default:
        return { status: 'error', error: `Unknown tool ${name}` };
    }
  }

  async findFreeSlots(date) {
    const day = clean(date, 10);
    const slots = candidateSlots(day, new Date());
    if (!slots.length) {
      return { status: 'none', message: 'No consultation time left on that date. Hours: Monday-Friday 7:30-10:30 PM, Saturday-Sunday 10 AM-8 PM, India time.' };
    }
    let free = slots;
    let checked = false;
    if (this.deps.postAppsScript) {
      try {
        const result = await this.deps.postAppsScript({ target: 'calendar_free_slots', date: day, slots }, { timeoutMs: 8000, maxAttempts: 1 });
        if (Array.isArray(result.free)) {
          free = slots.filter(s => result.free.includes(s));
          checked = true;
        }
      } catch (e) {
        console.warn('Free-slot check unavailable:', e.message);
      }
    }
    return {
      status: free.length ? 'ok' : 'full',
      free_slots: free.map(start => ({ start, spoken: spokenTime(start) })),
      calendar_checked: checked,
      ...(checked ? {} : { note: 'Calendar was not checked; the slot is confirmed only when the booking link is created.' })
    };
  }

  whatsappNumber(raw) {
    return normalizeCallerNumber(raw) || this.phone;
  }

  async book(args) {
    if (this.tools.booking) return { status: 'already_sent', whatsapp_number: `+${this.tools.booking.whatsapp}` };
    const whatsapp = this.whatsappNumber(args.whatsapp_number);
    if (!whatsapp) return { status: 'error', error: 'No WhatsApp number. Ask for their 10-digit WhatsApp number and read it back.' };
    if (!this.deps.createCallBooking) return { status: 'error', error: 'Booking by phone is not set up. Offer a call back instead.' };
    const result = await this.deps.createCallBooking({ callerPhone: this.phone, whatsappPhone: whatsapp, args, callSid: this.callSid });
    this.tools.booking = { ...result, whatsapp, name: args.customer_name || '' };
    if (result.status === 'awaiting_hi') {
      return { status: 'awaiting_hi', whatsapp_number: `+${whatsapp}`, next: 'WhatsApp lets us message this number only after they message us. Ask them to send "Hi" on WhatsApp; the payment link and invoice go out right after.' };
    }
    return { status: 'sent', whatsapp_number: `+${whatsapp}`, service: result.serviceName, appointment: result.appointmentDate };
  }

  async sendServiceLink(args) {
    const whatsapp = this.whatsappNumber(args.whatsapp_number);
    if (!whatsapp) return { status: 'error', error: 'No WhatsApp number. Ask for their 10-digit WhatsApp number and read it back.' };
    if (!this.deps.sendServiceLink) return { status: 'error', error: 'Sending links is not set up.' };
    const result = await this.deps.sendServiceLink({ phone: whatsapp, serviceName: args.service_name });
    this.tools.links.push({ ...result, whatsapp });
    return result.status === 'awaiting_hi'
      ? { status: 'awaiting_hi', next: 'Ask them to send "Hi" on WhatsApp; the link goes out right after.' }
      : { status: 'sent', service: result.serviceName, whatsapp_number: `+${whatsapp}` };
  }

  async escalate(args) {
    if (this.tools.escalation) return { status: 'already_alerted', next: `Say: "${ESCALATION_LINE}"` };
    const alert = {
      name: clean(args.caller_name, 60) || this.context?.user?.name || '',
      phone: this.phone,
      queryType: normalizeQueryType(args.query_type),
      summary: clean(args.summary || args.reason, 400)
    };
    this.tools.escalation = { ...alert, reason: clean(args.reason, 300), at: new Date() };
    if (this.deps.notifyOwner) await this.deps.notifyOwner(formatCallbackAlert(alert), `Callback needed: ${alert.name || (alert.phone ? `+${alert.phone}` : 'caller')}`);
    return { status: 'owner_alerted', next: `Say: "${ESCALATION_LINE}" Then close warmly and call end_call.` };
  }

  refreshReading() {
    const { genAI, SchemaType, modelName, crm } = this.deps;
    if (this.readingPromise) return this.readingPromise;
    if (!genAI || !crm) return Promise.resolve(this.reading);
    const turns = this.turns.map(t => ({ role: t.role, parts: [{ text: t.text }] }));
    this.readingPromise = crm.analyzeEmotion(genAI, SchemaType, modelName, turns)
      .then(reading => { if (reading) this.reading = reading; return this.reading; })
      .catch(e => { console.warn('Call reading failed:', e.message); return this.reading; })
      .finally(() => { this.readingPromise = null; });
    return this.readingPromise;
  }

  async readPerson() {
    const reading = await withTimeout(this.refreshReading(), 4000, this.reading);
    if (!reading || reading.category === 'unclear' || reading.confidence === 'low') {
      return { status: 'not_clear_yet', next: 'Keep listening warmly. With one soft question find out if it is more about family/marriage or work/money, and for how long.' };
    }
    return {
      status: 'ok',
      about: reading.category === 'marriage_family' ? 'marriage/family' : reading.category === 'career_business' ? 'career/business' : 'other',
      detail: reading.subtype,
      money_pressure: reading.money_pressure,
      feeling: reading.emotion,
      intensity: reading.intensity,
      worry_underneath: reading.core_concern,
      question_in_their_heart: reading.unspoken_question,
      confidence: reading.confidence,
      next: reading.intensity === 'high'
        ? 'Their feelings are strong: comfort first and slow down; do not sell in your next reply.'
        : 'Once, at a natural moment, gently name the feeling and the worry as a soft question.'
    };
  }

  // ----- ending -----

  /** end_call was requested: hang up after the goodbye, or shortly if she already said it before the tool call. */
  afterEndingTurn() {
    if (this.spokeSinceEnding) return this.sayGoodbye();
    if (!this.silentEndTimer) {
      this.silentEndTimer = setTimeout(() => this.sayGoodbye(), 4000);
      this.timers.push(this.silentEndTimer);
    }
  }

  sayGoodbye() {
    if (this.goodbyeTimer) return;
    this.sendExotel({ event: 'mark', stream_sid: this.streamSid, mark: { name: GOODBYE_MARK } });
    // Exotel echoes the mark once the goodbye has played; hang up anyway if it never does.
    const wait = Math.max(0, this.playbackEndsAt - Date.now()) + 1500;
    this.goodbyeTimer = setTimeout(() => this.hangUp('goodbye timeout'), Math.min(wait, 20000));
    this.timers.push(this.goodbyeTimer);
  }

  hangUp(reason) {
    if (this.hungUp) return;
    this.hungUp = true;
    this.finish(reason);
    try { this.exotel.close(1000, 'call ended'); } catch (_) { /* already closed */ }
  }

  finish(reason) {
    if (this.finished) return this.wrapUp;
    this.finished = true;
    this.timers.forEach(clearTimeout);
    if (this.live) {
      const live = this.live;
      this.live = null;
      live.close();
    }
    this.commit('user');
    this.commit('model');
    this.wrapUp = wrapUpCall(this, reason).catch(e => console.error(`Call wrap-up failed for ${this.callSid}:`, e.message));
    return this.wrapUp;
  }
}

/** After the call: owner summary, Phone Queries row, calls table, [Call] turns, profile and reading. */
async function wrapUpCall(session, reason) {
  const { deps, phone } = session;
  const { pool, crm } = deps;
  const seconds = Math.round((Date.now() - session.startedAt) / 1000);
  const transcript = session.turns.map(t => `${t.role === 'user' ? 'Caller' : 'Kamala'}: ${t.text}`).join('\n');
  const spoke = session.turns.some(t => t.role === 'user');
  const summary = await summarizeCall(deps, spoke ? transcript : '');
  const user = session.context?.user || {};
  const name = summary.caller_name || user.name || session.tools.booking?.name || session.tools.escalation?.name || '';
  const outcome = callOutcome(session);
  const escalation = session.tools.escalation;
  const callbackDue = escalation ? new Date(escalation.at.getTime() + 24 * 60 * 60 * 1000) : null;
  const queryType = escalation?.queryType && summary.query_type === 'Other' ? escalation.queryType : summary.query_type;
  const mood = session.reading?.emotion || summary.mood;
  const whatsappPhone = session.tools.booking?.whatsapp || session.tools.links[0]?.whatsapp || '';
  console.log(`📴 Call ${session.callSid} ended (${reason}) after ${seconds}s: ${outcome}`);

  if (deps.notifyOwner) {
    await deps.notifyOwner(formatCallSummary({
      name, phone, seconds, queryType, mood, outcome,
      summary: summary.summary, nextStep: summary.next_step, problem: session.problem
    }), `Call from ${name || (phone ? `+${phone}` : 'hidden number')}`).catch(e => console.error('Call summary alert failed:', e.message));
  }

  if (deps.postAppsScript) {
    await deps.postAppsScript({
      target: 'phone_query',
      date: istNow(new Date(session.startedAt)),
      name,
      phone: phone ? `+${phone}` : 'Hidden',
      customerId: crm?.isNewCustomerId(user.customer_id) ? user.customer_id : '',
      query: queryType,
      summary: summary.summary,
      mood,
      outcome,
      callbackDue: callbackDue ? istNow(callbackDue) : '',
      status: callbackDue ? 'Callback pending' : 'Closed',
      whatsapp: whatsappPhone ? `+${whatsappPhone}` : '',
      durationSeconds: seconds,
      callSid: session.callSid
    }, { timeoutMs: 20000, maxAttempts: 2 }).catch(e => console.error('Phone Queries sheet update failed:', e.message));
  }

  if (!pool) return;
  await pool.query(`INSERT INTO calls (call_sid, phone, whatsapp_phone, started_at, duration_seconds, caller_name, query_type,
      mood, outcome, summary, next_step, callback_due, status, end_reason, transcript)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT (call_sid) DO NOTHING`,
  [session.callSid, phone || null, whatsappPhone || null, new Date(session.startedAt), seconds, name, queryType, mood, outcome,
    summary.summary, summary.next_step, callbackDue, callbackDue ? 'callback_pending' : 'closed', reason, transcript.slice(0, 20000)])
    .catch(e => console.error('Call record failed:', e.message));

  if (!phone || !spoke || !crm) return;
  for (const t of session.turns) await crm.saveTurn(pool, phone, t.role, `[Call] ${t.text}`).catch(() => {});
  if (deps.forgetChat) deps.forgetChat(phone);
  if (!deps.genAI) return;
  try {
    const callerWords = session.turns.filter(t => t.role === 'user').map(t => t.text).join(' ').slice(-1500);
    const details = await crm.extractProfileDetails(deps.genAI, deps.SchemaType, deps.modelName, callerWords, 'Phone call with Kamala (everything the caller said)');
    await crm.applyProfileDetails(pool, phone, details);
    const reading = session.reading || await crm.analyzeEmotion(deps.genAI, deps.SchemaType, deps.modelName,
      session.turns.map(t => ({ role: t.role, parts: [{ text: t.text }] })));
    await crm.applyReading(pool, phone, reading);
    if (deps.postAppsScript && deps.getUser) {
      await deps.postAppsScript(crm.profilePayload(await deps.getUser(phone), { source: 'Phone call' }), { timeoutMs: 20000, maxAttempts: 2 });
    }
  } catch (e) {
    console.warn('Caller profile update after call failed:', e.message);
  }
}

// ---------- Server wiring ----------

async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS calls (
      call_sid TEXT PRIMARY KEY,
      phone TEXT,
      whatsapp_phone TEXT,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      duration_seconds INTEGER,
      caller_name TEXT,
      query_type TEXT,
      mood TEXT,
      outcome TEXT,
      summary TEXT,
      next_step TEXT,
      callback_due TIMESTAMPTZ,
      status TEXT,
      end_reason TEXT,
      transcript TEXT
    );
    CREATE INDEX IF NOT EXISTS calls_phone_idx ON calls (phone, started_at DESC);
    CREATE TABLE IF NOT EXISTS voice_pending_messages (
      id BIGSERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      media_id TEXT,
      filename TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      sent_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS voice_pending_phone_idx ON voice_pending_messages (phone) WHERE sent_at IS NULL;
  `);
}

function refuseUpgrade(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

/** Accepts Exotel's Voicebot WebSocket on /voice/exotel and runs one CallSession per call. */
function attach(server, deps) {
  const enabled = Boolean(deps.apiKey && deps.token);
  if (!enabled) console.warn('⚠️ Phone Kamala is off: set GEMINI_API_KEY and VOICE_STREAM_TOKEN to answer calls.');
  const maxCalls = Math.max(1, Number(deps.maxConcurrentCalls) || 10);
  const active = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost');
    if (url.pathname !== STREAM_PATH) return refuseUpgrade(socket, 404, 'Not Found');
    if (!enabled) return refuseUpgrade(socket, 503, 'Service Unavailable');
    if (!tokensMatch(deps.token, url.searchParams.get('token'))) {
      console.warn('Voice stream refused: wrong or missing token.');
      return refuseUpgrade(socket, 401, 'Unauthorized');
    }
    if (active.size >= maxCalls) {
      console.warn(`Voice stream refused: ${active.size} calls already active.`);
      return refuseUpgrade(socket, 503, 'Service Unavailable');
    }
    wss.handleUpgrade(req, socket, head, ws => {
      const session = new CallSession(ws, deps);
      active.add(session);
      ws.on('message', data => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (_) { return; }
        session.onExotel(msg);
      });
      ws.on('error', e => console.error('Exotel stream error:', e.message));
      ws.on('close', () => {
        active.delete(session);
        session.finish('stream closed');
      });
    });
  });

  return { enabled, path: STREAM_PATH, activeCalls: () => active.size };
}

module.exports = {
  STREAM_PATH,
  LIVE_MODELS,
  GREETING,
  ROBOT_ANSWER,
  ESCALATION_LINE,
  CALL_TOOLS,
  normalizeCallerNumber,
  pcmFromBase64,
  pcmToBuffer,
  StreamResampler,
  FrameQueue,
  exotelFrameBytes,
  candidateSlots,
  cleanKnowledge,
  knowledgeLoader,
  buildCallPrompt,
  formatCallbackAlert,
  formatCallSummary,
  callOutcome,
  CallSession,
  migrate,
  attach
};
