/**
 * Veshannastro free mobile-numerology leads -> Kamala's CRM spreadsheet.
 * Adds two tabs there: "Numerology Leads" (one row per unique lead) and "Numerology Stats".
 *
 * This is an extra file for the Apps Script project that already runs the WhatsApp bot (Kamala), the same way
 * voice-agent.gs is. Every name here starts with "numerology" so nothing clashes with Kamala's own code.
 *
 * Setup (once, about 5 minutes):
 *   1. Open Kamala's CRM spreadsheet > Extensions > Apps Script.
 *   2. Next to "Files" press + > Script. Name it numerology-leads. Paste this whole file and press Save.
 *   3. Open the file that has doPost. Find the line that reads the request body into `data`
 *      (it looks like  var data = JSON.parse(e.postData.contents);  ). Right AFTER that line, and BEFORE the
 *      apiSecret check, add these two lines:
 *        var numerologyResult = handleNumerologyTarget_(data);
 *        if (numerologyResult) return numerologyResult;
 *      They answer only the numerology website, which uses its own key. Every other request carries on as before.
 *      Press Save.
 *   4. At the top, choose the function setupNumerologySheets and press Run. Approve the permissions if asked.
 *      Open the Execution log:
 *        - "Hook OK" means step 3 is right. "Hook NOT working" means the two lines are missing or below the
 *          apiSecret check: move them up and run setupNumerologySheets again.
 *        - Copy the value after "NUMEROLOGY_SHEET_SECRET:". It goes into Cloudflare as SHEET_SECRET.
 *   5. Deploy > Manage deployments > pencil icon on the web app > Version: New version > Deploy.
 *      The /exec URL does not change; it goes into Cloudflare as SHEET_WEBAPP_URL. (Saving alone does not
 *      update the live URL; a new version must be deployed every time this code changes.)
 *
 * The website sends each new lead once, and this script also refuses any Key it already has, so a resend after
 * a network hiccup can never create a duplicate row.
 */

var NUMEROLOGY_LEADS_TAB = 'Numerology Leads';
var NUMEROLOGY_STATS_TAB = 'Numerology Stats';
var NUMEROLOGY_TARGET = 'numerology_append_rows';
var NUMEROLOGY_HEADERS = ['Date (IST)', 'Name', 'Mobile', 'Date of birth', 'Concern', 'Planned 1', 'Planned 2', 'Planned 3',
  'Consent', 'WhatsApp opt-in', 'Key'];

/** Called from doPost. Returns a response for the numerology website's request, or null for anything else. */
function handleNumerologyTarget_(data) {
  if (!data || data.target !== NUMEROLOGY_TARGET) return null;
  var secret = PropertiesService.getScriptProperties().getProperty('NUMEROLOGY_SHEET_SECRET');
  if (!secret || String(data.numerologySecret || '') !== secret) return numerologyJson_({ ok: false, error: 'unauthorised' });
  return numerologyJson_(numerologyAppendRows_(data.rows || []));
}

function numerologyAppendRows_(rows) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) return { ok: false, error: 'temporarily busy, retryable' };
  try {
    var sheet = numerologyLeadsSheet_();
    var keyCol = NUMEROLOGY_HEADERS.length;
    var results = {};
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i] || {};
      var key = String(row.key || '');
      if (!/^[0-9a-f]{64}$/.test(key)) { results[key] = 'invalid'; continue; }
      var last = sheet.getLastRow();
      var found = last > 1 && sheet.getRange(2, keyCol, last - 1, 1).createTextFinder(key).matchEntireCell(true).findNext();
      if (found) { results[key] = 'exists'; continue; }
      sheet.appendRow([
        numerologyIstDate_(row.date), numerologySafe_(row.name), "'" + String(row.mobile || ''), "'" + String(row.dob || ''),
        numerologySafe_(row.concern),
        row.planned1 ? "'" + row.planned1 : '', row.planned2 ? "'" + row.planned2 : '', row.planned3 ? "'" + row.planned3 : '',
        numerologySafe_(row.consent), numerologySafe_(row.waOptIn), key
      ]);
      results[key] = 'added';
    }
    return { ok: true, results: results };
  } finally {
    lock.releaseLock();
  }
}

// "2026-10-09 14:30:00" (IST) -> a real date-time value, so the Stats formulas can count by day.
function numerologyIstDate_(v) {
  var d = new Date(String(v || '').replace(' ', 'T') + '+05:30');
  return isNaN(d.getTime()) ? numerologySafe_(v) : d;
}

