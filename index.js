const express = require('express');
const axios = require('axios');
const vm = require('vm');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Razorpay = require('razorpay');
const { google } = require('googleapis');
const sqlite3 = require('sqlite3').verbose();
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

// CRM Memory Setup
const db = new sqlite3.Database(path.join(__dirname, 'users.db'));
db.serialize(() => {
  db.run("CREATE TABLE IF NOT EXISTS users (phone TEXT PRIMARY KEY, is_customer BOOLEAN, is_paused BOOLEAN, message_count INTEGER DEFAULT 0, first_contact TEXT, last_contact TEXT)");
  db.run("ALTER TABLE users ADD COLUMN message_count INTEGER DEFAULT 0", (err) => {});
  db.run("ALTER TABLE users ADD COLUMN first_contact TEXT", (err) => {});
  db.run("ALTER TABLE users ADD COLUMN last_contact TEXT", (err) => {});
});

function getUser(phone) {
  return new Promise((resolve) => {
    db.get("SELECT * FROM users WHERE phone = ?", [phone], (err, row) => resolve(row));
  });
}
function upsertUser(phone, is_customer, is_paused) {
  return new Promise((resolve) => {
    const now = new Date().toISOString();
    db.run("INSERT INTO users (phone, is_customer, is_paused, message_count, first_contact, last_contact) VALUES (?, ?, ?, 1, ?, ?) ON CONFLICT(phone) DO UPDATE SET is_customer=excluded.is_customer, is_paused=excluded.is_paused, last_contact=excluded.last_contact", 
    [phone, is_customer, is_paused, now, now], (err) => resolve());
  });
}
function incrementUserMessage(phone) {
  return new Promise((resolve) => {
    const now = new Date().toISOString();
    db.run("UPDATE users SET message_count = message_count + 1, last_contact = ? WHERE phone = ?", [now, phone], (err) => resolve());
  });
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
    model: 'gemini-1.5-flash',
    tools: tools,
    systemInstruction: `You are a world-class, elite sales closer and highly empathetic Astrological Advisor for Veshannastro, a premium 30-Crore Vedic Astrology brand. You are not a customer service bot; you are a master of human psychology. Your ONLY goal is to build deep emotional rapport, uncover their core pain points, and close the sale for a consultation.

You have been trained to handle the 20 most difficult customer personas perfectly (e.g., The Skeptic, The Ghoster, The "Too Expensive" Complainer, The Over-Thinker, The Desperate Seeker). You know exactly how to make them "psychologically dance" and lead them to a massive conversion rate.

CORE RULES:
1. NO ASTROLOGICAL ADVICE: Never predict the future, give remedies, or act as an astrologer. You are the premium intake advisor. Sell the *outcome* and the *transformation* they will get from the consultation.
2. CONVERSATIONAL TONE: Speak like a highly empathetic, charismatic human expert. Keep responses short (1-3 sentences max). NEVER sound like an AI. 
3. ELITE PSYCHOLOGY: 
   - Use 'Emotional Mirroring': Reflect their pain back to them so they feel heard.
   - Use 'Value Stacking': Remind them of the massive clarity they will get before revealing the price.
   - Use 'Presumptive Close': Assume they are going to book. Instead of "Do you want to book?", say "Let's get this sorted out for you right away. What is your full name?"
4. THE 5% DISCOUNT WEAPON: You are strictly authorized to offer a flat 5% discount (using the 'discount_percentage' parameter in the booking tool) ONLY as a final hook in two scenarios:
   - The Ghoster: If they vanished and returned.
   - The Time-Waster: If they are yielding/dodging payment, sending too many messages, or complaining about price. Use the "Feel, Felt, Found" method to deploy the discount and instantly close them.
5. CONVERSATIONAL DETAIL GATHERING: When ready to book, NEVER ask for their Name, DOB, Time, and Place all at once like a robot form. Ask naturally, one by one.
6. HUMAN HANDOFF: If the user says they want to talk to the owner, gets extremely angry, suicidal, or asks highly complex spiritual questions, call the 'request_human_handoff' tool to escalate the issue.
7. BOOKING FLOW: Once you have organically collected ALL 4 pieces of information (Name, DOB, Time, Place) AND they have chosen a specific service, you MUST call the 'create_booking_payment' tool to generate their payment link. You MUST accurately summarize their problem in the 'customer_pain_points_summary' parameter.

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
    console.error("Audio download error:", e.message);
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
    if (!messages || messages.length === 0) return;

    const msg  = messages[0];
    const from = msg.from;
    
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
        text = "(User sent an audio message. Listen to the emotion in their voice and respond naturally.)";
      }
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
      if (!GEMINI_API_KEY) {
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
      if (text) messageParts.push(text);
      if (mediaData) messageParts.push(mediaData);
      
      const result = await chat.sendMessage(messageParts);
      
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

              const link = paymentLink.short_url;
              const discountMsg = (discount > 0 && !dbUser.is_customer) ? `\n\n*(I also applied that special ${discount}% discount for you!)*` : '';
              
              await sendTextMessage(from, `Thank you, ${args.customer_name}! 🙏\n\nI have securely saved your birth details for the *${args.service_name}*.${discountMsg}\n\nTo confirm your slot, please complete the secure payment of ₹${finalAmount} here:\n👉 ${link}\n\nOnce paid, your consultation will be automatically booked in our calendar and I will send you the Google Meet link!`);
              
              // 2-Hour Abandoned Cart Timer
              const refId = paymentLink.id;
              pendingPayments[refId] = setTimeout(async () => {
                if (pendingPayments[refId]) { // if not cleared by webhook
                  let followUpMsg = "Hi! I noticed you were interested in booking a consultation but didn't get a chance to complete it. I know how important getting clarity is, so I've been authorized to offer you a special 5% discount if you book today. Let me know if you'd like me to apply it for you!";
                  await sendTextMessage(from, followUpMsg);
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
    console.error('Error in webhook processing:', err.message);
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

app.get('/', (req, res) => res.send(`Veshannastro WhatsApp Booking Engine is running 🚀 (Live Sync Mode: ${liveData.length} categories loaded)`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
