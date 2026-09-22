const express = require('express');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json());

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'veshannastro_webhook_2024';
const WA_TOKEN        = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1429954143524558';
const GEMINI_API_KEY  = process.env.GEMINI_API_KEY;

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY || 'dummy');
const model = genAI.getGenerativeModel({ 
  model: 'gemini-1.5-flash',
  systemInstruction: `You are a warm, friendly, and highly professional assistant for Veshannastro, Shashank Agrawal's astrology service.
Your tone should be personal, engaging, and slightly spiritual (use appropriate emojis 🙏, ✨).
You answer questions about Astrology, Numerology, and Gemstones concisely. 
If a user asks about pricing, services, or shows interest in booking, you must reply EXACTLY with the phrase: [SEND_MENU]
Do not include any other text if you output [SEND_MENU].
If the user asks something unrelated, politely steer them back to Veshannastro's services.`
});

// In-memory conversation store
const sessions = {};

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
      // Handle interactive menu selection
      let reply = '';
      if (interactiveId === 'menu_birth_chart') {
        reply = `🔭 *Birth Chart Reading (Jyotish)*\n\nShashank will deeply analyze your Vedic chart to guide your:\n• Life purpose & career timing\n• Relationship compatibility\n• Health & actionable remedies\n\n💰 Starting at ₹999\n\nReady? Reply with *BOOK* or visit https://veshannastro.co.in/booking.html 🙏`;
      } else if (interactiveId === 'menu_numerology') {
        reply = `🔢 *Numerology Analysis*\n\nDiscover the power of your numbers based on your name & DOB:\n• Life path insights\n• Lucky numbers & dates\n• Name correction suggestions\n\n💰 Starting at ₹799\n\nReply with *BOOK* to schedule your analysis! ✨`;
      } else if (interactiveId === 'menu_gemstone') {
        reply = `💎 *Gemstone Consultation*\n\nLab-certified gemstone recommendations based on your birth chart:\n• Which exact gemstone suits you\n• Auspicious time to wear it\n• We also provide certified stones\n\n💰 Consultation: ₹499+\n\nReply with *BOOK* to consult. 🙏`;
      } else if (interactiveId === 'menu_book') {
        reply = `📅 *Book a Session*\n\nFantastic! You can book directly on our website:\n👉 https://veshannastro.co.in/booking.html\n\nOr simply reply here with your Name and Date of Birth, and we will set it up for you! ✨`;
      }
      if (reply) await sendTextMessage(from, reply);
      return; // End processing for interactive messages
    }

    if (text) {
      // Fallback for simple keywords just in case
      const lowerText = text.toLowerCase();
      if (['hi','hello','hii','namaste','hey'].includes(lowerText)) {
        await sendInteractiveMenu(from);
        return;
      }

      // Route to Gemini AI
      if (!GEMINI_API_KEY) {
        // Fallback if no AI key
        await sendInteractiveMenu(from);
        return;
      }

      // Initialize chat session for user if it doesn't exist
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
  if (!WA_TOKEN) return;
  const data = {
    messaging_product: "whatsapp",
    to: to,
    type: "interactive",
    interactive: {
      type: "list",
      header: { type: "text", text: "Veshannastro Services ✨" },
      body: { text: "Namaste! 🙏 I'm your Veshannastro assistant. How can we guide you today?\n\nPlease select an option below:" },
      footer: { text: "Tap the button below" },
      action: {
        button: "View Services",
        sections: [
          {
            title: "Our Services",
            rows: [
              { id: "menu_birth_chart", title: "🔭 Birth Chart", description: "Vedic analysis, career, relations" },
              { id: "menu_numerology", title: "🔢 Numerology", description: "Life path, lucky numbers & names" },
              { id: "menu_gemstone", title: "💎 Gemstones", description: "Certified stone recommendations" },
              { id: "menu_book", title: "📅 Book a Session", description: "Schedule a video consultation" }
            ]
          }
        ]
      }
    }
  };
  try {
    await axios.post(`https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`, data, {
      headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' }
    });
  } catch (err) {
    console.error("Failed to send interactive menu", err.response?.data || err.message);
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

app.get('/', (req, res) => res.send('Veshannastro WhatsApp Webhook is running 🚀 (Hybrid AI Mode)'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
