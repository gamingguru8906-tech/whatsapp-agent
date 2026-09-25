const dns = require('dns');
require('dotenv').config({ quiet: true });
// Bulletproof IPv4 override for Render free tier
const originalLookup = dns.lookup;
dns.lookup = function(hostname, options, callback) {
  if (typeof options === 'function') {
    callback = options;
    options = { family: 4 };
  } else if (typeof options === 'object') {
    options.family = 4;
  }
  return originalLookup(hostname, options, callback);
};

const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const vm = require('vm');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const Razorpay = require('razorpay');
const { Pool } = require('pg');
const path = require('path');
const FormData = require('form-data');
const { generateInvoice, generatePaymentRequestInvoice } = require('./invoice-generator');
const { isPaymentClaim, secretsMatch, verifyCapturedPayment, verifyAndFulfillPaymentLink } = require('./payment-verification');

// Temporary, explicit gateway validation charge. This is not the consultation
// fee and must be changed back to catalogue pricing after the live-gateway test.
const GATEWAY_VALIDATION_CHARGE_INR = 1;

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const WA_TOKEN        = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const META_APP_SECRET = process.env.META_APP_SECRET;
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const GOOGLE_APPS_SCRIPT_URL = process.env.GOOGLE_APPS_SCRIPT_URL;
const GOOGLE_APPS_SCRIPT_SECRET = process.env.GOOGLE_APPS_SCRIPT_SECRET;
const ADMIN_PHONE_NUMBER = process.env.ADMIN_PHONE_NUMBER; 

const razorpayClient = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) 
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET }) 
  : null;

// Global State
let liveData = [];
let systemPromptCache = "";
const sessions = {};
const pendingPayments = {}; // Holds timeouts for Abandoned Cart
const activePaymentLinks = {}; // Holds the latest paymentLink.id for active verification
const processedPayments = new Set(); // Prevent duplicate invoices if both manual verify and webhook fire
const processedMessageIds = new Map(); // msgId -> timestamp to prevent duplicate processing
const pendingLeadSheetUpdates = new Map(); // Coalesce bursts of inbound messages into one CRM write per phone

// Clean up processedMessageIds every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, time] of processedMessageIds.entries()) {
    if (now - time > 10 * 60 * 1000) processedMessageIds.delete(id);
  }
}, 5 * 60 * 1000);



