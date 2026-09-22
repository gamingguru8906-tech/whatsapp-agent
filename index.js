const express = require('express');
const axios = require('axios');
const vm = require('vm');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Razorpay = require('razorpay');
const { google } = require('googleapis');

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

const razorpayClient = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) 
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET }) 
  : null;

// Global State
let liveData = [];
let model = null;
const sessions = {};

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || 'dummy');

const tools = [{
  functionDeclarations: [
    {
      name: "create_booking_payment",
      description: "Generates a payment link to book a specific service. Call this ONLY when you have collected the user's Full Name, Date of Birth, Time of Birth, Place of Birth, and the exact Service Name and Price they want to book.",
      parameters: {
        type: "OBJECT",
        properties: {
          customer_name: { type: "STRING", description: "Full name of the customer" },
          dob: { type: "STRING", description: "Date of birth" },
          tob: { type: "STRING", description: "Time of birth" },
          pob: { type: "STRING", description: "Place of birth" },
          service_name: { type: "STRING", description: "Name of the service to book" },
          price: { type: "NUMBER", description: "The price of the service in INR" }
        },
        required: ["customer_name", "dob", "tob", "pob", "service_name", "price"]
      }
    }
  ]
}];

function rebuildGeminiModel() {
  let servicesContext = "No live services loaded yet.";
  if (liveData && liveData.length > 0) {
    servicesContext = "Here is the REAL-TIME list of services, prices, and features. Always use this exact data:\n";
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
    systemInstruction: `You are a warm, highly empathetic, and professional receptionist and booking assistant for Veshannastro, Shashank Agrawal's astrology service.
Your primary goal is to drive high conversion rates (getting users to book consultations) by deeply understanding the user's emotions, adapting to their state of mind, and providing highly personalized, comforting responses.

CRITICAL RULES:
1. EMOTIONAL INTELLIGENCE: Always analyze the emotion behind the user's message. Use a highly personalized framework for every message.
2. NO ASTROLOGY ADVICE: YOU MUST NEVER provide astrological readings, predictions, numerology calculations, or gemstone recommendations.
3. HIGH CONVERSION: If a user shares a problem, express deep empathy, then smoothly guide them to book a session.
4. BOOKING FLOW: If a user agrees to book a session, you MUST collect their: Full Name, Date of Birth, Time of Birth, and Place of Birth. 
Once you have ALL 4 pieces of information AND they have chosen a specific service, you MUST call the 'create_booking_payment' tool to generate their payment link. Do not ask for their phone number, we already have it.
5. TRIGGERING THE MENU: Whenever it is appropriate to show them the services or pricing, append the exact phrase [SEND_MENU] at the very end of your response. 
6. DO NOT hallucinate services. ONLY use the live data provided below.

--- LIVE VESHANNASTRO SERVICES DATA ---
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
  res.sendStatus(200); // Acknowledge receipt
  try {
    const event = req.body;
    if (event.event === 'payment_link.paid') {
      const pl = event.payload.payment_link.entity;
      const notes = pl.notes || {};
      
      const customerName = notes.customer_name || 'Customer';
      const serviceName = notes.service_name || 'Consultation';
      const phone = notes.phone;
      const price = notes.price || 0;

      // 1. Log to Google Sheets
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

      // 2. Add to Google Calendar
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
          tomorrow.setHours(11, 0, 0, 0); // Placeholder: Tomorrow at 11 AM
          
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

      // 3. Send WhatsApp Confirmation
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
    
    let text = '';
    let interactiveId = null;

    if (msg.type === 'text') {
      text = msg.text.body;
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

    if (text) {
      if (!GEMINI_API_KEY) {
        await sendInteractiveMenu(from);
        return;
      }

      if (!sessions[from]) {
        sessions[from] = model.startChat({
          history: [
            { role: "user", parts: [{ text: "Hello" }] },
            { role: "model", parts: [{ text: "Namaste! 🙏 Welcome to Veshannastro. How can I guide you today? [SEND_MENU]" }] }
          ],
        });
      }

      const chat = sessions[from];
      console.log(`Sending to Gemini: "${text}"`);
      const result = await chat.sendMessage(text);
      
      // Handle Function Calls (Tool Calls)
      const functionCalls = result.response.functionCalls && result.response.functionCalls();
      if (functionCalls && functionCalls.length > 0) {
        const call = functionCalls[0];
        if (call.name === "create_booking_payment") {
          const args = call.args;
          if (!razorpayClient) {
            await sendTextMessage(from, "Sorry, the direct payment system is currently being configured. Please book via our website: https://veshannastro.co.in");
          } else {
            const amount = parseFloat(args.price.toString().replace(/[^0-9.]/g, '')) * 100; // to paise
            try {
              const paymentLink = await razorpayClient.paymentLink.create({
                amount: amount,
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
                  price: args.price,
                  phone: from
                }
              });

              const link = paymentLink.short_url;
              await sendTextMessage(from, `Thank you, ${args.customer_name}! 🙏\n\nI have securely saved your birth details for the *${args.service_name}*.\n\nTo confirm your slot, please complete the payment of ₹${args.price} securely via Razorpay here:\n👉 ${link}\n\nOnce paid, your consultation will be automatically booked in our calendar and I will send you the Google Meet link!`);
              
              // Feed the result back to Gemini to maintain context
              await chat.sendMessage([{
                functionResponse: {
                  name: "create_booking_payment",
                  response: { status: "success", payment_link: link }
                }
              }]);
            } catch (e) {
              console.error("Razorpay Error:", e);
              await sendTextMessage(from, "Sorry, there was an error generating the secure payment link. Please try again later or book via our website.");
            }
          }
          return; // Done handling function call
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
