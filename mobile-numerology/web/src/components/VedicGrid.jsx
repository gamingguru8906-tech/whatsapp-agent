import React from 'react';

export const GRID = [[3, 1, 9], [6, 7, 5], [2, 8, 4]];

// counts: digit -> how many times it appears (filled cells). present/absent: a yoga's pattern (absent cells crossed).
export default function VedicGrid({ counts, present = [], absent = [], size = 'md', label }) {
  const cell = { sm: 'h-7 w-7 text-xs', md: 'h-11 w-11 text-base', lg: 'h-14 w-14 text-xl' }[size];
  const gap = size === 'sm' ? 'gap-[3px]' : 'gap-1.5';
  return (
    <div className={`grid shrink-0 grid-cols-3 self-start ${gap}`} role="img" aria-label={label || describe(counts, present, absent)}>
      {GRID.flat().map(d => {
        const on = counts ? counts[d] > 0 : present.includes(d);
        const off = !counts && absent.includes(d);
        const n = counts?.[d] ?? 0;
        return (
          <span key={d} className={`relative grid ${cell} place-items-center rounded-md font-semibold tabular-nums ${
            on ? 'bg-primary text-primary-foreground' : off ? 'bg-danger-soft text-danger-dark' : 'bg-muted text-faint'}`}>
            {off ? <s className="decoration-2">{d}</s> : d}
            {n > 1 && size !== 'sm' && <sup className="absolute right-1 top-1 text-[10px] leading-none">×{n}</sup>}
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