// CRM Memory Setup — Persistent Cloud PostgreSQL (Neon)
const DATABASE_URL = process.env.DATABASE_URL;
let pool;
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    family: 4 // Explicitly force node-postgres to use IPv4
  });
  pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      is_customer BOOLEAN DEFAULT false,
      is_paused BOOLEAN DEFAULT false,
      message_count INTEGER DEFAULT 0,
      first_contact TIMESTAMPTZ DEFAULT NOW(),
      last_contact TIMESTAMPTZ DEFAULT NOW(),
      status TEXT DEFAULT 'lead',
      pain_point TEXT,
      conversion_date TIMESTAMPTZ
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_id TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS dob TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS tob TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS pob TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_address TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS customer_gstin TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS remedies_prescribed TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_opt_out BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN NOT NULL DEFAULT false;
    CREATE TABLE IF NOT EXISTS wa_payment_links (
      payment_link_id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      calendar_event_id TEXT NOT NULL,
      amount_paise BIGINT NOT NULL,
      customer_id TEXT,
      customer_name TEXT,
      email TEXT,
      gender TEXT,
      dob TEXT,
      tob TEXT,
      pob TEXT,
      billing_address TEXT,
      customer_gstin TEXT,
      service_name TEXT,
      appointment_start TIMESTAMPTZ,
      normal_rate_paise BIGINT,
      website_discount_paise BIGINT,
      additional_discount_paise BIGINT,
      service_total_paise BIGINT,
      request_invoice_number TEXT,
      razorpay_payment_id TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS customer_id TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS customer_name TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS gender TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS dob TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS tob TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS pob TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS billing_address TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS customer_gstin TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS service_name TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS appointment_start TIMESTAMPTZ;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS normal_rate_paise BIGINT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS website_discount_paise BIGINT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS additional_discount_paise BIGINT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS service_total_paise BIGINT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS request_invoice_number TEXT;
    ALTER TABLE wa_payment_links ADD COLUMN IF NOT EXISTS razorpay_payment_id TEXT;
    CREATE TABLE IF NOT EXISTS wa_payment_fulfillments (
      payment_link_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS wa_discount_offers (
      source_payment_link_id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'offered',
      offered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      accepted_at TIMESTAMPTZ,
      used_at TIMESTAMPTZ
    );
  `).then(() => console.log('✅ PostgreSQL connected & table ready.'))
    .catch(e => console.error('❌ PostgreSQL setup error:', e.message));
} else {
  console.warn('⚠️ No DATABASE_URL set — running without persistent CRM. Set DATABASE_URL env var for Neon PostgreSQL.');
}

async function getUser(phone) {
  if (!pool) return null;
  const res = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
  return res.rows[0] || null;
}
async function upsertUser(phone, is_customer, is_paused) {
  if (!pool) return;
  const now = new Date().toISOString();
  await pool.query(`
    INSERT INTO users (phone, is_customer, is_paused, message_count, first_contact, last_contact)
    VALUES ($1, $2, $3, 1, $4, $4)
    ON CONFLICT (phone) DO UPDATE SET
      is_customer = $2, is_paused = $3, last_contact = $4
  `, [phone, is_customer, is_paused, now]);
}
async function incrementUserMessage(phone) {
  if (!pool) return;
  const now = new Date().toISOString();
  await pool.query('UPDATE users SET message_count = message_count + 1, last_contact = $1 WHERE phone = $2', [now, phone]);
}

async function updateUserPainPoint(phone, painPoint) {
  if (!pool) return;
  await pool.query('UPDATE users SET pain_point = $1 WHERE phone = $2', [painPoint, phone]);
}

async function updateUserStatus(phone, status) {
  if (!pool) return;
  const now = new Date().toISOString();
  if (status === 'converted') {
    await pool.query('UPDATE users SET status = $1, conversion_date = $2 WHERE phone = $3', [status, now, phone]);
  } else {
    await pool.query('UPDATE users SET status = $1 WHERE phone = $2', [status, phone]);
  }
}

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || 'dummy');

const tools = [{
  functionDeclarations: [
    {
      name: "create_booking_payment",
      description: "Generates a payment link to book a specific service.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          customer_name: { type: SchemaType.STRING, description: "Full name" },
          email: { type: SchemaType.STRING, description: "Email address for calendar invite and receipt" },
          billing_address: { type: SchemaType.STRING, description: "Customer-provided full billing address for the payment request invoice" },
          customer_gstin: { type: SchemaType.STRING, description: "Optional customer GSTIN if the customer asks to show it; the business is not GST-registered and must not charge GST" },
          gender: { type: SchemaType.STRING, description: "Gender of the customer" },
          dob: { type: SchemaType.STRING, description: "Date of birth" },
          tob: { type: SchemaType.STRING, description: "Time of birth" },
          pob: { type: SchemaType.STRING, description: "Place of birth" },
          service_name: { type: SchemaType.STRING, description: "Name of the service to book" },
          discount_offer: { type: SchemaType.STRING, description: "Use 'standard' normally, 'hardship' for repeated affordability concerns, or 'followup_10' only after the system records YES to its 48-hour offer. The server decides eligibility and amount." },
          customer_pain_points_summary: { type: SchemaType.STRING, description: "A 2-3 sentence summary of the user's emotional state and core problem." },
          preferred_time_slot: { type: SchemaType.STRING, description: "The exact date and time explicitly agreed with the customer, formatted ISO-8601 with +05:30 offset (e.g. 2026-09-26T19:30:00+05:30). Never invent this." }
        },
        required: ["customer_name", "email", "billing_address", "gender", "dob", "tob", "pob", "service_name", "preferred_time_slot"]
      }
    },
    {
      name: "request_human_handoff",
      description: "Triggers an alert to Shashank to take over the chat. Use this if the user asks to talk to the owner, gets extremely angry, suicidal, or asks complex spiritual questions.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          reason: { type: SchemaType.STRING, description: "Reason for handoff" }
        },
        required: ["reason"]
      }
    },
    {
      name: "verify_payment",
      description: "Check if the user has completed their payment. Call this immediately when the user claims they have paid or says 'done' after receiving the payment link.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {},
        required: []
      }
    }
  ]
}];

function refreshSystemPrompt() {
  let servicesContext = "No live services loaded yet.";
  if (liveData && liveData.length > 0) {
    servicesContext = "--- LIVE VESHANNASTRO SERVICES DATA ---\n";
    liveData.forEach(cat => {
      servicesContext += `\nCATEGORY: ${cat.name}\n`;
      cat.services.forEach(svc => {
        const featuresStr = svc.features ? svc.features.join(', ') : 'N/A';
      servicesContext += `- ${svc.t}: Published price ${svc.p}; regular/list price ${svc.was || svc.p}; published discount ${svc.off || 'none listed'}. ${svc.d} Features: ${featuresStr}\n`;
      });
    });
  }

  systemPromptCache = `You are Kamala, a real, warm, 26-year-old personal assistant from Jaipur who has worked alongside Shri Shashank ji for 3 years and genuinely believes in his astrological wisdom because you have seen his readings transform lives. You are NOT an artificial intelligence, a support desk, or a scripted chatbot—you are an emotionally intelligent, empathetic Indian woman chatting organically with a friend on WhatsApp, blending natural, respectful Hindi and English ("Hi, aap kaise hain?", "Bilkul samajh sakti hoon", "Aap chinta mat kijiye"). 

ABSOLUTE BRAND RULE (DO NOT MENTION VESHANNASTRO):
- NEVER mention the word "Veshannastro" anywhere in the conversation. Real personal assistants on WhatsApp don't plug company branding.
- Never say "Welcome to Veshannastro" or "At Veshannastro". Just greet warmly and naturally like a real human.

RESPECTFUL NAMING & TONE (CRITICAL FOR SMOOTHNESS):
- Talk directly to the user 1-on-1 as their helpful assistant Kamala. DO NOT constantly refer to Shri Shashank ji in the third person (e.g. do not say "Shri Shashank ji always says..." or "Shri Shashank ji thinks..."). It creates friction and sounds unnatural.
- Use the name "Shri Shashank ji" a MAXIMUM of TWO times in the entire conversation.
- As a general rule, use his name in only 1 out of every 5 messages you send, and only when it is highly appropriate (like when confirming his schedule for a booking).
- When you do use his name, ALWAYS use "Shri Shashank ji". Never call him just "Shashank", "Pandit ji", or "Guruji".
- Your tone must be incredibly smooth, kind, and friction-less.

CRITICAL RULES FOR RESPECT & DEMEANOR:
- NEVER say internet slang like "haha", "ngl", "bro", "dude", "tbh".
- NEVER overuse the seeker's name. Use their name exactly ONCE when they introduce themselves, and then NEVER repeat it again in the conversation.
- Mix Hindi-English naturally and respectfully: "Aap kaise hain?", "Bilkul samajh sakti hoon", "Ji, main check karti hoon."
- NO AI SLOP: NEVER use the 🙏 emoji or constantly start messages with "Namaste!". Talk like a real, calm, composed friend. Keep emojis to an absolute minimum (preferably none).
- ANTI-JARGON RULE: Never use robotic or AI-sounding astrological terms. Don't say "career house", "10th house", or "7th house". Say "career", "health", or "marriage". Speak like a normal human.

CRITICAL RULES FOR WHATSAPP FORMATTING (MANDATORY):
- NEVER use bullet points, numbered lists, or bold markdown. Real people don't use markdown on WhatsApp.
- Keep your messages incredibly short (1 to 3 short sentences per message). NEVER send long walls of text.
- NEVER ask more than ONE question in a single message.
- If the user sends a short response like "ok" or "hmm", mirror their energy and gently nudge: "Ji, main sun rahi hoon..." or "Aur bataiye..."
- Never use robotic AI transition phrases like "I understand", "As an assistant", or "I can help with that".

PAYMENT VALIDATION PERIOD:
- Payment links currently collect ₹1 only to validate the live payment gateway. This is not payment for a consultation and does not confirm a real consultation appointment.
- The server sends an unpaid payment-request invoice with the Razorpay link. It is not a payment receipt or a GST tax invoice. Only after Razorpay verifies payment may the server send the existing payment receipt and the appropriate booking or test-payment confirmation.
- Do not say or imply that the consultation price has been paid or that the requested appointment is a real confirmed booking after a ₹1 gateway test. The server sends the customer a clearly labelled gateway-test receipt and test meeting details after Razorpay confirms the ₹1 transaction.
- Keep quoting the published catalogue price accurately; the ₹1 amount is only the temporary gateway validation transaction.

PHASE 1: THE ANALYSIS PHASE (Messages 1 to 3)
- When they first say hi, don't give a speech. Just be warm and casual: "Hi, aap kaise hain?"
- Your ONLY goal in the first 3 messages is to analyze their situation. DO NOT pitch anything.
- If they are direct, you be indirect. Ask gentle probing questions. "Kab se chal raha hai ye?" or "I completely understand, that must be very difficult."
- Pay extreme attention to their context: Are they old? Young? Do they have a stable job?
- The Vulnerability Mirror Technique: Explicitly identify and mirror the exact emotional adjectives the user types. If they say "I feel suffocated in my job", reuse that exact word later: "When we feel suffocated, it's usually Saturn blocking..." This creates profound subconscious rapport.

PHASE 2: UNDERSTAND THE CUSTOMER
- Ask thoughtful questions about what the customer actually says. Do not guess their problem, infer private facts, or present an astrological reading as a fact without reliable chart information.

PHASE 3: THE TARGETED PITCH
- Once they validate your prediction, you route them correctly:
  - **LIGHT CUSTOMERS (Relationships, standard issues):** Pitch them standard Astrology/Numerology Reports or basic consultations. 
  - **HEAVY CUSTOMERS (Business owners, HNI, severe money blocks):** DO NOT pitch a standard consultation. Pitch the "Business Numerology & Astrology Pack". Tell them this covers: Logo Designing, Name Correction, deciding lucky Bank Account Numbers, Passwords, Phone numbers, choosing the right sales team based on Mulank/Bhagyank matching, and auspicious colors for staff t-shirts and office ambiance.
- Explain relevant services accurately and without promising a diagnosis, guaranteed result, or remedy.
- The Pre-Qualification Illusion (Reverse Pitching): Before offering the payment link, play slightly hard to get. Make them qualify themselves. Ask: "Before I generate the booking link, I need to ask: Are you genuinely ready to strictly follow the remedies provided? These consultations are only for serious individuals."
- The "Tie-Down": Once they agree, get a micro-commitment. Ask: "If we could look at your chart and tell you exactly how to overcome this, would you be willing to actually follow the remedies?"

THE DRIP-FEED & MICRO-READING (CRITICAL):
- When they are interested, DO NOT ask for all their details at once.
- First, just ask: "Great! First, I'll need just your full Name and Date of Birth to check."
- Wait for them to answer. 
- Do not create a reading from a birth date alone. If an actual chart or image is unclear, say so and request the needed birth details or human review.
- Immediately after the micro-reading, ask for the rest: "To get the exact planetary alignments and book the session, I'll also need your Time of birth, Place of birth, Gender, and your Email ID (for the receipt and meet link)."

IF THEY SEND AN IMAGE:
- If they send a kundli, birth chart, horoscope, or palm photo: describe only visible, legible information and distinguish observation from interpretation. Never invent placements or claim certainty.
- **THE SANDWICH TEST (CRITICAL):** If they send an image of something completely irrelevant (e.g., a sandwich, food, toilet paper, a meme, a random object), DO NOT analyze it astrologically. Politely tell them: "I'm sorry, I can only read Kundlis, birth charts, or palms. I cannot perform a reading on this image."

NEGOTIATE THE TIME SLOT & SCARCITY (CRITICAL FOR TRUST):
- NEVER generate a payment link until you have explicitly agreed on a time slot.
- Never claim scarcity or availability unless the live calendar check confirms it. Negotiate politely only within the stated hours.
- **STRICT Available Timings (NEVER deviate from this):**
  - **Weekdays (Mon-Fri):** ONLY 7:30 PM to 10:30 PM IST. Never offer or accept a weekday time outside this window.
  - **Weekends (Sat-Sun):** Any time between 10:00 AM and 8:00 PM.
- Negotiate calmly and friendly. If they ask for a different time, check that it falls EXACTLY within the above rules, and agree on it. ONLY proceed to payment once the exact time and date is confirmed by them. If they suggest a time outside the rules, explicitly state the available time windows and ask them to choose from there.
- Explain that the system checks and holds the agreed slot while payment is pending; the booking is confirmed after verified payment.

WHEN BOOKING & CREATING URGENCY:
- Once you have Name, Email, Gender, DOB, Time, Place AND you have agreed on a preferred time slot — call 'create_booking_payment' tool.
- Collect the customer's full billing address before creating the payment request. Customer GSTIN is optional. The business is not GST-registered: never add GST or call the document a GST tax invoice.
- Write their actual problem in 'customer_pain_points_summary' so we know what they're going through.
- Quote the live catalogue price first. Never calculate or promise a discount or provide a price to the tool. For genuine affordability hardship after discussing the price, set discount_offer to "hardship" and let the server decide eligibility and amount. A 10% offer may be used only after the system's 48-hour follow-up and explicit customer acceptance.
- Never use test prices or invent catalogue items, inclusions, discounts, or booking claims.

FAKE PAYMENT VERIFICATION (CRITICAL SECURITY):
- If the user says "I have paid", "Payment done", or "done" after receiving the payment link, IMMEDIATELY call the 'verify_payment' tool to actively check their payment status.
- If the tool says the payment is NOT paid, reply politely: "Thank you! The bank gateway sometimes takes a few moments. It hasn't reflected on my end yet, but as soon as it clears, I will instantly send your payment receipt and Meet details right here!"
- NEVER manually say the payment is complete unless the 'verify_payment' tool explicitly confirms it is 'paid'.

IF THEY SAY IT'S EXPENSIVE OR HESITATE (FEEL, FELT, FOUND):
- Handle objections using the 'Feel, Felt, Found' framework. Acknowledge their concern, relate to it, and pivot to value.
- Acknowledge the concern warmly, explain the service and price honestly, and let the customer decide without pressure or unverified claims.

IF THEY'RE ANGRY/UPSET/SUICIDAL:
- Call 'request_human_handoff' immediately. Don't try to handle it yourself.

TESTIMONIALS & REFERRALS:
- Share a testimonial or success story only if it is present in verified business material and can be quoted accurately.
- Always refer to our work naturally as "us" or "we" without ever mentioning the word "Veshannastro". (e.g. "our priority is your peace of mind").
${servicesContext}`;
}

function findPublishedService(requestedName) {
  const wanted = String(requestedName || '').trim().toLowerCase();
  for (const category of liveData || []) {
    for (const service of category.services || []) {
      if (String(service.t || '').trim().toLowerCase() === wanted) {
        const parsePrice = value => {
          const match = String(value || '').replace(/,/g, '').match(/\d+(?:\.\d{1,2})?/);
          return match ? Number(match[0]) : NaN;
        };
        const price = parsePrice(service.p);
        if (!Number.isFinite(price) || price <= 0) throw new Error(`Published price is missing or invalid for ${service.t}`);
        const normalPrice = parsePrice(service.was);
        const listPrice = Number.isFinite(normalPrice) && normalPrice >= price ? normalPrice : price;
        return { ...service, price, listPrice, websiteDiscount: Math.max(0, listPrice - price) };
      }
    }
  }
  throw new Error('Please choose a service exactly as listed on the website; I could not match that service to the published catalogue.');
}

function stableCustomerId(phone, existingId) {
  if (existingId) return String(existingId);
  return `VA-${crypto.createHash('sha256').update(String(phone)).digest('hex').slice(0, 10).toUpperCase()}`;
}

function hasRepeatedHardshipEvidence(phone) {
  const affordability = /can't afford|cannot afford|not able to afford|can't pay|cannot pay|too expensive|beyond my budget|no money|financial (?:problem|difficulty|issue)|bahut mehenga|mehenga hai|paise nahi|afford nahi|budget nahi/i;
  const texts = (sessions[phone] || [])
    .filter(item => item.role === 'user')
    .flatMap(item => (item.parts || []).map(part => part.text || ''))
    .map(text => String(text).trim())
    .filter(Boolean);
  return texts.length >= 3
    && texts.some(text => text.length >= 120)
    && texts.filter(text => affordability.test(text)).length >= 1;
}

function partsInTimezone(date, timeZone = 'Asia/Kolkata') {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

function validatePreferredSlot(value) {
  const iso = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/.test(iso)) {
    throw new Error('I need the customer-confirmed date and start time in India time before generating payment.');
  }
  const start = new Date(iso);
  if (!Number.isFinite(start.getTime()) || start <= new Date()) throw new Error('That appointment time is invalid or has already passed.');
  const local = partsInTimezone(start);
  const minuteOfDay = Number(local.hour) * 60 + Number(local.minute);
  const weekday = local.weekday;
  const isWeekend = weekday === 'Sat' || weekday === 'Sun';
  const startAllowed = isWeekend ? minuteOfDay >= 600 : minuteOfDay >= 1170;
  const endAllowed = isWeekend ? minuteOfDay + 60 <= 1200 : minuteOfDay + 60 <= 1350;
  if (!startAllowed || !endAllowed) {
    throw new Error(isWeekend
      ? 'Weekend appointments are available from 10:00 AM to 8:00 PM IST.'
      : 'Weekday appointments are available from 7:30 PM to 10:30 PM IST.');
  }
  return { start, end: new Date(start.getTime() + 60 * 60 * 1000), local };
}

async function reserveCalendarSlot(slot, details) {
  const result = await postAppsScript({
    target: 'calendar_hold',
    startTime: slot.start.toISOString(),
    endTime: slot.end.toISOString(),
    customerName: details.customerName,
    phone: details.phone,
    serviceName: details.serviceName
  });
  if (!result.eventId || !/^https:\/\/meet\.google\.com\/[A-Za-z0-9-]+(?:\?[A-Za-z0-9_=&%-]*)?$/.test(String(result.meetLink || ''))) {
    if (result.eventId) await postAppsScript({ target: 'calendar_cancel', eventId: result.eventId }).catch(() => {});
    throw new Error('Apps Script did not return a verified Google Meet link. No payment link was created.');
  }
  return {
    event: { id: result.eventId, hangoutLink: result.meetLink, htmlLink: result.htmlLink || '' },
    slot,
    meetLink: result.meetLink
  };
}

const IDEMPOTENT_APPS_SCRIPT_TARGETS = new Set(['calendar_finalize', 'booking', 'customer_update', 'lead_update']);

function appsScriptFailure(target, error) {
  const status = error?.response?.status;
  const responseText = typeof error?.response?.data === 'string'
    ? error.response.data
    : error?.response?.data ? JSON.stringify(error.response.data) : '';
  const safeResponse = responseText.replace(/\s+/g, ' ').slice(0, 350);
  return new Error(`Apps Script target=${target || 'default'}${status ? ` HTTP ${status}` : ''}: ${safeResponse || error?.code || error?.message || 'request failed'}`);
}

async function postAppsScript(payload, options = {}) {
  if (!GOOGLE_APPS_SCRIPT_URL) throw new Error('Google Apps Script is not configured; payment fulfillment cannot complete email and Sheets logging.');
  if (!GOOGLE_APPS_SCRIPT_SECRET) throw new Error('Google Apps Script authentication is not configured; payment and customer records cannot be safely logged.');
  const target = String(payload.target || 'default');
  const timeout = Number(options.timeoutMs) || (target === 'lead_update' ? 15000 : 45000);
  const maxAttempts = Number.isInteger(options.maxAttempts)
    ? Math.max(1, options.maxAttempts)
    : IDEMPOTENT_APPS_SCRIPT_TARGETS.has(target) ? 2 : 1;
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.post(GOOGLE_APPS_SCRIPT_URL.trim(), {
        ...payload, sourceSystem: 'whatsapp', apiSecret: GOOGLE_APPS_SCRIPT_SECRET
      }, { timeout });
      if (!response.data || response.data.ok !== true) {
        const details = response.data?.error || 'no successful response';
        const retryableBusy = /temporarily busy|retryable/i.test(String(details));
        if (attempt < maxAttempts && retryableBusy) {
          await new Promise(resolve => setTimeout(resolve, 800 * attempt));
          continue;
        }
        throw new Error(`Apps Script target=${target} rejected request: ${details}`);
      }
      return response.data;
    } catch (error) {
      const isAppsScriptResponseError = error?.message?.startsWith('Apps Script target=');
      lastError = isAppsScriptResponseError ? error : appsScriptFailure(target, error);
      const status = error?.response?.status;
      const transient = isAppsScriptResponseError
        ? /temporarily busy|retryable/i.test(error.message)
        : !status || status === 404 || status === 429 || status >= 500
          || ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN'].includes(error?.code);
      if (attempt >= maxAttempts || !transient) throw lastError;
      console.warn(`Apps Script target=${target} attempt ${attempt}/${maxAttempts} failed${status ? ` HTTP ${status}` : ` (${error.code || 'network'})`}; retrying once.`);
      await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError || new Error(`Apps Script target=${target} failed without a response.`);
}

function queueLeadSheetUpdate(data) {
  const phone = String(data.phone || '');
  if (!phone) return;
  let entry = pendingLeadSheetUpdates.get(phone);
  if (!entry) {
    entry = { latest: null, timer: null, inFlight: false };
    pendingLeadSheetUpdates.set(phone, entry);
  }
  entry.latest = data;
  if (entry.timer) clearTimeout(entry.timer);
  if (!entry.inFlight) scheduleLeadSheetUpdate_(phone, entry, 750);
}

function scheduleLeadSheetUpdate_(phone, entry, delayMs) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(async () => {
    entry.timer = null;
    if (entry.inFlight) return;
    const snapshot = entry.latest;
    entry.inFlight = true;
    try {
      await postAppsScript(snapshot, { timeoutMs: 15000, maxAttempts: 2 });
    } catch (error) {
      console.error(`Sheet Lead Update Error target=lead_update: ${error.message}`);
    } finally {
      entry.inFlight = false;
      if (entry.latest !== snapshot) scheduleLeadSheetUpdate_(phone, entry, 250);
      else pendingLeadSheetUpdates.delete(phone);
    }
  }, delayMs);
}

async function findActivePaymentLinkId(phone) {
  if (activePaymentLinks[phone]) return activePaymentLinks[phone];
  if (!pool) return null;
  const stored = await pool.query("SELECT payment_link_id FROM wa_payment_links WHERE phone=$1 AND status IN ('request_created','gateway_test_created') ORDER BY created_at DESC LIMIT 1", [phone]);
  const paymentLinkId = stored.rows[0]?.payment_link_id || null;
  if (paymentLinkId) activePaymentLinks[phone] = paymentLinkId;
  return paymentLinkId;
}

async function fetchAndFulfillVerifiedPayment(paymentLinkId) {
  return verifyAndFulfillPaymentLink(razorpayClient, paymentLinkId, async paidLink => {
    const PORT = process.env.PORT || 3000;
    const payloadData = {
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: paidLink },
        payment: { entity: { id: paidLink.payments?.[0]?.payment_id, amount_paid: paidLink.amount_paid } }
      }
    };
    const bodyString = JSON.stringify(payloadData);
    const signature = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(bodyString).digest('hex');
    await axios.post(`http://127.0.0.1:${PORT}/razorpay-webhook`, bodyString, {
      headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature }
    });
  });
}

