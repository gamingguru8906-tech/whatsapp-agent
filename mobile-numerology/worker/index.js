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
import { wristRecommendation, wristSummary, wristConcern, readWristPhoto } from '../engine/wrist.js';
import { clientIp, verifyTurnstile, withinRateLimit } from './security.js';
import { checkPhoto, readWatchPhoto, VISION_MODEL } from '../engine/photo.js';
import { startLogin, loginStatus, logout, myReadings, savedInputs, leadKeyFor } from './account.js';
import { withSchema, saveAnswer, pushAnswers, flushAnswers, saveEvent, funnel } from './store.js';

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

  const seg = deps.segment ?? 'mobile';
  const year = deps.year ?? istYear();
  const result = seg === 'watch'
    ? watchReading(rulebook, { name: body.name, mobile: body.mobile, dob: body.dob, watch: body.watch, year })
    : seg === 'wrist'
      ? wristRecommendation(rulebook, { name: body.name, mobile: body.mobile, dob: body.dob, wrist: body.wrist, year })
      : engine.reading({
        name: body.name, mobile: body.mobile, dob: body.dob, concern: body.concern,
        planned: Array.isArray(body.planned) ? body.planned.slice(0, 5) : [], year
      });
  if (!result.ok) return json({ ok: false, errors: result.errors }, 400);

  const base = { name: result.input.name, mobile: result.input.mobile, dob: result.input.dob, planned: [], consent: true, waOptIn: body.waOptIn === true };
  const lead = seg === 'watch'
    ? { ...base, concern: watchConcern(result), readingSummary: watchSummary(result), inputs: { segment: 'watch', watch: result.input.watch } }
    : seg === 'wrist'
      ? { ...base, concern: wristConcern(result), readingSummary: wristSummary(result), inputs: { segment: 'wrist', wrist: result.input.wrist } }
      : { ...result.input, consent: true, waOptIn: body.waOptIn === true, readingSummary: readingSummary(result) };
  // The visitor's WhatsApp button carries this ID, so Kamala can find this exact reading (same details = same ID).
  const leadKey = await dedupeKey(lead);
  const leadRef = readingId(leadKey);
  if (deps.run || databaseUrl(env)) {
    const save = run => saveLead(env, lead, { run, fetchImpl: deps.fetchImpl, sleep: deps.sleep });
    const saving = (deps.run ? save(deps.run) : withDb(env, save)).catch(e => console.error('Lead not saved:', e.message));
    if (ctx?.waitUntil) ctx.waitUntil(saving); else await saving;
  } else {
    console.warn('No database (HYPERDRIVE / DATABASE_URL) is set: the reading was shown but the lead was not stored.');
  }

  const owner = env.OWNER_KEY && request.headers.get('x-owner-key') === env.OWNER_KEY;
  return json(owner ? { ...result, owner: true, leadRef, leadKey } : { ...publicView(result), leadRef, leadKey });
}

// POST /api/watch-photo { image: data URL } -> { ok, watch, filled }. The model only fills the form's choices; the
// visitor checks them before asking for the reading. The photo is not stored or logged.
const PHOTO_ERRORS = {
  'not-a-watch': 'We could not find a watch in this photo. Try a clear photo of the watch face, or fill in the details below.',
  'nothing-seen': 'The photo was not clear enough to read. Try a brighter, closer photo, or fill in the details below.',
  unreadable: 'We could not read this photo. Please fill in the details below.'
};
const WRIST_ERRORS = {
  'not-a-wrist': 'We could not see a wrist in this photo. Try a clear photo of your bare wrist and hand, or choose the details below.',
  unreadable: 'We could not read this photo. Please choose the details below.'
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
    if (deps.kind === 'wrist') {
      const r = await readWristPhoto(ai, VISION_MODEL, body.image);
      return r.ok ? json(r) : json({ ok: false, error: WRIST_ERRORS[r.error] ?? WRIST_ERRORS.unreadable }, 422);
    }
    const r = await readWatchPhoto(ai, body.image);
    return r.ok ? json(r) : json({ ok: false, error: PHOTO_ERRORS[r.error] ?? PHOTO_ERRORS.unreadable }, 422);
  } catch (e) {
    console.error('Photo reading failed:', e.message);
    return json({ ok: false, error: 'Photo reading is not available right now. Please fill in the details below.' }, 503);
  }
}

// POST /api/answer { key, feedback?: yes|partly|no, optIn?: true|false }: answers given after the reading, saved on
// the visitor's own lead (the full key came back with their reading) and written to the lead's Sheet row.
export async function handleAnswer(request, env, ctx, deps = {}) {
  const body = await request.json().catch(() => null);
  if (!/^[0-9a-f]{64}$/.test(String(body?.key ?? ''))) return json({ ok: false, error: 'Unknown reading.' }, 400);
  if (!deps.run && !databaseUrl(env)) return json({ ok: true, stored: false });
  try {
    const work = async run => {
      const row = await saveAnswer(withSchema(run), body.key, { feedback: body.feedback, optIn: body.optIn });
      if (!row) return null;
      await pushAnswers(env, run, [row], { fetchImpl: deps.fetchImpl, sleep: deps.sleep }).catch(e => console.error('Answer not in the Sheet yet:', e.message));
      return row;
    };
    const row = deps.run ? await work(deps.run) : await withDb(env, work);
    return row ? json({ ok: true }) : json({ ok: false, error: 'Unknown reading.' }, 404);
  } catch (e) {
    console.error('Answer not saved:', e.message);
    return json({ ok: false, error: 'Please try again.' }, 503);
  }
}

