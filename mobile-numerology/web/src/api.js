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
