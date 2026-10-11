import React, { useEffect, useRef, useState } from 'react';
import { getConfig, getReading, getWatchReading, getWristReading, track } from './api.js';
import WristForm from './components/WristForm.jsx';
import WristResult from './components/WristResult.jsx';
import ReadingForm from './components/ReadingForm.jsx';
import Story from './components/Story.jsx';
import VedicGrid from './components/VedicGrid.jsx';
import WatchForm from './components/WatchForm.jsx';
import WatchStory from './components/WatchStory.jsx';
import Watch3D from './components/Watch3D.jsx';
import MyReadings from './components/MyReadings.jsx';
import { UserRound } from 'lucide-react';
import { Lockup } from './components/Brand.jsx';
import { MobileMenu, FooterLinks } from './components/SiteNav.jsx';
import { startReveal, scrollToEl } from './motion.js';
import { PAGES, ORIGIN } from '../../engine/pages.js';

// Two segments on one site: Mobile Numerology at /, Wristwatch Numerology at /watch (with "Which watch should I wear
// this year?" at /watch/year); "My readings" at /my.
// Moving between them happens in the page (no reload), so the tabs slide and the content swaps smoothly.
const segmentOf = p => (p.startsWith('/watch/year') ? 'wrist' : p.startsWith('/watch') ? 'watch' : p.startsWith('/my') ? 'my' : 'mobile');
const ROUTES = ['/', '/watch', '/watch/year', '/my'];
const YEAR_NOW = new Date(Date.now() + 5.5 * 3600e3).getUTCFullYear();

const ownerKeyFromUrl = () => {
  try {
    const k = new URLSearchParams(location.search).get('owner');
    if (k) sessionStorage.setItem('ownerKey', k);
    return k || sessionStorage.getItem('ownerKey');
  } catch {
    return null;
  }
};

