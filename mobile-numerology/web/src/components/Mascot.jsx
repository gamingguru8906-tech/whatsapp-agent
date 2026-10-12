import React, { useEffect, useRef, useState } from 'react';

// The Veshannastro mascot: a small round character in the brand pink with a gold-tipped antenna (a watch crown)
// and little arms. Original artwork in SVG, moved with CSS. The parent sets the mood; blinking and the small
// idle glances happen here. It never follows the pointer.
// Moods: idle, talk, think, worried, happy, wave, surprised.
// Same file in mobile-numerology and veshannastro-suite (a test keeps the copies identical).

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const between = (a, b) => a + Math.random() * (b - a);

export default function Mascot({ mood = 'idle', size = 64, active = true }) {
  const [blink, setBlink] = useState(false);
  const [glance, setGlance] = useState(0);
  const uid = useRef(`v${Math.random().toString(36).slice(2, 8)}`).current;

  useEffect(() => {
    if (!active || reducedMotion() || mood === 'happy') return undefined;
    let t = 0, t2 = 0;
    const next = () => {
      t = window.setTimeout(() => {
        setBlink(true);
        t2 = window.setTimeout(() => setBlink(false), 120);
        next();
      }, between(2400, 5200));
    };
    next();
    return () => { window.clearTimeout(t); window.clearTimeout(t2); setBlink(false); };
  }, [active, mood]);

  useEffect(() => {
    if (!active || reducedMotion() || mood !== 'idle') { setGlance(0); return undefined; }
    let t = 0;
    const next = () => { t = window.setTimeout(() => { setGlance(g => (g ? 0 : Math.random() < 0.5 ? -1 : 1)); next(); }, between(2000, 4200)); };
    next();
    return () => window.clearTimeout(t);
  }, [active, mood]);

  // Where the pupils look, per mood.
  const look = mood === 'think' ? [-2.5, -3.5] : mood === 'worried' ? [0, 1.5] : [glance * 3, 0];
  const eyesClosedHappy = mood === 'happy';

  return (
    <span className={`vm vm-${mood} ${blink ? 'is-blink' : ''} ${active ? '' : 'is-paused'}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 120 120" width={size} height={size} focusable="false">
        <defs>
          <radialGradient id={`${uid}b`} cx="0.36" cy="0.3" r="0.8">
            <stop offset="0" stopColor="#FBA7C6" />
            <stop offset="0.45" stopColor="#E5498A" />
            <stop offset="0.85" stopColor="#B42A63" />
            <stop offset="1" stopColor="#8C2148" />
          </radialGradient>
          <radialGradient id={`${uid}g`}>
            <stop offset="0" stopColor="#F062A0" stopOpacity="0.45" />
            <stop offset="1" stopColor="#F062A0" stopOpacity="0" />
          </radialGradient>
          <linearGradient id={`${uid}c`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#FFF0C2" />
            <stop offset="0.55" stopColor="#E0B24F" />
            <stop offset="1" stopColor="#A2711F" />
          </linearGradient>
        </defs>
        <circle className="vm-glow" cx="60" cy="68" r="56" fill={`url(#${uid}g)`} />
        <g className="vm-float">
          <g className="vm-hop">
            {/* antenna with a gold crown bead */}
            <g className="vm-antenna">
              <path d="M60 30 Q58 20 64 12" fill="none" stroke="#8C2148" strokeWidth="3.2" strokeLinecap="round" />
              <circle cx="64.5" cy="11" r="5" fill={`url(#${uid}c)`} />
              <circle cx="63" cy="9.4" r="1.6" fill="#fff" opacity="0.8" />
            </g>
            {/* arms */}
            <g className="vm-arm vm-arm-l"><rect x="12" y="66" width="16" height="9" rx="4.5" fill="#C93573" /></g>
            <g className="vm-arm vm-arm-r"><rect x="92" y="66" width="16" height="9" rx="4.5" fill="#C93573" /></g>
            {/* body */}
            <circle cx="60" cy="68" r="38" fill={`url(#${uid}b)`} />
            <ellipse cx="46" cy="48" rx="13" ry="8" fill="#fff" opacity="0.38" transform="rotate(-28 46 48)" />
            {/* brows (thinking and worried only) */}
            <g className="vm-brows" fill="none" stroke="#5C1530" strokeWidth="2.6" strokeLinecap="round">
              <path className="vm-brow-l" d="M40 50 L52 48" />
              <path className="vm-brow-r" d="M68 48 L80 50" />
            </g>
            {/* eyes */}
            {eyesClosedHappy ? (
              <g fill="none" stroke="#2A0B16" strokeWidth="3.6" strokeLinecap="round">
                <path d="M40 64 Q46 56 52 64" />
                <path d="M68 64 Q74 56 80 64" />
              </g>
            ) : (
              <g className="vm-eyes">
                {[46, 74].map(x => (
                  <g key={x} className="vm-eye" style={{ transformOrigin: `${x}px 62px` }}>
                    <ellipse cx={x} cy="62" rx={mood === 'surprised' ? 9 : 8} ry={mood === 'surprised' ? 11 : 10} fill="#2A0B16" />
                    <g className="vm-shine" style={{ transform: `translate(${look[0]}px, ${look[1]}px)` }}>
                      <circle cx={x + 2.6} cy="58.6" r="3.1" fill="#fff" />
                      <circle cx={x - 2.4} cy="65.2" r="1.4" fill="#fff" opacity="0.85" />
                    </g>
                  </g>
                ))}
              </g>
            )}
            {/* cheeks */}
            <ellipse cx="35" cy="75" rx="6.5" ry="3.8" fill="#FFC0D6" opacity={mood === 'happy' ? 0.7 : 0.45} />
            <ellipse cx="85" cy="75" rx="6.5" ry="3.8" fill="#FFC0D6" opacity={mood === 'happy' ? 0.7 : 0.45} />
            {/* mouth */}
            {mood === 'happy' && <path d="M51 76 Q60 89 69 76 Z" fill="#5C1530" />}
            {mood === 'talk' && <ellipse className="vm-talk" cx="60" cy="79" rx="5.5" ry="4.5" fill="#5C1530" />}
            {mood === 'surprised' && <ellipse cx="60" cy="80" rx="4" ry="5" fill="#5C1530" />}
            {mood === 'worried' && <path d="M53 81 Q60 76 67 81" fill="none" stroke="#5C1530" strokeWidth="3" strokeLinecap="round" />}
            {mood === 'think' && <path d="M55 80 L65 79" fill="none" stroke="#5C1530" strokeWidth="3" strokeLinecap="round" />}
            {(mood === 'idle' || mood === 'wave') && <path d="M54 77 Q60 82.5 66 77" fill="none" stroke="#5C1530" strokeWidth="3" strokeLinecap="round" />}
          </g>
        </g>
      </svg>
    </span>
  );
}