// Text that starts with = + - @ would run as a spreadsheet formula; keep it as plain text.
function numerologySafe_(v) {
  var s = String(v == null ? '' : v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

// Same spreadsheet rule as voice-agent.gs: the bound CRM sheet, or CRM_SPREADSHEET_ID if the script is standalone.
function numerologySpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('CRM_SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Set the CRM_SPREADSHEET_ID script property (this script is not bound to the CRM sheet).');
  return ss;
}

function numerologyLeadsSheet_() {
  var ss = numerologySpreadsheet_();
  var sheet = ss.getSheetByName(NUMEROLOGY_LEADS_TAB) || ss.insertSheet(NUMEROLOGY_LEADS_TAB);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(NUMEROLOGY_HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, NUMEROLOGY_HEADERS.length).setFontWeight('bold');
  }
  return sheet;
}

/**
 * Run once from the editor (step 4 above). Safe to run again: it keeps existing leads and the existing key,
 * and only rewrites the "Numerology Stats" tab. It never touches Kamala's tabs or settings.
 */
function setupNumerologySheets() {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('NUMEROLOGY_SHEET_SECRET');
  if (!secret) {
    secret = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    props.setProperty('NUMEROLOGY_SHEET_SECRET', secret);
  }
  var ss = numerologySpreadsheet_();
  var sheet = numerologyLeadsSheet_();
  sheet.hideColumns(NUMEROLOGY_HEADERS.length); // Key: needed for the no-duplicates check, not for reading
  sheet.getRange('A2:A').setNumberFormat('yyyy-mm-dd hh:mm');

  var L = "'" + NUMEROLOGY_LEADS_TAB + "'!";
  var stats = ss.getSheetByName(NUMEROLOGY_STATS_TAB) || ss.insertSheet(NUMEROLOGY_STATS_TAB);
  stats.clear();
  stats.getRange('A1:B1').setValues([['Measure', 'Value']]).setFontWeight('bold');
  stats.getRange('A2:B6').setFormulas([
    ['="Total leads"', '=COUNTA(' + L + 'K2:K)'],
    ['="Last 7 days"', '=COUNTIF(' + L + 'A2:A,">="&(TODAY()-7))'],
    ['="WhatsApp opt-in %"', '=IFERROR(COUNTIF(' + L + 'J2:J,"Yes")/COUNTA(' + L + 'K2:K),0)'],
    ['="Checked a planned number"', '=COUNTIF(' + L + 'F2:F,"?*")'],
    ['="Opted in and checked a planned number"', '=COUNTIFS(' + L + 'J2:J,"Yes",' + L + 'F2:F,"?*")']
  ]);
  stats.getRange('B4').setNumberFormat('0%');
  stats.getRange('D1').setValue('Leads per day').setFontWeight('bold');
  stats.getRange('D2').setFormula('=IFERROR(QUERY(ARRAYFORMULA(IF(' + L + 'A2:A="",,INT(' + L + 'A2:A))),"select Col1, count(Col1) where Col1 is not null group by Col1 order by Col1 desc label Col1 \'Day\', count(Col1) \'Leads\'",0),"No leads yet")');
  stats.getRange('D3:D').setNumberFormat('yyyy-mm-dd');
  stats.autoResizeColumns(1, 5);

  if (ss.getSpreadsheetTimeZone() !== 'Asia/Kolkata') {
    Logger.log('Note: this spreadsheet\'s time zone is ' + ss.getSpreadsheetTimeZone() + ', so lead times show in that zone. '
      + 'To show them in IST, set File > Settings > Time zone to (GMT+05:30) India Standard Time (this also affects Kamala\'s tabs).');
  }
  Logger.log(checkNumerologyHook_(secret));
  Logger.log('NUMEROLOGY_SHEET_SECRET: ' + secret);
  Logger.log('Next: Deploy > Manage deployments > edit the web app > Version: New version > Deploy.');
  return { ok: true };
}

// Sends doPost an empty numerology request, exactly as the website would, to confirm the two lines are in place.
function checkNumerologyHook_(secret) {
  if (typeof doPost !== 'function') return 'Hook NOT working: this project has no doPost. Add this file to the project that runs Kamala.';
  var reply;
  try {
    var out = doPost({ postData: { contents: JSON.stringify({ target: NUMEROLOGY_TARGET, numerologySecret: secret, rows: [] }) }, parameter: {} });
    reply = JSON.parse(out.getContent());
  } catch (err) {
    return 'Hook NOT working: doPost failed (' + err + '). Check the two lines in step 3.';
  }
  if (reply && reply.ok === true && reply.results) return 'Hook OK: doPost passes numerology leads to this file.';
  return 'Hook NOT working: doPost answered ' + JSON.stringify(reply).slice(0, 200)
    + '. Put the two lines from step 3 right after `data` is read and before the apiSecret check, then run setupNumerologySheets again.';
}

function numerologyJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