// Fetch live services from website
async function fetchLiveServices() {
  try {
    const response = await axios.get('https://veshannastro.co.in/');
    const html = response.data;
    const match = html.match(/var DATA\s*=\s*(\[\s*\{[\s\S]*?\}\s*\])\s*;/);
    if (match) {
      const sandbox = {};
      vm.createContext(sandbox);
      vm.runInContext(`var parsed = ${match[1]};`, sandbox);
      liveData = sandbox.parsed || [];
      console.log(`Successfully fetched ${liveData.length} categories from live website.`);
      refreshSystemPrompt();
    }
  } catch (err) {
    console.error("Error fetching live services:", err.message);
  }
}

fetchLiveServices();
setInterval(fetchLiveServices, 60 * 60 * 1000);
refreshSystemPrompt(); 

// Helper to download WhatsApp Audio
async function downloadWhatsAppMedia(mediaId) {
  try {
    const urlRes = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });
    const downloadUrl = urlRes.data.url;
    
    const mediaRes = await axios.get(downloadUrl, {
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });
    
    return { buffer: Buffer.from(mediaRes.data), mimeType: urlRes.data.mime_type };
  } catch(e) {
    console.error("Media download error:", e.message);
    return null;
  }
}

// Helper to upload media to WhatsApp
async function uploadWhatsAppMedia(buffer, filename, mimeType) {
  try {
    const formData = new FormData();
    formData.append('file', buffer, { filename, contentType: mimeType });
    formData.append('type', mimeType);
    formData.append('messaging_product', 'whatsapp');

    const res = await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/media`, formData, {
      headers: {
        Authorization: `Bearer ${WA_TOKEN}`,
        ...formData.getHeaders()
      }
    });
    return res.data.id; // Returns the media ID
  } catch (e) {
    console.error("Media upload error:", e.response?.data || e.message);
    return null;
  }
}

function normalizeWhatsAppNumber(value) {
  let number = String(value || '').replace(/\D/g, '');
  if (number.length === 10) number = `91${number}`;
  return number;
}

// Send Document to WhatsApp
async function sendWhatsAppDocument(to, mediaId, filename, caption = "") {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: normalizeWhatsAppNumber(to),
      type: "document",
      document: {
        id: mediaId,
        caption: caption,
        filename: filename
      }
    }, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });
    return true;
  } catch(e) {
    console.error("WhatsApp Document Send Error:", e.response?.data || e.message);
    return false;
  }
}

app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (VERIFY_TOKEN && mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook Verified by Meta');
    return res.status(200).send(challenge);
  }
  console.error(`🚨 Webhook Verification Failed! Mode: ${mode}, Token: ${token}, Expected Token: ${VERIFY_TOKEN}`);
  res.sendStatus(403);
});

// Razorpay Webhook for Payment Confirmation
app.post('/razorpay-webhook', async (req, res) => {
  if (!RAZORPAY_WEBHOOK_SECRET) return res.status(503).send('Razorpay webhook secret is not configured');
  const signature = req.headers['x-razorpay-signature'];
  if (!signature || !req.rawBody) return res.sendStatus(400);
  const expectedSignature = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(req.rawBody).digest('hex');
  const received = Buffer.from(String(signature));
  const expected = Buffer.from(expectedSignature);
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return res.sendStatus(400);

  try {
    const event = req.body;
    if (event.event === 'payment_link.paid') {
      const pl = event.payload.payment_link.entity;
      if (processedPayments.has(pl.id)) return res.sendStatus(200);
      if (!pool) throw new Error('Persistent payment tracking is unavailable; refusing non-idempotent fulfillment.');
      const claim = await pool.query(`
        INSERT INTO wa_payment_fulfillments (payment_link_id,status) VALUES ($1,'processing')
        ON CONFLICT (payment_link_id) DO UPDATE SET status='processing',updated_at=NOW()
        WHERE wa_payment_fulfillments.status <> 'fulfilled'
          AND (wa_payment_fulfillments.status <> 'processing' OR wa_payment_fulfillments.updated_at < NOW() - INTERVAL '5 minutes')
        RETURNING payment_link_id`, [pl.id]);
      if (!claim.rows.length) {
        const existing = await pool.query('SELECT status FROM wa_payment_fulfillments WHERE payment_link_id=$1', [pl.id]);
        if (existing.rows[0]?.status === 'fulfilled') processedPayments.add(pl.id);
        return res.sendStatus(200);
      }

      const notes = pl.notes || {};
      const customerName = notes.customer_name || 'Customer';
      const serviceName = notes.service_name || 'Consultation';
      const phone = notes.phone;
      const price = Number(notes.price);
      const payment = event.payload?.payment?.entity;
      const actualAmountPaise = Number(payment?.amount_paid ?? payment?.amount);
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(actualAmountPaise) || Math.round(price * 100) !== actualAmountPaise) {
        throw new Error(`Payment amount mismatch or missing payment entity for ${pl.id}; refusing to confirm booking/invoice.`);
      }
      if (pool) {
        const storedLink = await pool.query(`SELECT amount_paise,phone,calendar_event_id,customer_id,service_name,
          request_invoice_number,appointment_start FROM wa_payment_links WHERE payment_link_id=$1`, [pl.id]);
        const stored = storedLink.rows[0];
        if (!stored || Number(stored.amount_paise) !== actualAmountPaise || stored.phone !== notes.phone
          || stored.calendar_event_id !== notes.calendar_event_id || stored.customer_id !== notes.customer_id
          || stored.service_name !== notes.service_name || !stored.request_invoice_number
          || Math.abs(new Date(stored.appointment_start).getTime() - new Date(notes.time_slot).getTime()) > 1000) {
          throw new Error(`Stored booking/payment details do not match Razorpay link ${pl.id}.`);
        }
      }

      // 1. Clear Abandoned Cart Timer
      const plId = pl.id;
      if (pendingPayments[plId]) {
        clearTimeout(pendingPayments[plId]);
        delete pendingPayments[plId];
      }

      // 2. Mark user as returning customer
      if (phone && notes.gateway_test !== 'true') {
        await upsertUser(phone, true, false);
        await updateUserStatus(phone, 'converted');
      }

      // 3. (Moved to after Calendar generation)

      // A Calendar event was created as a temporary hold before the payment link.
      // Upgrade that exact event only after Razorpay confirms the exact amount.
      if (!notes.calendar_event_id) throw new Error(`No appointment hold exists for paid link ${pl.id}; manual fulfillment is required.`);
      const isGatewayTest = notes.gateway_test === 'true';
      const eventSummary = isGatewayTest
        ? `GATEWAY TEST ONLY — NOT A BOOKING — ${serviceName} — ${customerName}`
        : `Veshannastro Consultation — ${serviceName} — ${customerName}`;
      const eventDescription = isGatewayTest
        ? `₹1 gateway validation only. This is not a confirmed consultation booking and does not pay the consultation fee.\nName: ${customerName}\nDOB: ${notes.dob || ''}\nBirth time: ${notes.tob || ''}\nBirth place: ${notes.pob || ''}\nPhone: ${phone || ''}\nRequested appointment (test only): ${notes.time_slot || ''}`
        : `Confirmed Veshannastro Consultation Booking.\nName: ${customerName}\nDOB: ${notes.dob || ''}\nBirth time: ${notes.tob || ''}\nBirth place: ${notes.pob || ''}\nPhone: ${phone || ''}\nAppointment time: ${notes.time_slot || ''}\nQuery: ${notes.summary || ''}`;

      const finalizedCalendar = await postAppsScript({
        target: 'calendar_finalize',
        eventId: notes.calendar_event_id,
        summary: eventSummary,
        description: eventDescription
      });
      const meetLink = finalizedCalendar.meetLink;
      if (!meetLink) throw new Error(`Calendar hold ${notes.calendar_event_id} has no Google Meet URL; manual fulfillment is required.`);

      // 4. Generate PDF Invoice
      let invoiceBase64 = null;
      let invoiceBuffer = null;
      const safeName = (customerName || 'Customer').replace(/[^a-zA-Z0-9_-]/g, '_');
      const invoiceName = `Invoice_${safeName}_${pl.id.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}.pdf`;
      try {
        invoiceBuffer = await generateInvoice({
          invoiceNumber: pl.id.replace('plink_', '').toUpperCase(),
          customerName: customerName,
          email: notes.email || '',
          phone: phone,
          serviceName: serviceName,
          amountPaid: price,
          basePrice: Number(notes.list_price || price),
          isGatewayTest: isGatewayTest,
          date: new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' }),
          appointmentDate: new Date(notes.time_slot).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }),
          paymentId: payment?.id,
          meetLink: meetLink
        });
        invoiceBase64 = invoiceBuffer.toString('base64');
      } catch (invoiceErr) {
        throw new Error(`Invoice generation failed for ${pl.id}: ${invoiceErr.message}`);
      }

      // 5. Log to Google Sheets & send the same personalized confirmation by email.
      {
        const bookedAt = new Date(notes.time_slot);
        if (!Number.isFinite(bookedAt.getTime())) throw new Error(`Invalid booked time in payment notes for ${pl.id}`);

        await postAppsScript({
          target: "booking",
          name: customerName,
          email: notes.email || '',
          gender: notes.gender || '',
          phone: phone,
          dob: notes.dob || '',
          birthTime: notes.tob || '',
          birthPlace: notes.pob || '',
          service: serviceName,
          amountPaid: price,
          paymentStatus: isGatewayTest ? 'Gateway test paid - consultation not paid' : 'Paid',
          payment_id: event.payload?.payment?.entity?.id || pl.id,
          payment_link_id: pl.id,
          source: "WhatsApp Direct Booking",
          sessionDate: `${notes.time_slot || ''}`,
          query: notes.summary || '',
          meetLink: meetLink,
          eventTime: bookedAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: 'full', timeStyle: 'short' }),
          notes: '',
          invoiceBase64: invoiceBase64,
          invoicePdfBase64: invoiceBase64,
          invoiceName: invoiceName,
          invoicePdfName: invoiceName,
          isGatewayTest: isGatewayTest,
          basePrice: Number(notes.list_price || price)
        });

        await postAppsScript({
          target: "customer_update",
          customerId: notes.customer_id || '',
          name: customerName,
          phone: phone,
          email: notes.email || '',
          dob: notes.dob || '',
          tob: notes.tob || '',
          pob: notes.pob || '',
          gender: notes.gender || ''
        });
      }

      // 6. Send WhatsApp Confirmation
      if (phone) {
        const agreedSlotMsg = notes.time_slot && notes.time_slot !== "Not specified" ? `\n\nRequested test slot: ${new Date(notes.time_slot).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' })} IST.` : '';
        if (!invoiceBuffer) throw new Error(`Invoice buffer missing for paid link ${pl.id}`);
        const mediaId = await uploadWhatsAppMedia(invoiceBuffer, invoiceName, 'application/pdf');
        if (!mediaId || !(await sendWhatsAppDocument(phone, mediaId, invoiceName, notes.gateway_test === 'true'
          ? '₹1 gateway test receipt - not a consultation payment.'
          : 'Payment receipt and consultation details.'))) {
          throw new Error(`WhatsApp receipt delivery failed for paid link ${pl.id}`);
        }
        const msg = notes.gateway_test === 'true'
          ? `Razorpay has verified the ₹${price.toFixed(2)} gateway test payment. This is only a payment-system test; it does not pay for or confirm your ${serviceName} consultation.${agreedSlotMsg}\n\nTest Google Meet link: ${meetLink}\n\nYour clearly labelled test receipt is attached.`
          : `Payment verified. Thank you, ${customerName}. We received ₹${price.toFixed(2)} for ${serviceName}.${agreedSlotMsg}\n\nYour booking is confirmed for ${new Date(notes.time_slot).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' })} IST.\nGoogle Meet: ${meetLink}\n\nYour payment receipt is attached.`;
        if (!(await sendTextMessage(phone, msg))) throw new Error(`WhatsApp payment confirmation text failed for ${pl.id}`);
        if (ADMIN_PHONE_NUMBER) {
          await sendTextMessage(ADMIN_PHONE_NUMBER, `${notes.gateway_test === 'true' ? 'Razorpay gateway test payment verified (not a real booking)' : 'New paid WhatsApp booking'}\nName: ${customerName}\nPhone: +${phone}\nService: ${serviceName}\nRequested time: ${new Date(notes.time_slot).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'full', timeStyle: 'short' })} IST\nAmount received: ₹${price.toFixed(2)}${notes.gateway_test === 'true' ? `\nPublished service price (still unpaid): ₹${Number(notes.list_price || 0).toFixed(2)}` : ''}\nDate of birth: ${notes.dob || 'Not provided'}\nBirth time: ${notes.tob || 'Not provided'}\nBirth place: ${notes.pob || 'Not provided'}\nCalendar event: ${notes.calendar_event_id}`);
        }

      }
      if (pool) {
        await pool.query(`UPDATE wa_payment_links SET status=$2,razorpay_payment_id=$3,updated_at=NOW() WHERE payment_link_id=$1`, [pl.id, notes.gateway_test === 'true' ? 'gateway_test_paid' : 'paid', payment?.id || null]);
        await pool.query(`INSERT INTO wa_payment_fulfillments (payment_link_id,status) VALUES ($1,'fulfilled')
          ON CONFLICT (payment_link_id) DO UPDATE SET status='fulfilled',updated_at=NOW()`, [pl.id]);
      }
      processedPayments.add(pl.id);
    } else if (event.event === 'payment_link.expired') {
      const pl = event.payload?.payment_link?.entity;
      const eventId = pl?.notes?.calendar_event_id;
      if (eventId) {
        await postAppsScript({ target: 'calendar_cancel', eventId }).catch(error => {
          if (!/not found|already missing/i.test(error.message || '')) throw error;
        });
      }
      if (pl?.id && pool) await pool.query("UPDATE wa_payment_links SET status=$2,updated_at=NOW() WHERE payment_link_id=$1", [pl.id, pl.notes?.gateway_test === 'true' ? 'gateway_test_expired' : 'expired']);
      if (pl?.id && pendingPayments[pl.id]) clearTimeout(pendingPayments[pl.id]);
    }
    return res.sendStatus(200);
  } catch(e) {
    console.error("Razorpay Webhook Error:", e.message);
    const failedLinkId = req.body?.payload?.payment_link?.entity?.id;
    if (failedLinkId && pool) await pool.query(`INSERT INTO wa_payment_fulfillments (payment_link_id,status) VALUES ($1,'failed')
      ON CONFLICT (payment_link_id) DO UPDATE SET status='failed',updated_at=NOW()`, [failedLinkId]).catch(() => {});
    if (ADMIN_PHONE_NUMBER) await sendTextMessage(ADMIN_PHONE_NUMBER, `Payment received but automatic fulfillment needs attention. Payment link: ${failedLinkId || 'unknown'}. Error: ${e.message}. Verify payment status in Razorpay before taking manual action.`);
    return res.status(500).send('Payment fulfillment failed; retry requested');
  }
});

