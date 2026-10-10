// The watch details the Wristwatch Numerology segment asks about (picked by hand now, read from a photo later).
import data from './data/watch-attributes.json' with { type: 'json' };
export const WATCH_ATTRIBUTES = data.attributes;

// Keeps only known details and values; anything else is dropped (the brain never reads what it does not know).
export function cleanWatch(input = {}) {
  const out = {};
  for (const a of WATCH_ATTRIBUTES) {
    const v = input[a.key];
    if (a.multi) { const list = (Array.isArray(v) ? v : []).filter(x => x in a.options); if (list.length) out[a.key] = list; }
    else if (typeof v === 'string' && v in a.options) out[a.key] = v;
  }
  for (const a of WATCH_ATTRIBUTES) if (a.onlyIf && out[a.key] && !Object.entries(a.onlyIf).every(([k, vs]) => vs.includes(out[k]))) delete out[a.key];
  return out;
}
