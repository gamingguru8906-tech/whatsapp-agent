import React, { useEffect, useRef, useState } from 'react';

// The Veshannastro mascot: a small watch dial with a face. Original artwork, drawn in SVG and moved with CSS.
// It sleeps until it scrolls into view, wakes with a small hop, then blinks, glances and breathes. A tap makes it
// happy for a moment. It never follows the pointer. Timers run only while it is on screen and the tab is visible.
// Same file in mobile-numerology and veshannastro-suite (a test keeps the copies identical).

// A soft square-round outline (superellipse), the shape of a cushion-cased watch.
function bodyPath(cx, cy, a, b, n = 3.6, steps = 72) {
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    pts.push([cx + a * Math.sign(c) * Math.abs(c) ** (2 / n), cy + b * Math.sign(s) * Math.abs(s) ** (2 / n)]);
  }
  return `M${pts.map(p => p.map(v => v.toFixed(1)).join(' ')).join('L')}Z`;
}
const BODY = bodyPath(100, 104, 70, 66);
const TICKS = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  const r1 = i % 3 === 0 ? 50 : 53, r2 = 58;
  return { x1: 100 + Math.sin(a) * r1, y1: 104 - Math.cos(a) * r1, x2: 100 + Math.sin(a) * r2, y2: 104 - Math.cos(a) * r2, main: i % 3 === 0 };
});

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const between = (a, b) => a + Math.random() * (b - a);

