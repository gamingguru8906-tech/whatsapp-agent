import React, { useEffect, useRef } from 'react';

// The hero's backdrop: a faint grid, three soft rose and gold shapes that drift and turn very slowly, and a few gold
// sparkles. Original artwork. Everything moves only by transform and opacity, stops while the hero is off screen,
// and stays still for Reduce Motion. Sits behind the hero's content and never takes a tap.
// Same file in mobile-numerology and veshannastro-suite (a test keeps the copies identical).

// Sparkles: position (% of the hero), size (px) and when each one starts its twinkle (s).
const SPARKS = [
  [8, 18, 9, 0], [22, 74, 7, 1.6], [46, 9, 8, 3.1], [61, 86, 6, 0.8], [74, 14, 10, 2.4], [88, 58, 7, 4.2], [94, 24, 6, 1.1]
];

function usePauseOffscreen(ref) {
  useEffect(() => {
    const el = ref.current;
    if (!el || !('IntersectionObserver' in window)) return undefined;
    const io = new IntersectionObserver(([e]) => el.classList.toggle('is-paused', !e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
}

export default function HeroBackdrop() {
  const ref = useRef(null);
  usePauseOffscreen(ref);
  return (
    <div ref={ref} className="hb" aria-hidden="true">
      <span className="hb-grid" />
      <span className="hb-blob hb-blob-1" />
      <span className="hb-blob hb-blob-2" />
      <span className="hb-blob hb-blob-3" />
      {SPARKS.map(([x, y, s, d]) => (
        <svg key={`${x}-${y}`} className="hb-spark" viewBox="0 0 20 20" width={s * 2} height={s * 2}
          style={{ left: `${x}%`, top: `${y}%`, animationDelay: `${d}s` }} focusable="false">
          <path d="M10 0 C11 7 13 9 20 10 C13 11 11 13 10 20 C9 13 7 11 0 10 C7 9 9 7 10 0 Z" />
        </svg>
      ))}
    </div>
  );
}
