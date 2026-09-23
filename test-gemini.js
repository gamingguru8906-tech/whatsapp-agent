const { GoogleGenerativeAI } = require('@google/generative-ai');
const genAI = new GoogleGenerativeAI('dummy');
const model = genAI.getGenerativeModel({ model: 'gemini-3.8-flash' });

try {
  const chat = model.startChat({
    history: [
      { role: "user", parts: [{ text: "Hello" }] },
      { role: "model", parts: [{ text: "Namaste!" }] }
    ]
  });
  console.log("Chat created successfully");
  chat.sendMessage(["Hey\n\n[SYSTEM CONTEXT]"]).catch(e => console.log("SendMessage error:", e.message));
} catch (e) {
  console.log("startChat Error:", e.message);
}
