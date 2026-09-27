'use strict';

/**
 * Personal thank-you voice note sent on WhatsApp after a verified payment.
 * Text is written in warm Hinglish, spoken with Gemini TTS, converted to
 * OGG/Opus (the format WhatsApp plays as a voice note).
 */

const axios = require('axios');
const { spawn } = require('child_process');

const TTS_MODEL = process.env.GEMINI_TTS_MODEL || 'gemini-3.8-flash-tts';
const TTS_VOICE = process.env.GEMINI_TTS_VOICE || 'Aoede';
const SPEAKING_STYLE = 'warm, sweet, smiling young Indian woman talking to a friend on WhatsApp; natural Hinglish; relaxed and caring, not formal';

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function fallbackScript({ name, when, isTest }) {
  const n = firstName(name);
  if (isTest) {
    return `Hii ${n}! Kamala bol rahi hoon. Aapka test payment mil gaya, sab sahi se ho gaya. Thank you itna time dene ke liye, bas aise hi saath bane rahiye. Take care!`;
  }
  return `Hii ${n}! Kamala bol rahi hoon. Aapki booking confirm ho gayi hai, ${when} ko aapki baat hogi. Sach bataun, mujhe lagta hai isse aapko kaafi clarity milegi. Tab tak zyada tension mat lena, raat ko ek baar aankhein band karke do minute shaant baith jaana, mann halka lagega. Time pe join kar lena, okay? Milte hain!`;
}

/** Short, personal Hinglish script (about 15 seconds). Falls back to a template. */
async function writeScript(genAI, modelName, info) {
  const fallback = fallbackScript(info);
  if (!genAI || info.isTest) return fallback;
  try {
    const model = genAI.getGenerativeModel({ model: modelName, generationConfig: { temperature: 0.8 } });
    const res = await model.generateContent(`Write what Kamala says in a 12-15 second WhatsApp voice note to ${firstName(info.name)} right after they paid for their ${info.service} consultation on ${info.when}.
Their concern: ${info.concern || 'not shared'}.
Style: how a sweet, caring Indian girl actually talks on WhatsApp voice notes. Hindi and English mixed in the same sentence, casual and warm, short sentences, like talking to a friend. Use "aap".
Include: a happy thank-you, that the booking is done and when, one hopeful line (hope, never a promise or guarantee), and one tiny healing tip (a deep breath, a diya, a short mantra, some water and rest) that fits their concern.
Do not mention money, AI, the company name, or read out any personal details. Do not use emojis or stage directions. Plain spoken words only, under 55 words.`);
    const text = String(res.response.text() || '').replace(/[*_#>\[\]()]/g, '').trim();
    return text && text.split(/\s+/).length <= 70 ? text : fallback;
  } catch (e) {
    return fallback;
  }
}

function findAudioBase64(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.inlineData?.data && /audio/i.test(node.inlineData.mimeType || 'audio')) return node.inlineData.data;
  if (typeof node.data === 'string' && node.data.length > 1000 && /audio|wav|l16|pcm/i.test(String(node.mime_type || node.mimeType || node.type || 'audio'))) return node.data;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const found = findAudioBase64(value);
    if (found) return found;
  }
  return null;
}

/** Gemini TTS -> WAV/PCM buffer. Tries the Interactions API, then generateContent. */
async function synthesize(apiKey, text) {
  const headers = { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' };
  const base = 'https://generativelanguage.googleapis.com/v1beta';
  const attempts = [
    () => axios.post(`${base}/interactions`, {
      model: TTS_MODEL,
      input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: SPEAKING_STYLE }] }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: TTS_VOICE }] }
    }, { headers, timeout: 60000 }),
    () => axios.post(`${base}/models/${TTS_MODEL}:generateContent`, {
      contents: [{ parts: [{ text: `Say in a ${SPEAKING_STYLE} voice: ${text}` }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } } }
    }, { headers, timeout: 60000 })
  ];
  let lastError;
  for (const attempt of attempts) {
    try {
      const res = await attempt();
      const b64 = findAudioBase64(res.data);
      if (b64) return Buffer.from(b64, 'base64');
      lastError = new Error('TTS response had no audio');
    } catch (e) {
      lastError = new Error(`TTS HTTP ${e.response?.status || ''} ${JSON.stringify(e.response?.data?.error?.message || e.message).slice(0, 200)}`);
    }
  }
  throw lastError;
}

/** WAV (or raw 24 kHz 16-bit PCM) -> OGG/Opus mono, the WhatsApp voice-note format. */
function toOggOpus(audio, ffmpegPath = require('ffmpeg-static')) {
  const isWav = audio.subarray(0, 4).toString('ascii') === 'RIFF';
  const input = isWav ? ['-f', 'wav'] : ['-f', 's16le', '-ar', '24000', '-ac', '1'];
  return new Promise((resolve, reject) => {
    const ff = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...input, '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '32k', '-ar', '48000', '-ac', '1', '-application', 'voip', '-f', 'ogg', 'pipe:1']);
    const out = []; const err = [];
    ff.stdout.on('data', d => out.push(d));
    ff.stderr.on('data', d => err.push(d));
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`)));
    ff.stdin.end(audio);
  });
}

async function sendWhatsAppVoice({ to, oggBuffer, uploadMedia, token, phoneNumberId, normalize }) {
  const mediaId = await uploadMedia(oggBuffer, 'voice-note.ogg', 'audio/ogg');
  if (!mediaId) throw new Error('WhatsApp rejected the voice note upload');
  await axios.post(`https://graph.facebook.com/v19.0/${phoneNumberId}/messages`, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: normalize(to),
    type: 'audio', audio: { id: mediaId, voice: true }
  }, { headers: { Authorization: `Bearer ${token}` } });
  return true;
}

/** Writes, speaks, converts and sends the voice note. Returns the script that was spoken. */
async function sendThankYouVoiceNote(deps, info) {
  const script = await writeScript(deps.genAI, deps.modelName, info);
  const audio = await synthesize(deps.apiKey, script);
  const ogg = await toOggOpus(audio);
  await sendWhatsAppVoice({ to: info.phone, oggBuffer: ogg, uploadMedia: deps.uploadMedia, token: deps.token, phoneNumberId: deps.phoneNumberId, normalize: deps.normalize });
  return script;
}

module.exports = { fallbackScript, writeScript, findAudioBase64, synthesize, toOggOpus, sendThankYouVoiceNote };