export default function App() {
  const [config, setConfig] = useState({});
  const [status, setStatus] = useState('idle'); // idle | loading | done
  const [errors, setErrors] = useState({});
  const [result, setResult] = useState(null);
  const storyRef = useRef(null);
  const ownerKey = useRef(ownerKeyFromUrl());
  const [path, setPath] = useState(() => (typeof location !== 'undefined' ? location.pathname.replace(/\/+$/, '') || '/' : '/'));
  const SEGMENT = segmentOf(path);
  const TAB = SEGMENT === 'wrist' ? 'watch' : SEGMENT;
  const seg = useRef(SEGMENT);
  seg.current = SEGMENT;
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => { getConfig().then(setConfig); }, []);
  // A new reading: glide to it once it is on the page.
  useEffect(() => { if (result) requestAnimationFrame(() => scrollToEl(storyRef.current)); }, [result]);
  // Blocks that rise into place as they come into view.
  useEffect(() => { return startReveal(document.getElementById('root')); }, []);

  // In-page navigation between the four pages; the browser's back button works as usual.
  useEffect(() => {
    const go = href => {
      const next = href.replace(/\/+$/, '') || '/';
      setResult(null); setStatus('idle'); setErrors({});
      setPath(next);
      scrollToEl(0, { immediate: true });
    };
    const onClick = e => {
      const a = e.target.closest?.('a[href]');
      if (!a) return;
      if (a.href.startsWith('https://wa.me/')) { track(seg.current, 'whatsapp_click'); return; }
      const url = new URL(a.href, location.href);
      const target = url.pathname.replace(/\/+$/, '') || '/';
      if (url.origin !== location.origin || !ROUTES.includes(target) || a.target === '_blank' || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      if (target === (location.pathname.replace(/\/+$/, '') || '/')) { scrollToEl(0); return; }
      history.pushState({}, '', target + url.search);
      go(target);
    };
    const onPop = () => go(location.pathname);
    const onScroll = () => setScrolled(window.scrollY > 4);
    document.addEventListener('click', onClick);
    window.addEventListener('popstate', onPop);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('scroll', onScroll);
    };
  }, []);

  // Funnel: one view per page shown.
  useEffect(() => {
    track(SEGMENT, 'view');
    // This page's title, description and address (the Worker writes the same into the HTML for the first load).
    const page = PAGES[SEGMENT];
    document.title = page.title;
    document.querySelector('meta[name="description"]')?.setAttribute('content', page.description);
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', ORIGIN + page.path);
  }, [SEGMENT]);

  async function submit(payload) {
    setStatus('loading');
    setErrors({});
    const data = await (SEGMENT === 'watch' ? getWatchReading : SEGMENT === 'wrist' ? getWristReading : getReading)(payload, ownerKey.current);
    if (!data.ok) {
      setErrors(data.errors || { form: 'Please check the form and try again.' });
      setStatus('idle');
      // Take them to the first message, so a problem is never hidden further down the form.
      requestAnimationFrame(() => {
        const first = document.querySelector('#reading-form .error');
        if (first) scrollToEl(first, { block: 'center' });
      });
      return false;
    }
    setResult(data);
    setStatus('done');
    track(SEGMENT, 'result_shown', { leadKey: data.leadKey });
    return true;
  }

  function again() {
    setResult(null);
    setStatus('idle');
    requestAnimationFrame(() => scrollToEl(document.getElementById('reading-form')));
  }

  return (
    <div className="min-h-screen bg-background">
      <header className={`sticky top-0 z-20 material ${scrolled ? 'scrolled' : ''}`} style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-5 py-3">
          <Lockup />
          <nav aria-label="Readings" className={`relative order-3 grid w-full grid-cols-2 rounded-full p-[3px] text-[14px] font-semibold tracking-[-0.01em] transition-colors duration-300 sm:order-2 sm:w-[264px] bg-border/50`}>
            <span aria-hidden="true"
              className={`absolute bottom-[3px] left-[3px] top-[3px] w-[calc(50%-3px)] rounded-full bg-card shadow-[0_3px_8px_rgba(0,0,0,0.12),0_1px_1px_rgba(0,0,0,0.06)] transition-[transform,opacity] duration-[420ms] ease-ios ${TAB === 'my' ? 'opacity-0' : 'opacity-100'}`}
              style={{ transform: `translateX(${TAB === 'watch' ? '100%' : '0'})` }} />
            {[['mobile', '/', 'Mobile number'], ['watch', '/watch', 'Wristwatch']].map(([k, href, label]) => (
              <a key={k} href={href} aria-current={TAB === k ? 'page' : undefined}
                className={`relative z-[1] rounded-full px-3.5 py-1.5 text-center no-underline transition-colors duration-300 ${TAB === k ? 'text-maroon' : 'text-muted-foreground hover:text-maroon'}`}>{label}</a>
            ))}
          </nav>
          <div className="order-2 flex items-center gap-1 sm:order-3">
            <a href="/my" aria-current={SEGMENT === 'my' ? 'page' : undefined}
              className={`pressable inline-flex min-h-[40px] min-w-[40px] items-center justify-center gap-1.5 rounded-full px-2.5 font-ui text-[14px] font-semibold tracking-[-0.01em] no-underline sm:min-h-[36px] sm:px-3 ${SEGMENT === 'my' ? 'bg-maroon-soft text-maroon' : 'text-muted-foreground hover:text-maroon'}`}>
              <UserRound size={18} aria-hidden="true" /><span className="sr-only sm:not-sr-only">My readings</span>
            </a>
            <MobileMenu site="readings" refCode={`WEB-${SEGMENT.toUpperCase()}-MENU`} />
          </div>
        </div>
      </header>

      {config.preview && (
        <p className="bg-accent-soft px-5 py-2 text-center text-[13px] font-medium text-warning-dark">
          Preview for the owner: readings run inside this page and nothing is saved. The live site saves leads to your database and Google Sheet.
        </p>
      )}
      <main>
        <div key={SEGMENT} className="animate-swap">
        {SEGMENT === 'my' ? <MyReadings config={config} /> : <>
        <div className="hero-day">
        <section className="mx-auto grid max-w-5xl grid-cols-1 gap-8 px-5 pb-10 pt-8 sm:pt-14 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)] lg:items-start lg:gap-14 lg:pb-16">
          {SEGMENT === 'wrist' ? (
            <div className="min-w-0 lg:sticky lg:top-28">
              <h1 className="enter t-large max-w-[13ch]">Which watch should you wear this year?</h1>
              <p className="enter enter-2 mt-4 max-w-[34rem] text-[18px] leading-[1.55] hero-sub">
                Your birth date sets the watch for your year: its metal and dial colour. A photo of your wrist sets its size,
                strap and finish. Get your answer in under a minute.
              </p>
              {/* On phones the photo step comes first, right under the question. */}
              <Watch3D className="mt-4 hidden w-full max-w-[420px] lg:block" />
            </div>
          ) : SEGMENT === 'watch' ? (
            <div className="min-w-0 lg:sticky lg:top-28">
              <h1 className="enter t-large max-w-[12ch]">What does your watch say about you?</h1>
              <p className="enter enter-2 mt-4 max-w-[34rem] text-[18px] leading-[1.55] hero-sub">
                The colour of the dial, its shape, the metal, the strap and the wrist you wear it on all carry meaning in numerology.
                Add one photo of your watch and see what it says about you, whether it suits your year, and your numbers.
              </p>
              <a href="/watch/year" className="hero-link mt-5 block font-display text-[16px] font-semibold">Not sure which watch to wear this year? <span className="whitespace-nowrap">Find yours ›</span></a>
              <Watch3D priority className="mx-auto mt-2 w-full max-w-[300px] sm:max-w-[360px] lg:mx-0 lg:mt-4 lg:max-w-[420px]" />
            </div>
          ) : (
          <div className="min-w-0 lg:sticky lg:top-28">
            <h1 className="enter t-large max-w-[13ch]">What is your mobile number doing to your life?</h1>
            <p className="enter enter-2 mt-4 max-w-[34rem] text-[18px] leading-[1.55] hero-sub">
              Every pair of digits in your number has a meaning, and the shapes your digits make on the Vedic grid form yogas.
              See yours, with your year ahead and how to protect yourself.
            </p>
            <div className="mt-8 flex items-center gap-5 sm:gap-7">
              <VedicGrid size="xl" counts={{ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1 }} lightOrder={[1, 2, 3, 4, 5, 6, 7, 8, 9]}
                label="The Vedic numerology grid: 3 1 9, 6 7 5, 2 8 4" />
              <p className="hero-sub min-w-0 max-w-[13rem] flex-1 text-[15px] leading-snug">
                Your digits light up on this grid. Where they line up, they form yogas.
              </p>
            </div>
          </div>
          )}
          <div className="form-sheet enter enter-3 min-w-0 scroll-mt-24" id="reading-form">
            {SEGMENT === 'wrist'
              ? <WristForm config={config} status={status} errors={errors} onSubmit={submit} year={YEAR_NOW} />
              : SEGMENT === 'watch'
                ? <WatchForm config={config} status={status} errors={errors} onSubmit={submit} />
                : <ReadingForm config={config} status={status} errors={errors} onSubmit={submit} />}
          </div>
        </section>
        </div>

        {result && (
          <section ref={storyRef} key={result.leadRef ?? 'r'} className="mx-auto max-w-[44rem] scroll-mt-24 px-5 pb-14 pt-4">
            {SEGMENT === 'wrist' ? <WristResult result={result} config={config} onAgain={again} saved={!config.preview} />
              : SEGMENT === 'watch' ? <WatchStory result={result} config={config} onAgain={again} saved={!config.preview} />
                : <Story result={result} config={config} onAgain={again} saved={!config.preview} />}
          </section>
        )}
        </>}
        </div>
      </main>

      <footer className="border-t border-border/70 bg-card/60">
        <div className="mx-auto grid max-w-5xl gap-3 px-5 py-9 text-[13px] leading-relaxed text-muted-foreground">
          <div className="mb-1"><Lockup size={26} /></div>
          <p className="font-ui text-[14px] text-foreground/80">Numerology and Vedic astrology by Shashank Agrawal, author of <span className="italic">Numbers &amp; Navgraha</span>.</p>
          <p><strong className="font-semibold text-foreground">Guidance, not a guarantee.</strong> Readings follow traditional numerology methods taught by experienced numerologists. They are not medical, legal or financial advice. For any health concern, please consult a doctor.</p>
          <p>What we store: your name, mobile number, date of birth, what you shared, the numbers and watch details you gave, and whether you want WhatsApp updates. We use them to show your reading and, only if you agree, to contact you on WhatsApp. We never sell them. Photos of your watch or wrist are read once and never stored.</p>
          <div className="mt-4 text-[14px]"><FooterLinks site="readings" refCode={`WEB-${SEGMENT.toUpperCase()}-FOOTER`} /></div>
        </div>
      </footer>
    </div>
  );
}