export default function Mascot({ size = 160, label = 'Veshannastro mascot', className = '', delay = 250 }) {
  const ref = useRef(null);
  const [mood, setMood] = useState(() => (reducedMotion() ? 'idle' : 'sleep')); // sleep | waking | idle | happy
  const [blink, setBlink] = useState(false);
  const [look, setLook] = useState(0); // -1 left, 0 ahead, 1 right
  const [awake, setAwake] = useState(false); // on screen and the tab is visible
  const uid = useRef(`m${Math.random().toString(36).slice(2, 8)}`).current;
  const tapTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(tapTimer.current), []);

  // Wake the first time it is seen; after that, only run the little loops while it is on screen.
  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) { setAwake(true); setMood('idle'); return undefined; }
    let woke = false, t = 0;
    const io = new IntersectionObserver(([e]) => {
      setAwake(e.isIntersecting && !document.hidden);
      if (e.isIntersecting && !woke) {
        woke = true;
        if (reducedMotion()) return;
        t = window.setTimeout(() => {
          setMood('waking');
          t = window.setTimeout(() => setMood('happy'), 520);
          window.setTimeout(() => setMood(m => (m === 'happy' ? 'idle' : m)), 1700);
        }, delay);
      }
    }, { threshold: 0.55 });
    io.observe(el);
    const onVis = () => setAwake(a => (document.hidden ? false : a));
    document.addEventListener('visibilitychange', onVis);
    return () => { io.disconnect(); window.clearTimeout(t); document.removeEventListener('visibilitychange', onVis); };
  }, [delay]);

  // Blinking: every few seconds, sometimes twice.
  useEffect(() => {
    if (!awake || mood === 'sleep' || reducedMotion()) return undefined;
    let t = 0;
    const next = () => {
      t = window.setTimeout(() => {
        setBlink(true);
        window.setTimeout(() => setBlink(false), 130);
        if (Math.random() < 0.25) window.setTimeout(() => { setBlink(true); window.setTimeout(() => setBlink(false), 120); }, 280);
        next();
      }, between(2600, 5600));
    };
    next();
    return () => window.clearTimeout(t);
  }, [awake, mood]);

  // Glancing: now and then it looks to one side, then back.
  useEffect(() => {
    if (!awake || mood !== 'idle' || reducedMotion()) return undefined;
    let t = 0;
    const next = () => {
      t = window.setTimeout(() => {
        setLook(l => (l !== 0 ? 0 : Math.random() < 0.5 ? -1 : 1));
        next();
      }, between(2200, 4800));
    };
    next();
    return () => { window.clearTimeout(t); setLook(0); };
  }, [awake, mood]);

  function tap() {
    if (mood === 'sleep') { setMood('waking'); window.setTimeout(() => setMood('idle'), 520); return; }
    setMood('happy');
    window.clearTimeout(tapTimer.current);
    tapTimer.current = window.setTimeout(() => setMood('idle'), 1400);
  }

  const eyesOpen = mood !== 'sleep' && mood !== 'happy';
  return (
    <button ref={ref} type="button" onClick={tap} aria-label={`${label}. Tap to say hello.`}
      className={`mascot mascot-${mood} ${blink ? 'is-blink' : ''} ${awake ? '' : 'is-paused'} ${className}`}
      style={{ width: size, height: size }}>
      <svg viewBox="0 0 200 200" width={size} height={size} aria-hidden="true" focusable="false">
        <defs>
          <radialGradient id={`${uid}b`} cx="0.36" cy="0.3" r="0.82">
            <stop offset="0" stopColor="#F79BBC" />
            <stop offset="0.42" stopColor="#DE4580" />
            <stop offset="0.78" stopColor="#A9265A" />
            <stop offset="1" stopColor="#7A1E3A" />
          </radialGradient>
          <linearGradient id={`${uid}c`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#F3DFA2" />
            <stop offset="0.5" stopColor="#D3A54A" />
            <stop offset="1" stopColor="#9A6B1E" />
          </linearGradient>
          <filter id={`${uid}s`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="5" /></filter>
          <filter id={`${uid}g`} x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="4" /></filter>
        </defs>
        <ellipse className="mascot-shadow" cx="100" cy="177" rx="52" ry="7" fill="#7A1E3A" opacity="0.22" filter={`url(#${uid}s)`} />
        <g className="mascot-hop">
          <g className="mascot-breathe">
            <rect x="166" y="92" width="13" height="24" rx="4" fill={`url(#${uid}c)`} />
            <rect x="174" y="96" width="3" height="16" rx="1.5" fill="#FFF7DF" opacity="0.6" />
            <path d={BODY} fill={`url(#${uid}b)`} />
            <path d={BODY} fill="none" stroke="#fff" strokeOpacity="0.18" strokeWidth="1.5" />
            <ellipse cx="74" cy="64" rx="26" ry="13" fill="#fff" opacity="0.32" transform="rotate(-24 74 64)" filter={`url(#${uid}g)`} />
            {TICKS.map((k, i) => (
              <line key={i} x1={k.x1} y1={k.y1} x2={k.x2} y2={k.y2} stroke="#fff" strokeOpacity={k.main ? 0.5 : 0.28}
                strokeWidth={k.main ? 3 : 2} strokeLinecap="round" />
            ))}
            <g className="mascot-face">
              {eyesOpen ? (
                <g className="mascot-eyes">
                  {[78, 122].map(x => (
                    <g key={x} className="mascot-eye" style={{ transformOrigin: `${x}px 98px` }}>
                      <ellipse cx={x} cy="98" rx="12" ry="15.5" fill="#fff" />
                      <g className="mascot-pupil" style={{ transform: `translateX(${look * 4}px)` }}>
                        <ellipse cx={x} cy="100" rx="6.4" ry="7.6" fill="#3A0F1E" />
                        <circle cx={x + 2.4} cy="96.6" r="2.1" fill="#fff" />
                      </g>
                    </g>
                  ))}
                </g>
              ) : mood === 'happy' ? (
                <g fill="none" stroke="#fff" strokeWidth="4.5" strokeLinecap="round">
                  <path d="M67 101 Q78 88 89 101" />
                  <path d="M111 101 Q122 88 133 101" />
                </g>
              ) : (
                <g fill="none" stroke="#fff" strokeWidth="4" strokeLinecap="round" strokeOpacity="0.9">
                  <path d="M68 99 Q78 106 88 99" />
                  <path d="M112 99 Q122 106 132 99" />
                </g>
              )}
              {mood === 'happy'
                ? <path d="M88 122 Q100 136 112 122 Z" fill="#3A0F1E" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
                : mood === 'sleep'
                  ? <ellipse cx="100" cy="126" rx="4" ry="3" fill="#fff" opacity="0.75" />
                  : <path d="M92 124 Q100 130 108 124" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" />}
              <ellipse cx="62" cy="118" rx="8" ry="4.5" fill="#FFC3D6" opacity={mood === 'happy' ? 0.55 : 0.3} />
              <ellipse cx="138" cy="118" rx="8" ry="4.5" fill="#FFC3D6" opacity={mood === 'happy' ? 0.55 : 0.3} />
            </g>
          </g>
        </g>
      </svg>
    </button>
  );
}
