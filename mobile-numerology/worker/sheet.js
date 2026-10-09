// Sends rows to the "Numerology Leads" tab of Kamala's CRM spreadsheet, through Kamala's Apps Script web app
// (apps-script/numerology-leads.gs is added to that project). The website uses its own key (SHEET_SECRET), never
// Kamala's apiSecret.
// Google sometimes drops a POST body on its redirect and answers with doGet's health reply instead
// ({ ok: true, service: '...' } and no results); nothing ran then, so the request is sent again (same lesson as
// postAppsScript() in the WhatsApp bot).
export const SHEET_TARGET = 'numerology_append_rows';

export async function pushRows(env, rows, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!env.SHEET_WEBAPP_URL || !env.SHEET_SECRET) throw new Error('Google Sheet is not configured');
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetchImpl(env.SHEET_WEBAPP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ target: SHEET_TARGET, numerologySecret: env.SHEET_SECRET, rows }),
        redirect: 'follow'
      });
      const data = await res.json().catch(() => null);
      if (data?.ok && data.results) return data.results;
      if (data?.service && !data.results) lastError = new Error('request lost on Google redirect');
      else throw new Error(`Sheet refused the rows: ${data?.error ?? data?.message ?? `HTTP ${res.status}`}`);
    } catch (e) {
      lastError = e;
      // Retrying cannot help: wrong key, or doPost does not pass numerology requests on yet (setup step 3).
      if (/refused the rows: .*(unauthori[sz]ed|bad json|unknown target|invalid secret|forbidden)/i.test(e.message)) break;
    }
    if (attempt < 4) await sleep(800 * attempt);
  }
  throw lastError;
}
