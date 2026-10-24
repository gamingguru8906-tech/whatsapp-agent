'use strict';
// node test-website-forms-gs.js — apps-script/website-forms.gs in a small stand-in for Google Sheets.
const assert = require('assert/strict');
const test = require('node:test');
const fs = require('fs');
const vm = require('vm');

function load() {
  const grid = [];
  const cell = (r, c) => (grid[r - 1] || [])[c - 1] ?? '';
  const put = (r, c, v) => { while (grid.length < r) grid.push([]); grid[r - 1][c - 1] = v; };
  const range = (r, c, nr = 1, nc = 1) => ({
    getValues: () => Array.from({ length: nr }, (_, i) => Array.from({ length: nc }, (_, j) => cell(r + i, c + j))),
    setValues(v) { v.forEach((row, i) => row.forEach((x, j) => put(r + i, c + j, x))); return this; },
    setFontWeight() { return this; }
  });
  let created = 0;
  const sheet = { getLastRow: () => grid.length, appendRow: v => grid.push([...v]), getRange: range, setFrozenRows() {}, hideColumns() {} };
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => (created ? sheet : null), insertSheet: () => { created++; return sheet; } }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    ContentService: { createTextOutput: t => ({ setMimeType: () => ({ text: t }) }), MimeType: { JSON: 'json' } },
    Logger: { log() {} }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/apps-script/website-forms.gs', 'utf8'), ctx);
  return { grid, ctx, call: rows => JSON.parse(ctx.handleWebsiteFormTarget_({ target: 'website_form_upsert', rows }).text) };
}

const V = 'a1b2c3d4e5f6a7b8c9d0e1f2';
test('one row per visitor: added once, then written over; typed formulas stay text', () => {
  const { grid, call } = load();
  assert.deepEqual(call([{ visitor: V, name: 'Ananya', whatsapp: '', saves: 1 }]), { added: 1, updated: 0, ok: true });
  assert.deepEqual(call([{ visitor: V, name: 'Ananya Iyer', whatsapp: '+919876500001', saves: 2 }, { visitor: 'bad id', name: 'x' }]), { added: 0, updated: 1, ok: true });
  assert.equal(grid.length, 2);
  assert.equal(grid[0][0], 'Last typed (IST)');
  assert.equal(grid[1][1], 'Ananya Iyer');
  assert.equal(grid[1][2], '+919876500001'.replace(/^\+/, "'+"));
  assert.equal(grid[1][13], V);
  call([{ visitor: 'b' + V.slice(1), name: '=HYPERLINK("x")' }]);
  assert.equal(grid[2][1], "'=HYPERLINK(\"x\")");
});

test('other targets pass through to the existing doPost', () => {
  const { ctx } = load();
  assert.equal(ctx.handleWebsiteFormTarget_({ target: 'booking' }), null);
});
