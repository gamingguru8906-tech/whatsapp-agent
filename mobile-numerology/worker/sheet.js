// Sends rows to the Google Sheet through its Apps Script web app (apps-script/numerology-leads.gs).
// Google sometimes drops a POST body on its redirect and answers with doGet's health reply instead; nothing
// ran then, so the request is sent again (same lesson as postAppsScript() in the WhatsApp bot).
export async function pushRows(env, rows, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!env.SHEET_WEBAPP_URL || !env.SHEET_SECRET) throw new Error('Google Sheet is not configured');
  let lastError;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetchImpl(env.SHEET_WEBAPP_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ secret: env.SHEET_SECRET, target: 'append_rows', rows }),
        redirect: 'follow'
      });
      const data = await res.json().catch(() => null);
      if (data?.ok && data.results) return data.results;
      if (data?.service === 'numerology-leads') lastError = new Error('request lost on Google redirect');
      else throw new Error(`Sheet refused the rows: ${data?.error ?? `HTTP ${res.status}`}`);
    } catch (e) {
      lastError = e;
      if (/refused the rows: (unauthorised|bad json|unknown target)/.test(e.message)) break; // retrying cannot help
    }
    if (attempt < 4) await sleep(800 * attempt);
  }
  throw lastError;
}
