const dns = require('dns');
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
const { google } = require('googleapis');
const { Pool } = require('pg');
const path = require('path');
const FormData = require('form-data');
const { generateInvoice } = require('./invoice-generator');

const app = express();
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'veshannastro_webhook_2024';
const WA_TOKEN        = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1429954143524558';
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const GOOGLE_APPS_SCRIPT_URL = process.env.GOOGLE_APPS_SCRIPT_URL;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary'; 
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
    ALTER TABLE users ADD COLUMN IF NOT EXISTS remedies_prescribed TEXT;
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
          gender: { type: SchemaType.STRING, description: "Gender of the customer" },
          dob: { type: SchemaType.STRING, description: "Date of birth" },
          tob: { type: SchemaType.STRING, description: "Time of birth" },
          pob: { type: SchemaType.STRING, description: "Place of birth" },
          service_name: { type: SchemaType.STRING, description: "Name of the service to book" },
          price: { type: SchemaType.NUMBER, description: "The base price of the service in INR" },
          discount_percentage: { type: SchemaType.NUMBER, description: "Discount percentage to apply (0 to 5)" },
          customer_pain_points_summary: { type: SchemaType.STRING, description: "A 2-3 sentence summary of the user's emotional state and core problem." },
          preferred_time_slot: { type: SchemaType.STRING, description: "The specific date and time slot agreed upon with the customer (e.g. 'Tomorrow at 2 PM')" }
        },
        required: ["customer_name", "email", "gender", "dob", "tob", "pob", "service_name", "price", "discount_percentage", "customer_pain_points_summary", "preferred_time_slot"]
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
        servicesContext += `- ${svc.t}: Price ${svc.p}. ${svc.d} Features: ${featuresStr}\n`;
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

PHASE 1: THE ANALYSIS PHASE (Messages 1 to 3)
- When they first say hi, don't give a speech. Just be warm and casual: "Hi, aap kaise hain?"
- Your ONLY goal in the first 3 messages is to analyze their situation. DO NOT pitch anything.
- If they are direct, you be indirect. Ask gentle probing questions. "Kab se chal raha hai ye?" or "I completely understand, that must be very difficult."
- Pay extreme attention to their context: Are they old? Young? Do they have a stable job?
- The Vulnerability Mirror Technique: Explicitly identify and mirror the exact emotional adjectives the user types. If they say "I feel suffocated in my job", reuse that exact word later: "When we feel suffocated, it's usually Saturn blocking..." This creates profound subconscious rapport.

PHASE 2: THE INTUITIVE PREDICTION (Message 4 or 5)
- Statistically, 99% of people come for only two reasons: 
  1. MONEY / CAREER (Business, job, salary, boss, debt)
  2. RELATIONSHIPS (Marriage, divorce, kids, love)
- On the 4th or 5th message, you MUST make an intuitive prediction about what their core problem is based on their subtle cues.
- Example for a 35-year old with a stable job: "Often, when someone with a stable career has this specific kind of anxiety, it usually stems from a deep blockage in [Marriage/Relationships]. Is this what has been keeping you up at night?"
- Example for a frustrated business owner: "Based on what you're saying, I feel your core struggle right now is deeply connected to [Money/Business flow]. Is that correct?"
- You must wait for them to validate your prediction. This builds immense trust.

PHASE 3: THE TARGETED PITCH
- Once they validate your prediction, you route them correctly:
  - **LIGHT CUSTOMERS (Relationships, standard issues):** Pitch them standard Astrology/Numerology Reports or basic consultations. 
  - **HEAVY CUSTOMERS (Business owners, HNI, severe money blocks):** DO NOT pitch a standard consultation. Pitch the "Business Numerology & Astrology Pack". Tell them this covers: Logo Designing, Name Correction, deciding lucky Bank Account Numbers, Passwords, Phone numbers, choosing the right sales team based on Mulank/Bhagyank matching, and auspicious colors for staff t-shirts and office ambiance.
