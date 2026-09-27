/**
 * Phone Kamala: Apps Script targets used by voice-agent.js.
 *
 * Setup (once):
 *   1. Add this file to the same Apps Script project that already handles the WhatsApp bot
 *      (targets like "booking", "profile_upsert", "calendar_hold").
 *   2. In doPost, right AFTER the apiSecret check and BEFORE the existing target handling, add:
 *        var voiceResult = handleVoiceTarget_(data);
 *        if (voiceResult) return voiceResult;
 *      where `data` is the parsed JSON body.
 *   3. Run setupVoiceSheets() once from the editor. It adds the "Phone Queries",
 *      "About & FAQ" and "Testimonials" tabs to the CRM spreadsheet.
 *   4. Deploy > Manage deployments > edit the web app > New version, so the live URL picks this up.
 *
 * Optional Script Properties: CRM_SPREADSHEET_ID (if this script is not bound to the CRM sheet)
 * and CALENDAR_ID (the calendar consultations are booked in; default calendar otherwise).
 */

var VOICE_TABS = {
  phoneQueries: {
    name: 'Phone Queries',
    headers: ['Date', 'Name', 'Number', 'Customer ID', 'Query', 'Summary', 'Mood', 'Outcome',
      'Callback due', 'Status', 'WhatsApp', 'Duration (sec)', 'Call ID']
  },
  faq: {
    name: 'About & FAQ',
    headers: ['Question', 'Answer (Kamala says only what is written here)']
  },
  testimonials: {
    name: 'Testimonials',
    headers: ['First name', 'City', 'Quote (word for word, real client, with permission)']
  }
};

var VOICE_STARTER_QUESTIONS = [
  'Shri Shashank ji kaun hain?',
  'Unka kitne saal ka experience hai?',
  'Unki book kaunsi hai?',
  'Consultation kaise hoti hai (online, kitni der)?',
  'Kya yeh trustable hai?',
  'Refund policy kya hai?',
  'Remedies ke liye alag se kharcha hota hai kya?',
  'Report kitne din mein milti hai?',
  'Payment safe hai kya?',
  'Consultation ke baad follow-up milta hai kya?'
];

/** Returns a JSON response for voice targets, or null so the existing doPost handles the rest. */
function handleVoiceTarget_(data) {
  var target = String((data && data.target) || '');
  var result;
  if (target === 'voice_setup') result = setupVoiceSheets();
  else if (target === 'phone_query') result = appendPhoneQuery_(data);
  else if (target === 'voice_knowledge') result = readVoiceKnowledge_();
  else if (target === 'calendar_free_slots') result = freeSlots_(data);
  else return null;
  result.ok = true;
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

function voiceSpreadsheet_() {
  var id = PropertiesService.getScriptProperties().getProperty('CRM_SPREADSHEET_ID');
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('Set the CRM_SPREADSHEET_ID script property (this script is not bound to the CRM sheet).');
  return ss;
}

function voiceTab_(tab) {
  var ss = voiceSpreadsheet_();
  var sheet = ss.getSheetByName(tab.name);
  if (!sheet) {
    sheet = ss.insertSheet(tab.name);
    sheet.getRange(1, 1, 1, tab.headers.length).setValues([tab.headers]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

/** Run once from the editor: creates the three tabs (existing tabs are left as they are). */
function setupVoiceSheets() {
  var queries = voiceTab_(VOICE_TABS.phoneQueries);
  var status = SpreadsheetApp.newDataValidation()
    .requireValueInList(['Callback pending', 'Called back', 'Closed'], true).setAllowInvalid(true).build();
  queries.getRange(2, 10, queries.getMaxRows() - 1, 1).setDataValidation(status);

  var faq = voiceTab_(VOICE_TABS.faq);
  if (faq.getLastRow() < 2) {
    faq.getRange(2, 1, VOICE_STARTER_QUESTIONS.length, 1)
      .setValues(VOICE_STARTER_QUESTIONS.map(function (q) { return [q]; }));
  }
  faq.setColumnWidth(1, 320).setColumnWidth(2, 600);

  var quotes = voiceTab_(VOICE_TABS.testimonials);
  quotes.setColumnWidth(3, 600);
  return { tabs: [VOICE_TABS.phoneQueries.name, VOICE_TABS.faq.name, VOICE_TABS.testimonials.name] };
}

function appendPhoneQuery_(d) {
  var sheet = voiceTab_(VOICE_TABS.phoneQueries);
  sheet.appendRow([
    d.date || new Date(), d.name || '', d.phone || '', d.customerId || '', d.query || 'Other',
    d.summary || '', d.mood || '', d.outcome || '', d.callbackDue || '', d.status || 'Closed',
    d.whatsapp || '', d.durationSeconds || '', d.callSid || ''
  ]);
  return { row: sheet.getLastRow() };
}

/** Only rows with both a question and an answer (or a quote) are spoken on calls. */
function readVoiceKnowledge_() {
  var faq = voiceTab_(VOICE_TABS.faq).getDataRange().getValues().slice(1)
    .filter(function (r) { return String(r[0]).trim() && String(r[1]).trim(); })
    .map(function (r) { return { question: String(r[0]).trim(), answer: String(r[1]).trim() }; });
  var testimonials = voiceTab_(VOICE_TABS.testimonials).getDataRange().getValues().slice(1)
    .filter(function (r) { return String(r[2]).trim(); })
    .map(function (r) { return { name: String(r[0]).trim(), city: String(r[1]).trim(), quote: String(r[2]).trim() }; });
  return { faq: faq, testimonials: testimonials };
}

/** Echoes back the one-hour slots (ISO strings with +05:30) that have no event in the booking calendar. */
function freeSlots_(d) {
  var id = PropertiesService.getScriptProperties().getProperty('CALENDAR_ID');
  var calendar = id ? CalendarApp.getCalendarById(id) : CalendarApp.getDefaultCalendar();
  if (!calendar) throw new Error('Calendar not found; check the CALENDAR_ID script property.');
  var free = (d.slots || []).filter(function (iso) {
    var start = new Date(iso);
    if (isNaN(start.getTime())) return false;
    var end = new Date(start.getTime() + 60 * 60 * 1000);
    return calendar.getEvents(start, end).filter(function (e) { return !e.isAllDayEvent(); }).length === 0;
  });
  return { free: free };
}
