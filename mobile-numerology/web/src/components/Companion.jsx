import React, { useCallback, useEffect, useRef, useState } from 'react';
import Mascot from './Mascot.jsx';

// The travelling helper. On a wide screen the mascot sits beside whatever matters at that moment (a button, the
// form, a field with a mistake) and moves along with it as the page scrolls; on a phone it waits in the bottom-left
// corner. It speaks in a bubble whose words type themselves out, sometimes with one action button, then folds into
// a small "..." bubble; a tap on the mascot brings the words back.
//
// Pages give it `stops` (one line per section). Forms talk to it with mascotSay({ mood, say, anchor, action, hold }).
// Same file in mobile-numerology and veshannastro-suite (a test keeps the copies identical).

const EVENT = 'vmascot';
/** Make the mascot react: mood (idle, talk, think, worried, happy, wave, surprised), what it says, what it stands
 *  next to (a CSS selector or an element), an optional action { label, href, onClick, external } and how long the
 *  words stay before folding (ms; 0 keeps them until the next message). */
export const mascotSay = detail => { if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(EVENT, { detail })); };

const SIZE = 64, PHONE_SIZE = 54, GAP = 14, WIDE = 900;
const narrow = () => typeof window !== 'undefined' && document.documentElement.clientWidth < WIDE;
const PHONE_HOLD = 4500; // on a phone the words fold sooner: the bubble sits over the page
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const resolve = a => (!a ? null : typeof a === 'string' ? document.querySelector(a) : a);
// For a heading or a line of text, the box of the words themselves (so it stands right beside the text, not at the
// far edge of a full-width line); for anything else, the element's own box.
function rectOf(el) {
  if (el.matches('h1, h2, h3, p, li, label, legend')) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const b = range.getBoundingClientRect();
    if (b.width > 0) return b;
  }
  return el.getBoundingClientRect();
}