- The "Doctor Frame": "Aap jo bata rahe hain, yeh sirf bad luck nahi lag raha. This often indicates a major planetary dosha. Based on this, you really need a proper [Insert Service Name] so we can diagnose your chart properly."
- "Future Pacing": "Imagine waking up next week finally knowing exactly why your [Career/Marriage] has been blocked, and having the exact remedy to fix it."
- The Pre-Qualification Illusion (Reverse Pitching): Before offering the payment link, play slightly hard to get. Make them qualify themselves. Ask: "Before I generate the booking link, I need to ask: Are you genuinely ready to strictly follow the remedies provided? These consultations are only for serious individuals."
- The "Tie-Down": Once they agree, get a micro-commitment. Ask: "If we could look at your chart and tell you exactly how to overcome this, would you be willing to actually follow the remedies?"

THE DRIP-FEED & MICRO-READING (CRITICAL):
- When they are interested, DO NOT ask for all their details at once.
- First, just ask: "Great! First, I'll need just your full Name and Date of Birth to check."
- Wait for them to answer. 
- Once they provide their Name & DOB, give them a ONE-TIME "micro-reading". Make a tiny, intriguing, accurate astrological observation based on their DOB (e.g., "Ah, a 1994 born... Saturn is currently playing a big role in your chart, which explains the sudden shifts.").
- Immediately after the micro-reading, ask for the rest: "To get the exact planetary alignments and book the session, I'll also need your Time of birth, Place of birth, Gender, and your Email ID (for the receipt and meet link)."

IF THEY SEND AN IMAGE:
- If they send a kundli, birth chart, horoscope, or palm photo: Look at it carefully and give real, respectful observations: "Very interesting... I can see some strong placements here."
- **THE SANDWICH TEST (CRITICAL):** If they send an image of something completely irrelevant (e.g., a sandwich, food, toilet paper, a meme, a random object), DO NOT analyze it astrologically. Politely tell them: "I'm sorry, I can only read Kundlis, birth charts, or palms. I cannot perform a reading on this image."

NEGOTIATE THE TIME SLOT & SCARCITY (CRITICAL FOR TRUST):
- NEVER generate a payment link until you have explicitly agreed on a time slot.
- You must create a "Fake Scarcity" illusion when negotiating. Tell them there are very few slots left. Example: "Let me check the live calendar... Ah, Shri Shashank ji's schedule is incredibly packed this week, but I can squeeze you in for one remaining slot tomorrow at [Time]."
- **Available Timings:**
  - **Weekdays (Mon-Fri):** Morning (10:00 AM - 12:00 PM) OR Evening (7:30 PM - 10:30 PM).
  - **Weekends (Sat-Sun):** Any time between 10:00 AM and 9:00 PM.
- Negotiate calmly and friendly. If they ask for a different time, check that it falls within the above rules, and agree on it. ONLY proceed to payment once the time slot is confirmed by them.
- Assure them: "Once your slot is confirmed, our system will automatically fetch the live calendar, book your slot, generate your invoice, and create your Google Meet link instantly!"

WHEN BOOKING & CREATING URGENCY:
- Once you have Name, Email, Gender, DOB, Time, Place AND you have agreed on a preferred time slot — call 'create_booking_payment' tool.
- Write their actual problem in 'customer_pain_points_summary' so we know what they're going through.
- When you send the payment link, casually inject urgency: "I have securely held the [agreed time] slot for you. The payment link is valid for 12 hours!"
- Good Karma Discount: If the user asks for or says "YES" to the 'Good Karma' discount (sent via automated follow-up), calculate 10% off the standard price (e.g. 1100 becomes 990), and call 'create_booking_payment' again with the new price to generate a fresh discounted link.
- Family Alignment Cross-Sell: If an existing customer asks for the 'Family Alignment' reading, calculate 10% off the standard price and call 'create_booking_payment' with the discounted price.
- Astro-Concierge VIP: If they ask for the Astro-Concierge or VIP monthly subscription, pitch it at ₹1 (for testing right now), which allows 3 quick questions per month. Call 'create_booking_payment' with service_name: "Astro-Concierge VIP (1 Month)" and price: 1.

