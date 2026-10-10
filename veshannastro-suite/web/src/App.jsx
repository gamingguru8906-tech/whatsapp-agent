import React from 'react';
import { ChevronRight } from 'lucide-react';
import Watch from './Watch.jsx';

// Veshannastro front page. The watch reading opens later; until then its button asks to be told on WhatsApp, and
// the mobile-number reading (live) is one tap away. "(Ref: ...)" tags the lead's source in Kamala's CRM.
const WHATSAPP = '917646952745';
const wa = text => `https://wa.me/${WHATSAPP}?text=${encodeURIComponent(text)}`;
const WATCH = 'https://veshannastro-numerology.veshannastro.workers.dev/watch';
const CONSULT = wa('Hi, I would like a watch and numerology consultation. (Ref: WEB-SUITE)');
const MOBILE = 'https://veshannastro-numerology.veshannastro.workers.dev';
const MAIN_SITE = 'https://veshannastro.co.in';

const WaIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 20Z" /></svg>
);

const STEPS = [
  ['Add a photo or describe it', 'A photo of your watch fills in its dial, metal and strap; check each answer, or pick them yourself.'],
  ['Add the finer details', 'Numerals, date window, hands and strap pattern, if you know them.'],
  ['Add your birth date', 'It gives your birth number and your personal year.'],
  ['Read your answer', 'What your watch says about you, whether it suits your year, and what to change.']
];

const READINGS = [
  { name: 'Wristwatch Analyzer', text: "What your watch's dial, colour, metal and strap say about you, and whether it suits your year.", status: 'Open now', href: WATCH },
  { name: 'Mobile Number Reading', text: 'What your mobile number is doing to your money, work and relationships, and whether to change it.', status: 'Open now', href: MOBILE },
  { name: 'Signature Analysis', text: 'What your signature shows about the way you decide and lead.', status: 'Coming later' },
  { name: 'Symbolism Mapper', text: 'What the symbols you carry and live with mean for you.', status: 'Coming later' }
];

const Dot = ({ className }) => <span className={`mt-[0.62em] h-1.5 w-1.5 shrink-0 rounded-full ${className}`} aria-hidden="true" />;

function Reading({ r }) {
  const live = Boolean(r.href);
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="t-head">{r.name}</h3>
        <span className={`inline-flex shrink-0 items-center gap-0.5 self-center font-display text-[14px] font-semibold ${live ? 'text-success-dark' : 'text-muted-foreground'}`}>
          {r.status}{live && <ChevronRight size={18} aria-hidden="true" />}
        </span>
      </div>
      <p className="mt-1 text-[16px] leading-snug text-muted-foreground">{r.text}</p>
    </>
  );
  return (
    <li>
      {live
        ? <a href={r.href} className="block px-5 py-5 transition-colors hover:bg-muted/50 sm:px-6">{body}</a>
        : <div className="px-5 py-5 sm:px-6">{body}</div>}
    </li>
  );
}

