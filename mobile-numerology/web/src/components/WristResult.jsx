import React, { useState } from 'react';
import { CalendarCheck, Check } from 'lucide-react';
import { WaButton, callLink, Source, SavedNote, WaIcon, Segmented } from './ui.jsx';
import { sendAnswer, track } from '../api.js';

// The answer to "Which watch should I wear this year?", then "Does this sound like you?", and the WhatsApp opt-in
// at the very end. Answers are saved on the visitor's own lead and written to the Sheet.

const CASE = { gold: ['#B8892B', '#F1D27E'], roseGold: ['#B97A63', '#EDC1AE'], silver: ['#9EA3A9', '#F2F4F6'], steel: ['#7F868D', '#D9DDE1'],
  twoTone: ['#9EA3A9', '#F1D27E'], black: ['#1E1E1E', '#4A4A4A'] };
const DIAL = { white: '#FBFAF7', blue: '#1F4E9C', green: '#1F6B4A', gold: '#D9B45A', yellow: '#E9C640' };
const STRAP = { leather: '#7A4A2B', metal: null, silicone: '#2B2F33' };

// A drawing of the recommended watch: its metal, dial colour and strap.
function TheWatch({ w }) {
  const [c0, c1] = CASE[w.metal] ?? CASE.steel;
  const dial = DIAL[w.colours?.[0]] ?? '#F4EFE8';
  const light = ['white', 'yellow', 'gold'].includes(w.colours?.[0]) || !w.colours?.length;
  const ink = light ? '#2A2A2A' : '#F4EFE8';
  const strap = STRAP[w.strap];
  const links = Array.from({ length: 5 }, (_, i) => i);
  return (
    <svg viewBox="0 0 200 300" className="h-auto w-[150px] shrink-0 sm:w-[170px]" role="img" aria-label="A drawing of your watch for the year">
      <defs>
        <linearGradient id="wc" x1="0" x2="1"><stop offset="0" stopColor={c0} /><stop offset=".5" stopColor={c1} /><stop offset="1" stopColor={c0} /></linearGradient>
        {w.metal === 'twoTone' && <linearGradient id="wt" x1="0" x2="1"><stop offset="0" stopColor="#B8892B" /><stop offset=".5" stopColor="#F1D27E" /><stop offset="1" stopColor="#B8892B" /></linearGradient>}
      </defs>
      {strap
        ? <><rect x="72" y="0" width="56" height="100" rx="10" fill={strap} /><rect x="72" y="200" width="56" height="100" rx="10" fill={strap} /></>
        : links.map(i => <g key={i}><rect x="72" y={i * 19} width="56" height="16" rx="3" fill={w.metal === 'twoTone' && i % 2 ? 'url(#wt)' : 'url(#wc)'} />
          <rect x="72" y={210 + i * 19} width="56" height="16" rx="3" fill={w.metal === 'twoTone' && i % 2 ? 'url(#wt)' : 'url(#wc)'} /></g>)}
      <circle cx="100" cy="150" r="66" fill="url(#wc)" />
      {w.metal === 'twoTone' && <circle cx="100" cy="150" r="60" fill="none" stroke="url(#wt)" strokeWidth="6" />}
      <circle cx="100" cy="150" r="56" fill={dial} />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i * 30 * Math.PI) / 180, r1 = i % 3 ? 48 : 44;
        return <line key={i} x1={100 + r1 * Math.sin(a)} y1={150 - r1 * Math.cos(a)} x2={100 + 52 * Math.sin(a)} y2={150 - 52 * Math.cos(a)} stroke={ink} strokeWidth={i % 3 ? 2 : 3.5} strokeLinecap="round" />;
      })}
      <line x1="100" y1="150" x2="100" y2="116" stroke={ink} strokeWidth="4" strokeLinecap="round" transform="rotate(-50 100 150)" />
      <line x1="100" y1="150" x2="100" y2="104" stroke={ink} strokeWidth="3" strokeLinecap="round" transform="rotate(60 100 150)" />
      <circle cx="100" cy="150" r="4" fill={ink} />
      <rect x="164" y="142" width="8" height="16" rx="2" fill="url(#wc)" />
    </svg>
  );
}