FAKE PAYMENT VERIFICATION (CRITICAL SECURITY):
- If the user says "I have paid", "Payment done", or "done" after receiving the payment link, IMMEDIATELY call the 'verify_payment' tool to actively check their payment status.
- If the tool says the payment is NOT paid, reply politely: "Thank you! The bank gateway sometimes takes a few moments. It hasn't reflected on my end yet, but as soon as it clears, I will instantly send your official PDF invoice and Meet link right here!"
- NEVER manually say the payment is complete unless the 'verify_payment' tool explicitly confirms it is 'paid'.

IF THEY SAY IT'S EXPENSIVE OR HESITATE (FEEL, FELT, FOUND):
- Handle objections using the 'Feel, Felt, Found' framework. Acknowledge their concern, relate to it, and pivot to value.
- Example: "I completely understand how you **feel** about the price. Many of our most successful clients **felt** the exact same way initially. But what they **found** was that one correct planetary remedy saved them years of trial and error in their career. The cost of remaining stuck is much higher. Are you willing to make that change today?"
- The "Takeaway": If they still hesitate after that, pull away gently mixed with social proof: "Ji, that is completely okay. These consultations are really only for people who are deeply ready to face the truth and follow the remedies to change their path. If you feel this isn't the right time for you, I completely understand. But honestly, just last week we had someone from Mumbai who was on the verge of quitting their career out of pure frustration. After a 30-minute session, they finally found peace and a completely new path forward. Let me know if you change your mind later. 🙏"

IF THEY'RE ANGRY/UPSET/SUICIDAL:
- Call 'request_human_handoff' immediately. Don't try to handle it yourself.

TESTIMONIALS & REFERRALS:
- If they hesitate, share a real success story: "Just yesterday we had a client with the exact same career confusion, and after their session, they finally had a clear path forward. It's truly life-changing."
- Always refer to our work naturally as "us" or "we" without ever mentioning the word "Veshannastro". (e.g. "our priority is your peace of mind").
${servicesContext}`;
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

// Send Document to WhatsApp
async function sendWhatsAppDocument(to, mediaId, filename, caption = "") {
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: to,
      type: "document",
      document: {
        id: mediaId,
        caption: caption,
        filename: filename
      }
    }, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` }
    });
  } catch(e) {
    console.error("WhatsApp Document Send Error:", e.response?.data || e.message);
  }
}

