import React, { useEffect, useRef, useState } from 'react';
import { getConfig, getReading, getWatchReading } from './api.js';
import ReadingForm from './components/ReadingForm.jsx';
import Story from './components/Story.jsx';
import VedicGrid from './components/VedicGrid.jsx';
import WatchForm from './components/WatchForm.jsx';
import WatchStory from './components/WatchStory.jsx';
import WatchArt from './components/WatchArt.jsx';

// Two segments on one site: Mobile Numerology at /, Wristwatch Numerology at /watch.
const SEGMENT = typeof location !== 'undefined' && location.pathname.startsWith('/watch') ? 'watch' : 'mobile';

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

  useEffect(() => { getConfig().then(setConfig); }, []);

  async function submit(payload) {
    setStatus('loading');
    setErrors({});
    const data = await (SEGMENT === 'watch' ? getWatchReading : getReading)(payload, ownerKey.current);
    if (!data.ok) {
      setErrors(data.errors || { form: 'Please check the form and try again.' });
      setStatus('idle');
      return false;
    }
    setResult(data);
    setStatus('done');
    requestAnimationFrame(() => storyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    return true;
  }

  function again() {
    setResult(null);
    setStatus('idle');
    requestAnimationFrame(() => document.getElementById('reading-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="material sticky top-0 z-20 border-b border-border/60" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3">
          <a href="/" className="font-display text-[19px] font-bold tracking-tight text-maroon no-underline">
            Veshannastro<span className="text-primary">.</span>
          </a>
          <nav aria-label="Readings" className="flex rounded-full bg-border/50 p-[3px] font-display text-[14px] font-semibold">
            {[['mobile', '/', 'Mobile number'], ['watch', '/watch', 'Wristwatch']].map(([k, href, label]) => (
              <a key={k} href={href} aria-current={SEGMENT === k ? 'page' : undefined}
                className={`rounded-full px-3.5 py-1.5 no-underline transition-colors ${SEGMENT === k ? 'bg-card text-maroon shadow-[0_2px_6px_rgba(0,0,0,0.1)]' : 'text-muted-foreground hover:text-maroon'}`}>{label}</a>
            ))}
          </nav>
        </div>
      </header>

      {config.preview && (
        <p className="bg-accent-soft px-5 py-2 text-center text-[13px] font-medium text-warning-dark">
          Preview for the owner: readings run inside this page and nothing is saved. The live site saves leads to your database and Google Sheet.
        </p>
      )}
      <main>
        <div className="hero-glow">
        <section className="mx-auto grid max-w-5xl gap-10 px-5 pb-12 pt-8 sm:pt-14 lg:grid-cols-[1fr_minmax(0,440px)] lg:items-start lg:gap-14">
          {SEGMENT === 'watch' ? (
            <div className="min-w-0">
              <h1 className="t-large max-w-[12ch]">What does your watch say about you?</h1>
              <p className="mt-4 max-w-[34rem] text-[18px] leading-[1.55] text-muted-foreground">
                The colour of the dial, its shape, the metal, the strap and the wrist you wear it on all carry meaning in numerology.
                See what yours says, whether it suits your year, and your numbers.
              </p>
              <WatchArt className="mt-6 w-full max-w-[420px]" />
            </div>
          ) : (
          <div className="min-w-0">
            <h1 className="t-large max-w-[13ch]">What is your mobile number doing to your life?</h1>
            <p className="mt-4 max-w-[34rem] text-[18px] leading-[1.55] text-muted-foreground">
              Every pair of digits in your number has a meaning, and the shapes your digits make on the Vedic grid form yogas.
              See yours, with your year ahead and how to protect yourself.
            </p>
            <div className="mt-8 flex items-center gap-5 sm:gap-7">
              <VedicGrid size="xl" counts={{ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1 }} lightOrder={[1, 2, 3, 4, 5, 6, 7, 8, 9]}
                label="The Vedic numerology grid: 3 1 9, 6 7 5, 2 8 4" />
              <p className="max-w-[13rem] text-[15px] leading-snug text-muted-foreground">
                Your digits light up on this grid. Where they line up, they form yogas.
              </p>
            </div>
          </div>
          )}
          <div className="min-w-0 scroll-mt-20" id="reading-form">
            {SEGMENT === 'watch'
              ? <WatchForm config={config} status={status} errors={errors} onSubmit={submit} />
              : <ReadingForm config={config} status={status} errors={errors} onSubmit={submit} />}
          </div>
        </section>
        </div>

        {result && (
          <section ref={storyRef} className="mx-auto max-w-[44rem] scroll-mt-16 px-5 pb-14 pt-4">
            {SEGMENT === 'watch' ? <WatchStory result={result} config={config} onAgain={again} /> : <Story result={result} config={config} onAgain={again} />}
          </section>
        )}
      </main>

      <footer className="border-t border-border/70 bg-card/60">
        <div className="mx-auto grid max-w-5xl gap-3 px-5 py-9 text-[13px] leading-relaxed text-muted-foreground">
          <p className="font-display text-[19px] font-bold text-maroon">Veshannastro<span className="text-primary">.</span></p>
          <p><strong className="font-semibold text-foreground">Guidance, not a guarantee.</strong> Readings follow traditional numerology methods taught by experienced numerologists. They are not medical, legal or financial advice. For any health concern, please consult a doctor.</p>
          <p>What we store: your name, mobile number, date of birth, what you shared, the numbers and watch details you gave, and whether you want WhatsApp updates. We use them to show your reading and, only if you agree, to contact you on WhatsApp. We never sell them.</p>
          <p>© {new Date().getFullYear()} Veshannastro</p>
        </div>
      </footer>
    </div>
  );
}
