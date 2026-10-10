// Shared building blocks for every reading page (mobile and watch segments): same look everywhere.
import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import VedicGrid from './VedicGrid.jsx';
export const fmt = m => `${m.slice(0, 5)} ${m.slice(5)}`;
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const dot = p => ({ positive: 'dot-good', negative: 'dot-care', mixed: 'dot-mixed' }[p] || 'dot-neutral');

export function jump(id) {
  document.getElementById(`r-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// A chapter: icon and title above, content in grouped cards below (iOS inset grouped style).
export function Chapter({ id, icon: Icon, title, intro, children }) {
  return (
    <section id={`r-${id}`} className="scroll-mt-32">
      <div className="mb-3 flex items-center gap-3 px-1">
        {Icon && <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-maroon-soft text-maroon"><Icon size={19} strokeWidth={2.1} aria-hidden="true" /></span>}
        <h2 className="t-section">{title}</h2>
      </div>
      {intro && <p className="mb-3 px-1 text-[15px] leading-snug text-muted-foreground">{intro}</p>}
      <div className="grid gap-3">{children}</div>
    </section>
  );
}

export function Source({ s, id, owner }) {
  if (!owner || !s) return null;
  return <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{id} · {s.file}{s.ref ? ` ${s.ref}` : ''}: “{s.quote}”</p>;
}

export function Line({ kind, children }) {
  const label = { good: 'Strength', care: 'Needs care', trait: 'Your nature', remedy: 'Remedy' }[kind];
  const color = { good: 'text-success-dark', care: 'text-care-dark', trait: 'text-muted-foreground', remedy: 'text-primary-dark' }[kind];
  return <p className="t-body"><span className={`mr-1.5 font-display font-semibold ${color}`}>{label}</span>{children}</p>;
}

// Shows the first few rows; the rest open with one tap. The owner sees everything, to check each line.
export function ShowMore({ items, initial = 3, owner, noun, render }) {
  const [open, setOpen] = useState(false);
  const all = owner || open || items.length <= initial + 1;
  return (
    <>
      {(all ? items : items.slice(0, initial)).map(render)}
      {items.length > initial + 1 && !owner && (
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="row flex w-full items-center justify-between text-left text-[17px] font-medium text-primary-dark">
          {open ? 'Show fewer' : `Show all ${items.length} ${noun}`}
          <ChevronDown size={20} className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      )}
    </>
  );
}

export function RuleRow({ x, owner, title, extra }) {
  return (
    <div className="row flex gap-3">
      <span className={`dot ${dot(x.polarity)}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <h3 className="t-headline">{title ?? x.title}</h3>
          {x.count > 1 && <span className="chip bg-muted text-muted-foreground">appears {x.count} times</span>}
          {extra}
        </div>
        <div className="mt-1 grid gap-1">
          {x.good && <Line kind="good">{x.good}</Line>}
          {x.trait && <Line kind="trait">{x.trait}</Line>}
          {x.care && <Line kind="care">{x.care}</Line>}
        </div>
        <Source s={x.source} id={x.id} owner={owner} />
      </div>
    </div>
  );
}

export function YogaRow({ y, owner, remedy }) {
  return (
    <div className="row flex items-start gap-3.5">
      <VedicGrid size="sm" present={y.present} absent={y.absent} />
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <span className={`dot ${dot(y.polarity)}`} aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="t-headline">{y.title}</h3>
            <p className="t-note">{y.group}, {y.pattern}</p>
          </div>
        </div>
        <div className="mt-1.5 grid gap-1">
          {y.good && <Line kind="good">{y.good}</Line>}
          {y.trait && <Line kind="trait">{y.trait}</Line>}
          {y.care && <Line kind="care">{y.care}</Line>}
          {remedy && <Line kind="remedy">{remedy}</Line>}
        </div>
        <Source s={y.source} id={y.id} owner={owner} />
      </div>
    </div>
  );
}

export const WaIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 20Z" /></svg>
);

// "(Ref: WEB-NUMEROLOGY)" tags the lead's source in the WhatsApp bot's CRM (growth.js extractRef), which removes it
// from the text. The Reading ID lets Kamala open this exact reading, even when they write from a different number.
export function whatsappLink(config, name, leadRef) {
  const num = (config.whatsappNumber || '').replace(/\D/g, '');
  if (!num) return null;
  const id = /^NM-[0-9a-f]{8}$/.test(leadRef || '') ? ` Reading ID: ${leadRef}.` : '';
  const text = encodeURIComponent(`Hi, I'm ${name}. I just got my free mobile numerology reading and would like a consultation.${id} (Ref: WEB-NUMEROLOGY)`);
  return `https://wa.me/${num}?text=${text}`;
}

export function WaButton({ href, children = 'Ask us on WhatsApp', className = '' }) {
  return <a href={href} target="_blank" rel="noopener noreferrer" className={`btn-whatsapp ${className}`}><WaIcon />{children}</a>;
}

export function InlineCta({ href, title, text }) {
  if (!href) return null;
  return (
    <div data-wa-cta className="group-card flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-whatsapp text-white"><WaIcon size={19} /></span>
        <div>
          <p className="t-headline">{title}</p>
          <p className="text-[15px] leading-snug text-muted-foreground">{text}</p>
        </div>
      </div>
      <WaButton href={href} className="shrink-0" />
    </div>
  );
}


// "Book a call" on WhatsApp, about one topic, carrying the Reading ID so Kamala opens this exact reading.
export function callLink(config, name, leadRef, topic, ref = 'WEB-NUMEROLOGY') {
  const num = (config.whatsappNumber || '').replace(/\D/g, '');
  if (!num) return null;
  const id = /^NM-[0-9a-f]{8}$/.test(leadRef || '') ? ` Reading ID: ${leadRef}.` : '';
  return `https://wa.me/${num}?text=${encodeURIComponent(`Hi, I'm ${name}. I'd like to book a call about ${topic}.${id} (Ref: ${ref})`)}`;
}

// A small "book a call" row inside a chapter, for points a person should explain.
export function CallRow({ href, text }) {
  if (!href) return null;
  return (
    <a data-wa-cta href={href} target="_blank" rel="noopener noreferrer"
      className="row flex items-center justify-between gap-3 font-display text-[16px] font-semibold text-whatsapp-dark">
      <span className="flex items-center gap-2"><WaIcon size={18} />{text}</span>
      <span aria-hidden="true">›</span>
    </a>
  );
}

// Under a fresh reading: it is kept for the number entered, and "My readings" shows it again after a WhatsApp sign-in.
export function SavedNote({ mobile }) {
  if (!mobile) return null;
  return (
    <a href="/my" className="group-card flex items-center gap-3 px-4 py-4 no-underline transition-colors hover:bg-muted/40 sm:px-5">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-maroon-soft font-display text-[15px] font-bold text-maroon" aria-hidden="true">✓</span>
      <span className="min-w-0 flex-1">
        <span className="t-headline block">Your reading is saved</span>
        <span className="t-note mt-0.5 block">Open it any time from My readings: sign in with WhatsApp from +91 {String(mobile).slice(0, 5)} {String(mobile).slice(5)}.</span>
      </span>
      <span className="hidden shrink-0 font-display text-[15px] font-semibold text-primary-dark sm:inline">My readings ›</span>
    </a>
  );
}
