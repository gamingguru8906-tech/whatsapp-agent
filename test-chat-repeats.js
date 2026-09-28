'use strict';

// Kamala must never send the same reply twice in one WhatsApp message.
const test = require('node:test');
const assert = require('node:assert');
const { collapseRepeats } = require('./crm');

test('a reply repeated back to back is sent once', () => {
  const once = 'Got it, right name vibration se life mein kaafi smooth flow ban jata hai. First, could you please share your current full Name and Date of Birth to check?';
  assert.strictEqual(collapseRepeats(once.repeat(4)), once);
  const twice = 'Actually could you please quickly share your full name aur date of birth ek baar yahan?';
  assert.strictEqual(collapseRepeats(twice.repeat(8)), twice);
  assert.strictEqual(collapseRepeats(`${once} ${once}\n${once}`), once);
});

test('a sentence said twice in one message is kept once', () => {
  assert.strictEqual(
    collapseRepeats('Main slot check karti hoon abhi.Main slot check karti hoon abhi.Aapka time kya rahega?'),
    'Main slot check karti hoon abhi. Aapka time kya rahega?'
  );
});

test('normal replies are left exactly as written', () => {
  for (const text of [
    'Price ₹1,100.50 hai. Slot 5 pm ka free hai. Book karun?',
    'Ji.\nJi.\nHaan bilkul, main dekhti hoon.',
    'Hi, aap kaise hain?',
    'Aapka career thoda stuck feel ho raha hai na? Don\'t worry, it\'s just a phase.'
  ]) assert.strictEqual(collapseRepeats(text), text);
});
