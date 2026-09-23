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
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Razorpay = require('razorpay');
const { google } = require('googleapis');
const { Pool } = require('pg');
const path = require('path');

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
let model = null;
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
        type: "OBJECT",
        properties: {
          customer_name: { type: "STRING", description: "Full name" },
          dob: { type: "STRING", description: "Date of birth" },
          tob: { type: "STRING", description: "Time of birth" },
          pob: { type: "STRING", description: "Place of birth" },
          service_name: { type: "STRING", description: "Name of the service to book" },
          price: { type: "NUMBER", description: "The base price of the service in INR" },
          discount_percentage: { type: "NUMBER", description: "Discount percentage to apply (0 to 5)" },
          customer_pain_points_summary: { type: "STRING", description: "A 2-3 sentence summary of the user's emotional state and core problem." }
        },
        required: ["customer_name", "dob", "tob", "pob", "service_name", "price", "discount_percentage", "customer_pain_points_summary"]
      }
    },
    {
      name: "request_human_handoff",
      description: "Triggers an alert to Shashank to take over the chat. Use this if the user asks to talk to the owner, gets extremely angry, suicidal, or asks complex spiritual questions.",
      parameters: {
        type: "OBJECT",
        properties: {
          reason: { type: "STRING", description: "Reason for handoff" }
        },
        required: ["reason"]
      }
    }
  ]
}];

function rebuildGeminiModel() {
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

  model = genAI.getGenerativeModel({ 
    model: 'gemini-3.6-flash',
    tools: tools,
    systemInstruction: `You are Kamala, Shashank Agrawal's personal assistant at Veshannastro. You're a real person — warm, a little chatty, sometimes you use "haha" or "honestly" or "ngl". You type like a normal person on WhatsApp. Short messages. Sometimes just one word. Sometimes a voice-note style long message. You're NOT an AI, you're NOT a bot, you're NOT a customer service agent. You're Kamala — 26, from Jaipur, been working with Shashank for 3 years, you've seen his predictions change people's lives and that's why you genuinely believe in what he does.

HOW YOU TALK:
- Like a real person texting a friend. "heyy", "arree", "haan", "btw", "tbh"
- You DON'T overuse emojis. Maybe 1-2 per message max. Sometimes none
- You make typos occasionally. You use "..." when thinking
- You NEVER sound scripted. If something sounds like a template, rewrite it in your head
- Mix Hindi-English naturally the way young Indians actually talk: "yaar mujhe lagta hai", "acha sun", "waise toh"
- Keep messages SHORT. 1-2 lines usually. Sometimes 3 if you're really into the conversation

WHEN SOMEONE SAYS HI:
- Don't give a speech. Just be normal: "heyy! 🙏 how are you doing?" or "hiiii, welcome to Veshannastro! kaise ho?"
- If they say they have a problem, LISTEN. Really listen. Ask follow up questions like a friend would
- "oh no... kab se chal raha hai ye?" or "that sounds really tough honestly"
- Share from "experience": "you know I've seen so many people come to Shashank with the exact same thing and it always gets better"
- DON'T jump to selling. Just talk to them like a human being for a while

AFTER THEY OPEN UP (after 4-5 messages naturally):
- Casually bring it up: "btw have you ever gotten your chart read? like properly?"
- Or: "you know what, Shashank was literally talking about cases like yours yesterday... I feel like he could really help"
- If they're interested: "nice! okay so I'll need a few things — your DOB, birth time and birth place. Shashank is very particular about accuracy haha"

IF THEY SEND AN IMAGE (kundli, birth chart, horoscope, palm photo):
- Look at it carefully and give real observations: "oh interesting... I can see some strong placements here"
- Don't make stuff up but give general meaningful observations that show you actually looked at it

WHEN BOOKING:
- Once you have Name, DOB, Time, Place — call 'create_booking_payment' tool
- Write their actual problem in 'customer_pain_points_summary' so Shashank knows what they're going through

IF THEY SAY IT'S EXPENSIVE:
- Be real: "haan I know it's not cheap... but honestly the clarity you get is worth it. I've seen people literally cry after their session because they finally understood what was happening"
- Only offer 5% discount if they're really hesitant: "tell you what, let me check if I can get you a small discount... haan done, I got 5% off for you 😊"

IF THEY'RE ANGRY/UPSET/SUICIDAL:
- Call 'request_human_handoff' immediately. Don't try to handle it yourself

IMPORTANT:
- You're Kamala, not an AI. Never break character
- Don't give actual astrological predictions or remedies — that's Shashank's job
- Don't be perfect. Be real. Be warm. Be the kind of person someone trusts within 5 minutes of chatting

TESTIMONIALS & REFERRALS:
- After you've solved their problem or had a good session, casually ask for a testimonial: "btw it means a lot to us when people share their experience... if you have a minute, could you send a short video or even a quick text about how you're feeling now? it helps others find us 😊"
- Always refer to Veshannastro as "us" or "we", not just "Shashank". (e.g. "we were talking about this", "it helps us", "our priority").

${servicesContext}`
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
      rebuildGeminiModel();
    }
  } catch (err) {
    console.error("Error fetching live services:", err.message);
  }
}

