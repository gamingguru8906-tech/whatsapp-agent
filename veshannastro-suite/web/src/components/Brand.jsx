import React from 'react';

// The Veshannastro mark: the 3 × 3 Vedic grid every reading is built on, in the brand's pink-to-maroon. The dots
// brighten along the diagonal, the way a person's digits light up the grid. Same file in both sites.

const DOTS = [0, 1, 2].flatMap(r => [0, 1, 2].map(c => ({ r, c, o: [1, 0.72, 0.5][Math.abs(r - c)] })));

export function BrandMark({ size = 28, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="vmark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#EE5A8F" />
          <stop offset="0.55" stopColor="#C42D66" />
          <stop offset="1" stopColor="#7A1E3A" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#vmark)" />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="none" stroke="#fff" strokeOpacity="0.18" />
      {DOTS.map(({ r, c, o }) => <circle key={`${r}${c}`} cx={9 + c * 7} cy={9 + r * 7} r="2.35" fill="#fff" fillOpacity={o} />)}
    </svg>
  );
}

// Mark + wordmark, as one lockup. The pink full stop is part of the wordmark.
export function Lockup({ href = '/', size = 28, className = '', dark = false }) {
  return (
    <a href={href} className={`inline-flex items-center gap-2.5 font-display text-[19px] font-bold tracking-[-0.02em] no-underline ${dark ? 'text-[#FFF4F7]' : 'text-maroon'} ${className}`}>
      <BrandMark size={size} />
      <span>Veshannastro<span className="text-primary">.</span></span>
    </a>
  );
}
