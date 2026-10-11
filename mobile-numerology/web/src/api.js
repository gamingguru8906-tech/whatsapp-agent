// Talks to the Worker. In the owner-only preview build (VITE_LOCAL_ENGINE=1) the engine runs in the page instead;
// the production build contains no rules, because that branch is removed at build time.
const LOCAL = import.meta.env.VITE_LOCAL_ENGINE === '1';

export async function getConfig() {
  if (LOCAL) return { turnstileSiteKey: null, whatsappNumber: import.meta.env.VITE_WHATSAPP_NUMBER || null, preview: true };
  try {
    const res = await fetch('/api/config');
    return res.ok ? await res.json() : {};
  } catch {
    return {};
  }
}

export async function getReading(payload, ownerKey) {
  if (LOCAL) {
    const { localReading } = await import('./local-engine.js');
    return localReading(payload);
  }
  try {
    const res = await fetch('/api/reading', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ownerKey ? { 'x-owner-key': ownerKey } : {}) },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => null);
    return data ?? { ok: false, errors: { form: 'The reading could not load. Please try again.' } };
  } catch {
    return { ok: false, errors: { form: 'No connection. Please check your internet and try again.' } };
  }
}

// Wristwatch segment: same flow, its own endpoint.
export async function getWatchReading(payload, ownerKey) {
  if (LOCAL) {
    const { localWatchReading } = await import('./local-engine.js');
    return localWatchReading(payload);
  }
  try {
    const res = await fetch('/api/watch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(ownerKey ? { 'x-owner-key': ownerKey } : {}) },
      body: JSON.stringify(payload)
    });
    const data = await res.json().catch(() => null);
    return data ?? { ok: false, errors: { form: 'The reading could not load. Please try again.' } };
  } catch {
    return { ok: false, errors: { form: 'No connection. Please check your internet and try again.' } };
  }
}

// Shrinks a photo in the browser (longest side 1024 px, JPEG) so it uploads fast on mobile data.
export async function shrinkPhoto(file, max = 1024) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Watch photo -> the form's choices ({ ok, watch, filled } or { ok: false, error }).
export async function readPhoto(image) {
  if (LOCAL) {
    // Owner preview has no Worker: a fixed sample answer, to check the form behaviour.
    await new Promise(r => setTimeout(r, 700));
    return { ok: true, watch: { dialShape: 'round', dialColour: 'blue', caseMetal: 'gold', markers: 'roman', dateWindow: 'date', datePosition: '3', strapMaterial: 'metal', hands: 'three' },
      filled: ['dialShape', 'dialColour', 'caseMetal', 'markers', 'dateWindow', 'datePosition', 'strapMaterial', 'hands'] };
  }
  try {
    const res = await fetch('/api/watch-photo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image }) });
    const data = await res.json().catch(() => null);
    return data ?? { ok: false, error: 'We could not read this photo. Please fill in the details below.' };
  } catch {
    return { ok: false, error: 'No connection. Please check your internet and try again.' };
  }
}

// ---------- Sign in with WhatsApp and "My readings" ----------
// The browser keeps its sign-in token (a random value; the server stores only its hash). If storage is blocked,
// the sign-in lasts for this page only.
let memoryToken = null;
export const session = {
  get() { try { return localStorage.getItem('vsession') || memoryToken; } catch { return memoryToken; } },
  set(t) { memoryToken = t; try { t ? localStorage.setItem('vsession', t) : localStorage.removeItem('vsession'); } catch { /* page-only */ } }
};

async function account(method, path, body) {
  const token = session.get();
  try {
    const res = await fetch(path, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    return (await res.json().catch(() => null)) ?? { ok: false, error: 'Something went wrong. Please try again.' };
  } catch {
    return { ok: false, error: 'No connection. Please check your internet and try again.' };
  }
}

export async function startLogin() {
  const r = await account('POST', '/api/login');
  if (r.ok) session.set(r.token);
  return r;
}
export const loginStatus = () => (session.get() ? account('GET', '/api/login') : Promise.resolve({ ok: true, state: 'expired' }));
export async function signOut() { await account('DELETE', '/api/login'); session.set(null); }
export const getMyReadings = () => account('GET', '/api/my-readings');
export const openMyReading = id => account('POST', '/api/my-readings/open', { id });

// ---------- Which watch for the year (wrist photo) ----------
export async function readWrist(image) {
  if (LOCAL) {
    await new Promise(r => setTimeout(r, 700));
    return { ok: true, wrist: { size: 'slim', undertone: 'warm', style: 'casual' }, filled: ['size', 'undertone', 'style'] };
  }
  try {
    const res = await fetch('/api/wrist-photo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image }) });
    return (await res.json().catch(() => null)) ?? { ok: false, error: 'We could not read this photo. Please choose the details below.' };
  } catch {
    return { ok: false, error: 'No connection. Please check your internet and try again.' };
  }
}

export async function getWristReading(payload, ownerKey) {
  if (LOCAL) {
    const { localWristReading } = await import('./local-engine.js');
    return localWristReading(payload);
  }
  try {
    const res = await fetch('/api/wrist', {
      method: 'POST', headers: { 'content-type': 'application/json', ...(ownerKey ? { 'x-owner-key': ownerKey } : {}) }, body: JSON.stringify(payload)
    });
    return (await res.json().catch(() => null)) ?? { ok: false, errors: { form: 'Your answer could not load. Please try again.' } };
  } catch {
    return { ok: false, errors: { form: 'No connection. Please check your internet and try again.' } };
  }
}

// "Does this sound like you?" and the opt-in, saved on the visitor's own lead.
export async function sendAnswer(key, answer) {
  if (LOCAL || !key) return { ok: true };
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch('/api/answer', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, ...answer }) });
      if (res.ok) return { ok: true };
      if (res.status !== 404) break;
    } catch { /* retry once */ }
    await new Promise(r => setTimeout(r, 1500)); // the lead may still be saving
  }
  return { ok: false };
}

// Funnel events: one random id per tab, no personal data. Never blocks or breaks the page.
let sid = null;
function tabId() {
  if (sid) return sid;
  try { sid = sessionStorage.getItem('vsid'); } catch { /* blocked */ }
  if (!sid) {
    sid = Array.from(crypto.getRandomValues(new Uint8Array(12)), b => (b % 36).toString(36)).join('');
    try { sessionStorage.setItem('vsid', sid); } catch { /* page-only */ }
  }
  return sid;
}
export function track(page, event, extra = {}) {
  if (LOCAL) return;
  try {
    const body = JSON.stringify({ sid: tabId(), page, event, ...extra });
    if (!(navigator.sendBeacon && navigator.sendBeacon('/api/event', new Blob([body], { type: 'application/json' })))) {
      fetch('/api/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true }).catch(() => {});
    }
  } catch { /* never break the page */ }
}