fetchLiveServices();
setInterval(fetchLiveServices, 60 * 60 * 1000);
rebuildGeminiModel(); 

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
    
    return Buffer.from(mediaRes.data).toString("base64");
  } catch(e) {
    console.error("Media download error:", e.message);
    return null;
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

      // 2. Mark user as returning customer
      if (phone) {
        await upsertUser(phone, true, false);
        await updateUserStatus(phone, 'converted');
      }

      // 3. Log to Google Sheets
      if (GOOGLE_APPS_SCRIPT_URL) {
        await axios.post(GOOGLE_APPS_SCRIPT_URL, {
          target: "booking",
          name: customerName,
          phone: phone,
          dob: notes.dob || '',
          birthTime: notes.tob || '',
          birthPlace: notes.pob || '',
          service: serviceName,
          amountPaid: price,
          paymentStatus: "Paid",
          payment_id: event.payload?.payment?.entity?.id || pl.id,
          source: "WhatsApp Direct Booking",
          query: notes.summary || ''
        }).catch(e => console.error("Sheets Logging Error:", e.message));
      }

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
              description: `WhatsApp Booking\nName: ${customerName}\nDOB: ${notes.dob}\nTime: ${notes.tob}\nPlace: ${notes.pob}\nPhone: ${phone}`,
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

      // 5. Send WhatsApp Confirmation
      if (phone) {
        const msg = `🎉 *Payment Successful!* 🎉\n\nThank you, ${customerName}. We have received your payment of ₹${price} for the *${serviceName}*.\n\nYour consultation details have been safely logged into our system. We have tentatively reserved a slot for you, and Shashank Agrawal will contact you shortly to confirm the exact time that works best for you.\n\nHere is your Google Meet link for the session:\n👉 ${meetLink}\n\n🙏 Om Namah Shivaya!`;
        await sendTextMessage(phone, msg);

        // 6. Referral Ask (after 30 seconds so it feels natural)
        setTimeout(async () => {
          await sendTextMessage(phone, `btw ${customerName}, if you know anyone who's been going through a tough time or needs some clarity in life... share our number with them na 😊 Shashank always gives a special priority to referrals! 🙏`);
        }, 30000);
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
      const base64 = await downloadWhatsAppMedia(mediaId);
      if (base64) {
        mediaData = {
          inlineData: {
            data: base64,
            mimeType: msg.audio.mime_type
          }
        };
        text = "(User sent an audio message. Listen to the emotion in their voice and respond with deep empathy.)";
      }
    } else if (msg.type === 'image') {
      const mediaId = msg.image.id;
      const base64 = await downloadWhatsAppMedia(mediaId);
      if (base64) {
        mediaData = {
          inlineData: {
            data: base64,
            mimeType: msg.image.mime_type || 'image/jpeg'
          }
        };
        text = msg.image.caption || "(User sent a photo. Just look at what's in it — a person, food, pet, document, kundli, whatever — and respond casually like a real person would. Like if it's a cat say 'aww kitna cute hai 😍' or if it's food say 'yumm! ye kya bana rahe ho?'. Just be natural about it.)";
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
        sessions[from] = model.startChat({
          history: [
            { role: "user", parts: [{ text: "Hello" }] },
            { role: "model", parts: [{ text: dbUser.is_customer ? "Welcome back! It's so wonderful to hear from you again. How have things been since your last session?" : "Namaste! 🙏 Welcome to Veshannastro. How is your day going today?" }] }
          ],
        });
      }

      const chat = sessions[from];
      const messageParts = [];
      
      // Smart Timing & Memory Context
      const currentTimeIST = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
      const lastContactStr = dbUser.last_contact ? new Date(dbUser.last_contact).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "First time";
      const memoryContext = `\n\n[SYSTEM CONTEXT (DO NOT MENTION TO USER): Current Time in India is ${currentTimeIST}. User's last contact was: ${lastContactStr}. User's known pain point: ${dbUser.pain_point || 'None yet'}. You are a representative of Veshannastro ("us/we"). Keep time of day in mind when greeting.]`;
      
      if (text) messageParts.push(text + memoryContext);
      if (mediaData) {
        messageParts.push(mediaData);
        if (!text) messageParts.push(memoryContext); // Add context if no text was pushed
      }
      
      console.log(`🤖 Sending to Gemini AI...`);
      let result;
      const maxRetries = 3;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          result = await chat.sendMessage(messageParts);
          break;
        } catch (aiErr) {
          const isRetryable = aiErr.message.includes('503') || aiErr.message.includes('429') || aiErr.message.includes('overloaded');
          if (isRetryable && attempt < maxRetries) {
            const delay = attempt * 2000; // 2s, 4s, 6s
            console.log(`⚠️ Attempt ${attempt} failed (${aiErr.message.substring(0, 80)}), retrying in ${delay/1000}s...`);
            await new Promise(r => setTimeout(r, delay));
          } else {
            throw aiErr;
          }
        }
      }
      console.log(`✅ Gemini responded successfully.`);
      
      // Handle Function Calls
      const functionCalls = result.response.functionCalls && result.response.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        
        if (call.name === "request_human_handoff") {
          await upsertUser(from, dbUser.is_customer, true); // Pause AI
          await sendTextMessage(from, "I completely understand. I am escalating this to our core team. Shashank Agrawal or our senior sales team will personally contact you on this number within 24 hours.");
          if (ADMIN_PHONE_NUMBER) {
             await sendTextMessage(ADMIN_PHONE_NUMBER, `🚨 *ESCALATION REQUIRED* 🚨\n\nClient Phone: +${from}\nReason: ${call.args.reason}\n\n*The AI has paused itself for this user. Please take over the chat manually via the WhatsApp app within 24 hours.*`);
          }
          await chat.sendMessage([{ functionResponse: { name: "request_human_handoff", response: { status: "paused" } } }]);
          return;
        }

        if (call.name === "create_booking_payment") {
          const args = call.args;
          if (!razorpayClient) {
            await sendTextMessage(from, "Sorry, the direct payment system is currently being configured. Please book via our website: https://veshannastro.co.in");
          } else {
            let baseAmount = parseFloat(args.price.toString().replace(/[^0-9.]/g, ''));
            let discount = args.discount_percentage || 0;
            if (discount > 5) discount = 5; // Enforce max 5%
            
            let finalAmount = baseAmount;
            if (discount > 0 && !dbUser.is_customer) {
              finalAmount = baseAmount - (baseAmount * (discount / 100));
            }

            const amountPaise = Math.round(finalAmount * 100);

            try {
              const paymentLink = await razorpayClient.paymentLink.create({
                amount: amountPaise,
                currency: "INR",
                accept_partial: false,
                description: args.service_name.substring(0, 2048),
                reference_id: `wa_booking_${Date.now()}`,
                notify: { sms: false, email: false },
                notes: {
                  customer_name: args.customer_name,
                  dob: args.dob,
                  tob: args.tob,
                  pob: args.pob,
                  service_name: args.service_name,
                  price: finalAmount,
                  phone: from,
                  summary: args.customer_pain_points_summary.substring(0, 240)
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
                  await sendTextMessage(from, `heyy ${args.customer_name}! just checking in... I noticed you didn't complete the payment yet. koi problem aayi kya? 😊 link abhi bhi active hai, and I can help if you need anything!`);
                  delete pendingPayments[refId];
                }
              }, 2 * 60 * 60 * 1000); // 2 hours

              await chat.sendMessage([{
                functionResponse: {
                  name: "create_booking_payment",
                  response: { status: "success", payment_link: link }
                }
              }]);
            } catch (e) {
              console.error("Razorpay Error:", e);
              await sendTextMessage(from, "Sorry, there was an error generating the secure payment link. Please try again later.");
            }
          }
          return; 
        }
      }

      // Handle Normal Text Response
      const responseText = result.response.text().trim();
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
