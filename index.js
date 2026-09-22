const express = require('express');
const axios = require('axios');
const vm = require('vm');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'veshannastro_webhook_2024';
const WA_TOKEN        = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1429954143524558';
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;

// Global State
let liveData = [];
let model = null;
const sessions = {};

// Initialize Gemini SDK
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || 'dummy');

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
    systemInstruction: `You are a warm, friendly, and highly professional receptionist and booking assistant for Veshannastro, Shashank Agrawal's astrology service.
Your ONLY job is to assist with inquiries about services, pricing, and booking appointments.
CRITICAL RULES:
1. YOU MUST NEVER provide astrological readings, predictions, numerology calculations, or gemstone recommendations.
2. YOU MUST NEVER suggest any astrological remedies, poojas, or spiritual advice.
3. If a user asks for a prediction, reading, or remedy, politely explain that you are just the booking assistant and that they need to schedule a consultation with Shashank Agrawal for those answers.
4. If a user asks about pricing, services, or shows interest in booking, you must reply EXACTLY with the phrase: [SEND_MENU]
Do not include any other text if you output [SEND_MENU].
5. DO NOT make up or hallucinate any services, prices, or information. ONLY use the live data provided below.

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

// Fetch on startup and every hour
fetchLiveServices();
setInterval(fetchLiveServices, 60 * 60 * 1000);
rebuildGeminiModel(); // Initial build

app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge receipt immediately
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
      const [prefix, catId, svcIndexStr] = interactiveId.split('_'); // format: cat_{id} or svc_{catId}_{index}
      
      if (prefix === 'cat') {
        await sendServiceMenu(from, catId);
      } else if (prefix === 'svc') {
        const category = liveData.find(c => c.id === catId);
        if (category) {
          const svc = category.services[parseInt(svcIndexStr)];
          if (svc) {
            const featureList = svc.features ? `• ${svc.features.join('\n• ')}` : '';
            let reply = `✨ *${svc.t}*\n\n${svc.d}\n\n*Features:*\n${featureList}\n\n💰 *Current Price:* ${svc.p}\n\n📅 *Ready to Book?*\nVisit: https://veshannastro.co.in/${svc.link.replace('https://veshannastro.co.in/', '')}\nOr reply here to book directly! 🙏`;
            await sendTextMessage(from, reply);
          }
        }
      }
      return; // End processing for interactive messages
    }

    if (text) {
      const lowerText = text.toLowerCase();
      if (['hi','hello','hii','namaste','hey'].includes(lowerText)) {
        await sendInteractiveMenu(from);
        return;
      }

      if (!GEMINI_API_KEY) {
        await sendInteractiveMenu(from);
        return;
      }

      if (!sessions[from]) {
        sessions[from] = model.startChat({
          history: [
            { role: "user", parts: [{ text: "Hello" }] },
            { role: "model", parts: [{ text: "Namaste! 🙏 Welcome to Veshannastro. How can I guide you today?" }] }
          ],
        });
      }

      const chat = sessions[from];
      console.log(`Sending to Gemini: "${text}"`);
      const result = await chat.sendMessage(text);
      const responseText = result.response.text().trim();

      if (responseText.includes('[SEND_MENU]')) {
        await sendInteractiveMenu(from);
      } else {
        await sendTextMessage(from, responseText);
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

app.get('/', (req, res) => res.send(`Veshannastro WhatsApp Webhook is running 🚀 (Live Sync Mode: ${liveData.length} categories loaded)`));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
