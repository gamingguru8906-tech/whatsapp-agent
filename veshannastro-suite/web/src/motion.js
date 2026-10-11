// Motion for the whole page, in one place. Same file in both sites.
// 1. Smooth scrolling: mouse wheels and trackpads glide (Lenis); phones keep their own native scrolling, which is
//    already smooth and which people's thumbs expect. Every scroll the page makes itself goes through scrollToEl.
// 2. Reveal: headings, paragraphs, cards and buttons rise into place one by one as they come into view, out of a
//    soft blur. Each block reveals once. Nothing hides if JavaScript is off or the person prefers less motion.
import Lenis from 'lenis';

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const HEADER = 88; // room for the sticky header when scrolling to something

let lenis = null;

export function startSmoothScroll() {
  if (lenis || reduced()) return lenis;
  lenis = new Lenis({
    duration: 1.1,
    easing: t => Math.min(1, 1.001 - Math.pow(2, -10 * t)), // exponential ease-out: quick to respond, long gentle settle
    smoothWheel: true,
    syncTouch: false
  });
  document.documentElement.style.scrollBehavior = 'auto'; // Lenis does the smoothing; CSS smoothing would fight it
  const raf = time => { lenis?.raf(time); requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  return lenis;
}

// Scroll to an element (or to the top with 0), leaving room for the header.
export function scrollToEl(target, { block = 'start', immediate = false } = {}) {
  if (target == null) return;
  if (lenis) {
    lenis.resize(); // the page may have just grown (a reading appeared): measure before choosing where to stop
    if (target === 0) { lenis.scrollTo(0, { immediate }); return; }
    const rect = target.getBoundingClientRect();
    const offset = block === 'center' ? -(window.innerHeight / 2 - rect.height / 2) : -HEADER;
    lenis.scrollTo(target, { offset, immediate, duration: immediate ? 0 : 1.0 });
    return;
  }
  const behavior = immediate || reduced() ? 'instant' : 'smooth';
  if (target === 0) window.scrollTo({ top: 0, behavior });
  else target.scrollIntoView({ behavior, block });
}

// ---------- Reveal ----------
// Units: the blocks that rise in. A unit inside another unit does not animate on its own (the whole card rises).
const UNIT = 'h1, h2, h3, p, ul, ol, blockquote, .group-card, .form-sheet, .btn-primary, .btn-whatsapp, .btn-plain, [data-reveal]';
const SKIP = 'header, .enter, [data-no-reveal]';

export function startReveal(root = document.body) {
  if (!root || reduced() || !('IntersectionObserver' in window)) return () => {};
  document.documentElement.classList.add('reveal-on');

  const io = new IntersectionObserver(entries => {
    // Everything that arrives in the same moment goes top to bottom, 55 ms apart.
    const shown = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    shown.forEach((e, i) => {
      const el = e.target;
      io.unobserve(el);
      el.dataset.rvD = String(Math.min(i, 6));
      el.dataset.rv = 'go';
      setTimeout(() => { el.dataset.rv = 'done'; delete el.dataset.rvD; }, 1100);
    });
  }, { rootMargin: '0px 0px 4% 0px', threshold: 0 }); // starts just before a block scrolls in, so the screen is never empty

  const tag = scope => {
    if (!(scope instanceof Element)) return;
    const found = scope.matches?.(UNIT) ? [scope, ...scope.querySelectorAll(UNIT)] : [...scope.querySelectorAll(UNIT)];
    for (const el of found) {
      if (el.dataset.rv || el.closest(SKIP)) continue;
      if (el.parentElement?.closest('[data-rv]')) continue; // inside a unit already
      if (el.closest('[data-rv]') !== null && el.closest('[data-rv]') !== el) continue;
      el.dataset.rv = '0';
      io.observe(el);
    }
  };
  tag(root);
  // New content (a reading, a new page, an opened list) is tagged as it appears.
  const mo = new MutationObserver(list => { for (const m of list) m.addedNodes.forEach(tag); });
  mo.observe(root, { childList: true, subtree: true });
  return () => { io.disconnect(); mo.disconnect(); };
}
