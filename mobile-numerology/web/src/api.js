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
