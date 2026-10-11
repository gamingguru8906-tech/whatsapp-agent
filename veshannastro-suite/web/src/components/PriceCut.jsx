import React, { useEffect, useRef, useState } from 'react';

// "Your first watch reading is ₹6,750 FREE": when the line comes into view, a fine gold stroke cuts through the price,
// the price fades back, and FREE settles in gold capitals with one slow shimmer. Plays once.
export default function PriceCut({ was = '₹6,750', className = '' }) {
  const ref = useRef(null);
  const [play, setPlay] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) { setPlay(true); return undefined; }
    let timer = 0;
    const io = new IntersectionObserver(([e]) => {
      if (!e.isIntersecting) return;
      io.disconnect();
      timer = window.setTimeout(() => setPlay(true), 550); // let the line settle into view first
    }, { threshold: 0.6 });
    io.observe(el);
    return () => { io.disconnect(); window.clearTimeout(timer); };
  }, []);

  return (
    <p ref={ref} className={`price-cut ${play ? 'play' : ''} ${className}`} aria-label={`Your first watch reading is free. It is usually ${was}.`}>
      <span aria-hidden="true">Your first watch reading is{' '}
        <span className="whitespace-nowrap">
          <span className="pc-was">{was}<span className="pc-stroke" /></span>{' '}
          <span className="pc-free">FREE</span>
        </span>
      </span>
    </p>
  );
}