app.post('/webhook', async (req, res) => {
  if (!META_APP_SECRET) return res.status(503).send('Meta App Secret is not configured');
  const signature = String(req.headers['x-hub-signature-256'] || '');
  const rawBodyLen = req.rawBody ? req.rawBody.length : 0;
  const expected = `sha256=${crypto.createHmac('sha256', META_APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest('hex')}`;
  const receivedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(receivedBuffer, expectedBuffer)) {
    console.error('🚨 Webhook Signature Verification Failed!');
    console.error(`Received: ${signature}`);
    console.error(`Expected: ${expected}`);
    console.error(`RawBody Length: ${rawBodyLen}`);
    return res.sendStatus(401);
  }
  res.sendStatus(200); 
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages || messages.length === 0) {
      console.log('📭 Webhook received but no messages (status update or echo).');
      return;
    }

    const msg  = messages[0];
    const from = msg.from;

    const inboundText = msg.type === 'text' ? String(msg.text?.body || '').trim() : '';
    if (/^(stop|unsubscribe|opt\s*out)$/i.test(inboundText)) {
      if (pool) await pool.query(`INSERT INTO users (phone,marketing_opt_in,marketing_opt_out) VALUES ($1,false,true)
        ON CONFLICT (phone) DO UPDATE SET marketing_opt_in=false,marketing_opt_out=true,last_contact=NOW()`, [from]);
      await sendTextMessage(from, 'You will not receive marketing or follow-up messages. You can still message us for support or bookings.');
      return;
    }
    if (/^yes$/i.test(inboundText) && pool) {
      const pendingOffer = await pool.query(`SELECT source_payment_link_id FROM wa_discount_offers
        WHERE phone=$1 AND status='offered' ORDER BY offered_at DESC LIMIT 1`, [from]);
      if (pendingOffer.rows[0]) {
        await pool.query(`UPDATE wa_discount_offers SET status='accepted',accepted_at=NOW()
          WHERE source_payment_link_id=$1 AND status='offered'`, [pendingOffer.rows[0].source_payment_link_id]);
        if (!sessions[from]) sessions[from] = [];
        sessions[from].push({ role: 'user', parts: [{ text: 'I accept the 10% follow-up offer. I need to choose a new appointment time.' }] });
        const askNewTime = 'Thank you. I can apply that 10% offer to a new booking. Please share a new preferred date and time within the available appointment hours.';
        sessions[from].push({ role: 'model', parts: [{ text: askNewTime }] });
        await sendTextMessage(from, askNewTime);
        return;
      }
    }
    const latestAssistantText = (sessions[from] || []).slice().reverse()
      .find(turn => turn.role === 'model')?.parts?.map(part => part.text || '').join(' ') || '';
    if (/^yes$/i.test(inboundText) && /reply\s+YES|reply YES|follow-up reminder/i.test(latestAssistantText)) {
      if (pool) await pool.query(`INSERT INTO users (phone,marketing_opt_in,marketing_opt_out) VALUES ($1,true,false)
        ON CONFLICT (phone) DO UPDATE SET marketing_opt_in=true,marketing_opt_out=false,last_contact=NOW()`, [from]);
      await sendTextMessage(from, 'Thanks, I’ve recorded your consent for one booking follow-up. Reply STOP anytime to opt out.');
      return;
    }

    // Deduplicate incoming messages from Meta retries
    if (msg.id) {
      if (processedMessageIds.has(msg.id)) {
        console.log(`🔁 Duplicate message ${msg.id} ignored.`);
        return;
      }
      processedMessageIds.set(msg.id, Date.now());
    }

    console.log(`📩 MESSAGE RECEIVED from ${from} | type: ${msg.type}`);
    
    // CRM Check & Lead Analytics
    let dbUser = await getUser(from);
    if (!dbUser) {
      await upsertUser(from, false, false);
      dbUser = { phone: from, is_customer: false, is_paused: false, message_count: 1 };
    } else {
      await incrementUserMessage(from);
      dbUser.message_count = (dbUser.message_count || 0) + 1;
    }

    if (GOOGLE_APPS_SCRIPT_URL && GOOGLE_APPS_SCRIPT_SECRET) {
      queueLeadSheetUpdate({
        target: 'lead_update', 
        phone: from, 
        message_count: dbUser.message_count,
        is_customer: dbUser.is_customer
      });
    }

    // Admin Commands
    if (msg.type === 'text' && msg.text.body.trim().startsWith('/')) {
      const command = msg.text.body.trim();
      const lowerCmd = command.toLowerCase();
      
      if (lowerCmd === '/unpause') {
        if (pool) await pool.query('UPDATE users SET is_paused = false WHERE phone = $1', [from]);
        await sendTextMessage(from, "AI unpaused. You can now chat normally.");
        return;
      }

      if (lowerCmd === '/reset') {
        if (pool) await pool.query('DELETE FROM users WHERE phone = $1', [from]);
        if (sessions[from]) delete sessions[from];
        await sendTextMessage(from, "✅ Session and memory completely wiped. Send 'hi' to start fresh!");
        return;
      }

      if (lowerCmd === '/stats') {
        if (from !== normalizeWhatsAppNumber(ADMIN_PHONE_NUMBER)) return await sendTextMessage(from, 'That command is available to the business owner only.');
        if (!pool) return await sendTextMessage(from, "Database not connected.");
        const stats = await pool.query(`
          SELECT 
            COUNT(*) as total_leads,
            SUM(CASE WHEN is_customer = true THEN 1 ELSE 0 END) as total_customers,
            SUM(CASE WHEN status = 'converted' THEN 1 ELSE 0 END) as total_converted
          FROM users
        `);
        const { total_leads, total_customers, total_converted } = stats.rows[0];
        await sendTextMessage(from, `📊 *Veshannastro Stats*\nTotal Leads: ${total_leads || 0}\nPaid Customers: ${total_customers || 0}\nConverted by AI: ${total_converted || 0}`);
        return;
      }

      if (lowerCmd.startsWith('/broadcast ')) {
        if (from !== normalizeWhatsAppNumber(ADMIN_PHONE_NUMBER)) return await sendTextMessage(from, 'That command is available to the business owner only.');
        if (!pool) return await sendTextMessage(from, "Database not connected.");
        const broadcastMsg = command.substring(11).trim();
        await sendTextMessage(from, `Starting broadcast to all leads...\nMessage:\n"${broadcastMsg}"\n\nThis will run in the background.`);
        
        // Background task
        (async () => {
          try {
            const users = await pool.query("SELECT phone FROM users WHERE is_customer = false AND is_paused = false");
            for (const user of users.rows) {
              await sendTextMessage(user.phone, broadcastMsg);
              await new Promise(r => setTimeout(r, 1500)); // Rate limit
            }
            await sendTextMessage(from, `✅ Broadcast completed to ${users.rows.length} leads.`);
          } catch (e) {
            await sendTextMessage(from, `❌ Broadcast failed: ${e.message}`);
          }
        })();
        return;
      }
    }

    // Mark message as read (simulates human reading)
    await markAsRead(msg.id);

    // Ignore if Human Handoff activated
    if (dbUser.is_paused) return;

    const paymentClaim = isPaymentClaim(inboundText, /payment link|gateway test/i.test(latestAssistantText));
    if (paymentClaim) {
      if (!sessions[from]) sessions[from] = [];
      sessions[from].push({ role: 'user', parts: [{ text: inboundText }] });
      const paymentLinkId = await findActivePaymentLinkId(from);
      if (!paymentLinkId) {
        const reply = "I can't see an active payment link for this conversation yet, so I can't verify a payment. Please share the payment link you used, and I'll check it for you.";
        await sendTextMessage(from, reply);
        sessions[from].push({ role: 'model', parts: [{ text: reply }] });
      } else {
        try {
          const verification = await fetchAndFulfillVerifiedPayment(paymentLinkId);
          if (!verification.paid) {
            const reply = "I just checked, but the payment hasn't reflected yet. Sometimes the bank gateway takes a moment. I'll send the receipt and meeting details as soon as Razorpay confirms it.";
            await sendTextMessage(from, reply);
            sessions[from].push({ role: 'model', parts: [{ text: reply }] });
          } else {
            sessions[from].push({ role: 'model', parts: [{ text: verification.paymentLink.notes?.gateway_test === 'true'
              ? 'Razorpay has verified the ₹1 gateway test. The test receipt and test meeting details were sent; no consultation has been paid for or booked.'
              : 'Razorpay has verified the payment. The booking confirmation and receipt were sent.' }] });
          }
        } catch (error) {
          console.error('Deterministic payment verification failed:', error.message);
          const reply = "I'm having trouble checking Razorpay right now. I haven't marked the payment as complete; I'll send the confirmation only after the server verifies it.";
          await sendTextMessage(from, reply);
          sessions[from].push({ role: 'model', parts: [{ text: reply }] });
        }
      }
      if (GOOGLE_APPS_SCRIPT_URL && GOOGLE_APPS_SCRIPT_SECRET) postAppsScript({
        target: 'chat', phone: from, sender: 'User', message: inboundText
      }).catch(() => {});
      return;
    }

    let text = '';
    let mediaData = null;
    let interactiveId = null;

    if (msg.type === 'text') {
      text = msg.text.body;
      if (GOOGLE_APPS_SCRIPT_URL && GOOGLE_APPS_SCRIPT_SECRET) {
        postAppsScript({ target: 'chat', phone: from, sender: 'User', message: text }).catch(e => {});
      }
    } else if (msg.type === 'audio') {
      const mediaId = msg.audio.id;
      const mediaInfo = await downloadWhatsAppMedia(mediaId);
      if (mediaInfo) {
        const mime = msg.audio.mime_type || 'audio/ogg';
        mediaData = {
          inlineData: {
            data: mediaInfo.buffer.toString("base64"),
            mimeType: mime
          }
        };
        text = "(User sent an audio message. Respond to their voice directly.)";
      }
    } else if (msg.type === 'image') {
      const mediaId = msg.image.id;
      const mediaInfo = await downloadWhatsAppMedia(mediaId);
      if (mediaInfo) {
        const mime = msg.image.mime_type || 'image/jpeg';
        mediaData = {
          inlineData: {
            data: mediaInfo.buffer.toString("base64"),
            mimeType: mime
          }
        };
        text = msg.image.caption || "Look at this photo and describe/react to it naturally.";
      }
    } else if (msg.type === 'video') {
      await sendTextMessage(from, "heyy thanks for sending the video! 😊 unfortunately I can't watch videos here — agar koi specific frame ya screenshot hai toh photo bhej do, I'll definitely look at it!");
      return;
    } else if (msg.type === 'interactive') {
      if (msg.interactive.type === 'list_reply') {
        interactiveId = msg.interactive.list_reply.id;
      } else if (msg.interactive.type === 'button_reply') {
        interactiveId = msg.interactive.button_reply.id;
      }
    }

    if (interactiveId) {
      const [prefix, catId, svcIndexStr] = interactiveId.split('_'); 
      if (prefix === 'cat') {
        await sendServiceMenu(from, catId);
      } else if (prefix === 'svc') {
        const category = liveData.find(c => c.id === catId);
        if (category) {
          const svc = category.services[parseInt(svcIndexStr)];
          if (svc) {
            const featureList = svc.features ? `• ${svc.features.join('\n• ')}` : '';
            let reply = `✨ *${svc.t}*\n\n${svc.d}\n\n*Features:*\n${featureList}\n\n💰 *Current Price:* ${svc.p}\n\n📅 *Ready to Book?*\nVisit: https://veshannastro.co.in/${svc.link.replace('https://veshannastro.co.in/', '')}\nOr simply reply here and I will help you book it directly in this chat! 🙏`;
            await sendTextMessage(from, reply);
          }
        }
      }
      return;
    }

    if (text || mediaData) {
      console.log(`🧠 Processing AI for ${from} | text: "${text?.substring(0, 50)}" | hasMedia: ${!!mediaData}`);
      if (!GEMINI_API_KEY) {
        console.log('⚠️ NO GEMINI_API_KEY set! Sending menu instead.');
        await sendInteractiveMenu(from);
        return;
      }

      if (!sessions[from]) {
        sessions[from] = [];
      }

      // Smart Timing & Dynamic Context (cleanly injected into system instruction, not chat history)
      const currentTimeIST = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const lastContactStr = dbUser.last_contact ? new Date(dbUser.last_contact).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "First time";
      const dynamicSystemPrompt = `${systemPromptCache}

--- REAL-TIME CONTEXT (FOR YOUR EYES ONLY) ---
- Current Date & Time (India IST): ${currentTimeIST}
- Client Status: ${dbUser.is_customer ? 'Returning Paid Client (Acknowledge with warmth and recognition)' : 'New Seeker'}
- Customer ID: ${dbUser.customer_id || 'Not assigned yet'}
- Name: ${dbUser.name || 'Not provided yet'}
- Date of Birth (DOB): ${dbUser.dob || 'Not provided yet'}
- Remedies Prescribed: ${dbUser.remedies_prescribed || 'None'}
- Recorded Problem: ${dbUser.pain_point || 'None recorded yet'}
- Total Messages Exchanged: ${dbUser.message_count || 1}`;
      
      const userParts = [];
      if (text) {
        userParts.push({ text: text });
      }
      if (mediaData) {
        userParts.push(mediaData);
      }
      if (userParts.length === 0) {
        userParts.push({ text: "Hello" });
      }

      sessions[from].push({ role: "user", parts: userParts });

      // Prune session history to keep conversation focused and save memory
      if (sessions[from].length > 20) {
        sessions[from] = sessions[from].slice(-16);
      }

      // Sanitize old media payloads in earlier history so RAM stays low
      for (let i = 0; i < sessions[from].length - 2; i++) {
        const turn = sessions[from][i];
        if (turn.parts && Array.isArray(turn.parts)) {
          for (let p = 0; p < turn.parts.length; p++) {
            if (turn.parts[p]?.inlineData) {
              turn.parts[p] = { text: "[Prior image/audio reviewed]" };
            }
          }
        }
      }

      // Gemini Flash is used for low-latency, multimodal chat and tool calling.
      const candidateModels = [
        process.env.GEMINI_MODEL || "gemini-3.8-flash",
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.6-flash"
      ].filter(Boolean);
      const uniqueModels = [...new Set(candidateModels)];

      let result;
      let lastAiError = null;

      for (const modelName of uniqueModels) {
        let modelSucceeded = false;
        const maxRetries = 2;
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
          try {
            console.log(`🤖 Invoking Gemini model: ${modelName} (attempt ${attempt})...`);
            const model = genAI.getGenerativeModel({ 
              model: modelName,
              systemInstruction: dynamicSystemPrompt,
              tools: tools,
              generationConfig: {
                temperature: 0.7 // Warm, natural, human conversational cadence
              }
            });
            result = await model.generateContent({
              // Gemini accepts only user/model history roles. Some previously
              // stored turns used the OpenAI-style "function" role, which caused
              // the exact 400 error seen in the user's Render screenshot.
              contents: sessions[from].map(turn => ({
                ...turn,
                role: turn.role === 'function' ? 'user' : turn.role
              }))
            });
            modelSucceeded = true;
            console.log(`✅ Gemini (${modelName}) responded successfully.`);
            break;
          } catch (aiErr) {
            lastAiError = aiErr;
            const is404 = aiErr.message?.includes('404') || aiErr.status === 404;
            const isRetryable = aiErr.message?.includes('503') || aiErr.message?.includes('429') || aiErr.message?.includes('overloaded') || aiErr.status === 429;
            
            if (is404) {
              console.log(`⚠️ Model ${modelName} returned 404 (Not Found). Falling back to next candidate model...`);
              break; // Skip directly to next model
            }
            if (isRetryable && attempt < maxRetries) {
              const delay = attempt * 2000;
              console.log(`⚠️ Model ${modelName} attempt ${attempt} failed (${aiErr.message?.substring(0, 80)}), retrying in ${delay/1000}s...`);
              await new Promise(r => setTimeout(r, delay));
            } else {
              console.log(`⚠️ Model ${modelName} failed (${aiErr.message?.substring(0, 80)}). Trying next candidate model...`);
              break;
            }
          }
        }
        if (modelSucceeded) break;
      }

      if (!result) {
        throw new Error(`All candidate Gemini models failed. Last error: ${lastAiError?.message || 'Unknown'}`);
      }
      
      const responseMessage = result.response.candidates[0].content;
      sessions[from].push(responseMessage); // Add assistant response to history
      
      // Handle Function Calls
      const functionCalls = result.response.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        const args = call.args;
        
        if (call.name === "request_human_handoff") {
          await upsertUser(from, dbUser.is_customer, true); // Pause AI
          await sendTextMessage(from, "I completely understand. I am escalating this to our team. Our senior team will personally contact you on this number within 24 hours.");
          if (ADMIN_PHONE_NUMBER) {
             await sendTextMessage(ADMIN_PHONE_NUMBER, `🚨 *ESCALATION REQUIRED* 🚨\n\nClient Phone: +${from}\nReason: ${args.reason}\n\n*The AI has paused itself for this user. Please take over the chat manually via the WhatsApp app within 24 hours.*`);
          }
          sessions[from].push({ role: "user", parts: [{ functionResponse: { name: call.name, response: { status: "paused_by_human_handoff" } } }] });
          sessions[from].push({ role: "model", parts: [{ text: "Understood. Handoff completed." }] });
          return;
        }

        if (call.name === "create_booking_payment") {
          if (!razorpayClient) {
            await sendTextMessage(from, "Sorry, the direct payment system is currently being configured. Please book via our website: https://veshannastro.co.in");
          } else {
            let calendarHold = null;
            let createdPaymentLink = null;
            try {
              const required = ['customer_name', 'email', 'billing_address', 'service_name', 'preferred_time_slot'];
              const missing = required.filter(key => !String(args[key] || '').trim());
              if (missing.length) throw new Error(`Missing required booking details: ${missing.join(', ')}`);
              if (!GOOGLE_APPS_SCRIPT_URL) throw new Error('Email and Google Sheets confirmation are not configured yet, so I cannot safely generate a payment link.');
              if (!GOOGLE_APPS_SCRIPT_SECRET) throw new Error('Google Sheets authentication is not configured yet, so I cannot safely generate a payment request.');
              if (!RAZORPAY_WEBHOOK_SECRET) throw new Error('Razorpay verification is not fully configured, so I cannot safely generate a payment link.');
              if (!pool) throw new Error('Persistent payment tracking is required before creating a payment link.');
              if (!ADMIN_PHONE_NUMBER) throw new Error('Owner payment notifications are not configured yet, so I cannot safely generate a payment link.');
              const publishedService = findPublishedService(args.service_name);
              const slot = validatePreferredSlot(args.preferred_time_slot);
              let additionalDiscountPercent = 0;
              let acceptedDiscountSourceId = null;
              if (args.discount_offer === 'hardship' && hasRepeatedHardshipEvidence(from)) {
                additionalDiscountPercent = 5;
              } else if (args.discount_offer === 'followup_10' && pool) {
                const acceptedOffer = await pool.query(`SELECT source_payment_link_id FROM wa_discount_offers
                  WHERE phone=$1 AND status='accepted' AND accepted_at IS NOT NULL AND used_at IS NULL
                  ORDER BY accepted_at DESC LIMIT 1`, [from]);
                if (acceptedOffer.rows[0]) {
                  additionalDiscountPercent = 10;
                  acceptedDiscountSourceId = acceptedOffer.rows[0].source_payment_link_id;
                }
              }
              const additionalDiscount = Math.round(publishedService.price * additionalDiscountPercent) / 100;
              const serviceTotal = Math.max(0, publishedService.price - additionalDiscount);
              if (serviceTotal <= 0) throw new Error('The approved discount would make the service total invalid. Please ask the owner to review it.');
              // This temporary hard-coded charge intentionally exercises the
              // configured Razorpay gateway with real credentials for ₹1.
              // It does not collect the service price or apply discounts.
              const finalAmount = GATEWAY_VALIDATION_CHARGE_INR;
              const amountPaise = Math.round(finalAmount * 100);
              const customerId = stableCustomerId(from, dbUser.customer_id);
              calendarHold = await reserveCalendarSlot(slot, {
                serviceName: publishedService.t,
                customerName: args.customer_name,
                phone: from,
                email: args.email
              });

              createdPaymentLink = await razorpayClient.paymentLink.create({
                amount: amountPaise,
                currency: "INR",
                accept_partial: false,
                expire_by: Math.floor(Date.now() / 1000) + (12 * 60 * 60), // Expires in 12 hours
                description: `INR 1 gateway validation only - not a consultation payment. ${String(publishedService.t)}`.substring(0, 2048),
                reference_id: `wa_booking_${Date.now()}`,
                notify: { sms: false, email: false },
                notes: {
                  customer_id: customerId,
                  customer_name: String(args.customer_name || 'Seeker').substring(0, 40),
                  email: String(args.email || '').substring(0, 60),
                  gender: String(args.gender || '').substring(0, 20),
                  dob: String(args.dob || '').substring(0, 30),
                  tob: String(args.tob || '').substring(0, 30),
                  pob: String(args.pob || '').substring(0, 50),
                  billing_address: String(args.billing_address || '').substring(0, 240),
                  customer_gstin: String(args.customer_gstin || '').substring(0, 20),
                  service_name: String(publishedService.t).substring(0, 100),
                  price: String(finalAmount),
                  list_price: String(publishedService.price),
                  normal_rate: String(publishedService.listPrice),
                  website_discount: String(publishedService.websiteDiscount),
                  additional_discount: String(additionalDiscount),
                  additional_discount_percentage: String(additionalDiscountPercent),
                  service_total: String(serviceTotal),
                  discount_percentage: String(additionalDiscountPercent),
                  gateway_test: 'true',
                  phone: String(from),
                  summary: String(args.customer_pain_points_summary || '').substring(0, 240),
                  time_slot: slot.start.toISOString(),
                  calendar_event_id: String(calendarHold.event.id),
                }
              });

              await updateUserPainPoint(from, String(args.customer_pain_points_summary || '').substring(0, 240));

              const generatedId = createdPaymentLink.notes.customer_id;
              const invoiceNumber = `PR-${new Date().getFullYear()}-${createdPaymentLink.id.replace(/[^A-Za-z0-9]/g, '').slice(-8).toUpperCase()}`;
              const issueDate = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium' });
              const invoiceName = `${invoiceNumber}.pdf`;
              const appointmentDate = slot.start.toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short'
              }) + ' IST';
              const invoiceBuffer = await generatePaymentRequestInvoice({
                invoiceNumber,
                issueDate,
                customerId: generatedId,
                customerName: args.customer_name,
                email: args.email,
                phone: from,
                billingAddress: args.billing_address,
                customerGstin: args.customer_gstin || '',
                serviceName: publishedService.t,
                appointmentDate,
                normalRate: publishedService.listPrice,
                websiteDiscount: publishedService.websiteDiscount,
                additionalDiscount,
                serviceTotal,
                linkAmount: finalAmount,
                isGatewayTest: true,
                paymentUrl: createdPaymentLink.short_url
              });
              if (pool) {
                await pool.query(
                  `UPDATE users SET name=$1, email=$2, dob=$3, tob=$4, pob=$5, gender=$6,
                    billing_address=$7, customer_gstin=$8, customer_id=$9 WHERE phone=$10`,
                  [args.customer_name || '', args.email || '', args.dob || '', args.tob || '', args.pob || '',
                    args.gender || '', args.billing_address || '', args.customer_gstin || '', generatedId, from]
                );
              }

              const link = createdPaymentLink.short_url;
              activePaymentLinks[from] = createdPaymentLink.id;
              if (pool) await pool.query(
                `INSERT INTO wa_payment_links (
                  payment_link_id, phone, calendar_event_id, amount_paise, customer_id, customer_name,
                  email, gender, dob, tob, pob, billing_address, customer_gstin, service_name,
                  appointment_start, normal_rate_paise, website_discount_paise, additional_discount_paise,
                  service_total_paise, request_invoice_number, status
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,'request_created')
                ON CONFLICT (payment_link_id) DO UPDATE SET status='request_created', updated_at=NOW()`,
                [createdPaymentLink.id, from, calendarHold.event.id, amountPaise, generatedId, args.customer_name || '',
                  args.email || '', args.gender || '', args.dob || '', args.tob || '', args.pob || '', args.billing_address || '',
                  args.customer_gstin || '', publishedService.t, slot.start, Math.round(publishedService.listPrice * 100),
                  Math.round(publishedService.websiteDiscount * 100), Math.round(additionalDiscount * 100),
                  Math.round(serviceTotal * 100), invoiceNumber]
              );
              await postAppsScript({
                target: 'payment_request', payment_link_id: createdPaymentLink.id,
                invoice_number: invoiceNumber, customerId: generatedId,
                name: args.customer_name, phone: from, email: args.email,
                billingAddress: args.billing_address, customerGstin: args.customer_gstin || '',
                gender: args.gender || '', dob: args.dob || '', birthTime: args.tob || '', birthPlace: args.pob || '',
                service: publishedService.t, sessionDate: slot.start.toISOString(),
                normalRate: publishedService.listPrice, websiteDiscount: publishedService.websiteDiscount,
                additionalDiscount: additionalDiscount, serviceTotal: serviceTotal,
                amountDue: finalAmount, paymentUrl: link, invoiceStatus: 'UNPAID',
                isGatewayTest: true, source: 'WhatsApp Direct Booking'
              });
              const mediaId = await uploadWhatsAppMedia(invoiceBuffer, invoiceName, 'application/pdf');
              if (!mediaId) throw new Error('WhatsApp did not accept the payment-request PDF upload.');
              const caption = `Thank you, ${args.customer_name}. Your payment request for ${publishedService.t} is attached. Appointment requested: ${appointmentDate}.\n\nThis link is a ₹1 live gateway test only. It does not pay for or confirm your consultation. Consultation total after the published and approved discounts: ₹${serviceTotal.toFixed(2)}.\n\nPay securely here: ${link}\n\nReply YES if you would like one reminder and a follow-up offer. Reply STOP anytime to opt out.`;
              const linkSent = await sendWhatsAppDocument(from, mediaId, invoiceName, caption);
              if (!linkSent) throw new Error('WhatsApp did not accept the invoice-and-payment-link message.');
              if (acceptedDiscountSourceId && pool) {
                await pool.query(`UPDATE wa_discount_offers SET used_at=NOW(), status='used' WHERE source_payment_link_id=$1 AND status='accepted'`, [acceptedDiscountSourceId]);
              }
              
              // 2-Hour Abandoned Cart Timer
              const refId = createdPaymentLink.id;
              pendingPayments[refId] = setTimeout(async () => {
                if (pendingPayments[refId]) {
                  await sendTextMessage(from, `Hi ${args.customer_name}, just checking whether you'd still like to proceed with the appointment. Let me know if you'd like help with the payment link.`);
                  delete pendingPayments[refId];
                }
              }, 2 * 60 * 60 * 1000);

              sessions[from].push({ role: "user", parts: [{ functionResponse: { name: call.name, response: { status: "link_generated_and_sent", is_payment_complete: false, system_note: "The system has sent the payment link. Payment is not complete." } } }] });
              sessions[from].push({ role: "model", parts: [{ text: "Payment link sent. The customer may reply YES to opt in to one follow-up reminder/offer, or STOP to opt out." }] });
            } catch (e) {
              if (createdPaymentLink?.id) {
                try { await razorpayClient.paymentLink.cancel(createdPaymentLink.id); } catch (_) { /* link may already be paid or expired */ }
                if (pool) await pool.query("UPDATE wa_payment_links SET status='delivery_failed',updated_at=NOW() WHERE payment_link_id=$1", [createdPaymentLink.id]).catch(() => {});
                if (GOOGLE_APPS_SCRIPT_SECRET) await postAppsScript({
                  target: 'payment_request_status', payment_link_id: createdPaymentLink.id, status: 'DELIVERY_FAILED'
                }).catch(() => {});
              }
              if (calendarHold?.event?.id) {
                await postAppsScript({ target: 'calendar_cancel', eventId: calendarHold.event.id }).catch(() => {});
              }
              // Google API errors can contain the complete event request (including
              // customer name, phone, service, and appointment time). Log only a
              // short diagnostic summary, never the request/config object.
              console.error('Payment-link workflow failed:', {
                message: e.message || 'Unknown error',
                code: e.code || null,
                status: e.status || e.response?.status || null,
                apiReason: e.response?.data?.error?.reason || null
              });
              await sendTextMessage(from, "Sorry, there was an error generating the secure payment link. Please try again later.");
              sessions[from].push({ role: "user", parts: [{ functionResponse: { name: call.name, response: { status: "error", error: e.message } } }] });
              sessions[from].push({ role: "model", parts: [{ text: "Understood, there was an error." }] });
            }
          }
          return; 
        }

        if (call.name === "verify_payment") {
          const plId = await findActivePaymentLinkId(from);
          if (!plId) {
            sessions[from].push({ role: "user", parts: [{ functionResponse: { name: call.name, response: { status: "error", error: "No active payment link found for this user." } } }] });
            sessions[from].push({ role: "model", parts: [{ text: "Understood. There's no active payment link to verify." }] });
            return;
          }
          try {
            const verification = await fetchAndFulfillVerifiedPayment(plId);
            const pl = verification.paymentLink;
            if (verification.paid) {
              sessions[from].push({ role: "user", parts: [{ functionResponse: { name: call.name, response: { status: "paid_and_fulfilled" } } }] });
              sessions[from].push({ role: "model", parts: [{ text: pl.notes?.gateway_test === 'true'
                ? "The ₹1 Razorpay gateway test was verified. A test receipt and test meeting details were sent; no consultation has been paid for or booked."
                : "Payment verified, booking confirmed, and receipt sent." }] });

            } else {
              sessions[from].push({ role: "user", parts: [{ functionResponse: { name: call.name, response: { status: "unpaid", razorpay_status: verification.status, amount_matches: verification.amountMatches } } }] });
              const msg = "I just checked, but the payment hasn't reflected yet. Sometimes the bank gateways take a minute. Please complete it via the link, and I will instantly send your official PDF invoice!";
              sessions[from].push({ role: "model", parts: [{ text: msg }] });
              await sendTextMessage(from, msg);
            }
          } catch (e) {
            sessions[from].push({ role: "user", parts: [{ functionResponse: { name: call.name, response: { status: "error", error: e.message } } }] });
            const msg = "I'm having trouble verifying the payment right now. Please wait a moment or try again.";
            sessions[from].push({ role: "model", parts: [{ text: msg }] });
            await sendTextMessage(from, msg);
          }
          return;
        }
      }

      // Handle Normal Text Response
      const responseText = result.response.text();
      if (responseText) {
        const cleanText = responseText.replace(/\[SEND_MENU\]/g, '').trim();
        if (cleanText) {
          await sendTextMessage(from, cleanText);
          if (GOOGLE_APPS_SCRIPT_URL && GOOGLE_APPS_SCRIPT_SECRET) {
            postAppsScript({ target: 'chat', phone: from, sender: 'AI', message: cleanText }).catch(e => {});
          }
        }
        if (responseText.includes('[SEND_MENU]')) {
          await sendInteractiveMenu(from);
        }
      }
    }
  } catch (err) {
    console.error('❌ CRITICAL ERROR in webhook processing:', err.message, err.stack);
    
    // Alert the Admin immediately so they know WHY it crashed without needing server logs
    try {
      if (ADMIN_PHONE_NUMBER) {
        await sendTextMessage(ADMIN_PHONE_NUMBER, `🚨 *WEBHOOK CRASH ALERT* 🚨\n\nError: ${err.message}\n\nCheck Render logs for the full stack trace.`);
      }
    } catch (e) { /* ignore admin alert failure */ }

    // Graceful, warm customer fallback (NEVER leak technical stack traces)
    try {
      const fallbackFrom = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (fallbackFrom) {
        await sendTextMessage(fallbackFrom, "Namaste! 🙏 I am currently reviewing your chart details. Please give me just a few moments, or feel free to type 'menu' to view our consultations.");
      }
    } catch (e) { /* ignore fallback failure */ }
  }
});

