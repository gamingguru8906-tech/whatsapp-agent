// Runs apps-script/numerology-leads.gs against a small in-memory spreadsheet, so the code JK pastes into Kamala's
// Apps Script is tested before it goes live: append once per key, and op "update" fills the answer columns of the
// existing row and never appends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fakeSpreadsheet() {
  const grid = []; // rows of cells, 1-based in the API
  const cell = (r, c) => (grid[r - 1] ?? [])[c - 1] ?? '';
  const put = (r, c, v) => { while (grid.length < r) grid.push([]); grid[r - 1][c - 1] = v; };
  const range = (r, c, nr = 1, nc = 1) => ({
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
    setValues: v => { v.forEach((row, i) => row.forEach((x, j) => put(r + i, c + j, x))); return range(r, c, nr, nc); },
    setValue: v => { put(r, c, v); return range(r, c); },
    setFontWeight: () => range(r, c, nr, nc),
    setNumberFormat: () => range(r, c, nr, nc),
    createTextFinder: text => ({ matchEntireCell: () => ({ findNext: () => {
      for (let i = 0; i < nr; i++) if (String(cell(r + i, c)) === text) return { getRow: () => r + i };
      return null;
    } }) })
  });
  const sheet = {
    getLastRow: () => grid.length, appendRow: v => { grid.push([...v]); }, setFrozenRows() {}, hideColumns() {},
    getRange: (a, b, c, d) => (typeof a === 'string' ? range(1, 1) : range(a, b, c, d)), autoResizeColumns() {}
  };
  return { grid, sheet };
}

function load() {
  const { grid, sheet } = fakeSpreadsheet();
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }), openById: () => null },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k === 'NUMEROLOGY_SHEET_SECRET' ? 's3cret' : null), setProperty() {} }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { createTextOutput: t => ({ setMimeType: () => ({ text: t }) }), MimeType: { JSON: 'json' } },
    Logger: { log() {} }, Utilities: { getUuid: () => 'u' }
  };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL('../apps-script/numerology-leads.gs', import.meta.url), 'utf8'), ctx);
  const call = rows => JSON.parse(ctx.handleNumerologyTarget_({ target: 'numerology_append_rows', numerologySecret: 's3cret', rows }).text);
  return { grid, call, ctx };
}

const KEY = 'a'.repeat(64);
const lead = { key: KEY, date: '2026-10-11 10:00:00', name: 'Rahul Sharma', mobile: '9811045672', dob: '1988-10-29',
  concern: 'Watch for the year: size=slim', consent: 'Yes', waOptIn: 'No' };

test('a lead is appended once; answers fill L to N and the opt-in column on the same row', () => {
  const { grid, call } = load();
  assert.deepEqual(call([lead]).results, { [KEY]: 'added' });
  assert.deepEqual(call([lead]).results, { [KEY]: 'exists' });
  assert.deepEqual(grid[0].slice(11, 14), ['Sounds like you', 'Answered at (IST)', 'Opt-in at (IST)']);
  assert.equal(grid.length, 2);
  assert.deepEqual(call([{ op: 'update', key: KEY, soundsLikeYou: 'Yes', answeredAt: '2026-10-11 10:01:00' }]).results, { [KEY]: 'updated' });
  assert.deepEqual(call([{ op: 'update', key: KEY, waOptIn: 'Yes', optInAt: '2026-10-11 10:02:00' }]).results, { [KEY]: 'updated' });
  const row = grid[1];
  assert.equal(row[2], "'9811045672");
  assert.equal(row[9], 'Yes');
  assert.equal(row[11], 'Yes');
  assert.ok([row[12], row[13]].every(d => Object.prototype.toString.call(d) === '[object Date]' && !isNaN(d))); // real date-times
  assert.equal(grid.length, 2);
});

test('an update for a key the Sheet does not have is never appended; a wrong secret is refused', () => {
  const { grid, call, ctx } = load();
  assert.deepEqual(call([{ op: 'update', key: 'b'.repeat(64), soundsLikeYou: 'No' }]).results, { ['b'.repeat(64)]: 'missing' });
  assert.equal(grid.length, 1); // only the header row
  const bad = JSON.parse(ctx.handleNumerologyTarget_({ target: 'numerology_append_rows', numerologySecret: 'x', rows: [lead] }).text);
  assert.equal(bad.ok, false);
  assert.equal(ctx.handleNumerologyTarget_({ target: 'something_else' }), null); // Kamala's own requests pass through
});
