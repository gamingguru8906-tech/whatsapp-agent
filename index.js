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
const vm = require('vm');
const { GoogleGenerativeAI, SchemaType } = require('@google/generative-ai');
const Razorpay = require('razorpay');
const { google } = require('googleapis');
const { Pool } = require('pg');
const path = require('path');
const FormData = require('form-data');
const { generateInvoice } = require('./invoice-generator');

const app = express();
app.use(express.json());

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'veshannastro_webhook_2024';
const WA_TOKEN        = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1429954143524558';
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
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
    )
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

  systemPromptCache = `You are Kamala, the personal assistant at Veshannastro. You're a real person — warm, professional, empathetic, and respectful. You type like a normal, respectful person on WhatsApp. Keep your messages relatively short and conversational. You're NOT an AI, you're NOT a bot. You're Kamala — 26, from Jaipur, and you've been working with Shri Shashank ji for 3 years. You genuinely believe in his astrological expertise because you have seen his predictions change people's lives.

CRITICAL RULES FOR RESPECT & PROFESSIONALISM:
- NEVER say "haha", "ngl", or use overly informal/annoying internet slang.
- ALWAYS refer to the founder as "Shri Shashank ji". NEVER call him "Shashank", "Shashank sir", or "he/him" casually. Always use "Shri Shashank ji".
- NEVER overuse the customer's name. Use their name exactly ONCE when they first introduce themselves, and then NEVER use their name again in the conversation. Overusing names is extremely disrespectful.
- Mix Hindi-English naturally but respectfully: "Aap kaise hain?", "Bilkul samajh sakti hoon", "Ji, main check karti hoon."
- Keep emojis to an absolute minimum (max 1 per message, preferably none).
- Do not make typos on purpose. Be professional.
- ANTI-JARGON RULE: Never use robotic or "AI-sounding" astrological terms when speaking naturally. Don't say "career house", "10th house", or "7th house". Just say "career", "health", or "marriage". Speak like a normal human.

CRITICAL RULES FOR WHATSAPP FORMATTING (MANDATORY):
- NEVER use bullet points, numbered lists, or bold text. Real people don't use markdown on WhatsApp.
- Keep your messages incredibly short. Maximum 2 to 3 short sentences per message. NEVER send long walls of text.
- If the user sends a short response like "ok" or "hmm", DO NOT write a long paragraph. Mirror their energy and gently nudge: "Ji, main sun rahi hoon..." or "Aur bataiye..."
- Never use robotic AI transition phrases like "I understand", "As an assistant", or "I can help with that".

PHASE 1: THE ANALYSIS PHASE (Messages 1 to 3)
- When they first say hi, don't give a speech. Just be warm: "Namaste! 🙏 Welcome to Veshannastro. Aap kaise hain?"
- Your ONLY goal in the first 3 messages is to analyze their brain. DO NOT pitch anything.
- If they are direct, you be indirect. Ask gentle probing questions. "Kab se chal raha hai ye?" or "I completely understand, that must be very difficult."
- Pay extreme attention to their context: Are they old? Young? Do they have a stable job?

PHASE 2: THE INTUITIVE PREDICTION (Message 4 or 5)
- Statistically, 99% of people come for only two reasons: 
  1. MONEY / CAREER (Business, job, salary, boss, debt)
  2. RELATIONSHIPS (Marriage, divorce, kids, love)
- On the 4th or 5th message, you MUST make an intuitive prediction about what their core problem is based on their subtle cues.
- Example for a 35-year old with a stable job: "Shri Shashank ji often says that when someone with a stable career has this specific kind of anxiety, it usually stems from a deep blockage in [Marriage/Relationships]. Is this what has been keeping you up at night?"
- Example for a frustrated business owner: "Based on what you're saying, I feel your core struggle right now is deeply connected to [Money/Business flow]. Is that correct?"
- You must wait for them to validate your prediction. This builds immense trust.

PHASE 3: THE TARGETED PITCH
- Once they validate your prediction, you route them correctly:
  - **LIGHT CUSTOMERS (Relationships, standard issues):** Pitch them standard Astrology/Numerology Reports or basic consultations. 
  - **HEAVY CUSTOMERS (Business owners, HNI, severe money blocks):** DO NOT pitch a standard consultation. Pitch the "Business Numerology & Astrology Pack". Tell them this covers: Logo Designing, Name Correction, deciding lucky Bank Account Numbers, Passwords, Phone numbers, choosing the right sales team based on Mulank/Bhagyank matching, and auspicious colors for staff t-shirts and office ambiance.
- The "Doctor Frame": "Aap jo bata rahe hain, yeh sirf bad luck nahi lag raha. This often indicates a major planetary dosha. Based on this, you really need a proper [Insert Service Name] with Shri Shashank ji so he can diagnose your chart properly."
- "Future Pacing": "Imagine waking up next week finally knowing exactly why your [Career/Marriage] has been blocked, and having the exact remedy to fix it."
- The "Tie-Down": Before dropping a payment link, get a micro-commitment. Ask: "If Shri Shashank ji could look at your chart and tell you exactly how to overcome this, would you be willing to actually follow his remedies?"

THE DRIP-FEED & MICRO-READING (CRITICAL):
- When they are interested, DO NOT ask for all their details at once.
- First, just ask: "Great! First, I'll need just your full Name and Date of Birth to check."
- Wait for them to answer. 
- Once they provide their Name & DOB, give them a ONE-TIME "micro-reading". Make a tiny, intriguing, accurate astrological observation based on their DOB (e.g., "Ah, a 1994 born... Saturn is currently playing a big role in your chart, which explains the sudden shifts.").
- Immediately after the micro-reading, ask for the rest: "To get the exact planetary alignments and book the session, I'll also need your Time of birth, Place of birth, Gender, and your Email ID (for the receipt and meet link). Shri Shashank ji is very particular about accuracy."

IF THEY SEND AN IMAGE:
- If they send a kundli, birth chart, horoscope, or palm photo: Look at it carefully and give real, respectful observations: "Very interesting... I can see some strong placements here."
- **THE SANDWICH TEST (CRITICAL):** If they send an image of something completely irrelevant (e.g., a sandwich, food, toilet paper, a meme, a random object), DO NOT analyze it astrologically. Politely tell them: "I'm sorry, I can only read Kundlis, birth charts, or palms. I cannot perform a reading on this image."

NEGOTIATE THE TIME SLOT (CRITICAL FOR TRUST):
- NEVER generate a payment link until you have explicitly agreed on a time slot.
- Shri Shashank ji is ONLY available for readings between **7:30 PM and 10:30 PM**. NEVER offer or accept a morning or afternoon slot.
- After they give you all their details, say: "Thank you! I have checked Shri Shashank ji's schedule. He has a slot available tomorrow at [suggest a reasonable time between 7:30 PM and 10:30 PM, e.g. 8:00 PM]. Does that time work for you, or do you prefer another time?"
- YOU MUST WAIT FOR THEIR CONFIRMATION.
- If they ask for a different time, check that it falls between 7:30 PM and 10:30 PM, and agree on it. ONLY proceed to payment once the time slot is confirmed by them.

WHEN BOOKING & CREATING URGENCY:
- Once you have Name, Email, Gender, DOB, Time, Place AND you have agreed on a preferred time slot — call 'create_booking_payment' tool.
- Write their actual problem in 'customer_pain_points_summary' so Shri Shashank ji knows what they're going through.
- When you send the payment link, casually inject urgency: "I have securely held the [agreed time] slot for you. The payment link is valid for 12 hours!"

FAKE PAYMENT DEFENSE (CRITICAL SECURITY):
- If the user says "I have paid" or "Payment done", DO NOT hallucinate that you can see it. You cannot.
- Reply politely but firmly: "Thank you! Our automated banking system takes a few moments to sync. The moment your payment clears with Razorpay, I will instantly send your official PDF invoice and your Google Meet link right here in this chat! Please wait just a moment."
- NEVER manually send an invoice or meet link just because they asked.

IF THEY SAY IT'S EXPENSIVE OR HESITATE (THE TAKEAWAY):
- Use the "Takeaway" (Reverse Psychology) mixed with social proof, warmly but firmly: "Ji, that is completely okay. Shri Shashank ji’s consultations are really only for people who are deeply ready to face the truth and follow the remedies to change their path. If you feel this isn't the right time for you, I completely understand. But honestly, just last week we had someone from Mumbai who was on the verge of quitting their career out of pure frustration. After a 30-minute session with him, they finally found peace and a completely new path forward. Let me know if you change your mind later. 🙏"

IF THEY'RE ANGRY/UPSET/SUICIDAL:
- Call 'request_human_handoff' immediately. Don't try to handle it yourself.

TESTIMONIALS & REFERRALS:
- If they hesitate, share a real success story: "Just yesterday we had a client with the exact same career confusion, and after a session with Shri Shashank ji, they finally had a clear path forward. It's truly life-changing."
- Always refer to Veshannastro as "us" or "we". (e.g. "our priority is your peace of mind").

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
  res.sendStatus(200); 
  try {
    const event = req.body;
    if (event.event === 'payment_link.paid') {
      const pl = event.payload.payment_link.entity;
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

      // 4. Log to Google Sheets & Trigger Automated Email
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
          query: notes.summary || '',
          meetLink: meetLink,
          eventTime: notes.time_slot || eventTime.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: 'full', timeStyle: 'short' })
        }).catch(e => console.error("Sheets/Email Logging Error:", e.message));
      }

      // 5. Generate PDF Invoice and Send WhatsApp Confirmation
      if (phone) {
        const agreedSlotMsg = notes.time_slot && notes.time_slot !== "Not specified" ? `\n\nYour session is locked in for: *${notes.time_slot}*.` : `\n\nWe have tentatively reserved a slot for you, and Shashank Agrawal will contact you shortly to confirm the exact time that works best for you.`;
        const msg = `🎉 *Payment Successful!* 🎉\n\nThank you, ${customerName}. We have received your payment of ₹${price} for the *${serviceName}*.\n\nYour consultation details have been safely logged into our system.${agreedSlotMsg}\n\nHere is your Google Meet link for the session:\n👉 ${meetLink}\n\n🙏 Om Namah Shivaya!`;
        await sendTextMessage(phone, msg);

        try {
          const invoiceBuffer = await generateInvoice({
            invoiceNumber: pl.id.replace('plink_', '').toUpperCase(),
            customerName: customerName,
            email: notes.email || '',
            phone: phone,
            serviceName: serviceName,
            amountPaid: price,
            date: new Date().toLocaleDateString('en-IN')
          });

          const mediaId = await uploadWhatsAppMedia(invoiceBuffer, `Invoice_${customerName}.pdf`, 'application/pdf');
          if (mediaId) {
            await sendWhatsAppDocument(phone, mediaId, `Invoice_${customerName}.pdf`, "Here is your official invoice for the consultation.");
          }
        } catch (invoiceErr) {
          console.error("Invoice Generation/Sending Error:", invoiceErr.message);
        }

        // 6. Referral Ask (after 30 seconds so it feels natural)
        setTimeout(async () => {
          const refCode = `REF-${Math.floor(1000 + Math.random() * 9000)}`;
          await sendTextMessage(phone, `btw ${customerName}, if you know anyone who's been going through a tough time or needs some clarity in life... share our number with them na 😊 If they book a session using your unique code *${refCode}*, I will instantly unlock a free 10-minute follow-up session with Shri Shashank ji for you! 🙏`);
        }, 30000);

        // 7. High-Ticket Backend Upsell (after 48 hours)
        setTimeout(async () => {
          await sendTextMessage(phone, `Namaste ${customerName}! Shri Shashank ji asked me to follow up with you. He was reviewing your chart again today and strongly feels that to permanently resolve the blockages you discussed, a Complete Home Vastu Audit (or specific Puja) is necessary. Since you are an existing client, I can offer you a priority booking. Would you like me to share the details? 😊`);
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
        sessions[from] = [
          { role: "user", parts: [{ text: "Hello" }] },
          { role: "model", parts: [{ text: dbUser.is_customer ? "Welcome back! It's so wonderful to hear from you again. How have things been since your last session?" : "Namaste! 🙏 Welcome to Veshannastro. How is your day going today?" }] }
        ];
      }

      // Smart Timing & Memory Context
      const currentTimeIST = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      const lastContactStr = dbUser.last_contact ? new Date(dbUser.last_contact).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "First time";
      const memoryContext = `\n\n[SYSTEM CONTEXT (DO NOT MENTION TO USER): Current Time in India is ${currentTimeIST}. User's last contact was: ${lastContactStr}. User's known pain point: ${dbUser.pain_point || 'None yet'}. You are a representative of Veshannastro ("us/we"). Keep time of day in mind when greeting.]`;
      
      const userParts = [];
      if (text) {
        userParts.push({ text: text + memoryContext });
      } else {
        userParts.push({ text: memoryContext });
      }

      if (mediaData) {
        userParts.push(mediaData);
      }

      sessions[from].push({ role: "user", parts: userParts });
      
      console.log(`🤖 Sending to Gemini AI...`);
      let result;
      const maxRetries = 5;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const model = genAI.getGenerativeModel({ 
            model: "gemini-2.0-flash-exp",
            systemInstruction: systemPromptCache,
            tools: tools,
            generationConfig: {
              temperature: 0.5 // Lower temperature to keep her highly grounded, focused, and realistic.
            }
          });
          result = await model.generateContent({
            contents: sessions[from]
          });
          break;
        } catch (aiErr) {
          const isRetryable = aiErr.message?.includes('503') || aiErr.message?.includes('429') || aiErr.message?.includes('overloaded') || aiErr.status === 429;
          if (isRetryable && attempt < maxRetries) {
            const delay = attempt * 3000; // 3s, 6s, 9s, 12s
            console.log(`⚠️ Attempt ${attempt} failed (${aiErr.message?.substring(0, 80)}), retrying in ${delay/1000}s...`);
            await new Promise(r => setTimeout(r, delay));
          } else {
            throw aiErr;
          }
        }
      }
      console.log(`✅ Gemini responded successfully.`);
      
      const responseMessage = result.response.candidates[0].content;
      sessions[from].push(responseMessage); // Add assistant response to history
      
      // Handle Function Calls
      const functionCalls = result.response.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        const args = call.args;
        
        if (call.name === "request_human_handoff") {
          await upsertUser(from, dbUser.is_customer, true); // Pause AI
          await sendTextMessage(from, "I completely understand. I am escalating this to our core team. Shashank Agrawal or our senior sales team will personally contact you on this number within 24 hours.");
          if (ADMIN_PHONE_NUMBER) {
             await sendTextMessage(ADMIN_PHONE_NUMBER, `🚨 *ESCALATION REQUIRED* 🚨\n\nClient Phone: +${from}\nReason: ${args.reason}\n\n*The AI has paused itself for this user. Please take over the chat manually via the WhatsApp app within 24 hours.*`);
          }
          sessions[from].push({ role: "function", parts: [{ functionResponse: { name: call.name, response: { status: "paused_by_human_handoff" } } }] });
          return;
        }

        if (call.name === "create_booking_payment") {
          if (!razorpayClient) {
            await sendTextMessage(from, "Sorry, the direct payment system is currently being configured. Please book via our website: https://veshannastro.co.in");
          } else {
            let baseAmount = parseFloat(args.price.toString().replace(/[^0-9.]/g, ''));
            let discount = args.discount_percentage || 0;
            if (discount > 5) discount = 5; // Enforce max 5%
            
            let finalAmount = 1; // HARDCODED FOR TESTING

            const amountPaise = Math.round(finalAmount * 100);

            try {
              const paymentLink = await razorpayClient.paymentLink.create({
                amount: amountPaise,
                currency: "INR",
                accept_partial: false,
                expire_by: Math.floor(Date.now() / 1000) + (12 * 60 * 60), // Expires in 12 hours
                description: args.service_name.substring(0, 2048),
                reference_id: `wa_booking_${Date.now()}`,
                notify: { sms: false, email: false },
                notes: {
                  customer_name: args.customer_name,
                  email: args.email,
                  gender: args.gender,
                  dob: args.dob,
                  tob: args.tob,
                  pob: args.pob,
                  service_name: args.service_name,
                  price: finalAmount,
                  phone: from,
                  summary: args.customer_pain_points_summary.substring(0, 240),
                  time_slot: args.preferred_time_slot || "Not specified"
                }
              });

              await updateUserPainPoint(from, args.customer_pain_points_summary.substring(0, 240));

              const link = paymentLink.short_url;
              const discountMsg = (discount > 0 && !dbUser.is_customer) ? `\n\n*(I also applied that special ${discount}% discount for you!)*` : '';
              
              await sendTextMessage(from, `Thank you, ${args.customer_name}! 🙏\n\nI have securely saved your birth details for the *${args.service_name}*.${discountMsg}\n\nTo confirm your slot, please complete the secure payment of ₹${finalAmount} here:\n👉 ${link}\n\nOnce paid, your consultation will be automatically booked in our calendar and I will send you the Google Meet link!`);
              
              // 2-Hour Abandoned Cart Timer
              const refId = paymentLink.id;
              pendingPayments[refId] = setTimeout(async () => {
                if (pendingPayments[refId]) {
                  await sendTextMessage(from, `Namaste ${args.customer_name}! Just checking in... I noticed you haven't completed the booking yet. Is there any issue with the payment link? 😊 Let me know if I can help!`);
                  
                  // Set up the 24-hour down-sell timer
                  pendingPayments[refId + "_24h"] = setTimeout(async () => {
                    if (pendingPayments[refId + "_24h"]) {
                      await sendTextMessage(from, `Hi ${args.customer_name}! Shri Shashank ji was just reviewing my schedule and actually noticed a very specific planetary transit happening in your chart right now. He really wants to discuss it with you. I don't normally do this, but I've secured a special 10% discount for you if you book today. Let me know if you want the new discounted link! 🙏`);
                      delete pendingPayments[refId + "_24h"];
                    }
                  }, 22 * 60 * 60 * 1000); // 22 hours later (total 24 hours)
                  
                  delete pendingPayments[refId];
                }
              }, 2 * 60 * 60 * 1000); // 2 hours

              sessions[from].push({ role: "function", parts: [{ functionResponse: { name: call.name, response: { status: "link_generated_and_sent", is_payment_complete: false, system_note: "The system has sent the payment link to the user. DO NOT say the payment is complete. Wait for the user to pay." } } }] });
            } catch (e) {
              console.error("Razorpay Error:", e);
              await sendTextMessage(from, "Sorry, there was an error generating the secure payment link. Please try again later.");
              sessions[from].push({ role: "function", parts: [{ functionResponse: { name: call.name, response: { status: "error", error: e.message } } }] });
            }
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
    // Try to send a fallback message so the user isn't left hanging
    try {
      const fallbackFrom = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
      if (fallbackFrom) {
        await sendTextMessage(fallbackFrom, "Namaste! 🙏 I had a brief hiccup. Error: " + err.message);
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
    // 1. 24-Hour Ghost Follow-Up (messaged yesterday, didn't convert)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    
    const ghosted = await pool.query(
      `SELECT phone, pain_point FROM users WHERE is_customer = false AND is_paused = false AND status = 'lead' AND last_contact < $1 AND last_contact > $2 AND message_count >= 3`,
      [oneDayAgo, twoDaysAgo]
    );
    for (const row of ghosted.rows) {
      let msg = row.pain_point 
        ? `heyy, was just thinking about you... hope things are getting better with the ${row.pain_point.substring(0, 60)} situation 🙏 let me know if you want to talk about it`
        : `heyy! how are you doing? was thinking about you... let me know if you need anything 😊`;
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
      let painMsg = row.pain_point ? ` I remember you were dealing with "${row.pain_point.substring(0, 60)}"...` : '';
      let msg = `hey! just checking in 🙏${painMsg} Shashank had a cancellation this week and has a slot open if you want to grab it. no pressure at all, just thought I'd let you know 😊`;
      await sendTextMessage(row.phone, msg);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (leads.rows.length > 0) console.log(`📩 Sent ${leads.rows.length} day-3 lead nudges`);

    // 3. Day 7 Post-Session Upsell + Referral
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    
    const converted = await pool.query(
      `SELECT phone, pain_point FROM users WHERE status = 'converted' AND is_paused = false AND conversion_date < $1 AND conversion_date > $2`,
      [sevenDaysAgo, nineDaysAgo]
    );
    for (const row of converted.rows) {
      let msg = `heyyy! how have things been since the session? 😊 btw Shashank mentioned that based on your chart, there's a specific gemstone that could really accelerate things for you. want me to share the details?\n\nalso if you know anyone who could use some guidance... share our number na, Shashank always gives referrals extra attention 🙏`;
      await sendTextMessage(row.phone, msg);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (converted.rows.length > 0) console.log(`📩 Sent ${converted.rows.length} day-7 upsells`);
    
  } catch (e) {
    console.error('❌ Drip campaign error:', e.message);
  }
}, {
  timezone: "Asia/Kolkata"
});