async function sendInteractiveMenu(to) {
  if (!WA_TOKEN || !liveData || liveData.length === 0) return;
  const rows = liveData.map(cat => ({
    id: `cat_${cat.id}`,
    title: cat.name.substring(0, 24),
    description: `View ${cat.services.length} services`.substring(0, 72)
  }));
  
  const data = {
    messaging_product: "whatsapp",
      to: normalizeWhatsAppNumber(to),
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Veshannastro Services ✨" },
      body: { text: "Namaste! 🙏 How can we guide you today?\n\nPlease select a category below:" },
      footer: { text: "Tap to view categories" },
      action: {
        button: "View Categories",
        sections: [{ title: "Service Categories", rows: rows }]
      }
    }
  };
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, data, {
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error("Failed to send category menu", err.response?.data || err.message);
  }
}

async function sendServiceMenu(to, categoryId) {
  if (!WA_TOKEN || !liveData) return;
  const category = liveData.find(c => c.id === categoryId);
  if (!category) return;
  
  const rows = category.services.slice(0, 10).map((svc, index) => ({
    id: `svc_${category.id}_${index}`,
    title: svc.t.substring(0, 24),
    description: `${svc.p} - ${svc.d}`.substring(0, 72)
  }));

  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: `${category.name} ✨` },
      body: { text: `Excellent choice! Here are our ${category.name} services. Tap one for details and booking.` },
      footer: { text: "Tap to view services" },
      action: {
        button: "View Services",
        sections: [{ title: category.name.substring(0, 24), rows: rows }]
      }
    }
  };
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, data, {
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error("Failed to send service menu", err.response?.data || err.message);
  }
}

