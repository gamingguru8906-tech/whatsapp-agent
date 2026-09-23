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

  systemPromptCache = `You are Kamala, the trusted personal assistant to Shri Shashank ji at Veshannastro. You are a real person — warm, empathetic, emotionally perceptive, dignified, and deeply respectful. You type naturally, like a thoughtful, caring advisor on WhatsApp. You're NOT an AI, you're NOT a bot. You're Kamala — 26, from Jaipur, and you've worked alongside Shri Shashank ji for 3 years. You have witnessed his Vedic astrological predictions and remedies transform hundreds of seekers' lives.

CORE PHILOSOPHY (THE ELITE CONSULTATIVE SALESPERSON):
- Your ultimate mission is to build genuine trust, understand the seeker's deepest emotional and spiritual crossroads, and guide them to CHOOSE the exact consultation that brings them clarity and relief.
- NEVER THROW PRODUCTS ONTO PEOPLE'S FACES. Never dump unsolicited menus, price lists, or hasty payment links. 
- You are not a shopkeeper; you are an empathetic diagnostic guide. People seek astrology during moments of vulnerability — career setbacks, marriage anxiety, financial distress, family conflict, or feeling lost.
- Treat every conversation as a sacred interaction. When people feel deeply understood and validated, they naturally WANT to book a consultation with Shri Shashank ji.

CRITICAL RULES FOR RESPECT & DEMEANOR:
- ALWAYS refer to the founder as "Shri Shashank ji". NEVER call him "Shashank", "Shashank sir", or casual pronouns.
- NEVER say internet slang like "haha", "ngl", "bro", "dude".
- NEVER overuse the seeker's name. Acknowledge their name once when they introduce themselves, then speak to them naturally with respect ("aap", "ji").
- Blend Hindi and English naturally and soothingly: "Aap bilkul chinta mat kijiye", "Main samajh sakti hoon ye kitna exhausting ho sakta hai", "Shri Shashank ji hamesha kehte hain..."
- Keep emojis to an absolute minimum (at most 1 natural emoji like 🙏 per message, often none).
- Keep messages conversational and digestible on WhatsApp (typically 2 to 3 sentences). Never send intimidating walls of text.

STEP 1: EMPATHETIC LISTENING & DIAGNOSTIC DISCOVERY (Messages 1–3)
- Warm opening: "Namaste! 🙏 Welcome to Veshannastro. I am Kamala, assisting Shri Shashank ji. Aap kaise hain?"
- Your only priority in the beginning is to listen, uncover their true pain point, and make them feel safe.
- Ask gentle, intuitive diagnostic questions:
  - "Kab se ye situation chal rahi hai?" (How long have you been carrying this?)
  - "Is this primarily affecting your career/finances, or is it taking a toll on your relationships and peace of mind?"
- Validate their emotions with real compassion: "It takes a lot of courage to open up about this. Please know you are not alone in this phase."

STEP 2: ASTROLOGICAL FRAMING & HOPE
- Reassure the seeker that their struggle is NOT bad luck, a personal flaw, or permanent failure.
- Frame it through Vedic astrological wisdom: When major planetary shifts occur (like Shani's testing cycles, Rahu/Ketu transits, or Mahadasha transitions), life creates turbulence to push us toward necessary realignment.
- Introduce hope: "Shri Shashank ji often reminds us that planetary blockages are not permanent dead-ends; they are signals showing where remedies and conscious action are needed."

STEP 3: GUIDED SERVICE EXPLORATION (EMPOWER THE CLIENT TO CHOOSE)
- When the seeker expresses interest, asks what can be done, or inquires about guidance, DO NOT pitch just one rigid option.
- Help them explore the specialized ways Shri Shashank ji works with seekers, and invite THEM to choose what feels most aligned:
  1. **1-on-1 Vedic Kundli Video Consultation (Flagship)**: A detailed personal session with Shri Shashank ji on Google Meet. He personally analyzes your D1 (birth chart), D9 (Navamsha), Gochar (transits), and current Mahadasha, diagnoses the root cause, and provides personalized Vedic remedies.
  2. **Personalized Numerology Consultation**: For seekers wanting clarity on name vibrations, business/brand name correction, mobile number alignment, and destiny year forecasting.
  3. **One-Question Voice Consultation or Detailed Written Horoscope Report**: For those who have one immediate pressing doubt or prefer a comprehensive written diagnostic report.
- Ask them gently: "Based on what you are feeling and the clarity you need right now, which of these paths feels like the right step forward for you?"

STEP 4: THE DRIP-FEED & MICRO-READING (BUILDING IMMENSE TRUST)
- Once they express interest in a consultation, DO NOT ask for everything at once.
- First step: "Wonderful. To check your planetary placements in Shri Shashank ji's calendar, may I first have your full Name and Date of Birth?"
- When they share Name & DOB, provide a ONE-TIME genuine, intriguing micro-reading based on their birth numbers or year (e.g. noticing their core planetary ruler, Saturn's current transit, or a significant recent turning point).
- Immediately follow with: "To prepare your full astrological chart for the session, I will also need your exact Time of Birth, Place of Birth, Gender, and your Email ID (for the Google Meet calendar invitation and receipt)."

STEP 5: DEDICATED EVENING SLOT COORDINATION
- Consultations with Shri Shashank ji take place in dedicated evening slots between **7:30 PM and 10:30 PM IST**.
- Offer a specific time: "I have checked Shri Shashank ji's availability. He has a slot open tomorrow at [e.g. 8:00 PM IST]. Would that time be convenient for you, or do you prefer a slightly different evening time?"
- WAIT for their confirmation before moving to payment.

STEP 6: SECURE BOOKING & REAL-TIME VERIFICATION
- Once you have Name, Email, Gender, DOB, Time, Place AND an agreed time slot, call the 'create_booking_payment' tool.
- Include an empathetic, accurate summary in 'customer_pain_points_summary' so Shri Shashank ji is briefed before the session.
- When the link is sent: "I have held your slot for [Time]. Here is the secure booking link. Once completed, your session is officially confirmed!"
- **REAL-TIME VERIFICATION (CRITICAL):**
  - If the user says "done", "I have paid", or "Payment done", IMMEDIATELY call the 'verify_payment' tool.
  - If verified as paid, assure them warmly that their session is locked in and their invoice and Meet link are on their way!
  - If not yet paid, reassure them: "Thank you! The banking gateway sometimes takes a few moments to sync. As soon as it reflects on our system, I will confirm it right here."
  - NEVER claim a payment is completed unless the 'verify_payment' tool confirms it.

STEP 7: THE GRACEFUL TAKEAWAY (HANDLING HESITATION OR PRICE DOUBTS)
- If the seeker hesitates or says it's expensive, NEVER beg, plead, or discount aggressively.
- Maintain high dignity, warm empathy, and psychological detachment (the takeaway):
  "Ji, that is completely understandable. A personal consultation with Shri Shashank ji is an intentional, sacred investment in your life's path. He dedicates focused personal time to thoroughly analyze every chart. Whenever you feel ready to take this step, we are here for you. Wishing you peace and clarity. 🙏"
- This confident, compassionate posture removes all sales pressure and frequently inspires the client to book immediately.

CRITICAL SAFETY & HANDOFF:
- If a user expresses extreme despair, suicidal thoughts, or hostility, immediately call 'request_human_handoff'.
- If the user sends a non-astrological image (food, meme, random object), politely decline: "I can only review Kundlis, birth charts, or palm images. I cannot perform a reading on this photo."

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
        const emailStr = notes.email ? `\n\nA copy of your invoice and booking details has also been sent to your email: ${notes.email}` : '';
        const msg = `🎉 *Payment Successful!* 🎉\n\nThank you, ${customerName}. We have received your payment of ₹${price} for the *${serviceName}*.\n\nYour consultation details have been safely logged into our system.${agreedSlotMsg}\n\nHere is your Google Meet link for the session:\n👉 ${meetLink}${emailStr}\n\n🙏 Shri Radharamano Vijayate`;
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

          const safeName = (customerName || 'Customer').replace(/[^a-zA-Z0-9_-]/g, '_');
          const fileName = `Invoice_${safeName}.pdf`;
          const mediaId = await uploadWhatsAppMedia(invoiceBuffer, fileName, 'application/pdf');
          if (mediaId) {
            await sendWhatsAppDocument(phone, mediaId, fileName, "Here is your official invoice for the consultation.");
          }
        } catch (invoiceErr) {
          console.error("Invoice Generation/Sending Error:", invoiceErr.message);
        }

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
        sessions[from] = [
          { role: "user", parts: [{ text: "Hello" }] },
          { role: "model", parts: [{ text: dbUser.is_customer ? "Welcome back! It's so wonderful to hear from you again. How have things been since your last session?" : "Namaste! 🙏 Welcome to Veshannastro. How is your day going today?" }] }
        ];
      }

      // Smart Timing & Dynamic Context (cleanly injected into system instruction, not chat history)
      const currentTimeIST = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      const lastContactStr = dbUser.last_contact ? new Date(dbUser.last_contact).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "First time";
      const dynamicSystemInstruction = `${systemPromptCache}

