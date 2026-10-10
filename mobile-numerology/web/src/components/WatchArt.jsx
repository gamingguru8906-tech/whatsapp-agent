import React from 'react';

// The front page's one animated moment: a watch whose parts light up one by one, each with the name of what the
// reading looks at. Every part is drawn twice: a quiet base, and its lit colour on top that fades in on its turn.
// With reduced motion the lit layer simply shows.

const CX = 210, CY = 180;
const at = (r, hour) => {
  const a = (hour * 30 * Math.PI) / 180;
  return [CX + r * Math.sin(a), CY - r * Math.cos(a)];
};
const MARKS = [1, 2, 4, 5, 7, 8, 10, 11];
const ROMAN = [[12, 'XII'], [3, 'III'], [6, 'VI'], [9, 'IX']];
const OFF = '#E6DED5', OFF_DIAL = '#F2ECE5', OFF_INK = '#CBBFB3';

const STEP = { strap: 250, metal: 650, dial: 1050, numerals: 1450, hands: 1850 };
const Lit = ({ when, children }) => <g className="lit" style={{ animationDelay: `${STEP[when]}ms` }}>{children}</g>;

// A part's name, with a leader line ending in a dot on the part.
function Label({ when, x, y, anchor, from, to, children }) {
  return (
    <Lit when={when}>
      <path d={`M${from[0]} ${from[1]} L${to[0]} ${to[1]}`} fill="none" stroke="#7A1E3A" strokeOpacity="0.45" strokeWidth="1.25" />
      <circle cx={to[0]} cy={to[1]} r="3" fill="#E83E7B" />
      <text x={x} y={y} textAnchor={anchor} fontFamily="League Spartan, sans-serif" fontSize="16" fontWeight="600" fill="#7A1E3A">{children}</text>
    </Lit>
  );
}

function Hands({ color, cap }) {
  const [hx, hy] = at(40, 10);
  const [mx, my] = at(58, 2);
  return (
    <g strokeLinecap="round">
      <line x1={CX} y1={CY} x2={hx} y2={hy} stroke={color} strokeWidth="6" />
      <line x1={CX} y1={CY} x2={mx} y2={my} stroke={color} strokeWidth="4" />
      <circle cx={CX} cy={CY} r="6" fill={cap} />
    </g>
  );
}

function Numerals({ color }) {
  return (
    <g>
      {MARKS.map(h => {
        const [x1, y1] = at(58, h);
        const [x2, y2] = at(66, h);
        return <line key={h} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth="3" strokeLinecap="round" />;
      })}
      {ROMAN.map(([h, t]) => {
        const [x, y] = at(57, h);
        return <text key={h} x={x} y={y + 5.5} textAnchor="middle" fontFamily="League Spartan, sans-serif" fontSize="15" fontWeight="700" fill={color}>{t}</text>;
      })}
    </g>
  );
}

export default function Watch({ className = '' }) {
  return (
    <svg viewBox="0 0 420 360" className={className} role="img"
      aria-label="A wristwatch. Its strap, metal, dial colour, numerals and hands light up one by one.">
      <defs>
        <linearGradient id="w-dial" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#EC5089" />
          <stop offset="0.55" stopColor="#B92A5C" />
          <stop offset="1" stopColor="#6E1A35" />
        </linearGradient>
        <linearGradient id="w-metal" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#F4DB97" />
          <stop offset="0.5" stopColor="#D4A23A" />
          <stop offset="1" stopColor="#9C7020" />
        </linearGradient>
        <linearGradient id="w-strap" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#4E1224" />
          <stop offset="0.5" stopColor="#7A1E3A" />
          <stop offset="1" stopColor="#4E1224" />
        </linearGradient>
      </defs>

      {/* Strap */}
      <rect x="174" y="-24" width="72" height="140" rx="12" fill={OFF} />
      <rect x="174" y="244" width="72" height="140" rx="12" fill={OFF} />
      <Lit when="strap">
        <rect x="174" y="-24" width="72" height="140" rx="12" fill="url(#w-strap)" />
        <rect x="174" y="244" width="72" height="140" rx="12" fill="url(#w-strap)" />
        {[300, 322, 344].map(y => <circle key={y} cx="210" cy={y} r="3.5" fill="#FBF7F2" fillOpacity="0.55" />)}
      </Lit>

      {/* Case and crown */}
      <rect x="292" y="170" width="16" height="20" rx="4" fill={OFF} />
      <circle cx={CX} cy={CY} r="88" fill={OFF} />
      <Lit when="metal">
        <rect x="292" y="170" width="16" height="20" rx="4" fill="url(#w-metal)" />
        <circle cx={CX} cy={CY} r="88" fill="url(#w-metal)" />
      </Lit>
      <circle cx={CX} cy={CY} r="80" fill="none" stroke="#000" strokeOpacity="0.1" strokeWidth="2" />

      {/* Dial */}
      <circle cx={CX} cy={CY} r="76" fill={OFF_DIAL} />
      <Lit when="dial"><circle cx={CX} cy={CY} r="76" fill="url(#w-dial)" /></Lit>

      {/* Numerals and hands */}
      <Numerals color={OFF_INK} />
      <Lit when="numerals"><Numerals color="#FFFFFF" /></Lit>
      <Hands color={OFF_INK} cap={OFF_INK} />
      <Lit when="hands"><Hands color="#FFFFFF" cap="#D4A23A" /></Lit>

      {/* What the reading looks at */}
      <Label when="strap" x="106" y="62" anchor="end" from={[114, 56]} to={[172, 56]}>Strap</Label>
      <Label when="metal" x="106" y="292" anchor="end" from={[114, 286]} to={[150, 248]}>Metal</Label>
      <Label when="dial" x="106" y="200" anchor="end" from={[114, 194]} to={[156, 194]}>Dial colour</Label>
      <Label when="hands" x="316" y="124" anchor="start" from={[308, 118]} to={[238, 158]}>Hands</Label>
      <Label when="numerals" x="316" y="258" anchor="start" from={[308, 252]} to={[269, 218]}>Numerals</Label>
    </svg>
  );
}