export default function App() {
  const year = new Date().getFullYear();
  return (
    <div className="min-h-screen">
      <header className="material sticky top-0 z-20 border-b border-border/60" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3">
          <a href="/" className="font-display text-[19px] font-bold tracking-tight text-maroon">Veshannastro<span className="text-primary">.</span></a>
          <nav aria-label="Page" className="hidden items-center gap-7 text-[15px] font-medium text-muted-foreground sm:flex">
            <a href="#how" className="hover:text-maroon">How it works</a>
            <a href="#readings" className="hover:text-maroon">Readings</a>
            <a href={CONSULT} target="_blank" rel="noopener noreferrer" className="hover:text-maroon">Consult</a>
          </nav>
        </div>
      </header>

      <main>
        {/* Hero: the watch reading */}
        <section id="watch" className="mx-auto grid max-w-5xl items-center gap-8 px-5 pb-14 pt-10 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_420px] lg:gap-12">
          <div className="min-w-0">
            <h1 className="t-large max-w-[12ch]">What does your watch say about you?</h1>
            <p className="mt-5 max-w-[34rem] text-[18px] leading-[1.6] text-muted-foreground">
              The colour of the dial, the metal, the strap and the wrist you wear it on all carry meaning in numerology.
              Add a photo or describe your watch, and see what it says about you and whether it suits your year.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href={WATCH} className="btn-primary">Read my watch</a>
              <a href={MOBILE} className="btn-plain">Read my mobile number now</a>
            </div>
          </div>
          <Watch className="mx-auto w-full max-w-[420px]" />
        </section>

        {/* The price shift */}
        <section id="price" className="border-y border-border/70 bg-card">
          <div className="mx-auto max-w-5xl px-5 py-14 sm:py-20">
            <p className="text-[17px] text-muted-foreground">A personal watch and numerology consultation often costs</p>
            <p className="mt-2 font-display text-[2.25rem] font-bold leading-[1.05] tracking-[-0.02em] text-maroon sm:text-[4rem]">₹50,000 to ₹1,00,000</p>
            <p className="mt-3 font-display text-[1.375rem] font-semibold leading-snug sm:text-[1.625rem]">Your first watch reading is free.</p>

            <div className="mt-10 grid gap-10 sm:grid-cols-2 sm:gap-12">
              <div>
                <h2 className="text-[17px] font-semibold text-maroon">The free watch reading</h2>
                <ul className="mt-3 grid gap-2 text-[16px]">
                  <li className="flex gap-3"><Dot className="bg-primary" />What your dial, metal and strap say about you</li>
                  <li className="flex gap-3"><Dot className="bg-primary" />Whether your watch suits your personal year</li>
                  <li className="flex gap-3"><Dot className="bg-primary" />What to change, if anything</li>
                </ul>
              </div>
              <div>
                <h2 className="text-[17px] font-semibold text-maroon">A personal consultation</h2>
                <ul className="mt-3 grid gap-2 text-[16px]">
                  <li className="flex gap-3"><Dot className="bg-maroon" />Everything in the free reading</li>
                  <li className="flex gap-3"><Dot className="bg-maroon" />Your birth date and name read with your watch</li>
                  <li className="flex gap-3"><Dot className="bg-maroon" />A watch chosen for you</li>
                  <li className="flex gap-3"><Dot className="bg-maroon" />Your questions answered on WhatsApp</li>
                </ul>
                <a href={CONSULT} target="_blank" rel="noopener noreferrer" className="btn-whatsapp mt-6 w-full sm:w-auto"><WaIcon />Book a consultation</a>
              </div>
            </div>
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="mx-auto max-w-5xl scroll-mt-16 px-5 py-14 sm:py-20">
          <h2 className="t-title">How the watch reading works</h2>
          <ol className="mt-8 grid gap-7 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
            {STEPS.map(([title, text], i) => (
              <li key={title} className="flex gap-4 lg:flex-col lg:gap-3">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border-[1.5px] border-maroon/40 font-display text-[16px] font-semibold text-maroon">{i + 1}</span>
                <div>
                  <h3 className="t-head">{title}</h3>
                  <p className="mt-1 text-[16px] leading-snug text-muted-foreground">{text}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        {/* Every reading */}
        <section id="readings" className="mx-auto max-w-5xl scroll-mt-16 px-5 pb-14 sm:pb-20">
          <h2 className="t-title">Readings by Veshannastro</h2>
          <ul className="group-card rows mt-8">
            {READINGS.map(r => <Reading key={r.name} r={r} />)}
          </ul>
        </section>

        {/* Who is behind it, and the consultation */}
        <section id="about" className="border-t border-border/70">
          <div className="mx-auto grid max-w-5xl gap-10 px-5 py-14 sm:py-20 lg:grid-cols-2 lg:gap-16">
            <div>
              <h2 className="t-title">Who reads your numbers</h2>
              <p className="mt-4 text-[17px]">
                Veshannastro is a Vedic astrology and numerology practice led by Shashank Agrawal, author of
                {' '}<em>Numbers &amp; Navgraha: Untold Secret of Numerology</em>.
              </p>
              <a href={MAIN_SITE} className="mt-4 inline-flex items-center gap-0.5 font-display text-[16px] font-semibold text-primary-dark hover:text-maroon">
                Visit veshannastro.co.in<ChevronRight size={18} aria-hidden="true" />
              </a>
            </div>
            <div className="lg:pt-1">
              <h2 className="t-title">Want a watch chosen for you?</h2>
              <p className="mt-4 text-[17px] text-muted-foreground">Talk to us on WhatsApp about your watch, your numbers or a new mobile number.</p>
              <a href={CONSULT} target="_blank" rel="noopener noreferrer" className="btn-whatsapp mt-6 w-full sm:w-auto"><WaIcon />Consult on WhatsApp</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/70 bg-card/60">
        <div className="mx-auto grid max-w-5xl gap-2 px-5 py-9 text-[14px] leading-relaxed text-muted-foreground">
          <p className="font-display text-[19px] font-bold text-maroon">Veshannastro<span className="text-primary">.</span></p>
          <p>Readings follow traditional numerology. They are not medical, legal or financial advice.</p>
          <p>© {year} Veshannastro</p>
        </div>
      </footer>
    </div>
  );
}
