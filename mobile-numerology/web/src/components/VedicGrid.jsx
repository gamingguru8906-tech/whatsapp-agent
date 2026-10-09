import React from 'react';

export const GRID = [[3, 1, 9], [6, 7, 5], [2, 8, 4]];

// counts: digit -> how many times it appears (filled cells). present/absent: a yoga's pattern (absent cells crossed).
// lightOrder: digits in the order they should light up (the page's one animated moment); omit for a still grid.
export default function VedicGrid({ counts, present = [], absent = [], size = 'md', label, lightOrder }) {
  const cell = {
    sm: 'h-7 w-7 rounded-[7px] text-xs',
    md: 'h-12 w-12 rounded-[12px] text-lg',
    lg: 'h-16 w-16 rounded-[16px] text-2xl',
    xl: 'h-[4.5rem] w-[4.5rem] rounded-[18px] text-[1.75rem] sm:h-24 sm:w-24 sm:rounded-[22px] sm:text-[2.25rem]'
  }[size];
  const gap = { sm: 'gap-[3px]', md: 'gap-1.5', lg: 'gap-2', xl: 'gap-2.5 sm:gap-3' }[size];
  const order = lightOrder ? [...new Set(lightOrder)] : null;
  return (
    <div className={`grid shrink-0 grid-cols-3 self-start ${gap}`} role="img" aria-label={label || describe(counts, present, absent)}>
      {GRID.flat().map(d => {
        const on = counts ? counts[d] > 0 : present.includes(d);
        const off = !counts && absent.includes(d);
        const n = counts?.[d] ?? 0;
        const step = order ? order.indexOf(d) : -1;
        return (
          <span key={d} style={on && step >= 0 ? { animationDelay: `${180 + step * 110}ms` } : undefined}
            className={`relative grid ${cell} place-items-center font-display font-bold tabular-nums ${
              on ? `tile-on ${step >= 0 ? 'cell-light' : ''}` : off ? 'bg-care-soft text-care-dark' : 'bg-muted text-faint'}`}>
            {off ? <s className="decoration-2">{d}</s> : d}
            {n > 1 && size !== 'sm' && <sup className="absolute right-1.5 top-1.5 font-sans text-[10px] font-semibold leading-none">×{n}</sup>}
          </span>
        );
      })}
    </div>
  );
}

function describe(counts, present, absent) {
  if (counts) return `Grid: ${GRID.flat().filter(d => counts[d] > 0).join(', ')} present`;
  return `Needs ${present.join(', ')}${absent.length ? `, without ${absent.join(', ')}` : ''}`;
}