export default function Companion({ stops = [] }) {
  const root = useRef(null), body = useRef(null), bubble = useRef(null);
  const [msg, setMsg] = useState(null);          // { say, mood, action, hold, anchor, key }
  const [typed, setTyped] = useState(0);
  const [folded, setFolded] = useState(false);
  const [mood, setMood] = useState('wave');
  const [shown, setShown] = useState(false);
  const [hidden, setHidden] = useState(false);   // phone keyboard open
  const anchorRef = useRef(null);                // element it stands next to now
  const override = useRef(null);                 // a form's message, until it expires
  const stopRef = useRef(null);                  // the section in view
  const seen = useRef(new Set());
  const raf = useRef(0);
  const flyUntil = useRef(0);
  const stopsRef = useRef(stops);
  stopsRef.current = stops;

  const typeStart = useRef(0);
  const show = useCallback((m) => {
    if (narrow() && m.hold !== 0) m = { ...m, hold: Math.min(m.hold ?? PHONE_HOLD, PHONE_HOLD) };
    setMsg({ ...m, key: Math.random() });
    typeStart.current = performance.now();
    setTyped(reducedMotion() ? m.say.length : 0);
    setFolded(false);
    setMood(m.mood === 'idle' || !m.mood ? 'talk' : m.mood);
  }, []);

  // Position the mascot and its bubble. Runs on scroll, resize and when the thing it stands next to changes.
  const place = useCallback(() => {
    raf.current = 0;
    const r0 = root.current, b = body.current, bub = bubble.current;
    if (!r0 || !b) return;
    const vw = document.documentElement.clientWidth, vh = window.innerHeight;
    const wide = vw >= WIDE;
    const S = wide ? SIZE : PHONE_SIZE;
    const header = document.querySelector('header')?.getBoundingClientRect().bottom ?? 0;

    // Which section is being read: the last one (in page order) whose top has reached the upper half of the
    // screen and which is still on screen; before any has, the first one on screen.
    let best = null, first = null;
    for (const s of stopsRef.current) {
      const el = resolve(s.el);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const onScreen = r.bottom > header + 40 && r.top < vh - 40;
      if (onScreen && !first) first = s;
      if (onScreen && r.top <= header + (vh - header) * 0.5) best = s;
    }
    best = best ?? first;
    if (best && best.id === stopRef.current?.id) stopRef.current = best; // the page may rebuild its list; keep the newest
    if (best && best.id !== stopRef.current?.id) {
      stopRef.current = best;
      if (!override.current) {
        // On a phone, a section speaks up only when it offers something to do; otherwise it just shows "...".
        if (!seen.current.has(best.id) && (wide || best.action)) { seen.current.add(best.id); show({ ...best, hold: best.hold ?? (best.action ? 9000 : 6500) }); }
        else { setMsg({ ...best, key: Math.random() }); setTyped(best.say.length); setFolded(true); setMood(best.mood ?? 'idle'); }
      }
    }

    const target = resolve(override.current?.anchor) ?? resolve(stopRef.current?.anchor ?? stopRef.current?.el);
    if (target !== anchorRef.current) { anchorRef.current = target; flyUntil.current = performance.now() + 700; }

    let x, y;
    if (!wide || !target) {
      x = 12; y = vh - S - 18;
    } else {
      const r = rectOf(target);
      const midY = r.top + Math.min(r.height, 160) / 2 - S / 2;
      if (vw - r.right >= S + GAP * 2) { x = r.right + GAP; y = midY; }
      else if (r.left >= S + GAP * 2) { x = r.left - S - GAP; y = midY; }
      else { x = Math.min(r.right - S * 0.75, vw - S - 10); y = r.top - S * 0.62; } // perched on its top corner
      y = Math.max(header + 8, Math.min(y, vh - S - 12));
    }
    b.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    r0.classList.toggle('is-flying', performance.now() < flyUntil.current);

    if (bub) {
      const bw = bub.offsetWidth, bh = bub.offsetHeight;
      let bx = wide && x + S / 2 + bw <= vw - 12 ? x + S * 0.35 : x + S * 0.65 - bw;
      bx = Math.max(12, Math.min(bx, vw - bw - 12));
      // Above it if there is room; otherwise beside it (so it never covers the thing it points at); else below.
      let by = y - bh - 10, side = 'above';
      if (by < header + 6) {
        if (wide && x + S + 12 + bw <= vw - 12) { side = 'right'; bx = x + S + 12; by = Math.max(header + 8, y + S / 2 - bh / 2); }
        else if (wide && x - 12 - bw >= 12) { side = 'left'; bx = x - 12 - bw; by = Math.max(header + 8, y + S / 2 - bh / 2); }
        else { side = 'below'; by = y + S + 10; }
      }
      bub.dataset.side = side;
      bub.classList.toggle('is-below', side === 'below');
      bub.style.transform = `translate3d(${Math.round(bx)}px, ${Math.round(by)}px, 0)`;
      bub.style.setProperty('--tail-x', `${Math.round(Math.max(18, Math.min(bw - 18, x + S / 2 - bx)))}px`);
    }
  }, [show]);

  const schedule = useCallback(() => { if (!raf.current) raf.current = requestAnimationFrame(place); }, [place]);

  // Arrive a moment after the page opens, then follow the page.
  useEffect(() => {
    const t = window.setTimeout(() => { setShown(true); schedule(); }, 900);
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const iv = window.setInterval(schedule, 600); // content above may grow (a reading appears)
    return () => { window.clearTimeout(t); window.clearInterval(iv); window.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); cancelAnimationFrame(raf.current); };
  }, [schedule]);

  // Messages from the forms.
  useEffect(() => {
    let t = 0;
    const on = e => {
      const d = e.detail || {};
      if (!d.say) return;
      window.clearTimeout(t);
      override.current = d;
      show({ ...d, hold: d.hold ?? 8000 });
      schedule();
      const life = d.hold === 0 ? 0 : (d.hold ?? 8000) + 2000;
      if (life) t = window.setTimeout(() => {
        override.current = null;
        const s = stopRef.current; // back to this section's own line, folded
        if (s) { setMsg({ ...s, key: Math.random() }); setTyped(s.say.length); setFolded(true); setMood(s.mood === 'wave' ? 'idle' : s.mood ?? 'idle'); }
        schedule();
      }, life);
    };
    window.addEventListener(EVENT, on);
    return () => { window.removeEventListener(EVENT, on); window.clearTimeout(t); };
  }, [show, schedule]);

  // Type the words out, then fold after a while.
  useEffect(() => {
    if (!msg || folded) return undefined;
    if (typed < msg.say.length) {
      // Typed at an even pace (about 60 letters a second) measured by the clock, so a busy page cannot slow it down.
      const t = window.setTimeout(() => setTyped(Math.min(msg.say.length, Math.max(typed + 1, Math.floor((performance.now() - typeStart.current) / 16)))), 30);
      return () => window.clearTimeout(t);
    }
    if (mood === 'talk') setMood(msg.mood && msg.mood !== 'talk' ? msg.mood : 'idle');
    if (!msg.hold) return undefined;
    const t = window.setTimeout(() => { setFolded(true); setMood(m => (m === 'happy' || m === 'wave' ? 'idle' : m)); }, msg.hold);
    return () => window.clearTimeout(t);
  }, [msg, typed, folded, mood]);

  useEffect(() => { if (mood === 'wave' || mood === 'happy') { const t = window.setTimeout(() => setMood(m => (m === 'wave' ? 'idle' : m)), 1600); return () => window.clearTimeout(t); } return undefined; }, [mood]);

  // On a phone, step aside while the keyboard is open.
  useEffect(() => {
    const check = () => setHidden(document.documentElement.clientWidth < WIDE && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? ''));
    let t = 0;
    const later = () => { window.clearTimeout(t); t = window.setTimeout(check, 50); };
    document.addEventListener('focusin', check); document.addEventListener('focusout', later);
    return () => { window.clearTimeout(t); document.removeEventListener('focusin', check); document.removeEventListener('focusout', later); };
  }, []);

  useEffect(() => { schedule(); }, [msg, folded, typed, schedule]);

  function tap() {
    if (!msg) return;
    if (folded) show({ ...msg, hold: msg.hold || 9000 });
    else { setFolded(true); }
  }
  function act(e) {
    const a = msg?.action;
    if (!a) return;
    if (a.onClick) { e.preventDefault(); a.onClick(); }
  }

  const text = msg ? msg.say.slice(0, typed) : '';
  return (
    <div ref={root} className={`vc ${shown && !hidden ? 'is-shown' : ''}`} data-no-reveal="">
      {msg && (
        <div ref={bubble} className={`vc-bubble ${folded ? 'is-folded' : ''}`} onClick={folded ? tap : undefined}>
          {folded ? (
            <span className="vc-dots" aria-hidden="true"><i /><i /><i /></span>
          ) : (
            <>
              <p className="vc-text" aria-hidden="true">{text}<span className="vc-caret" /></p>
              {msg.action && typed >= msg.say.length && (
                msg.action.href
                  ? <a className="vc-action" href={msg.action.href} {...(msg.action.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} onClick={act}>{msg.action.label}</a>
                  : <button type="button" className="vc-action" onClick={act}>{msg.action.label}</button>
              )}
            </>
          )}
          <span className="vc-tail" aria-hidden="true"><i /><i /></span>
        </div>
      )}
      <span className="sr-only" role="status" aria-live="polite">{msg && !folded ? msg.say : ''}</span>
      <button ref={body} type="button" className="vc-body" onClick={tap}
        aria-label={folded ? 'Veshannastro helper. Tap to read the tip.' : 'Veshannastro helper. Tap to fold the tip.'}>
        <Mascot mood={mood} size={typeof window !== 'undefined' && document.documentElement.clientWidth < WIDE ? PHONE_SIZE : SIZE} active={shown} />
      </button>
    </div>
  );
}
