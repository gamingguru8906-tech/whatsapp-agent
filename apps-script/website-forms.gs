/**
 * Website Forms: the 2027 order form on veshannastro.co.in, saved while people type (Kamala's form-drafts.js).
 *
 * Setup (once):
 *   1. Add this file to the same Apps Script project that already handles the WhatsApp bot
 *      (targets like "booking", "profile_upsert", "analytics"). File > New > Script, name it website-forms.
 *   2. In doPost, right AFTER the block that answers 'Unauthorized WhatsApp service request.' and BEFORE the line
 *      that starts `var knownTargets` (that line refuses targets it does not know), add these two lines:
 *        var websiteFormResult = handleWebsiteFormTarget_(data);
 *        if (websiteFormResult) return websiteFormResult;
 *      (If you added the phone Kamala lines from voice-agent.gs, put these right below them.)
 *      Kamala's own secret is checked by that block first, so only Kamala can write this tab.
 *   3. Run setupWebsiteFormsSheet() once from the editor. It adds the "Website Forms" tab.
 *   4. Deploy > Manage deployments > edit the web app > New version, so the live URL picks this up.
 *
 * One row per browser (the website's visitor id, column N, hidden). Kamala sends the row again whenever it changes,
 * and it is written over the same row, so nothing is duplicated.
 * Optional Script Property: CRM_SPREADSHEET_ID (if this script is not bound to the CRM sheet).
 */

var WEBSITE_FORMS_TAB = 'Website Forms';
var WEBSITE_FORMS_HEADERS = ['Last typed (IST)', 'Name', 'WhatsApp', 'Email', 'Date of birth', 'Time of birth', 'Place of birth',
  'Report', 'Referral', 'How far they got', 'Kamala follow-up', 'Saves', 'First seen (IST)', 'Visitor id'];
var WEBSITE_FORMS_KEYS = ['lastTyped', 'name', 'whatsapp', 'email', 'dob', 'tob', 'pob',
  'report', 'referral', 'stage', 'followUp', 'saves', 'firstSeen', 'visitor'];

/** Returns a JSON response for the website form target, or null so the existing doPost handles the rest. */
function handleWebsiteFormTarget_(data) {
  if (String((data && data.target) || '') !== 'website_form_upsert') return null;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Sheet temporarily busy; retryable' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  try {
    var result = upsertWebsiteForms_(data.rows || []);
    result.ok = true;
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  } finally {
    lock.releaseLock();
  }
}

function websiteFormsSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('CRM_SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Set the CRM_SPREADSHEET_ID script property (this script is not bound to the CRM sheet).');
  var sheet = ss.getSheetByName(WEBSITE_FORMS_TAB);
  if (!sheet) {
    sheet = ss.insertSheet(WEBSITE_FORMS_TAB);
    sheet.getRange(1, 1, 1, WEBSITE_FORMS_HEADERS.length).setValues([WEBSITE_FORMS_HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.hideColumns(WEBSITE_FORMS_HEADERS.length);
  }
  return sheet;
}

// Text a person typed is stored as text: a value starting with = + - @ would otherwise run as a formula.
function websiteFormCell_(v) {
  var s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'number') return v;
  s = s.slice(0, 300);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function upsertWebsiteForms_(rows) {
  var sheet = websiteFormsSheet_();
  var idCol = WEBSITE_FORMS_HEADERS.length;
  var last = sheet.getLastRow();
  var ids = last > 1 ? sheet.getRange(2, idCol, last - 1, 1).getValues() : [];
  var rowOf = {};
  for (var i = 0; i < ids.length; i++) if (ids[i][0]) rowOf[String(ids[i][0])] = i + 2;
  var added = 0, updated = 0;
  for (var j = 0; j < rows.length; j++) {
    var r = rows[j] || {};
    var visitor = String(r.visitor || '');
    if (!/^[a-f0-9]{16,40}$/.test(visitor)) continue;
    var values = WEBSITE_FORMS_KEYS.map(function (k) { return websiteFormCell_(r[k]); });
    if (rowOf[visitor]) {
      sheet.getRange(rowOf[visitor], 1, 1, values.length).setValues([values]);
      updated++;
    } else {
      sheet.appendRow(values);
      rowOf[visitor] = sheet.getLastRow();
      added++;
    }
  }
  return { added: added, updated: updated };
}

/** Run once from the editor: creates the "Website Forms" tab (an existing tab is left as it is). */
function setupWebsiteFormsSheet() {
  var sheet = websiteFormsSheet_();
  Logger.log('Website Forms tab ready (' + Math.max(0, sheet.getLastRow() - 1) + ' rows so far).');
}