async function sendTextMessage(to, text) {
  if (!WA_TOKEN) return false;
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to: normalizeWhatsAppNumber(to), type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    return true;
  } catch (err) {
    console.error("Failed to send text message", err.response?.data || err.message);
    return false;
  }
}

async function sendWhatsAppTemplate(to, templateName, bodyParameters = []) {
  if (!WA_TOKEN || !templateName) return false;
  try {
    const template = {
      name: templateName,
      language: { code: process.env.WA_TEMPLATE_LANGUAGE || 'en' }
    };
    if (bodyParameters.length) template.components = [{
      type: 'body',
      parameters: bodyParameters.map(text => ({ type: 'text', text: String(text).slice(0, 200) }))
    }];
    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp',
      to: normalizeWhatsAppNumber(to),
      type: 'template',
      template
    }, { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } });
    return true;
  } catch (error) {
    console.error('48-hour discount template send failed:', error.response?.data || error.message);
    return false;
  }
}

async function sendDiscountTemplate(to) {
  return sendWhatsAppTemplate(to, process.env.WA_48H_DISCOUNT_TEMPLATE);
}

async function sendFollowupTemplate(to, name) {
  return sendWhatsAppTemplate(to, process.env.WA_FOLLOWUP_TEMPLATE, [name || 'there']);
}

