// Cloudflare Worker: serves the site (static assets in dist/), POST /api/reading and a scheduled Sheet catch-up.
// Leads go to Kamala's database (Hyperdrive or DATABASE_URL, table numerology_leads) and to the "Numerology Leads" tab of
// Kamala's CRM Sheet. The site's code stays separate from Kamala's; only the data is shared.
// The rulebook runs here, so visitors only ever receive their own reading, never the rules.
import { createEngine, publicView } from '../engine/core.js';
import { rulebook } from '../engine/rulebook.js';
import { saveLead, flushUnsynced, dedupeKey, readingId, ensureTable } from './store.js';
import { databaseUrl, withDb } from './db.js';
import { readingSummary } from '../engine/summary.js';
import { watchReading, watchSummary, watchConcern } from '../engine/watch.js';
import { clientIp, verifyTurnstile, withinRateLimit } from './security.js';
import { checkPhoto, readWatchPhoto } from '../engine/photo.js';

const engine = createEngine(rulebook);

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
});

// The reading is for the calendar year in India.
export const istYear = (now = Date.now()) => new Date(now + 5.5 * 3600e3).getUTCFullYear();


// Owner check: /api/health?key=OWNER_KEY. Connects to the database, creates the table if it is missing, and reports
// counts and whether the Sheet is configured. Never shows any lead or secret.
export async function handleHealth(url, env, deps = {}) {
  if (!env.OWNER_KEY || url.searchParams.get('key') !== env.OWNER_KEY) return json({ ok: false, error: 'Not found' }, 404);
  const out = { ok: true, database: 'not configured', sheet: Boolean(env.SHEET_WEBAPP_URL && env.SHEET_SECRET),
    turnstile: Boolean(env.TURNSTILE_SECRET), whatsapp: Boolean(env.WHATSAPP_NUMBER) };
  if (!deps.run && !databaseUrl(env)) return json(out);
  try {
    const check = async run => {
      await ensureTable(run);
      const [c] = await run(`SELECT count(*)::int AS leads, count(*) FILTER (WHERE NOT sheet_synced)::int AS waiting_for_sheet,
        max(sheet_error) FILTER (WHERE NOT sheet_synced) AS last_sheet_error FROM numerology_leads`, []);
      return c;
    };
    Object.assign(out, { database: 'ok' }, deps.run ? await check(deps.run) : await withDb(env, check));
  } catch (e) {
    out.ok = false;
    out.database = `error: ${e.message}`;
  }
  return json(out, out.ok ? 200 : 503);
}

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

  const watch = deps.segment === 'watch';
  const result = watch
    ? watchReading(rulebook, { name: body.name, mobile: body.mobile, dob: body.dob, watch: body.watch, year: deps.year ?? istYear() })
    : engine.reading({
      name: body.name, mobile: body.mobile, dob: body.dob, concern: body.concern,
      planned: Array.isArray(body.planned) ? body.planned.slice(0, 5) : [], year: deps.year ?? istYear()
    });
  if (!result.ok) return json({ ok: false, errors: result.errors }, 400);

  const lead = watch
    ? { name: result.input.name, mobile: result.input.mobile, dob: result.input.dob, concern: watchConcern(result), planned: [],
      consent: true, waOptIn: body.waOptIn === true, readingSummary: watchSummary(result) }
    : { ...result.input, consent: true, waOptIn: body.waOptIn === true, readingSummary: readingSummary(result) };
  // The visitor's WhatsApp button carries this ID, so Kamala can find this exact reading (same details = same ID).
  const leadRef = readingId(await dedupeKey(lead));
  if (deps.run || databaseUrl(env)) {
    const save = run => saveLead(env, lead, { run, fetchImpl: deps.fetchImpl, sleep: deps.sleep });
    const saving = (deps.run ? save(deps.run) : withDb(env, save)).catch(e => console.error('Lead not saved:', e.message));
    if (ctx?.waitUntil) ctx.waitUntil(saving); else await saving;
  } else {
    console.warn('No database (HYPERDRIVE / DATABASE_URL) is set: the reading was shown but the lead was not stored.');
  }

  const owner = env.OWNER_KEY && request.headers.get('x-owner-key') === env.OWNER_KEY;
  return json(owner ? { ...result, owner: true, leadRef } : { ...publicView(result), leadRef });
}

// POST /api/watch-photo { image: data URL } -> { ok, watch, filled }. The model only fills the form's choices; the
// visitor checks them before asking for the reading. The photo is not stored or logged.
const PHOTO_ERRORS = {
  'not-a-watch': 'We could not find a watch in this photo. Try a clear photo of the watch face, or fill in the details below.',
  'nothing-seen': 'The photo was not clear enough to read. Try a brighter, closer photo, or fill in the details below.',
  unreadable: 'We could not read this photo. Please fill in the details below.'
};
export async function handlePhoto(request, env, deps = {}) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'Please choose a photo.' }, 400); }
  const bad = checkPhoto(body?.image);
  if (bad) return json({ ok: false, error: bad }, 400);
  if (!(await withinRateLimit(env, `photo:${clientIp(request)}`))) return json({ ok: false, error: 'Too many photos from this connection. Please wait a minute and try again.' }, 429);
  const ai = deps.ai ?? env.AI;
  if (!ai) return json({ ok: false, error: 'Photo reading is not available right now. Please fill in the details below.' }, 503);
  try {
    const r = await readWatchPhoto(ai, body.image);
    return r.ok ? json(r) : json({ ok: false, error: PHOTO_ERRORS[r.error] ?? PHOTO_ERRORS.unreadable }, 422);
  } catch (e) {
    console.error('Photo reading failed:', e.message);
    return json({ ok: false, error: 'Photo reading is not available right now. Please fill in the details below.' }, 503);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/reading') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
      return handleReading(request, env, ctx);
    }
    if (url.pathname === '/api/watch') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
      return handleReading(request, env, ctx, { segment: 'watch' });
    }
    if (url.pathname === '/api/watch-photo') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
      return handlePhoto(request, env);
    }
    if (url.pathname === '/api/health') return handleHealth(url, env);
    if (url.pathname === '/api/config') {
      return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null, whatsappNumber: env.WHATSAPP_NUMBER || null });
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Not found' }, 404);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    if (!databaseUrl(env)) return;
    ctx.waitUntil(withDb(env, run => flushUnsynced(env, { run }))
      .then(r => console.log('Sheet catch-up:', JSON.stringify(r)))
      .catch(e => console.error('Sheet catch-up failed:', e.message)));
  }
};
