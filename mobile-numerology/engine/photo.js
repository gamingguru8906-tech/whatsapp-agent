// Reading a watch from a photo. A vision model only *describes* the watch, using the form's own choices; it never
// writes any part of the reading. Whatever it returns is checked against the form's vocabulary (cleanWatch), so an
// unknown or made-up value is dropped, and the visitor checks every filled answer before the reading is made.
// The photo is not stored.

import { WATCH_ATTRIBUTES, cleanWatch } from '../../brain/watch.js';

export const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';

// Details a photo can show. Wrist (photos are often mirrored), size on the wrist, power, original/copy, gift,
// how it is worn and how many watches the person owns cannot be seen, so the visitor answers those.
export const PHOTO_KEYS = ['dialShape', 'dialColour', 'caseMetal', 'markers', 'numeralsShown', 'numeralSize', 'dateWindow',
  'datePosition', 'strapMaterial', 'strapWidth', 'strapStructure', 'hands', 'handStyle', 'thickness', 'watchType', 'dialArt'];

const ATTR = Object.fromEntries(WATCH_ATTRIBUTES.map(a => [a.key, a]));

// Plain descriptions so the model picks the right code (codes alone, like "rectVertical", are easy to misread).
const HINT = {
  dialShape: 'shape of the dial face. rectVertical = rectangle taller than wide; rectHorizontal = wider than tall; roundedRect = square/rectangle with rounded corners (most smartwatches); ovalVertical / ovalHorizontal; hexHorizontal / hexVertical; octagon',
  dialColour: 'main background colour of the dial face (not the case)',
  caseMetal: 'colour of the case around the dial. twoTone = gold and silver together; black = black metal/ceramic; plastic = plastic/resin case',
  markers: 'what marks the hours: arabic = 1 2 3; roman = I II III; regional = Hindi/Arabic-Indic or other script digits; dashes = short lines/batons; dots; stars; diamonds = stones; none = nothing at the hours',
  numeralsShown: 'which hours carry a NUMBER (arabic or roman): all; quarters = only 12, 3, 6, 9; onlyTwelve; even; odd; noneShown = no numbers at all',
  numeralSize: 'size of the hour numbers or marks compared with the dial',
  dateWindow: 'a small window showing the date and/or the day: none, date, day, dayDate',
  datePosition: 'the hour position (1-12) nearest to the date/day window, e.g. "3" when it sits at 3 o\'clock',
  strapMaterial: 'metal = metal bracelet/chain; leather; rubber; silicone; resin; nylon; fabric; velcro; wood; stone; crystal',
  strapWidth: 'strap width compared with the dial width: wide (as wide as the dial), medium, narrow (much narrower)',
  strapStructure: 'solid = one continuous strap; longLinks = metal bracelet with links; gaps = mesh/open links with visible gaps',
  hands: 'three = hour, minute and second hands; noSeconds = only hour and minute; noMinute = one hand; digital = digital display, no hands',
  handStyle: 'classic = plain straight hands; sharp = pointed sword/dagger hands; tails = second hand with a long tail behind the centre; odd = unusual hands',
  thickness: 'how thick the case looks from the side, if visible',
  watchType: 'classic = dress/everyday analog; smart = smartwatch screen; sports = chronograph/diver/rugged; pocketFlip = pocket or flip watch; reversible',
  dialArt: 'list of anything printed on the dial besides the time: text (brand words do not count unless large), face, scenery, animal, birds, plants, verticalLines, horizontalLines, spiral, circles, glitter, compass. Empty list if none'
};

// JSON schema the model must follow: every detail is one of the form's codes, or "unsure".
export function photoSchema() {
  const props = {};
  for (const k of PHOTO_KEYS) {
    const opts = Object.keys(ATTR[k].options);
    props[k] = ATTR[k].multi
      ? { type: 'array', items: { type: 'string', enum: opts } }
      : { type: 'string', enum: [...opts, 'unsure'] };
  }
  props.isWatch = { type: 'boolean' };
  return { type: 'object', properties: props, required: ['isWatch', ...PHOTO_KEYS] };
}

export function photoPrompt() {
  const lines = PHOTO_KEYS.map(k => `- ${k}: one of [${Object.keys(ATTR[k].options).join(', ')}${ATTR[k].multi ? '' : ', unsure'}]. ${HINT[k]}`);
  return [
    'You describe the wristwatch in the photo for a form. Look carefully at the watch only.',
    'Answer with JSON only, using exactly these keys and only the listed codes.',
    'Use "unsure" whenever you cannot clearly see a detail. Do not guess. A wrong answer is worse than "unsure".',
    'Set isWatch to false if the photo does not show a watch.',
    ...lines
  ].join('\n');
}

// Turns the model's reply into form answers. Returns { ok, watch, filled } or { ok: false, error }.
export function parsePhotoReply(reply) {
  let data = reply;
  if (typeof reply === 'string') {
    const m = reply.match(/\{[\s\S]*\}/);
    if (!m) return { ok: false, error: 'unreadable' };
    try { data = JSON.parse(m[0]); } catch { return { ok: false, error: 'unreadable' }; }
  }
  if (!data || typeof data !== 'object') return { ok: false, error: 'unreadable' };
  if (data.isWatch === false) return { ok: false, error: 'not-a-watch' };
  const picked = {};
  for (const k of PHOTO_KEYS) if (data[k] !== undefined && data[k] !== 'unsure') picked[k] = data[k];
  // The date position only counts when a window was seen; a digital or smart watch has no hour marks to read.
  if (!['date', 'day', 'dayDate'].includes(picked.dateWindow)) delete picked.datePosition;
  if (picked.hands === 'digital' || picked.watchType === 'smart') { delete picked.markers; delete picked.numeralsShown; delete picked.numeralSize; delete picked.handStyle; }
  // Almost every dial carries a brand name, which the model tends to report as "text"; the visitor adds real text art.
  if (Array.isArray(picked.dialArt)) picked.dialArt = picked.dialArt.filter(x => x !== 'text');
  const watch = cleanWatch(picked);
  if (Array.isArray(watch.dialArt) && !watch.dialArt.length) delete watch.dialArt;
  const filled = Object.keys(watch);
  if (!filled.length) return { ok: false, error: 'nothing-seen' };
  return { ok: true, watch, filled };
}

// Accepts only a small JPEG/PNG/WebP data URL (the page shrinks the photo before sending it).
export const MAX_PHOTO_BYTES = 1_500_000;
export function checkPhoto(dataUrl) {
  if (typeof dataUrl !== 'string') return 'Please choose a photo.';
  const m = dataUrl.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return 'Please choose a JPG, PNG or WebP photo.';
  if (m[2].length * 0.75 > MAX_PHOTO_BYTES) return 'That photo is too large. Please try a smaller one.';
  return null;
}

export async function readWatchPhoto(ai, dataUrl) {
  const res = await ai.run(VISION_MODEL, {
    messages: [
      { role: 'system', content: photoPrompt() },
      { role: 'user', content: [
        { type: 'text', text: 'Describe this watch for the form. JSON only.' },
        { type: 'image_url', image_url: { url: dataUrl } }
      ] }
    ],
    response_format: { type: 'json_schema', json_schema: photoSchema() },
    temperature: 0,
    max_tokens: 600
  });
  const out = res?.response ?? res?.choices?.[0]?.message?.content ?? res;
  return parsePhotoReply(out);
}