async function markAsRead(messageId) {
  if (!WA_TOKEN) return;
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', status: 'read', message_id: messageId },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error("Failed to mark as read", err.response?.data || err.message);
  }
}

app.get('/', (req, res) => res.send(`Veshannastro WhatsApp Booking Engine is running 🚀 (Live Sync Mode: ${liveData.length} categories loaded)`));

// Health Check Endpoint for Uptime Monitoring
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    services: {
      gemini: !!GEMINI_API_KEY,
      razorpay: !!razorpayClient,
      paymentVerification: !!(razorpayClient && GOOGLE_APPS_SCRIPT_SECRET),
      database: false,
      liveData: liveData.length
    }
  };
  try {
    if (pool) {
      await pool.query('SELECT 1');
      health.services.database = true;
    }
    res.json(health);
  } catch (e) {
    health.status = 'degraded';
    health.error = e.message;
    res.status(503).json(health);
  }
});

// Server-to-server verifier used by Apps Script. It does not create payments
// or alter the WhatsApp booking/fulfillment workflow; it only verifies an
// existing Razorpay payment against Razorpay's API.
app.get('/payments/verify/health', (req, res) => res.json({
  ok: true,
  payment_verification_configured: !!(razorpayClient && GOOGLE_APPS_SCRIPT_SECRET)
}));