function Choice({ options, value, onPick, busy }) {
  return (
    <div className={`mt-4 grid gap-2 ${options.length === 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
      {options.map(([k, label]) => (
        <button key={String(k)} type="button" disabled={busy} aria-pressed={value === k} onClick={() => onPick(k)}
          className={`pressable min-h-[48px] rounded-[12px] border px-2 text-[16px] font-semibold ${value === k ? 'border-primary bg-primary-soft text-maroon' : 'border-primary/15 bg-card text-maroon hover:border-primary/50'}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

export default function WristResult({ result, config, onAgain, againLabel = 'Try another wrist photo', saved = true }) {
  const by = id => result.sections.find(s => s.id === id);
  const a = by('wrist-answer'), next = by('next-year'), profile = by('profile'), br = by('bracelet');
  const owner = result.owner === true;
  const word = result.input.name.split(' ')[0];
  const first = word.charAt(0).toUpperCase() + word.slice(1);
  const href = callLink(config, first, result.leadRef, `my watch for ${a.year}`, 'WEB-WRIST');
  const [feedback, setFeedback] = useState(null);
  const [optIn, setOptIn] = useState(null);
  const [busy, setBusy] = useState(false);

  async function answer(kind, value) {
    setBusy(true);
    if (kind === 'feedback') setFeedback(value); else setOptIn(value);
    track('wrist', kind === 'feedback' ? 'feedback' : 'opt_in', { leadKey: result.leadKey, detail: { value: String(value) } });
    await sendAnswer(result.leadKey, kind === 'feedback' ? { feedback: value } : { optIn: value });
    setBusy(false);
  }

  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-8">
      <section id="r-answer" className="group-card scroll-mt-32 shadow-soft">
        <div className="border-t-[3px] border-t-primary px-5 pb-6 pt-6 sm:px-7 sm:pt-7">
          <p className="font-display text-[15px] font-medium text-muted-foreground">{first}, your watch for {a.year}</p>
          <div className="mt-3 flex flex-col items-center gap-5 sm:flex-row sm:items-start">
            <TheWatch w={a.watch} />
            <div className="min-w-0">
              <h2 className="font-display text-[1.75rem] font-bold leading-[1.15] tracking-[-0.015em] text-maroon sm:text-[2rem]">{a.answer}</h2>
              <p className="mt-3 flex items-center gap-2 font-display text-[15px] font-medium text-muted-foreground">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-maroon-soft text-[14px] font-bold text-maroon">{a.personalYear}</span>
                Your personal year in {a.year}
              </p>
            </div>
          </div>
        </div>
        <div className="border-t border-border/70 px-5 py-5 sm:px-7">
          <h3 className="text-[15px] font-semibold text-maroon">Why this watch</h3>
          <ul className="mt-3 grid gap-3">
            {a.why.map(w => (
              <li key={w.id} className="flex gap-3">
                <Check size={18} className="mt-1 shrink-0 text-success-dark" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="t-body">{w.text}</p>
                  {owner && <p className="t-note mt-0.5">Rule {w.id}</p>}
                </div>
              </li>
            ))}
          </ul>
          <p className="t-note mt-4">This is guidance for style and orientation, not a guaranteed outcome.</p>
        </div>
      </section>

      {profile.items.length > 0 && (
        <section className="group-card px-5 py-6 sm:px-7">
          <p className="font-display text-[15px] font-medium text-muted-foreground">Birth number {profile.birthNumber}</p>
          <h2 className="t-title mt-1">Does this sound like you?</h2>
          <div className="mt-3 grid gap-2.5">
            {profile.items.map(x => (
              <div key={x.id}>
                <p className="text-[18px] leading-[1.5]">{x.say}</p>
                {owner && x.source && <Source s={{ file: x.source.book, ref: `p. ${x.source.pages.join(', ')}`, quote: x.source.quote }} id={x.id} owner />}
              </div>
            ))}
          </div>
          <div className="mt-4"><Segmented label="Does this sound like you?" options={[['yes', 'Yes'], ['partly', 'Partly'], ['no', 'No']]} value={feedback ?? ''} onChange={v => answer('feedback', v)} /></div>
          {feedback && <p className="mt-3 text-[15px] text-muted-foreground" role="status">{feedback === 'yes' ? 'Thank you. Your numbers read you well.' : 'Thank you for telling us. A consultation looks at your full chart, not only your birth number.'}</p>}
        </section>
      )}

      {next?.text && (
        <section className="group-card row flex items-start gap-4 px-5 py-5 sm:px-7">
          <CalendarCheck size={22} className="mt-0.5 shrink-0 text-maroon" aria-hidden="true" />
          <div className="min-w-0">
            <h3 className="t-headline">Coming next: your watch for {next.year}</h3>
            <p className="t-body mt-0.5 text-foreground/80">Personal year {next.personalYear}: {next.text.split('. ')[0].replace(/\.$/, '')}.</p>
          </div>
        </section>
      )}

      {br?.bracelet && (
        <section className="group-card row flex items-center justify-between gap-4 px-5 py-5 sm:px-7">
          <div className="min-w-0">
            <p className="t-note">Wear it with your watch · birth number {br.birthNumber}</p>
            <h3 className="t-headline mt-0.5">{br.bracelet.name}</h3>
          </div>
          <a href={br.bracelet.url} target="_blank" rel="noopener noreferrer" onClick={() => track('wrist', 'shop_click', { leadKey: result.leadKey })}
            className="btn-plain min-h-[44px] shrink-0 bg-card px-4 text-[15px] shadow-[0_0_0_1px_hsl(var(--border))]">₹{br.bracelet.price.toLocaleString('en-IN')} · Shop</a>
        </section>
      )}

      <section className="group-card px-5 py-6 text-center sm:px-7">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-whatsapp text-white"><WaIcon size={24} /></span>
        <h2 className="t-title mt-3">Get your watch reminders on WhatsApp?</h2>
        <p className="mx-auto mt-2 max-w-md text-[17px] text-muted-foreground">When your watch for the year changes, and new recommendations and offers. Reply STOP any time.</p>
        <div className="mx-auto max-w-sm"><Choice options={[[true, 'Yes, send them'], [false, 'No thanks']]} value={optIn} busy={busy} onPick={v => answer('optIn', v)} /></div>
        {optIn !== null && <p className="mt-3 text-[15px] text-muted-foreground" role="status">{optIn ? 'Done. We will message you on WhatsApp.' : 'No problem. We will not send you updates.'}</p>}
      </section>

      <section data-wa-cta className="group-card px-6 py-8 text-center shadow-soft">
        <h2 className="t-title">Want help choosing the exact watch?</h2>
        <p className="mx-auto mt-2 max-w-md text-[17px] text-muted-foreground">We match your watch to your full numbers and your budget, on a call.</p>
        {href && <WaButton href={href} className="mt-6">Book a call on WhatsApp</WaButton>}
        <p className="mt-5"><a href="/watch" className="font-display text-[15px] font-semibold text-primary-dark">Read the watch you wear now ›</a></p>
      </section>
      {saved && <SavedNote mobile={result.input.mobile} />}
      <button type="button" onClick={onAgain} className="btn-plain justify-self-center bg-card px-6 shadow-[0_0_0_1px_hsl(var(--border))]">{againLabel}</button>
    </div>
  );
}
