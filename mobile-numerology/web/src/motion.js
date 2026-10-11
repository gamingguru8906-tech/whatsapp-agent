// Motion for the whole page, in one place. Same file in both sites.
// 1. Scrolling is the browser's own: it answers the finger and the wheel at once, with nothing in between.
//    Every scroll the page makes itself (to a new reading, back to the top) goes through scrollToEl.
// 2. Reveal: headings, paragraphs, cards and buttons rise into place one by one as they come into view.
//    Only opacity and position animate (the two things the graphics chip moves for free), so scrolling stays
//    smooth on any phone. Each block reveals once. Nothing hides if JavaScript is off or the person prefers less motion.

const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const HEADER = 80; // room for the sticky header when scrolling to something

// Scroll to an element (or to the top with 0), leaving room for the header.
export function scrollToEl(target, { block = 'start', immediate = false } = {}) {
  if (target == null) return;
  const behavior = immediate || reduced() ? 'instant' : 'smooth';
  if (target === 0) { window.scrollTo({ top: 0, behavior }); return; }
  const rect = target.getBoundingClientRect();
  const top = block === 'center'
    ? window.scrollY + rect.top - (window.innerHeight / 2 - rect.height / 2)
    : window.scrollY + rect.top - HEADER;
  window.scrollTo({ top: Math.max(0, top), behavior });
}

// ---------- Reveal ----------
// Units: the blocks that rise in. A unit inside another unit does not animate on its own (the whole card rises).
const UNIT = 'h1, h2, h3, p, ul, ol, blockquote, .group-card, .form-sheet, .btn-primary, .btn-whatsapp, .btn-plain, [data-reveal]';
const SKIP = 'header, .enter, [data-no-reveal]';

export function startReveal(root = document.body) {
  if (!root || reduced() || !('IntersectionObserver' in window)) return () => {};
  document.documentElement.classList.add('reveal-on');

  const io = new IntersectionObserver(entries => {
    // Everything that arrives in the same moment goes top to bottom, 40 ms apart.
    const shown = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    shown.forEach((e, i) => {
      const el = e.target;
      io.unobserve(el);
      el.dataset.rvD = String(Math.min(i, 5));
      el.dataset.rv = 'go';
      setTimeout(() => { el.dataset.rv = 'done'; delete el.dataset.rvD; }, 700);
    });
  }, { rootMargin: '0px 0px 8% 0px', threshold: 0 }); // starts just before a block scrolls in, so the screen is never empty

  const tag = scope => {
    if (!(scope instanceof Element)) return;
    const found = scope.matches?.(UNIT) ? [scope, ...scope.querySelectorAll(UNIT)] : [...scope.querySelectorAll(UNIT)];
    for (const el of found) {
      if (el.dataset.rv || el.closest(SKIP)) continue;
      if (el.parentElement?.closest('[data-rv]')) continue; // inside a unit already
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
