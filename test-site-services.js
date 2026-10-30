'use strict';
// node test-site-services.js — the website's services.json reader.
const assert = require('assert/strict');
const test = require('node:test');
const site = require('./site-services');

const sample = {
  updated: '2026-10-24',
  categories: [
    { id: 'r27', name: '2027 Personal Year Report', services: [
      { t: '2027 Report: Astro-Numero Blend', p: '₹1,263', was: '₹1,804', off: '30% off', usd: 'US$30', give: ['pdf'], needs: ['dob', 'tob', 'pob'], features: ['Delivered on WhatsApp and email within 24 hours'] },
      { t: '2027 Report: Classic', p: '₹963', give: ['pdf'], needs: ['dob', 'pob'] },
      { t: 'No price yet' }
    ] },
    { id: 'empty', name: 'Nothing here', services: [] },
    { name: 'No id', services: [{ t: 'x', p: '₹1' }] }
  ],
  offer: '2027 reports: 30% Diwali offer until 6 November. Phase one is limited to 200 reports.',
  inside: ['All 12 months, one page each: which months are favourable.'],
  faq: [{ q: 'What is the 2027 numerology report price in India?', a: 'The Astro-Numero Blend is ₹1,263.' }, { q: 'no answer' }],
  blog: [{ title: 'Personal Year 5 in 2027', about: 'Change and travel.', url: 'https://www.veshannastro.co.in/blog/personal-year-5-in-2027.html' },
    { title: 'Bad link', url: 'javascript:alert(1)' }]
};

test('keeps only usable categories and services', () => {
  const r = site.read(sample);
  assert.equal(r.categories.length, 1);
  assert.deepEqual(r.categories[0].services.map(s => s.t), ['2027 Report: Astro-Numero Blend', '2027 Report: Classic']);
  assert.deepEqual(r.categories[0].services[0].needs, ['dob', 'tob', 'pob']);
});

test('facts: answered questions and https blog links only', () => {
  const { facts } = site.read(sample);
  assert.equal(facts.faq.length, 1);
  assert.equal(facts.blog.length, 1);
  const text = site.factsText(facts);
  assert.match(text, /2027 REPORT OFFER: 2027 reports: 30% Diwali offer until 6 November/);
  assert.match(text, /Q: What is the 2027 numerology report price in India\?\nA: The Astro-Numero Blend is ₹1,263\./);
  assert.match(text, /personal-year-5-in-2027\.html/);
  assert.doesNotMatch(text, /javascript:/);
});

test('nothing usable gives null, and no facts give no text', () => {
  assert.equal(site.read(null), null);
  assert.equal(site.read({ categories: [] }), null);
  assert.equal(site.read({ categories: [{ id: 'a', name: 'A', services: [{ t: 'x' }] }] }), null);
  assert.equal(site.factsText(null), '');
  assert.equal(site.factsText({ offer: '', inside: [], faq: [], blog: [] }), '');
});

test('the real services.json from the website repo, when it is next to this one', () => {
  const fs = require('fs'), path = require('path');
  const file = path.join(__dirname, '..', 'veshannastro6', 'services.json');
  if (!fs.existsSync(file)) return;
  const r = site.read(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.ok(r && r.categories[0].id === 'r27');
  const names = r.categories.flatMap(c => c.services.map(s => s.t));
  assert.ok(names.includes('2027 Report: Astro-Numero Blend') && names.includes('2027 Report: Classics'));
  assert.ok(!names.includes('Personal Year Forecast'));
  assert.ok(site.factsText(r.facts).length < 9000);
});

test('India-only fees: only Indian +91 mobile numbers pass', () => {
  assert.equal(site.indiaOnly({ region: 'IN' }), true);
  assert.equal(site.indiaOnly({ region: 'in' }), true);
  assert.equal(site.indiaOnly({}), false);
  assert.equal(site.isIndianNumber('919876543210'), true);
  assert.equal(site.isIndianNumber('+91 98765 43210'), true);
  assert.equal(site.isIndianNumber('14155552671'), false);
  assert.equal(site.isIndianNumber('971501234567'), false);
  assert.equal(site.isIndianNumber('9876543210'), false);
});

test('the website marks the three consultations India-only, with one flat fee each', () => {
  const fs = require('fs'), path = require('path');
  const file = path.join(__dirname, '..', 'veshannastro6', 'services.json');
  if (!fs.existsSync(file)) return;
  const r = site.read(JSON.parse(fs.readFileSync(file, 'utf8')));
  const all = Object.fromEntries(r.categories.flatMap(c => c.services.map(s => [s.t, s])));
  for (const [name, fee] of [['Online Astrology Consultation', '₹3,699'], ['Online Numerology Consultation', '₹555'], ['Muhurat Selection Consultation', '₹1,269']]) {
    assert.ok(all[name], name);
    assert.equal(all[name].p, fee);
    assert.equal(all[name].was, undefined);
    assert.ok(site.indiaOnly(all[name]));
  }
  assert.equal(all['Online Numerology Consultation'].options.length, 8);
});
