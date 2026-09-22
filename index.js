const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const VERIFY_TOKEN    = process.env.VERIFY_TOKEN    || 'veshannastro_webhook_2024';
const WA_TOKEN        = process.env.WA_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || '1429954143524558';

// WEBHOOK VERIFICATION
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified');
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// INCOMING MESSAGES
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const messages = req.body?.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages || messages.length === 0) return;

    const msg  = messages[0];
    const from = msg.from;
    const text = (msg.text?.body || '').trim().toLowerCase();
    console.log(`Message from ${from}: "${text}"`);

    let reply = null;

    if (['hi','hello','hii','namaste','hey'].includes(text)) {
      reply = `🙏 Namaste! Welcome to *Veshannastro*\n\nI can help you with:\n1️⃣ Birth Chart Reading (Jyotish)\n2️⃣ Numerology Analysis\n3️⃣ Gemstone Consultation\n4️⃣ Book a Session\n\nReply with 1, 2, 3 or 4, or type *BOOK* to schedule a consultation.`;
    } else if (text === '1' || text.includes('birth chart') || text.includes('jyotish')) {
      reply = `🔭 *Birth Chart Reading (Jyotish)*\n\nPersonalised Vedic analysis:\n• Life purpose & dharma\n• Career & financial timing\n• Relationship compatibility\n• Health & remedies\n\n💰 Starting at ₹999\n\nType *BOOK* to schedule your session.`;
    } else if (text === '2' || text.includes('numerology')) {
      reply = `🔢 *Numerology Analysis*\n\nCompound numerology based on your name & DOB:\n• Life path number\n• Lucky numbers & dates\n• Name correction\n\n💰 Starting at ₹799\n\nType *BOOK* to schedule.`;
    } else if (text === '3' || text.includes('gemstone')) {
      reply = `💎 *Gemstone Consultation*\n\nLab-certified gemstone recommendations based on your birth chart.\n• Which gemstone suits you\n• How & when to wear it\n• Certified stones available\n\nType *BOOK* for a consultation.`;
    } else if (text === '4' || text.includes('book') || text.includes('appointment')) {
      reply = `📅 *Book a Session*\n\nBook directly here:\n👉 https://veshannastro.co.in/booking.html\n\nOr reply with your:\n• Full name\n• Date of birth (DD/MM/YYYY)\n• What you need help with\n\nShashank Agrawal will confirm your slot within 24 hours. 🙏`;
    } else if (text.includes('price') || text.includes('cost') || text.includes('fee')) {
      reply = `💰 *Services & Pricing*\n\n🔭 Birth Chart Reading — ₹999+\n🔢 Numerology Analysis — ₹799+\n💎 Gemstone Consultation — ₹499+\n📦 Combo Package — ₹1,799+\n\nAll sessions online via video call.\nType *BOOK* to get started! 🙏`;
    } else {
      reply = `🙏 Thanks for contacting *Veshannastro*!\n\nWe'll get back to you shortly.\n\nFor quick help:\n• *Hi* — See menu\n• *Book* — Schedule a session\n• *Price* — View pricing\n\nVisit: https://veshannastro.co.in`;
    }

    if (reply) await sendMessage(from, reply);
  } catch (err) {
    console.error('Error:', err.message);
  }
});

async function sendMessage(to, text) {
  if (!WA_TOKEN) { console.warn('WA_TOKEN not set'); return; }
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
    { headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' } }
  );
  console.log(`Reply sent to ${to}`);
}

app.get('/', (req, res) => res.send('Veshannastro WhatsApp Webhook is running 🚀'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
