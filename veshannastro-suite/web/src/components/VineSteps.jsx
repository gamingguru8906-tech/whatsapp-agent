import React, { useEffect, useRef } from 'react';

// "How the watch reading works" as a growing vine. A gold vine draws down the page as you scroll, its tip held at
// the reading line (a little below the middle of the screen). At each step a pair of gold leaves sprouts and the
// step's card lights up; smaller leaves sprout along the way. Original artwork.
// Cost: one scroll handler, run at most once a frame and only while the section is on screen, that sets one dash
// offset, one transform and (when a step is reached) a class. Reduce Motion, or no JavaScript: the vine is shown
// fully grown and every card is lit.

const LEAF = 'M0 0 C5 -7 15 -8 22 -1 C15 5 6 6 0 0 Z';
const RIB = 'M1.5 -0.4 C8 -2.6 14 -2.8 19 -1.4';
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function VineSteps({ steps, children }) {
  const wrap = useRef(null);
  const svg = useRef(null);

  useEffect(() => {
    const root = wrap.current, s = svg.current;
    if (!root || !s) return undefined;
    const reduced = reducedMotion();
    const NS = 'http://www.w3.org/2000/svg';
    const items = [...root.querySelectorAll('.vine-step')];
    let geo = null, raf = 0, active = false, lastY = -1;

    // Lay the vine out from where the cards actually are: a gentle S-curve between steps, through each step's node.
    function layout() {
      const box = root.getBoundingClientRect();
      const W = box.width, H = box.height;
      const wide = W >= 860;
      const cx = wide ? W / 2 : 20;
      const amp = wide ? 34 : 11;
      const nodes = items.map(li => {
        const r = li.querySelector('.vine-card').getBoundingClientRect();
        return wide ? r.top - box.top + r.height / 2 : r.top - box.top + 34;
      });
      // The vine ends a little below the last step, not behind the button under it.
      const end = Math.min(H, nodes[nodes.length - 1] + (wide ? 70 : 46));
      const ys = [0, ...nodes, end];
      let d = `M${cx} 0`;
      const mids = [];
      for (let i = 1; i < ys.length; i++) {
        const a = ys[i - 1], b = ys[i], h = b - a, k = i % 2 ? amp : -amp;
        d += ` C${cx + k} ${a + h * 0.3} ${cx - k} ${a + h * 0.7} ${cx} ${b}`;
        if (i > 1 && i < ys.length - 1 && h > 120) mids.push({ y: a + h * 0.3, x: cx + k * 0.75, side: k > 0 ? 1 : -1 });
      }
      s.setAttribute('viewBox', `0 0 ${W} ${H}`);
      s.setAttribute('width', W); s.setAttribute('height', H);
      s.querySelectorAll('.vine-path').forEach(p => p.setAttribute('d', d));
      const lit = s.querySelector('.vine-lit');
      const L = lit.getTotalLength();
      s.querySelectorAll('.vine-lit, .vine-glow').forEach(p => { p.style.strokeDasharray = `${L} ${L}`; });

      // Nodes, step leaves and the small leaves between steps.
      const g = s.querySelector('.vine-marks');
      g.textContent = '';
      const add = (html) => { const t = document.createElementNS(NS, 'g'); t.innerHTML = html; g.appendChild(t); return t; };
      const marks = nodes.map((y, i) => {
        const side = wide ? (i % 2 ? -1 : 1) : 1; // toward the card
        const el = add(
          `<g class="vine-node"><circle cx="${cx}" cy="${y}" r="9" class="vine-node-ring"/><circle cx="${cx}" cy="${y}" r="4.5" class="vine-node-dot"/></g>`
        );
        return { y, el, side };
      });
      geo = { L, H: end, cx, nodes, marks, mids, wide };
      // The leaves are plain SVG, placed here because their positions come from measuring the cards.
      marks.forEach(({ y, el, side }) => {
        el.insertAdjacentHTML('beforeend', leafPair(cx, y, side, wide ? 1.5 : 1.2));
      });
      mids.forEach(m => {
        const t = add(leafOne(m.x, m.y, m.side, wide ? 1.15 : 0.9));
        m.el = t;
      });
      lastY = -1;
      update();
    }

    const leafSvg = (x, y, deg, sc) =>
      `<g class="vine-leaf" transform="translate(${x} ${y}) rotate(${deg}) scale(${sc})"><g class="vine-leaf-grow">` +
      `<path d="${LEAF}" fill="url(#vine-leaf)"/><path d="${RIB}" fill="none" stroke="#7C5410" stroke-opacity="0.55" stroke-width="0.9" stroke-linecap="round"/></g></g>`;
    // Two leaves at a step: one reaching up and out, one lower and smaller, both away from the card.
    const leafPair = (x, y, side, k) => {
      const out = side > 0 ? -1 : 1; // leaves grow on the side away from the card
      return leafSvg(x + out * 5, y - 7, out > 0 ? -38 : 218, k) + leafSvg(x + out * 4, y + 6, out > 0 ? 14 : 166, k * 0.75);
    };
    const leafOne = (x, y, side, k) => leafSvg(x, y, side > 0 ? -24 : 204, k);

    // The length along the vine at a given height (the vine only ever goes down, so a binary search finds it).
    const p = () => s.querySelector('.vine-lit');
    function lengthAtY(y) {
      const path = p();
      let lo = 0, hi = geo.L;
      for (let i = 0; i < 18; i++) { const mid = (lo + hi) / 2; if (path.getPointAtLength(mid).y < y) lo = mid; else hi = mid; }
      return lo;
    }

    function update() {
      raf = 0;
      if (!geo) return;
      const top = root.getBoundingClientRect().top;
      const y = reduced ? geo.H : Math.max(0, Math.min(geo.H, window.innerHeight * 0.62 - top));
      if (Math.abs(y - lastY) < 0.5) return;
      lastY = y;
      const len = y >= geo.H ? geo.L : lengthAtY(y);
      s.querySelectorAll('.vine-lit, .vine-glow').forEach(el => { el.style.strokeDashoffset = String(geo.L - len); });
      const pt = p().getPointAtLength(len);
      const head = s.querySelector('.vine-head');
      head.setAttribute('transform', `translate(${pt.x} ${pt.y})`);
      head.classList.toggle('is-done', y >= geo.H - 1 || y <= 0);
      geo.marks.forEach(({ y: ny, el }, i) => {
        const on = ny <= y + 1;
        el.classList.toggle('is-on', on);
        items[i].classList.toggle('is-on', on);
      });
      geo.mids.forEach(m => m.el.classList.toggle('is-on', m.y <= y));
    }

    const onScroll = () => { if (active && !raf) raf = requestAnimationFrame(update); };
    const io = new IntersectionObserver(([e]) => { active = e.isIntersecting; if (active) onScroll(); }, { rootMargin: '20% 0px' });
    io.observe(root);
    window.addEventListener('scroll', onScroll, { passive: true });
    let rt = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(rt); rt = requestAnimationFrame(layout); });
    ro.observe(root);
    if (!reduced) root.classList.add('vine-on');
    layout();
    document.fonts?.ready.then(layout);
    return () => {
      io.disconnect(); ro.disconnect(); window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf); cancelAnimationFrame(rt); root.classList.remove('vine-on');
    };
  }, [steps]);

  return (
    <div ref={wrap} className="vine" data-no-reveal>
      <svg ref={svg} className="vine-svg" aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id="vine-gold" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#F3DFA2" />
            <stop offset="0.5" stopColor="#E2B95C" />
            <stop offset="1" stopColor="#F3DFA2" />
          </linearGradient>
          <linearGradient id="vine-leaf" x1="0" y1="-6" x2="22" y2="4" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#FFF0C2" />
            <stop offset="0.55" stopColor="#E0B24F" />
            <stop offset="1" stopColor="#A2711F" />
          </linearGradient>
        </defs>
        <path className="vine-path vine-track" />
        <path className="vine-path vine-glow" />
        <path className="vine-path vine-lit" />
        <g className="vine-marks" />
        <g className="vine-head"><circle r="11" className="vine-head-halo" /><circle r="6" className="vine-head-dot" /></g>
      </svg>
      <ol className="vine-list">
        {steps.map(([title, text], i) => (
          <li key={title} className={`vine-step ${i % 2 ? 'is-right' : 'is-left'}`}>
            <div className="vine-card">
              <span className="vine-num" aria-hidden="true">{i + 1}</span>
              <h3 className="vine-title"><span className="sr-only">Step {i + 1}: </span>{title}</h3>
              <p className="vine-text">{text}</p>
            </div>
          </li>
        ))}
      </ol>
      {children}
    </div>
  );
}