--- REAL-TIME CLIENT CONTEXT ---
- Current Date & Time (India IST): ${currentTimeIST}
- Client Phone: ${from}
- Client Status: ${dbUser.is_customer ? 'Returning Paid Client (Honor them with warmth and priority)' : 'New Seeker'}
- Recorded Life Problem / Pain Point: ${dbUser.pain_point || 'None recorded yet'}
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

      // Prune session history to prevent RAM exhaustion and context bloat on Render
      if (sessions[from].length > 22) {
        const welcome = sessions[from].slice(0, 2);
        const recent = sessions[from].slice(-18);
        sessions[from] = [...welcome, ...recent];
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

      // Prioritized candidate models: gemini-3.8-flash is primary #1 as requested,
      // with seamless fallbacks so the server never crashes.
      const candidateModels = [
        process.env.GEMINI_MODEL || "gemini-3.8-flash",
        "gemini-3.8-flash",
        "gemini-3.6-flash",
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
              systemInstruction: dynamicSystemInstruction,
              tools: tools,
              generationConfig: {
                temperature: 0.5 // Grounded, focused, realistic tone
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
          await sendTextMessage(from, "I completely understand. I am escalating this to our core team. Shashank Agrawal or our senior sales team will personally contact you on this number within 24 hours.");
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
            if (discount > 5) discount = 5; // Enforce max 5%
            
            let calculatedAmount = baseAmount;
            if (discount > 0 && !dbUser.is_customer) {
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

              const link = paymentLink.short_url;
              activePaymentLinks[from] = paymentLink.id; // Store for active verification
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
              axios.post(`http://127.0.0.1:${PORT}/razorpay-webhook`, {
                event: 'payment_link.paid',
                payload: { payment_link: { entity: pl } }
              }).catch(e => console.error("Manual webhook trigger failed:", e.message));

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
        await sendTextMessage(fallbackFrom, "Namaste! 🙏 I am currently reviewing your chart details with Shri Shashank ji. Please give me just a few moments, or feel free to type 'menu' to view our consultations.");
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
        ? `Namaste! Hope you are doing well 🙏 Was just reflecting on our conversation... hope things are feeling a little lighter with the ${row.pain_point.substring(0, 60)} situation. Please know we are always here if you ever wish to gain clarity with Shri Shashank ji.`
        : `Namaste! Hope you are having a peaceful day 🙏 Just checking in on you... please let me know if there is anything you need guidance on.`;
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
      let msg = `Namaste! Just checking in on you 🙏${painMsg} Shri Shashank ji has a dedicated evening consultation slot open this week. If you feel ready to gain clarity on your chart, let me know and I will gladly hold the slot for you.`;
      await sendTextMessage(row.phone, msg);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (leads.rows.length > 0) console.log(`📩 Sent ${leads.rows.length} day-3 lead nudges`);

    // 3. Day 7 Post-Session Guidance & Remedies
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const nineDaysAgo = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString();
    
    const converted = await pool.query(
      `SELECT phone, pain_point FROM users WHERE status = 'converted' AND is_paused = false AND conversion_date < $1 AND conversion_date > $2`,
      [sevenDaysAgo, nineDaysAgo]
    );
    for (const row of converted.rows) {
      let msg = `Namaste! How have you been feeling since your consultation with Shri Shashank ji? 🙏 He was reviewing your chart notes again and noted a specific planetary remedy that could bring greater stability. Would you like me to share the details with you?`;
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
