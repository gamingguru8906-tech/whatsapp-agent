// Preview build only: the same engine and rulebook the Worker uses, run in the browser.
import { createEngine, publicView } from '../../engine/core.js';
import { rulebook } from '../../engine/rulebook.js';

const engine = createEngine(rulebook);

export function localReading(p) {
  if (p.consent !== true) return { ok: false, errors: { consent: 'Please tick the box to agree, so we can show your reading.' } };
  const year = new Date(Date.now() + 5.5 * 3600e3).getUTCFullYear();
  return publicView(engine.reading({ name: p.name, mobile: p.mobile, dob: p.dob, concern: p.concern, planned: p.planned, year }));
}

import { watchReading } from '../../engine/watch.js';
export function localWatchReading(p) {
  if (p.consent !== true) return { ok: false, errors: { consent: 'Please tick the box to agree, so we can show your reading.' } };
  const year = new Date(Date.now() + 5.5 * 3600e3).getUTCFullYear();
  return publicView(watchReading(rulebook, { name: p.name, mobile: p.mobile, dob: p.dob, watch: p.watch, year }));
}