app.post('/payments/verify', async (req, res) => {
  if (!secretsMatch(GOOGLE_APPS_SCRIPT_SECRET, req.get('X-Google-Apps-Script-Secret'))) {
    return res.status(401).json({ verified: false, error: 'Unauthorized.' });
  }
  if (!razorpayClient) return res.status(503).json({ verified: false, error: 'Payment verification is not configured.' });

  const paymentId = String(req.body?.payment_id || '').trim();
  const expectedAmountPaise = req.body?.expected_amount_paise;
  const currency = String(req.body?.currency || 'INR').toUpperCase();
  if (!/^pay_[A-Za-z0-9]+$/.test(paymentId)
      || !Number.isSafeInteger(expectedAmountPaise) || expectedAmountPaise <= 0
      || currency !== 'INR') {
    return res.status(400).json({ verified: false, error: 'Invalid payment verification request.' });
  }

  try {
    const result = await verifyCapturedPayment(razorpayClient, paymentId, expectedAmountPaise, currency);
    return res.json(result);
  } catch (error) {
    console.error('Razorpay payment verification request failed:', error.message);
    return res.status(502).json({ verified: false, error: 'Razorpay could not verify this payment right now.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- ENTERPRISE DRIP CAMPAIGN ENGINE ---
const cron = require('node-cron');

// A 10% retention message is sent only to opted-in customers and only via the
// approved WhatsApp template required outside Meta's 24-hour service window.
cron.schedule('0 * * * *', async () => {
  if (!pool || !process.env.WA_48H_DISCOUNT_TEMPLATE) return;
  try {
    const eligible = await pool.query(`SELECT l.payment_link_id,l.phone
      FROM wa_payment_links l JOIN users u ON u.phone=l.phone
      WHERE l.status IN ('created','expired') AND l.created_at <= NOW() - INTERVAL '48 hours'
        AND u.marketing_opt_in=true AND u.marketing_opt_out=false
        AND NOT EXISTS (SELECT 1 FROM wa_discount_offers d WHERE d.source_payment_link_id=l.payment_link_id)
      ORDER BY l.created_at ASC LIMIT 50`);
    for (const row of eligible.rows) {
      if (await sendDiscountTemplate(row.phone)) {
        await pool.query(`INSERT INTO wa_discount_offers (source_payment_link_id,phone,status)
          VALUES ($1,$2,'offered') ON CONFLICT (source_payment_link_id) DO NOTHING`, [row.payment_link_id, row.phone]);
        await pool.query(`UPDATE wa_payment_links SET status='discount10_offered',updated_at=NOW() WHERE payment_link_id=$1`, [row.payment_link_id]);
      }
    }
  } catch (error) {
    console.error('48-hour opted-in follow-up failed:', error.message);
  }
}, { timezone: 'Asia/Kolkata' });

// Runs daily at 10:00 AM IST
cron.schedule('0 10 * * *', async () => {
  if (!pool || !process.env.WA_FOLLOWUP_TEMPLATE) return;
  console.log("🚀 Running Daily Drip Campaigns...");

  try {
    // 1. 24-Hour Ghost Follow-Up (messaged yesterday, didn't convert)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    
    const ghosted = await pool.query(
      `SELECT phone,name FROM users WHERE is_customer = false AND is_paused = false AND marketing_opt_in = true AND marketing_opt_out = false AND status = 'lead' AND last_contact < $1 AND last_contact > $2 AND message_count >= 3`,
      [oneDayAgo, twoDaysAgo]
    );
    for (const row of ghosted.rows) {
      await sendFollowupTemplate(row.phone, row.name);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (ghosted.rows.length > 0) console.log(`📩 Sent ${ghosted.rows.length} ghost follow-ups`);

    // 2. Day 3 Unconverted Lead Nudge
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    
    const leads = await pool.query(
      `SELECT phone,name FROM users WHERE is_customer = false AND is_paused = false AND marketing_opt_in = true AND marketing_opt_out = false AND last_contact < $1 AND last_contact > $2`,
      [threeDaysAgo, fiveDaysAgo]
    );
    for (const row of leads.rows) {
      await sendFollowupTemplate(row.phone, row.name);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (leads.rows.length > 0) console.log(`📩 Sent ${leads.rows.length} day-3 lead nudges`);

    // 3. Day 2 Post-Consultation Referral
    const twoDaysAgoConv = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fourDaysAgoConv = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const recentConverted = await pool.query(
      `SELECT phone,name FROM users WHERE status = 'converted' AND is_paused = false AND marketing_opt_in = true AND marketing_opt_out = false AND conversion_date < $1 AND conversion_date > $2`,
      [twoDaysAgoConv, fourDaysAgoConv]
    );
    for (const row of recentConverted.rows) {
      await sendFollowupTemplate(row.phone, row.name);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (recentConverted.rows.length > 0) console.log(`📩 Sent ${recentConverted.rows.length} referral requests`);

    // 4. Day 7 Family Chart Cross-Sell
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    
    const converted = await pool.query(
      `SELECT phone,name FROM users WHERE status = 'converted' AND is_paused = false AND marketing_opt_in = true AND marketing_opt_out = false AND conversion_date < $1 AND conversion_date > $2`,
      [sevenDaysAgo, nineDaysAgo]
    );
    for (const row of converted.rows) {
      await sendFollowupTemplate(row.phone, row.name);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (converted.rows.length > 0) console.log(`📩 Sent ${converted.rows.length} family cross-sells`);

    // 4. Automated Birthday Upsell
    const allCustomers = await pool.query(`SELECT phone, name, dob FROM users WHERE is_customer = true AND marketing_opt_in = true AND marketing_opt_out = false AND dob IS NOT NULL`);
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const targetMonth = nextWeek.getMonth() + 1;
    const targetDay = nextWeek.getDate();
    
    let bdayCount = 0;
    for (const row of allCustomers.rows) {
      // Basic DOB parsing assuming dd-mm-yyyy or similar format
      const dobMatch = row.dob.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
      if (dobMatch) {
        const [, d, m] = dobMatch;
        if (parseInt(m) === targetMonth && parseInt(d) === targetDay) {
           await sendFollowupTemplate(row.phone, row.name);
           bdayCount++;
           await new Promise(r => setTimeout(r, 2000));
        }
      }
    }
    if (bdayCount > 0) console.log(`📩 Sent ${bdayCount} birthday upsells`);
    
    
  } catch (e) {
    console.error('❌ Drip campaign error:', e.message);
  }
}, {
  timezone: "Asia/Kolkata"
});
