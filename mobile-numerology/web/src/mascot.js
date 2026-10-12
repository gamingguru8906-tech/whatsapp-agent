// What the helper says while someone fills in a form on this site. The forms keep their own error messages under
// each field; the helper adds one friendly line beside the first thing that needs attention.
import { mascotSay } from './components/Companion.jsx';

const TIPS = {
  photo: (msg, seg) => (/clearer/.test(msg) ? 'That photo did not work for me. Try a closer photo of the watch face, in good light.'
    : seg === 'watch' ? 'Start with a photo of your watch. Tap Add photo.' : msg),
  strap: () => 'Which strap is on your watch? Pick one.',
  wrist: (msg, seg) => (seg === 'wrist' ? 'Add a photo of your wrist, or choose your wrist size.' : 'Which wrist do you wear it on?'),
  goal: () => 'What would you like to improve? Pick one, or type your own.',
  name: () => 'What should I call you? Please add your name.',
  mobile: () => 'Could you check your mobile number? It needs 10 digits, like 98765 43210.',
  dob: msg => (/does not exist/.test(msg) ? 'That date does not exist. Could you check the day and month?' : 'I need your full date of birth: day, month and year.'),
  concern: () => 'Tell me what is worrying you, or tap one that fits.',
  consent: () => 'Please tick the box so I can show your reading.'
};
const ANCHOR = { photo: '#w-photo', strap: '#w-strap', wrist: { watch: '#w-wrist', wrist: '#reading-form .group-card' }, goal: '#w-goal' };

/** The first missing or wrong field: one line beside it. */
export function tipMissing(miss, segment) {
  const k = Object.keys(miss)[0];
  if (!k) return;
  const a = ANCHOR[k];
  const anchor = typeof a === 'object' ? a[segment] : a ?? `#f-${k}`;
  mascotSay({ mood: 'worried', say: TIPS[k] ? TIPS[k](miss[k], segment) : miss[k], anchor, hold: 8000 });
}

export const photoReading = anchor => mascotSay({ mood: 'think', say: 'Reading your photo...', anchor, hold: 0 });
export const photoRead = (anchor, say) => mascotSay({ mood: 'happy', say, anchor, hold: 7000 });
export const photoFailed = (anchor, say) => mascotSay({ mood: 'worried', say, anchor, hold: 9000 });

const WORK = { watch: 'Reading your watch...', wrist: 'Finding your watch for the year...', mobile: 'Reading your number...' };
export const sending = segment => mascotSay({ mood: 'think', say: WORK[segment] ?? 'One moment...', anchor: '#reading-form button[type=submit]', hold: 0 });
export const failed = say => mascotSay({ mood: 'worried', say, anchor: '#reading-form button[type=submit]', hold: 9000 });
export const done = segment => mascotSay({
  mood: 'happy', anchor: '#r-answer',
  say: segment === 'wrist' ? 'Here is your watch for the year.' : segment === 'watch' ? 'Here is what your watch says about you.' : 'Here is your reading.',
  hold: 6000
});

/** A mobile number left half typed: say so when they move on from the field. */
export function watchMobileField() {
  const on = e => {
    if (e.target?.id !== 'f-mobile') return;
    const n = e.target.value.replace(/\D/g, '').length;
    if (n > 0 && n < 10) mascotSay({ mood: 'worried', say: TIPS.mobile(), anchor: '#f-mobile', hold: 8000 });
  };
  document.addEventListener('focusout', on);
  return () => document.removeEventListener('focusout', on);
}