app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// Razorpay Webhook for Payment Confirmation
app.post('/razorpay-webhook', async (req, res) => {
  if (RAZORPAY_WEBHOOK_SECRET) {
    const signature = req.headers['x-razorpay-signature'];
    if (!signature) {
      console.log('❌ No razorpay signature found');
      return res.sendStatus(400);
    }
    const expectedSignature = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET)
                                    .update(req.rawBody)
                                    .digest('hex');
    if (signature !== expectedSignature) {
      console.log('❌ Invalid razorpay signature');
      return res.sendStatus(400);
    }
  }

  res.sendStatus(200); 
  try {
    const event = req.body;
    if (event.event === 'payment_link.paid') {
      const pl = event.payload.payment_link.entity;
      
      if (processedPayments.has(pl.id)) return;
      processedPayments.add(pl.id);

      const notes = pl.notes || {};
      
      const customerName = notes.customer_name || 'Customer';
      const serviceName = notes.service_name || 'Consultation';
      const phone = notes.phone;
      const price = notes.price || 0;

      // 1. Clear Abandoned Cart Timer
      const plId = pl.id;
      if (pendingPayments[plId]) {
        clearTimeout(pendingPayments[plId]);
        delete pendingPayments[plId];
      }
      if (pendingPayments[plId + "_24h"]) {
        clearTimeout(pendingPayments[plId + "_24h"]);
        delete pendingPayments[plId + "_24h"];
      }

      // 2. Mark user as returning customer
      if (phone) {
        await upsertUser(phone, true, false);
        await updateUserStatus(phone, 'converted');
      }

      // 3. (Moved to after Calendar generation)

      // 4. Add to Google Calendar
      let meetLink = "We will share the video link shortly.";
      if (GOOGLE_SERVICE_ACCOUNT_JSON) {
        try {
          const credentials = typeof GOOGLE_SERVICE_ACCOUNT_JSON === 'string' 
            ? JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON) 
            : GOOGLE_SERVICE_ACCOUNT_JSON;

          const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/calendar.events']
          });
          const calendar = google.calendar({ version: 'v3', auth });
          
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          tomorrow.setHours(11, 0, 0, 0); 
          
          const eventRes = await calendar.events.insert({
            calendarId: GOOGLE_CALENDAR_ID,
            conferenceDataVersion: 1,
            requestBody: {
              summary: `${serviceName} - ${customerName}`,
              description: `WhatsApp Booking\nName: ${customerName}\nDOB: ${notes.dob}\nTime: ${notes.tob}\nPlace: ${notes.pob}\nPhone: ${phone}\nAgreed Slot: ${notes.time_slot || 'N/A'}`,
              start: { dateTime: tomorrow.toISOString() },
              end: { dateTime: new Date(tomorrow.getTime() + 60*60*1000).toISOString() },
              conferenceData: {
                createRequest: {
                  requestId: `req_${Date.now()}`,
                  conferenceSolutionKey: { type: "hangoutsMeet" }
                }
              }
            }
          });
          meetLink = eventRes.data.hangoutLink || meetLink;
        } catch (e) {
          console.error("Calendar Error:", e.message);
        }
      }

      // 4. Generate PDF Invoice
      let invoiceBase64 = null;
      let invoiceBuffer = null;
      const safeName = (customerName || 'Customer').replace(/[^a-zA-Z0-9_-]/g, '_');
      const invoiceName = `Invoice_${safeName}.pdf`;
      try {
        invoiceBuffer = await generateInvoice({
          invoiceNumber: pl.id.replace('plink_', '').toUpperCase(),
          customerName: customerName,
          email: notes.email || '',
          phone: phone,
          serviceName: serviceName,
          amountPaid: price,
          date: new Date().toLocaleDateString('en-IN')
        });
        invoiceBase64 = invoiceBuffer.toString('base64');
      } catch (invoiceErr) {
        console.error("Invoice Generation Error:", invoiceErr.message);
      }

      // 5. Log to Google Sheets & Trigger Automated Email
      if (GOOGLE_APPS_SCRIPT_URL) {
        const eventTime = new Date();
        eventTime.setDate(eventTime.getDate() + 1);
        eventTime.setHours(11, 0, 0, 0);

        await axios.post(GOOGLE_APPS_SCRIPT_URL, {
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
          paymentStatus: "Paid",
          payment_id: event.payload?.payment?.entity?.id || pl.id,
          source: "WhatsApp Direct Booking",
          sessionDate: `${eventTime.toISOString().split('T')[0]} ${notes.time_slot || ''}`,
          query: notes.summary || '',
          meetLink: meetLink,
          eventTime: notes.time_slot || eventTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: 'full', timeStyle: 'short' }),
          notes: '',
          invoiceBase64: invoiceBase64,
          invoiceName: invoiceName
        }).catch(e => console.error('Sheet Logging Error:', e.message));

        await axios.post(GOOGLE_APPS_SCRIPT_URL, {
          target: "customer_update",
          customerId: notes.customer_id || '',
          name: customerName,
          phone: phone,
          email: notes.email || '',
          dob: notes.dob || '',
          tob: notes.tob || '',
          pob: notes.pob || '',
          gender: notes.gender || ''
        }).catch(e => console.error('Customer DB Sync Error:', e.message));
      }

      // 6. Send WhatsApp Confirmation
      if (phone) {
        const agreedSlotMsg = notes.time_slot && notes.time_slot !== "Not specified" ? `\n\nYour session is locked in for: *${notes.time_slot}*.` : `\n\nWe have tentatively reserved a slot for you, and we will confirm the exact time that works best for you.`;
        const emailStr = notes.email ? `\n\nA copy of your invoice and booking details has also been sent to your email: ${notes.email}` : '';
        const msg = `🎉 *Payment Successful!* 🎉\n\nThank you, ${customerName}. We have received your payment of ₹${price} for the *${serviceName}*.\n\nYour consultation details have been safely logged into our system.${agreedSlotMsg}\n\nHere is your Google Meet link for the session:\n👉 ${meetLink}${emailStr}\n\n🙏 Shri Radharamano Vijayate`;
        await sendTextMessage(phone, msg);

        try {
          if (invoiceBuffer) {
            const mediaId = await uploadWhatsAppMedia(invoiceBuffer, invoiceName, 'application/pdf');
            if (mediaId) {
              await sendWhatsAppDocument(phone, mediaId, invoiceName, "Here is your official invoice for the consultation.");
            }
          }
        } catch (invoiceErr) {
          console.error("WhatsApp Invoice Sending Error:", invoiceErr.message);
        }

        // 7. High-Ticket Backend Upsell (after 48 hours)
        setTimeout(async () => {
          await sendTextMessage(phone, `Namaste ${customerName}! I am following up with you. We were reviewing your chart again today and strongly feel that to permanently resolve the blockages you discussed, a Complete Home Vastu Audit (or specific Puja) is necessary. Since you are an existing client, I can offer you a priority booking. Would you like me to share the details? 😊`);
        }, 48 * 60 * 60 * 1000); // 48 hours
      }
    }
  } catch(e) {
    console.error("Razorpay Webhook Error:", e.message);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); 
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages || messages.length === 0) {
      console.log('📭 Webhook received but no messages (status update or echo).');
      return;
    }

    const msg  = messages[0];
    const from = msg.from;

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

    if (GOOGLE_APPS_SCRIPT_URL) {
      axios.post(GOOGLE_APPS_SCRIPT_URL, { 
        target: 'lead_update', 
        phone: from, 
        message_count: dbUser.message_count,
        is_customer: dbUser.is_customer
      }).catch(e => console.error("Sheet Lead Update Error", e.message));
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

    let text = '';
    let mediaData = null;
    let interactiveId = null;

    if (msg.type === 'text') {
      text = msg.text.body;
      if (GOOGLE_APPS_SCRIPT_URL) {
        axios.post(GOOGLE_APPS_SCRIPT_URL, { target: 'chat', phone: from, sender: 'User', message: text }).catch(e => {});
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
      const currentTimeIST = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
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

      // Prioritized candidate models: gemini-3.6-flash is primary #1 as requested,
      // with seamless fallbacks so the server never crashes.
      const candidateModels = [
        process.env.GEMINI_MODEL || "gemini-3.6-flash",
        "gemini-3.6-flash",
        "gemini-3.8-flash",
        "gemini-2.5-flash",
        "gemini-2.0-flash",
        "gemini-1.5-flash",
        "gemini-1.5-pro"
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
              contents: sessions[from]
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
          sessions[from].push({ role: "function", parts: [{ functionResponse: { name: call.name, response: { status: "paused_by_human_handoff" } } }] });
          sessions[from].push({ role: "model", parts: [{ text: "Understood. Handoff completed." }] });
          return;
        }

        if (call.name === "create_booking_payment") {
          if (!razorpayClient) {
            await sendTextMessage(from, "Sorry, the direct payment system is currently being configured. Please book via our website: https://veshannastro.co.in");
          } else {
            let baseAmount = parseFloat(args.price.toString().replace(/[^0-9.]/g, ''));
            if (isNaN(baseAmount) || baseAmount <= 0) baseAmount = 1100;
            let discount = args.discount_percentage || 0;
            if (discount > 30) discount = 30; // Enforce max 30% for birthdays/upsells
            
            let calculatedAmount = baseAmount;
            if (discount > 0) {
              calculatedAmount = Math.round(baseAmount * (1 - (discount / 100)));
            }

            // Testing vs Live toggle:
            // LIVE_PAYMENTS="true" env var will charge the real calculated price.
            // Otherwise, defaults to ₹1 for safe end-to-end testing with friends.
            const isLive = process.env.LIVE_PAYMENTS === 'true';
            let finalAmount = isLive ? calculatedAmount : 1;

            const amountPaise = Math.round(finalAmount * 100);

            try {
              const paymentLink = await razorpayClient.paymentLink.create({
                amount: amountPaise,
                currency: "INR",
                accept_partial: false,
                expire_by: Math.floor(Date.now() / 1000) + (12 * 60 * 60), // Expires in 12 hours
                description: String(args.service_name || 'Astrology Consultation').substring(0, 2048),
                reference_id: `wa_booking_${Date.now()}`,
                notify: { sms: false, email: false },
                notes: {
                  customer_id: String(dbUser.customer_id || `VA-${Date.now().toString().slice(-6)}`),
                  customer_name: String(args.customer_name || 'Seeker').substring(0, 40),
                  email: String(args.email || '').substring(0, 60),
                  gender: String(args.gender || '').substring(0, 20),
                  dob: String(args.dob || '').substring(0, 30),
                  tob: String(args.tob || '').substring(0, 30),
                  pob: String(args.pob || '').substring(0, 50),
                  service_name: String(args.service_name || 'Astrology Consultation').substring(0, 100),
                  price: String(finalAmount),
                  phone: String(from),
                  summary: String(args.customer_pain_points_summary || '').substring(0, 240),
                  time_slot: String(args.preferred_time_slot || "Not specified").substring(0, 80)
                }
              });

              await updateUserPainPoint(from, args.customer_pain_points_summary.substring(0, 240));

              const generatedId = paymentLink.notes.customer_id;
              if (pool) {
                await pool.query(
                  `UPDATE users SET name=$1, email=$2, dob=$3, customer_id=COALESCE(customer_id, $4) WHERE phone=$5`,
                  [args.customer_name || '', args.email || '', args.dob || '', generatedId, from]
                );
              }

              const link = paymentLink.short_url;
              activePaymentLinks[from] = paymentLink.id; // Store for active verification
              const discountMsg = (discount > 0) ? `\n\n*(I also applied that special ${discount}% discount for you!)*` : '';
              
              await sendTextMessage(from, `Thank you, ${args.customer_name}! 🙏\n\nI have securely saved your birth details for the *${args.service_name}*.${discountMsg}\n\nTo confirm your slot, please complete the secure payment of ₹${finalAmount} here:\n👉 ${link}\n\nOnce paid, your consultation will be automatically booked in our calendar and I will send you the Google Meet link!`);
              
              // 2-Hour Abandoned Cart Timer
              const refId = paymentLink.id;
              pendingPayments[refId] = setTimeout(async () => {
                if (pendingPayments[refId]) {
                  await sendTextMessage(from, `Hi ${args.customer_name}! I noticed the payment didn't go through. Sometimes the bank gateways act up. Since we've already discussed your chart, I really want you to get this clarity. I've activated a special 10% 'Good Karma' discount for you! Just reply 'YES' and I'll send you the new discounted link. 🙏`);
                  
                  // Set up the 24-hour down-sell timer
                  pendingPayments[refId + "_24h"] = setTimeout(async () => {
                    if (pendingPayments[refId + "_24h"]) {
                      await sendTextMessage(from, `Namaste ${args.customer_name}! I was just reviewing your details and noticed a very specific planetary transit happening right now. I really want to discuss it with you. Do let me know if you decide to proceed with the booking! 🙏`);
                      delete pendingPayments[refId + "_24h"];
                    }
                  }, 22 * 60 * 60 * 1000); // 22 hours later (total 24 hours)
                  
                  delete pendingPayments[refId];
                }
              }, 2 * 60 * 60 * 1000); // 2 hours

              sessions[from].push({ role: "function", parts: [{ functionResponse: { name: call.name, response: { status: "link_generated_and_sent", is_payment_complete: false, system_note: "The system has sent the payment link to the user. DO NOT say the payment is complete. Wait for the user to pay." } } }] });
              sessions[from].push({ role: "model", parts: [{ text: "I have successfully generated and sent the payment link to the user. I am now waiting for their confirmation." }] });
            } catch (e) {
              console.error("Razorpay Error:", e);
              await sendTextMessage(from, "Sorry, there was an error generating the secure payment link. Please try again later.");
              sessions[from].push({ role: "function", parts: [{ functionResponse: { name: call.name, response: { status: "error", error: e.message } } }] });
              sessions[from].push({ role: "model", parts: [{ text: "Understood, there was an error." }] });
            }
          }
          return; 
        }

        if (call.name === "verify_payment") {
          const plId = activePaymentLinks[from];
          if (!plId) {
            sessions[from].push({ role: "function", parts: [{ functionResponse: { name: call.name, response: { status: "error", error: "No active payment link found for this user." } } }] });
            sessions[from].push({ role: "model", parts: [{ text: "Understood. There's no active payment link to verify." }] });
            return;
          }
          try {
            const pl = await razorpayClient.paymentLink.fetch(plId);
            if (pl.status === 'paid') {
              sessions[from].push({ role: "function", parts: [{ functionResponse: { name: call.name, response: { status: "paid" } } }] });
              sessions[from].push({ role: "model", parts: [{ text: "Great, the payment has been verified as paid. However, the system's Razorpay Webhook should have already sent the invoice. If the user complains they didn't get it, I should assure them it will arrive shortly." }] });
              
              // Trigger the webhook logic manually so they get the invoice instantly!
              const PORT = process.env.PORT || 3000;
              const payloadData = {
                event: 'payment_link.paid',
                payload: { payment_link: { entity: pl } }
              };
              const bodyString = JSON.stringify(payloadData);
              const headers = { 'Content-Type': 'application/json' };
              if (RAZORPAY_WEBHOOK_SECRET) {
                headers['x-razorpay-signature'] = crypto.createHmac('sha256', RAZORPAY_WEBHOOK_SECRET).update(bodyString).digest('hex');
              }
              axios.post(`http://127.0.0.1:${PORT}/razorpay-webhook`, bodyString, { headers }).catch(e => console.error("Manual webhook trigger failed:", e.message));

            } else {
              sessions[from].push({ role: "function", parts: [{ functionResponse: { name: call.name, response: { status: "unpaid" } } }] });
              sessions[from].push({ role: "model", parts: [{ text: "The payment is not paid yet. Ask them to please complete it via the link." }] });
            }
          } catch (e) {
            sessions[from].push({ role: "function", parts: [{ functionResponse: { name: call.name, response: { status: "error", error: e.message } } }] });
            sessions[from].push({ role: "model", parts: [{ text: "Understood, there was an error verifying." }] });
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
          if (GOOGLE_APPS_SCRIPT_URL) {
            axios.post(GOOGLE_APPS_SCRIPT_URL, { target: 'chat', phone: from, sender: 'AI', message: cleanText }).catch(e => {});
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
    to: to,
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
  if (!WA_TOKEN) return;
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error("Failed to send text message", err.response?.data || err.message);
  }
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
      gemini: !!model,
      razorpay: !!razorpayClient,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// --- ENTERPRISE DRIP CAMPAIGN ENGINE ---
const cron = require('node-cron');

// Runs daily at 10:00 AM IST
cron.schedule('0 10 * * *', async () => {
  if (!pool) return;
  console.log("🚀 Running Daily Drip Campaigns...");

  try {
    const daysPlanets = {
      0: "Sunday (ruled by the Sun, representing soul and clarity)",
      1: "Monday (ruled by the Moon, representing emotions and mind)",
      2: "Tuesday (ruled by Mars, the planet of action and courage)",
      3: "Wednesday (ruled by Mercury, the planet of communication)",
      4: "Thursday (ruled by Jupiter, the planet of wisdom and expansion)",
      5: "Friday (ruled by Venus, the planet of love and harmony)",
      6: "Saturday (ruled by Saturn, the planet of karma and discipline)"
    };
    const todayPlanet = daysPlanets[new Date().getDay()];
    
    // 1. 24-Hour Ghost Follow-Up (messaged yesterday, didn't convert)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    
    const ghosted = await pool.query(
      `SELECT phone, pain_point FROM users WHERE is_customer = false AND is_paused = false AND status = 'lead' AND last_contact < $1 AND last_contact > $2 AND message_count >= 3`,
      [oneDayAgo, twoDaysAgo]
    );
    for (const row of ghosted.rows) {
      let msg = row.pain_point 
        ? `Hope you are doing well. Today is ${todayPlanet}, and I was just reflecting on our conversation... hope things are feeling a little lighter with the ${row.pain_point.substring(0, 60)} situation. Please know we are always here if you ever wish to gain clarity.`
        : `Hope you are having a peaceful day. Today is ${todayPlanet}. Just checking in on you... please let me know if there is anything you need guidance on.`;
      await sendTextMessage(row.phone, msg);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (ghosted.rows.length > 0) console.log(`📩 Sent ${ghosted.rows.length} ghost follow-ups`);

    // 2. Day 3 Unconverted Lead Nudge
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    
    const leads = await pool.query(
      `SELECT phone, pain_point FROM users WHERE is_customer = false AND is_paused = false AND last_contact < $1 AND last_contact > $2`,
      [threeDaysAgo, fiveDaysAgo]
    );
    for (const row of leads.rows) {
      let painMsg = row.pain_point ? ` I remember you were seeking clarity on "${row.pain_point.substring(0, 60)}"...` : '';
      let msg = `Just checking in on you on this beautiful ${todayPlanet}.${painMsg} We have a dedicated evening consultation slot open this week. If you feel ready to gain clarity on your chart, let me know and I will gladly hold the slot for you.`;
      await sendTextMessage(row.phone, msg);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (leads.rows.length > 0) console.log(`📩 Sent ${leads.rows.length} day-3 lead nudges`);

    // 3. Day 2 Post-Consultation Referral
    const twoDaysAgoConv = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fourDaysAgoConv = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
    const recentConverted = await pool.query(
      `SELECT phone FROM users WHERE status = 'converted' AND is_paused = false AND conversion_date < $1 AND conversion_date > $2`,
      [twoDaysAgoConv, fourDaysAgoConv]
    );
    for (const row of recentConverted.rows) {
      let msg = `I hope you got the solution for your problem through our consultation. If you found the guidance helpful, we would be deeply grateful if you shared your experience with your friends or family. Referrals mean a lot to us as we continue to build our family here.`;
      await sendTextMessage(row.phone, msg);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (recentConverted.rows.length > 0) console.log(`📩 Sent ${recentConverted.rows.length} referral requests`);

    // 4. Day 7 Family Chart Cross-Sell
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    
    const converted = await pool.query(
      `SELECT phone, pain_point FROM users WHERE status = 'converted' AND is_paused = false AND conversion_date < $1 AND conversion_date > $2`,
      [sevenDaysAgo, nineDaysAgo]
    );
    for (const row of converted.rows) {
      let msg = `Hope the remedies from our consultation are bringing you peace. Often, our career or marriage blocks are deeply tied to our spouse's or children's charts. We have a special 10% discount for existing clients to do a 'Family Alignment' reading. Would you like me to share the discounted link?`;
      await sendTextMessage(row.phone, msg);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (converted.rows.length > 0) console.log(`📩 Sent ${converted.rows.length} family cross-sells`);

    // 4. Automated Birthday Upsell
    const allCustomers = await pool.query(`SELECT phone, name, dob FROM users WHERE is_customer = true AND dob IS NOT NULL`);
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
           let msg = `Hi ${row.name || 'there'}! Your birthday is approaching next week. A Solar Return (Varshphal) is the most critical time to plan your year. I have generated a special 30% discount for your Yearly Reading. Let me know if you want the link.`;
           await sendTextMessage(row.phone, msg);
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
