// Cloudflare Worker: serves the site (static assets in dist/), POST /api/reading and a scheduled Sheet catch-up.
// Leads go to Kamala's database (DATABASE_URL, table numerology_leads) and to the "Numerology Leads" tab of
// Kamala's CRM Sheet. The site's code stays separate from Kamala's; only the data is shared.
// The rulebook runs here, so visitors only ever receive their own reading, never the rules.
import { neon } from '@neondatabase/serverless';
import { createEngine, publicView } from '../engine/core.js';
import { rulebook } from '../engine/rulebook.js';
import { saveLead, flushUnsynced, dedupeKey, readingId } from './store.js';
import { readingSummary } from '../engine/summary.js';
import { clientIp, verifyTurnstile, withinRateLimit } from './security.js';

const engine = createEngine(rulebook);

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
});

// The reading is for the calendar year in India.
export const istYear = (now = Date.now()) => new Date(now + 5.5 * 3600e3).getUTCFullYear();

const neonRunner = env => {
  const sql = neon(env.DATABASE_URL);
  return (text, params) => sql(text, params);
};

export async function handleReading(request, env, ctx, deps = {}) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, errors: { form: 'Something went wrong with the form. Please try again.' } }, 400); }
  if (!body || typeof body !== 'object') return json({ ok: false, errors: { form: 'Please fill in the form.' } }, 400);
  if (body.website) return json({ ok: false, errors: { form: 'Please try again.' } }, 400); // honeypot: hidden from people
  const ip = clientIp(request);
  if (!(await withinRateLimit(env, ip))) return json({ ok: false, errors: { form: 'Too many readings from this connection. Please wait a minute and try again.' } }, 429);
  if (env.TURNSTILE_SECRET && !(await verifyTurnstile(body.turnstileToken, ip, env.TURNSTILE_SECRET, deps.fetchImpl))) {
    return json({ ok: false, errors: { form: 'Please complete the quick check below the form and try again.' } }, 400);
  }
  if (body.consent !== true) return json({ ok: false, errors: { consent: 'Please tick the box to agree, so we can show your reading.' } }, 400);

  const result = engine.reading({
    name: body.name, mobile: body.mobile, dob: body.dob, concern: body.concern,
    planned: Array.isArray(body.planned) ? body.planned.slice(0, 5) : [], year: deps.year ?? istYear()
  });
  if (!result.ok) return json({ ok: false, errors: result.errors }, 400);

  const lead = { ...result.input, consent: true, waOptIn: body.waOptIn === true, readingSummary: readingSummary(result) };
  // The visitor's WhatsApp button carries this ID, so Kamala can find this exact reading (same details = same ID).
  const leadRef = readingId(await dedupeKey(lead));
  const run = deps.run ?? (env.DATABASE_URL ? neonRunner(env) : null);
  if (run) {
    const saving = saveLead(env, lead, { run, fetchImpl: deps.fetchImpl, sleep: deps.sleep })
      .catch(e => console.error('Lead not saved:', e.message));
    if (ctx?.waitUntil) ctx.waitUntil(saving); else await saving;
  } else {
    console.warn('DATABASE_URL (Kamala\'s database) is not set: the reading was shown but the lead was not stored.');
  }

  const owner = env.OWNER_KEY && request.headers.get('x-owner-key') === env.OWNER_KEY;
  return json(owner ? { ...result, owner: true, leadRef } : { ...publicView(result), leadRef });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/reading') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
      return handleReading(request, env, ctx);
    }
    if (url.pathname === '/api/config') {
      return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null, whatsappNumber: env.WHATSAPP_NUMBER || null });
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Not found' }, 404);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    if (!env.DATABASE_URL) return;
    ctx.waitUntil(flushUnsynced(env, { run: neonRunner(env) }).then(r => console.log('Sheet catch-up:', JSON.stringify(r))));
  }
};
