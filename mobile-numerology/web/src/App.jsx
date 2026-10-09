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
      <header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <a href="/" className="text-lg font-bold tracking-tight text-foreground no-underline">
            Veshannastro<span className="text-primary">.</span>
          </a>
          <span className="text-sm font-medium text-muted-foreground">Free · No login</span>
        </div>
      </header>

      {config.preview && (
        <p className="bg-accent-soft px-4 py-2 text-center text-sm font-medium text-warning-dark">
          Preview for the owner: readings run inside this page and nothing is saved. The live site saves leads to your database and Google Sheet.
        </p>
      )}
      <main>
        <section className="relative overflow-hidden bg-primary-soft/60">
          <div className="mx-auto grid max-w-5xl gap-8 px-4 py-10 sm:py-14 lg:grid-cols-[1fr_minmax(0,460px)] lg:items-start lg:gap-12">
            <div className="min-w-0 animate-rise">
              <p className="text-sm font-semibold uppercase tracking-[0.08em] text-primary-dark">Free mobile numerology</p>
              <h1 className="mt-3 text-[2rem] font-bold leading-[1.08] tracking-tight sm:text-5xl">
                What is your mobile number doing to your life?
              </h1>
              <p className="mt-4 max-w-xl text-lg text-muted-foreground">
                Enter your number and date of birth. See what every pair of digits means, the yogas your number forms on
                the Vedic grid, your year ahead, and how to protect yourself.
              </p>
              <ul className="mt-6 flex flex-wrap gap-2 text-sm font-semibold">
                {['Free', 'No login', 'Takes a minute', 'Compare a number before you buy it'].map(t => (
                  <li key={t} className="rounded-full border border-primary/20 bg-background px-3 py-1 text-foreground">{t}</li>
                ))}
              </ul>
              <div className="mt-8 hidden items-center gap-5 lg:flex">
                <VedicGrid size="lg" counts={{ 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1 }} label="The Vedic numerology grid" />
                <p className="max-w-[16rem] text-sm text-muted-foreground">
                  Your digits are placed on this grid. The patterns they form are called yogas.
                </p>
              </div>
            </div>
            <div className="min-w-0" id="reading-form">
              <ReadingForm config={config} status={status} errors={errors} onSubmit={submit} />
            </div>
          </div>
        </section>

        {result && (
          <section ref={storyRef} className="mx-auto max-w-3xl scroll-mt-20 px-4 py-10">
            <Story result={result} config={config} onAgain={again} />
          </section>
        )}
      </main>

      <footer className="border-t bg-muted/50">
        <div className="mx-auto grid max-w-5xl gap-3 px-4 py-8 text-sm text-muted-foreground">
          <p><strong className="text-foreground">Guidance, not a guarantee.</strong> Readings follow traditional numerology methods taught by experienced numerologists. They are not medical, legal or financial advice. For any health concern, please consult a doctor.</p>
          <p>What we store: your name, mobile number, date of birth, what you shared, the numbers you checked, and whether you want WhatsApp updates. We use them to show your reading and, only if you agree, to contact you on WhatsApp. We never sell them.</p>
          <p>© {new Date().getFullYear()} Veshannastro</p>
        </div>
      </footer>
    </div>
  );
}
