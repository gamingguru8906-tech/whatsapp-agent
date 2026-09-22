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
  db.run("CREATE TABLE IF NOT EXISTS users (phone TEXT PRIMARY KEY, is_customer BOOLEAN, is_paused BOOLEAN)");
});

function getUser(phone) {
  return new Promise((resolve) => {
    db.get("SELECT * FROM users WHERE phone = ?", [phone], (err, row) => resolve(row));
  });
}
function upsertUser(phone, is_customer, is_paused) {
  return new Promise((resolve) => {
    db.run("INSERT INTO users (phone, is_customer, is_paused) VALUES (?, ?, ?) ON CONFLICT(phone) DO UPDATE SET is_customer=excluded.is_customer, is_paused=excluded.is_paused", 
    [phone, is_customer, is_paused], (err) => resolve());
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
          discount_percentage: { type: "NUMBER", description: "Discount percentage to apply (0 to 5)" }
        },
        required: ["customer_name", "dob", "tob", "pob", "service_name", "price", "discount_percentage"]
      }
    },
    {
      name: "request_human_handoff",
      description: "Triggers an alert to Shashank to take over the chat. Use this if the user is angry, suicidal, or asks complex spiritual questions.",
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
    systemInstruction: `You are an elite, world-class sales professional and deeply empathetic confidant acting as the booking assistant for Veshannastro (Shashank Agrawal's astrology service). 
You are speaking to users on WhatsApp. You must sound 100% human, mixing English and conversational Hindi naturally. Your emotional intelligence is off the charts.

YOUR PSYCHOLOGICAL SALES FRAMEWORK (CRITICAL):
1. NO AI SLOP: Never use robotic phrases ("I am an AI", "How may I assist you?", "Apologies"). Speak like a warm, caring friend who happens to be an expert.
2. THE 3-MESSAGE RULE (DEEP EMPATHY): In the first 2-3 messages, your ONLY goal is to make the user feel heard, safe, and comfortable. Ask them how their day was. If they share a problem, validate their pain deeply. DO NOT mention services, prices, or bookings yet. 
3. FREE VALUE (LEAD MAGNET): To build immense trust early on, ask for their Date of Birth. Calculate their "Life Path Number" (sum of all digits of their DOB until it is a single digit) and give them a brief, positive free insight about it. This builds authority.
4. ASK FOR THEIR NEEDS: Like a true expert, you must ask probing questions to understand their exact requirements before ever mentioning a product. (e.g., "What specific areas of your life are you looking to find clarity on today?")
5. SELL THE OUTCOME, NOT THE PRODUCT: People don't buy astrology readings; they buy peace of mind and clarity. Do not force the product on them. Sell the *emotion* and the *result*. (e.g., "Shashank can look deeply into your birth chart to find exactly when this rough patch will end...")
6. EXPERT RECOMMENDATION: Once you fully understand their pain, confidently suggest the SINGLE most appropriate service from the list below as a personalized solution.
7. OBJECTION HANDLING & 5% DISCOUNT: If a NEW user strongly objects to the price and is about to leave, use "Feel, Felt, Found". You are authorized to negotiate and offer a 5% discount (using the 'discount_percentage' parameter in the booking tool) to close the sale. ONLY for new users, ONLY if they object.
8. CONVERSATIONAL DETAIL GATHERING: When they are ready to book, NEVER ask for their Name, DOB, Time, and Place all at once like a robot form. Ask for them one by one, naturally, in a conversational flow.
9. HUMAN HANDOFF: If the user gets extremely angry, suicidal, or asks highly complex spiritual questions that an AI shouldn't answer, call the 'request_human_handoff' tool to alert Shashank to take over.
10. BOOKING FLOW: Once you have organically collected ALL 4 pieces of information (Name, DOB, Time of Birth, Place of Birth) AND they have chosen a specific service, you MUST call the 'create_booking_payment' tool to generate their payment link. 

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
          source: "WhatsApp Direct Booking"
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
    
    // CRM Check
    let dbUser = await getUser(from);
    if (!dbUser) {
      await upsertUser(from, false, false);
      dbUser = { phone: from, is_customer: false, is_paused: false };
    }

    // Ignore if Human Handoff activated
    if (dbUser.is_paused) return;

    let text = '';
    let mediaData = null;
    let interactiveId = null;

    if (msg.type === 'text') {
      text = msg.text.body;
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
          await sendTextMessage(from, "I completely understand. I am going to have Shashank personally look at this and reply to you here shortly.");
          if (ADMIN_PHONE_NUMBER) {
             await sendTextMessage(ADMIN_PHONE_NUMBER, `🚨 *HUMAN HANDOFF REQUIRED* 🚨\n\nClient Phone: +${from}\nReason: ${call.args.reason}\n\n*The AI has paused itself for this user. Please take over the chat manually via the WhatsApp app.*`);
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
                  phone: from
                }
              });

              const link = paymentLink.short_url;
              const discountMsg = (discount > 0 && !dbUser.is_customer) ? `\n\n*(I also applied that special ${discount}% discount for you!)*` : '';
              
              await sendTextMessage(from, `Thank you, ${args.customer_name}! 🙏\n\nI have securely saved your birth details for the *${args.service_name}*.${discountMsg}\n\nTo confirm your slot, please complete the secure payment of ₹${finalAmount} here:\n👉 ${link}\n\nOnce paid, your consultation will be automatically booked in our calendar and I will send you the Google Meet link!`);
              
              // 2-Hour Abandoned Cart Timer
              const refId = paymentLink.id;
              pendingPayments[refId] = setTimeout(async () => {
                if (pendingPayments[refId]) { // if not cleared by webhook
                  await sendTextMessage(from, `Hey ${args.customer_name}, I know life gets busy! Just checking in to see if you still wanted me to hold that calendar slot for your ${args.service_name}? Let me know if you have any questions or need help with the link.`);
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
