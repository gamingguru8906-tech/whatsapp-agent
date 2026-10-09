import React, { useEffect, useRef, useState } from 'react';
import { getConfig, getReading } from './api.js';
import ReadingForm from './components/ReadingForm.jsx';
import Story from './components/Story.jsx';
import VedicGrid from './components/VedicGrid.jsx';

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
    const data = await getReading(payload, ownerKey.current);
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
          <a href="/" className="font-display text-[19px] font-bold tracking-tight text-foreground no-underline">
            Veshannastro<span className="text-primary">.</span>
          </a>
          <span className="text-[13px] font-medium text-muted-foreground">Free reading, no login</span>
        </div>
      </header>

      {config.preview && (
        <p className="bg-accent-soft px-5 py-2 text-center text-[13px] font-medium text-warning-dark">
          Preview for the owner: readings run inside this page and nothing is saved. The live site saves leads to your database and Google Sheet.
        </p>
      )}
      <main>
        <section className="mx-auto grid max-w-5xl gap-10 px-5 pb-12 pt-8 sm:pt-14 lg:grid-cols-[1fr_minmax(0,440px)] lg:items-start lg:gap-14">
          <div className="min-w-0">
            <h1 className="t-large max-w-[13ch]">What is your mobile number doing to your life?</h1>
            <p className="mt-4 max-w-[34rem] text-[19px] leading-[1.42] text-muted-foreground">
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
            <p className="mt-8 text-[15px] text-muted-foreground">
              Free, always. Every line of your reading comes from a fixed numerology rulebook, not AI.
            </p>
          </div>
          <div className="min-w-0 scroll-mt-20" id="reading-form">
            <ReadingForm config={config} status={status} errors={errors} onSubmit={submit} />
          </div>
        </section>

        {result && (
          <section ref={storyRef} className="mx-auto max-w-[44rem] scroll-mt-16 px-5 pb-14 pt-4">
            <Story result={result} config={config} onAgain={again} />
          </section>
        )}
      </main>

      <footer className="border-t border-border/70">
        <div className="mx-auto grid max-w-5xl gap-3 px-5 py-8 text-[13px] leading-relaxed text-muted-foreground">
          <p><strong className="font-semibold text-foreground">Guidance, not a guarantee.</strong> Readings follow traditional numerology methods taught by experienced numerologists. They are not medical, legal or financial advice. For any health concern, please consult a doctor.</p>
          <p>What we store: your name, mobile number, date of birth, what you shared, the numbers you checked, and whether you want WhatsApp updates. We use them to show your reading and, only if you agree, to contact you on WhatsApp. We never sell them.</p>
          <p>© {new Date().getFullYear()} Veshannastro</p>
        </div>
      </footer>
    </div>
  );
}
