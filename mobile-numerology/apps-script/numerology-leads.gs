/**
 * Veshannastro free mobile-numerology leads -> this Google Sheet.
 *
 * Setup (once, about 5 minutes):
 *   1. In the Sheet: Extensions > Apps Script. Delete what is there, paste this whole file, press Save.
 *   2. Choose the function "setup" at the top and press Run. Approve the permissions (Advanced > Go to project).
 *      It creates the Leads and Stats tabs and a secret key. Open View > Execution log (or the log panel) and copy
 *      the line "SHEET_SECRET: ..." — that value goes into Cloudflare as SHEET_SECRET.
 *   3. Deploy > New deployment > type Web app. Execute as: Me. Who has access: Anyone. Deploy.
 *      Copy the web app URL (ends in /exec) — it goes into Cloudflare as SHEET_WEBAPP_URL.
 *
 * The site sends each new lead once; this script also refuses any Key it already has, so a resend after a
 * network hiccup can never create a duplicate row. Requests without the secret are refused.
 */

var LEADS = 'Leads';
var STATS = 'Stats';
var HEADERS = ['Date (IST)', 'Name', 'Mobile', 'Date of birth', 'Concern', 'Planned 1', 'Planned 2', 'Planned 3', 'Consent', 'WhatsApp opt-in', 'Key'];

function doGet() {
  return json_({ ok: true, service: 'numerology-leads' });
}

function doPost(e) {
  var data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad json' }); }
  var secret = PropertiesService.getScriptProperties().getProperty('SHEET_SECRET');
  if (!secret || data.secret !== secret) return json_({ ok: false, error: 'unauthorised' });
  if (data.target === 'append_rows') return json_(appendRows_(data.rows || []));
  return json_({ ok: false, error: 'unknown target' });
}

function appendRows_(rows) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'temporarily busy, retryable' };
  try {
    var sheet = leadsSheet_();
    var keyCol = HEADERS.length;
    var results = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var key = String(row.key || '');
      if (!/^[0-9a-f]{64}$/.test(key)) { results[key] = 'invalid'; continue; }
      var last = sheet.getLastRow();
      var found = last > 1 && sheet.getRange(2, keyCol, last - 1, 1).createTextFinder(key).matchEntireCell(true).findNext();
      if (found) { results[key] = 'exists'; continue; }
      sheet.appendRow([
        istDate_(row.date), safe_(row.name), "'" + String(row.mobile || ''), "'" + String(row.dob || ''), safe_(row.concern),
        row.planned1 ? "'" + row.planned1 : '', row.planned2 ? "'" + row.planned2 : '', row.planned3 ? "'" + row.planned3 : '',
        safe_(row.consent), safe_(row.waOptIn), key
      ]);
      results[key] = 'added';
    }
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

// "2026-10-09 14:30:00" (IST) -> a real date-time value, so the Stats formulas can count by day.
function istDate_(v) {
  var d = new Date(String(v || '').replace(' ', 'T') + '+05:30');
  return isNaN(d.getTime()) ? safe_(v) : d;
}

// Text that starts with = + - @ would run as a spreadsheet formula; keep it as plain text.
function safe_(v) {
  var s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function leadsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(LEADS) || ss.insertSheet(LEADS);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

/** Run once from the editor. Safe to run again: it keeps existing leads and the existing secret. */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SHEET_SECRET');
  if (!secret) {
    secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('SHEET_SECRET', secret);
  }
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = leadsSheet_();
  sheet.hideColumns(HEADERS.length); // Key: needed for the no-duplicates check, not for reading
  var stats = ss.getSheetByName(STATS) || ss.insertSheet(STATS);
  stats.clear();
  stats.getRange('A1:B1').setValues([['Measure', 'Value']]).setFontWeight('bold');
  stats.getRange('A2:B6').setFormulas([
    ['="Total leads"', '=COUNTA(Leads!K2:K)'],
    ['="Last 7 days"', '=COUNTIF(Leads!A2:A,">="&(TODAY()-7))'],
    ['="WhatsApp opt-in %"', '=IFERROR(COUNTIF(Leads!J2:J,"Yes")/COUNTA(Leads!K2:K),0)'],
    ['="Checked a planned number"', '=COUNTIF(Leads!F2:F,"?*")'],
    ['="Opted in and checked a planned number"', '=COUNTIFS(Leads!J2:J,"Yes",Leads!F2:F,"?*")']
  ]);
  stats.getRange('B4').setNumberFormat('0%');
  stats.getRange('D1').setValue('Leads per day').setFontWeight('bold');
  stats.getRange('D2').setFormula('=IFERROR(QUERY(ARRAYFORMULA(IF(Leads!A2:A="",,INT(Leads!A2:A))),"select Col1, count(Col1) where Col1 is not null group by Col1 order by Col1 desc label Col1 \'Day\', count(Col1) \'Leads\'",0),"No leads yet")');
  stats.getRange('D3:D').setNumberFormat('yyyy-mm-dd');
  sheet.getRange('A2:A').setNumberFormat('yyyy-mm-dd hh:mm');
  ss.setSpreadsheetTimeZone('Asia/Kolkata');
  stats.autoResizeColumns(1, 5);
  Logger.log('SHEET_SECRET: ' + secret);
  Logger.log('Next: Deploy > New deployment > Web app (Execute as: Me, Who has access: Anyone), then copy the /exec URL.');
  return { ok: true };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