// POST /api/event { sid, page, event, leadKey?, detail? }: one step of the funnel. Never fails the page.
export async function handleEvent(request, env, ctx, deps = {}) {
  const body = await request.json().catch(() => null);
  if (!body || (!deps.run && !databaseUrl(env))) return new Response(null, { status: 204 });
  const save = run => saveEvent(withSchema(run), body);
  const p = (deps.run ? save(deps.run) : withDb(env, save)).catch(e => console.error('Event not saved:', e.message));
  if (ctx?.waitUntil) ctx.waitUntil(p); else await p;
  return new Response(null, { status: 204 });
}

// GET /api/stats?key=OWNER_KEY&days=30: the owner's funnel (counts only, no personal data).
export async function handleStats(url, env, deps = {}) {
  if (!env.OWNER_KEY || url.searchParams.get('key') !== env.OWNER_KEY) return json({ ok: false, error: 'Not found' }, 404);
  const days = Math.min(Math.max(Number(url.searchParams.get('days')) || 30, 1), 365);
  if (!deps.run && !databaseUrl(env)) return json({ ok: false, error: 'No database' }, 503);
  const go = run => funnel(withSchema(run), days);
  return json({ ok: true, ...(deps.run ? await go(deps.run) : await withDb(env, go)) });
}

// Sign in with WhatsApp and "My readings" (worker/account.js). The browser sends its token as "Authorization: Bearer".
const bearer = request => (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim() || null;
export async function handleAccount(request, env, url, deps = {}) {
  if (!deps.run && !databaseUrl(env)) return json({ ok: false, error: 'Sign-in is not available right now.' }, 503);
  const go = fn => (deps.run ? fn(withSchema(deps.run)) : withDb(env, run => fn(withSchema(run))));
  const token = bearer(request);
  try {
    if (url.pathname === '/api/login') {
      if (request.method === 'POST') {
        if (!(await withinRateLimit(env, `login:${clientIp(request)}`))) return json({ ok: false, error: 'Too many tries. Please wait a minute.' }, 429);
        return json({ ok: true, ...(await go(startLogin)), whatsappNumber: env.WHATSAPP_NUMBER || null });
      }
      if (request.method === 'GET') return json({ ok: true, ...(await go(run => loginStatus(run, token))) });
      if (request.method === 'DELETE') { await go(run => logout(run, token)); return json({ ok: true }); }
      return json({ ok: false, error: 'Use POST, GET or DELETE' }, 405);
    }
    const who = await go(run => loginStatus(run, token));
    if (who.state !== 'signed-in') return json({ ok: false, error: 'Please sign in again.', state: who.state }, 401);
    if (url.pathname === '/api/my-readings' && request.method === 'GET') {
      return json({ ok: true, phone: who.phone, readings: await go(run => myReadings(run, who.phone)) });
    }
    if (url.pathname === '/api/my-readings/open' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const input = await go(run => savedInputs(run, who.phone, body?.id));
      if (!input) return json({ ok: false, error: 'That reading was not found.' }, 404);
      const year = deps.year ?? istYear();
      const result = input.segment === 'watch' ? watchReading(rulebook, { ...input, year })
        : input.segment === 'wrist' ? wristRecommendation(rulebook, { ...input, year }) : engine.reading({ ...input, year });
      if (!result.ok) return json({ ok: false, error: 'That reading could not be shown again.' }, 422);
      return json({ ...publicView(result), segment: input.segment, leadRef: body.id, leadKey: await go(run => leadKeyFor(run, who.phone, body.id)) });
    }
    return json({ ok: false, error: 'Not found' }, 404);
  } catch (e) {
    console.error('Account request failed:', e.message);
    return json({ ok: false, error: 'Something went wrong. Please try again.' }, 503);
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
    if (url.pathname === '/api/watch-photo' || url.pathname === '/api/wrist-photo') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
      return handlePhoto(request, env, { kind: url.pathname === '/api/wrist-photo' ? 'wrist' : 'watch' });
    }
    if (url.pathname === '/api/wrist') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
      return handleReading(request, env, ctx, { segment: 'wrist' });
    }
    if (url.pathname === '/api/answer') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
      return handleAnswer(request, env, ctx);
    }
    if (url.pathname === '/api/event') {
      if (request.method !== 'POST') return json({ ok: false, error: 'Use POST' }, 405);
      return handleEvent(request, env, ctx);
    }
    if (url.pathname === '/api/stats') return handleStats(url, env);
    if (url.pathname === '/api/login' || url.pathname.startsWith('/api/my-readings')) return handleAccount(request, env, url);
    if (url.pathname === '/api/health') return handleHealth(url, env);
    if (url.pathname === '/api/config') {
      return json({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null, whatsappNumber: env.WHATSAPP_NUMBER || null });
    }
    if (url.pathname.startsWith('/api/')) return json({ ok: false, error: 'Not found' }, 404);
    return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    if (!databaseUrl(env)) return;
    ctx.waitUntil(withDb(env, async run => ({ ...(await flushUnsynced(env, { run })), ...(await flushAnswers(env, { run })) }))
      .then(r => console.log('Sheet catch-up:', JSON.stringify(r)))
      .catch(e => console.error('Sheet catch-up failed:', e.message)));
  }
};
