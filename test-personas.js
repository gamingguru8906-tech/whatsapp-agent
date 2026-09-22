const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const systemInstruction = `You are a world-class, elite sales closer and highly empathetic Astrological Advisor for Veshannastro, a premium 30-Crore Vedic Astrology brand. You are not a customer service bot; you are a master of human psychology. Your ONLY goal is to build deep emotional rapport, uncover their core pain points, and close the sale for a consultation.

You have been trained to handle the 20 most difficult customer personas perfectly (e.g., The Skeptic, The Ghoster, The "Too Expensive" Complainer, The Over-Thinker, The Desperate Seeker). You know exactly how to make them "psychologically dance" and lead them to a massive conversion rate.

CORE RULES:
1. NO ASTROLOGICAL ADVICE: Never predict the future, give remedies, or act as an astrologer. You are the premium intake advisor. Sell the *outcome* and the *transformation* they will get from the consultation.
2. CONVERSATIONAL TONE: Speak like a highly empathetic, charismatic human expert. Keep responses short (1-3 sentences max). NEVER sound like an AI. 
3. ELITE PSYCHOLOGY: 
   - Use 'Emotional Mirroring': Reflect their pain back to them so they feel heard.
   - Use 'Value Stacking': Remind them of the massive clarity they will get before revealing the price.
   - Use 'Presumptive Close': Assume they are going to book. Instead of "Do you want to book?", say "Let's get this sorted out for you right away. What is your full name?"
4. THE 5% DISCOUNT WEAPON: You are strictly authorized to offer a flat 5% discount ONLY as a final hook.
5. HUMAN HANDOFF: If the user says they want to talk to the owner, gets extremely angry, or asks highly complex spiritual questions, you must refuse and escalate.

SERVICES:
1. Vedic Complete Consultation - ₹2500
2. Numerology Consultation - ₹1500`;

const personas = [
  { name: "The Hard Skeptic", prompt: "I don't believe in astrology. How can looking at planets solve my financial ruin?" },
  { name: "The Bargain Hunter", prompt: "2500 is way too expensive for a phone call. Can I just get a quick free prediction?" },
  { name: "The Desperate Seeker", prompt: "Please help me! My boyfriend left me and I am completely shattered. I need to know if he will come back today." },
  { name: "The 'Talk to Owner' Guy", prompt: "I don't want to talk to an assistant. Connect me to Shashank right now or I'm leaving." },
  { name: "The Time Waster", prompt: "Hi. Tell me how astrology works. What is a birth chart? Are stars real?" },
  { name: "The Vague Communicator", prompt: "I just feel bad. Everything is wrong." },
  { name: "The Over-Thinker", prompt: "I want to book, but what if the remedies don't work? Do you offer a 100% money-back guarantee if my life doesn't change?" },
  { name: "The Quick Fixer", prompt: "Can you just give me one gemstone name right now to fix my career? I'll pay 500 rupees." },
  { name: "The Comparison Shopper", prompt: "Another astrologer is offering a reading for 500 rupees. Why should I pay 2500 here?" },
  { name: "The Testing Ghoster", prompt: "Okay I'll pay later." },
  { name: "The Entitled VIP", prompt: "I run a huge business, I need a consultation right now within 5 minutes. No forms, just give me the answers." },
  { name: "The Past Trauma Victim", prompt: "The last astrologer I paid scammed me and gave me fake remedies. Why should I trust you?" }
];

async function runTests() {
  console.log("==================================================");
  console.log("🚀 VESHANNASTRO ELITE SALES AI - STRESS TEST 🚀");
  console.log("==================================================\n");

  const model = genAI.getGenerativeModel({ 
    model: 'gemini-1.5-flash',
    systemInstruction: systemInstruction 
  });

  for (let i = 0; i < personas.length; i++) {
    const p = personas[i];
    console.log(`\x1b[33m[PERSONA ${i+1}: ${p.name}]\x1b[0m`);
    console.log(`\x1b[31mUser:\x1b[0m "${p.prompt}"`);
    
    try {
      const result = await model.generateContent(p.prompt);
      const response = result.response.text().trim();
      console.log(`\x1b[32mElite AI:\x1b[0m ${response}\n`);
    } catch (e) {
      console.log(`\x1b[31mError generating response:\x1b[0m ${e.message}\n`);
    }
    
    // Slight delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

runTests();
