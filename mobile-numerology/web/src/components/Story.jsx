import React, { useEffect, useMemo, useRef, useState } from 'react';
import VedicGrid from './VedicGrid.jsx';

// Every numerology sentence here comes from the reading the engine returns (rule wording approved by the owner).
// The page only adds headings, short "how this works" intros, navigation and layout.

const fmt = m => `${m.slice(0, 5)} ${m.slice(5)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const CAT = { theme: 'The year', do: 'Do', avoid: 'Avoid', money: 'Money', career: 'Work', relationship: 'Love & marriage', health: 'Health', education: 'Study', travel: 'Travel', home: 'Home', colours: 'Colours', accessories: 'Wear', crystal: 'Crystal', remedy: 'Remedy', name: 'Your name', chart: 'Birth chart' };
const CAT_ORDER = Object.keys(CAT);
const AREA = { money: 'Money', career: 'Career', relationship: 'Love & marriage', family: 'Family', health: 'Health', mind: 'Peace of mind', education: 'Education', legal: 'Court & legal', government: 'Government', travel: 'Travel & abroad', home: 'Home', spiritual: 'Spiritual' };
const tone = p => ({ positive: 'item-good', negative: 'item-care', mixed: 'item-mixed' }[p] || 'item-neutral');

// Points about what the visitor shared come first in every list.
const concernFirst = (items, ids) => [...items.filter(x => ids.has(x.id)), ...items.filter(x => !ids.has(x.id))];

function jump(id) {
  document.getElementById(`r-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function Section({ id, eyebrow, title, intro, children }) {
  return (
    <section id={`r-${id}`} className="section animate-rise scroll-mt-32">
      {eyebrow && <p className="text-xs font-semibold uppercase tracking-[0.08em] text-primary-dark">{eyebrow}</p>}
      <h2 className="section-title mt-1">{title}</h2>
      {intro && <p className="section-intro">{intro}</p>}
      <div className="mt-4 grid gap-3">{children}</div>
    </section>
  );
}

function Source({ s, id, owner }) {
  if (!owner || !s) return null;
  return <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{id} · {s.file}{s.ref ? ` ${s.ref}` : ''}: “{s.quote}”</p>;
}

function Line({ kind, children }) {
  const label = { good: 'Strength', care: 'Needs care', trait: 'Your nature', remedy: 'Remedy' }[kind];
  const color = { good: 'text-success-dark', care: 'text-care-dark', trait: 'text-muted-foreground', remedy: 'text-primary-dark' }[kind];
  return (
    <p className="text-[15px] leading-relaxed">
      <span className={`mr-1.5 text-[11px] font-bold uppercase tracking-wide ${color}`}>{label}</span>{children}
    </p>
  );
}

// Shows the first few items; the rest open with one tap. The owner sees everything, to check each line.
function ShowMore({ items, initial = 3, owner, noun, render }) {
  const [open, setOpen] = useState(false);
  const all = owner || open || items.length <= initial + 1;
  return (
    <>
      {(all ? items : items.slice(0, initial)).map(render)}
      {items.length > initial + 1 && !owner && (
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="justify-self-start rounded-full border bg-background px-4 py-2 text-sm font-semibold text-primary-dark hover:border-primary">
          {open ? 'Show fewer' : `Show all ${items.length} ${noun}`}
        </button>
      )}
    </>
  );
}

function RuleItem({ x, owner, title, extra }) {
  return (
    <div className={`item ${tone(x.polarity)}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h3 className="font-bold">{title ?? x.title}</h3>
        {x.count > 1 && <span className="chip bg-background/70 text-foreground">appears {x.count} times</span>}
        {extra}
      </div>
      <div className="mt-1 grid gap-1">
        {x.good && <Line kind="good">{x.good}</Line>}
        {x.trait && <Line kind="trait">{x.trait}</Line>}
        {x.care && <Line kind="care">{x.care}</Line>}
      </div>
      <Source s={x.source} id={x.id} owner={owner} />
    </div>
  );
}

function YogaItem({ y, owner, remedy }) {
  return (
    <div className={`item ${tone(y.polarity)} flex items-start gap-3`}>
      <VedicGrid size="sm" present={y.present} absent={y.absent} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h3 className="font-bold">{y.title}</h3>
          <span className="text-xs text-muted-foreground">{y.group} · {y.pattern}</span>
        </div>
        <div className="mt-1 grid gap-1">
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

const WaIcon = ({ size = 20 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 20Z" /></svg>
);

// "(Ref: WEB-NUMEROLOGY)" tags the lead's source in the WhatsApp bot's CRM (growth.js extractRef), which removes it
// from the text. The Reading ID lets Kamala open this exact reading, even when they write from a different number.
function whatsappLink(config, name, leadRef) {
  const num = (config.whatsappNumber || '').replace(/\D/g, '');
  if (!num) return null;
  const id = /^NM-[0-9a-f]{8}$/.test(leadRef || '') ? ` Reading ID: ${leadRef}.` : '';
  const text = encodeURIComponent(`Hi, I'm ${name}. I just got my free mobile numerology reading and would like a consultation.${id} (Ref: WEB-NUMEROLOGY)`);
  return `https://wa.me/${num}?text=${text}`;
}

function WaButton({ href, children = 'Ask us on WhatsApp', className = '' }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className={`inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-success px-5 text-base font-bold text-primary-foreground no-underline shadow-soft hover:bg-success-dark ${className}`}>
      <WaIcon />{children}
    </a>
  );
}

function InlineCta({ href, title, text }) {
  if (!href) return null;
  return (
    <div data-wa-cta className="flex flex-col gap-3 rounded-lg border border-success/25 bg-success-soft px-5 py-4 animate-rise sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-bold">{title}</p>
        <p className="text-sm text-muted-foreground">{text}</p>
      </div>
      <WaButton href={href} className="shrink-0" />
    </div>
  );
}

// ---------- 1. At a glance ----------

function Overview({ by, href, carePoints }) {
  const concern = by('concern');
  const protection = by('protection');
  const mobileItems = [...by('decoded').pairs, ...by('mobile-grid').yogas];
  const strengths = mobileItems.filter(x => x.good).length;
  const top = concern.items.slice(0, 3);
  const remedies = [protection.bracelet, protection.mani].filter(Boolean);
  return (
    <section id="r-overview" className="scroll-mt-32 overflow-hidden rounded-lg border-2 border-primary/20 bg-card shadow-soft animate-rise">
      <div className="bg-primary-soft/60 px-5 py-4 sm:px-6">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-primary-dark">At a glance</p>
        <div className="mt-3 grid grid-cols-2 gap-2.5">
          <button type="button" onClick={() => jump('mobile-grid')} className="rounded-lg border-l-[3px] border-l-success bg-background px-4 py-3 text-left">
            <span className="block text-3xl font-bold tabular-nums text-success-dark">{strengths}</span>
            <span className="text-sm font-semibold">{strengths === 1 ? 'strength' : 'strengths'} in your number</span>
          </button>
          <button type="button" onClick={() => jump(carePoints ? 'if-kept' : 'decoded')} className="rounded-lg border-l-[3px] border-l-care bg-background px-4 py-3 text-left">
            <span className="block text-3xl font-bold tabular-nums text-care-dark">{carePoints}</span>
            <span className="text-sm font-semibold">{carePoints === 1 ? 'point needs' : 'points need'} care</span>
          </button>
        </div>
      </div>

      <div className="grid gap-3 px-5 py-5 sm:px-6">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.06em] text-muted-foreground">About what you shared</p>
          <p className="mt-0.5 text-[15px] italic text-muted-foreground">“{concern.text}”</p>
          {concern.areas.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{concern.areas.map(a => <span key={a} className="chip bg-primary-soft text-primary-dark">{AREA[a] || a}</span>)}</div>}
        </div>
        {!concern.areas.length && <p className="text-[15px]">Thank you for sharing. Your full reading below covers every part of life your number touches.</p>}
        {concern.areas.length > 0 && !top.length && <p className="text-[15px]">Nothing in your number or birth date speaks directly to this. Your full reading continues below.</p>}
        {top.map(x => (
          <div key={`${x.id}${x.fromDob ? 'd' : ''}`} className={`item ${tone(x.polarity)}`}>
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h3 className="font-bold">{x.kind === 'yoga' ? `${x.title} (${x.pattern})` : x.title}</h3>
              {x.fromDob && <span className="chip bg-background/70 text-muted-foreground">from your birth date</span>}
            </div>
            <div className="mt-1 grid gap-1">
              {x.care && <Line kind="care">{x.care}</Line>}
              {x.good && <Line kind="good">{x.good}</Line>}
            </div>
          </div>
        ))}
        {concern.items.length > 3 && (
          <button type="button" onClick={() => jump('concern')} className="justify-self-start text-sm font-semibold text-primary-dark">
            {plural(concern.items.length - 3, 'more point', 'more points')} about this →
          </button>
        )}

        {remedies.length > 0 && (
          <div className="rounded-lg bg-accent-soft px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-[0.08em] text-warning-dark">Your protection</p>
            <p className="mt-1 text-[15px]">{remedies.join(' · ')}{protection.screenSaver.length ? ' · a phone screen saver for you' : ''}</p>
            <button type="button" onClick={() => jump('protection')} className="mt-1 text-sm font-semibold text-primary-dark">See your remedies →</button>
          </div>
        )}

        <div className="mt-1 flex flex-col gap-2.5 sm:flex-row">
          {href && <WaButton href={href} className="sm:flex-1">Ask us about this on WhatsApp</WaButton>}
          <button type="button" onClick={() => jump(concern.items.length > 3 ? 'concern' : 'decoded')}
            className="h-12 rounded-lg border bg-background px-5 text-base font-semibold hover:border-primary sm:flex-1">
            Read the full reading ↓
          </button>
        </div>
      </div>
    </section>
  );
}

// ---------- 4. Chapter bar ----------

function ChapterBar({ chapters, rootRef }) {
  const [active, setActive] = useState(chapters[0]?.id);
  const [progress, setProgress] = useState(0);
  const [top, setTop] = useState(0);
  const navRef = useRef(null);

  useEffect(() => {
    const header = document.querySelector('header');
    const measure = () => setTop(header ? Math.round(header.getBoundingClientRect().height) : 0);
    const onScroll = () => {
      const root = rootRef.current;
      if (!root) return;
      const r = root.getBoundingClientRect();
      setProgress(Math.min(1, Math.max(0, -r.top / Math.max(1, r.height - window.innerHeight))));
      let current = chapters[0]?.id;
      for (const c of chapters) {
        const el = document.getElementById(`r-${c.id}`);
        if (el && el.getBoundingClientRect().top < 170) current = c.id;
      }
      setActive(current);
    };
    measure();
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', measure);
    return () => { window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', measure); };
  }, [chapters, rootRef]);

  // Keep the current chapter's tab in view inside the horizontal bar (without moving the page).
  useEffect(() => {
    const nav = navRef.current;
    const tab = nav?.querySelector(`[data-id="${active}"]`);
    if (nav && tab) nav.scrollTo({ left: tab.offsetLeft - nav.clientWidth / 2 + tab.clientWidth / 2, behavior: 'smooth' });
  }, [active]);

  return (
    <nav aria-label="Chapters of your reading" style={{ top }}
      className="sticky z-10 -mx-4 min-w-0 border-b bg-background/95 backdrop-blur sm:mx-0 sm:rounded-lg sm:border">
      <div ref={navRef} className="no-scrollbar flex gap-1 overflow-x-auto px-3 py-2">
        {chapters.map(c => (
          <button key={c.id} data-id={c.id} type="button" onClick={() => jump(c.id)} aria-current={active === c.id ? 'true' : undefined}
            className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors ${active === c.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="h-[3px] bg-muted" aria-hidden="true">
        <div className="h-full bg-primary transition-[width] duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </nav>
  );
}

// ---------- 5. Sticky WhatsApp button on phones ----------

function StickyWhatsApp({ href }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      const overview = document.getElementById('r-overview');
      const past = overview ? overview.getBoundingClientRect().bottom < 0 : false;
      // Hidden while another WhatsApp button is on screen, so two never show at once.
      const otherInView = [...document.querySelectorAll('[data-wa-cta]')].some(el => {
        const r = el.getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0;
      });
      setShow(past && !otherInView);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" aria-hidden={!show} tabIndex={show ? 0 : -1}
      style={{ bottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
      className={`fixed right-4 z-30 inline-flex h-12 items-center gap-2 rounded-full bg-success px-5 text-base font-bold text-primary-foreground no-underline shadow-lg transition-all duration-200 sm:hidden ${show ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'}`}>
      <WaIcon />Ask us on WhatsApp
    </a>
  );
}

// ---------- Chapters ----------

// The first 3 points about their concern are in "At a glance"; this chapter holds the rest (none = no chapter).
function Concern({ s, owner, eyebrow }) {
  const rest = s.items.slice(3);
  return (
    <Section id="concern" eyebrow={eyebrow} title="More about what you shared" intro={`“${s.text}”`}>
      <div className="flex flex-wrap gap-1.5">{s.areas.map(a => <span key={a} className="chip bg-primary-soft text-primary-dark">{AREA[a] || a}</span>)}</div>
      <ShowMore items={rest} initial={4} owner={owner} noun="points" render={x => (
        <RuleItem key={`${x.id}${x.fromDob ? 'd' : ''}`} x={x} owner={owner}
          extra={x.fromDob ? <span className="chip bg-background/70 text-muted-foreground">from your birth date</span> : null}
          title={x.kind === 'yoga' ? `${x.title} (${x.pattern})` : undefined} />)} />
    </Section>
  );
}

function Decoded({ s, owner, eyebrow, concernIds }) {
  return (
    <Section id="decoded" eyebrow={eyebrow} title="Your number, decoded"
      intro="Every two neighbouring digits in your number form a pair, and each pair has a meaning. Zeros are skipped, so the digits on either side of a zero count as neighbours.">
      <div className="flex flex-wrap gap-1.5" aria-label={`Your number ${s.mobile}`}>
        {[...s.mobile].map((c, i) => (
          <span key={i} style={{ animationDelay: `${i * 45}ms` }}
            className={`digit animate-pop ${c === '0' ? 'bg-transparent text-faint line-through' : ''} ${i === 5 ? 'ml-2' : ''}`}>{c}</span>
        ))}
      </div>
      <ShowMore items={concernFirst(s.pairs, concernIds)} owner={owner} noun="pairs" render={p => <RuleItem key={p.id} x={p} owner={owner} />} />
    </Section>
  );
}

function MobileGrid({ s, owner, eyebrow, concernIds, remedyFor }) {
  const [open, setOpen] = useState(false);
  return (
    <Section id="mobile-grid" eyebrow={eyebrow} title="Your number's grid"
      intro="Your digits are placed on the Vedic grid. Where they line up, they form yogas.">
      <div className="flex flex-wrap items-start gap-5">
        <VedicGrid size="lg" counts={s.counts} />
        <div className="min-w-0 flex-1 basis-56 text-[15px]">
          <p className="font-semibold">Planets in your number</p>
          <p className="text-muted-foreground">{s.planets.map(p => `${p.digit} ${p.planet}`).join(' · ')}</p>
          <button type="button" className="mt-2 text-sm font-semibold text-primary-dark" onClick={() => setOpen(o => !o)} aria-expanded={open}>
            {open ? 'Hide' : 'Show'} what each digit means
          </button>
        </div>
      </div>
      {open && s.planets.map(p => (
        <div key={p.id} className="item item-neutral">
          <h3 className="font-bold">{p.digit} · {p.planet}{p.count > 1 ? ` (×${p.count})` : ''}</h3>
          <p className="mt-1 text-[15px] leading-relaxed">{p.trait}</p>
          <p className="mt-1 text-sm text-muted-foreground">Signifies: {p.signifies}</p>
          <Source s={p.source} id={p.id} owner={owner} />
        </div>
      ))}
      {s.yogas.length
        ? <><p className="text-sm font-semibold text-muted-foreground">{s.yogas.length} {s.yogas.length === 1 ? 'yoga forms' : 'yogas form'} on your number's grid</p>
            <ShowMore items={concernFirst(s.yogas, concernIds)} owner={owner} noun="yogas"
              render={y => <YogaItem key={y.id} y={y} owner={owner} remedy={remedyFor[y.id]} />} /></>
        : <p className="text-[15px] text-muted-foreground">No yogas form on your number's grid.</p>}
    </Section>
  );
}

function DobGrid({ s, dob, owner, eyebrow, concernIds, remedyFor }) {
  return (
    <Section id="dob-grid" eyebrow={eyebrow} title="Yogas you were born with"
      intro={`The digits of your birth date (${dob.split('-').reverse().join('/')}) on the same grid. These stay with you whichever number you use.`}>
      <div className="flex flex-wrap items-start gap-5">
        <VedicGrid size="lg" counts={s.counts} />
        <div className="grid min-w-0 flex-1 basis-64 gap-3">
          {s.yogas.length
            ? <ShowMore items={concernFirst(s.yogas, concernIds)} owner={owner} noun="yogas"
                render={y => <YogaItem key={y.id} y={y} owner={owner} remedy={remedyFor[y.id]} />} />
            : <p className="text-[15px] text-muted-foreground">No yogas form on your birth-date grid.</p>}
        </div>
      </div>
    </Section>
  );
}

function Career({ s, owner, eyebrow }) {
  return (
    <Section id="career" eyebrow={eyebrow} title="Your number & your career" intro="Certain combinations in a mobile number are linked with certain fields of work.">
      <div className="grid gap-2 sm:grid-cols-2">
        {s.professions.map(p => (
          <div key={p.id} className="item item-good">
            <h3 className="font-bold">{p.title}</h3>
            <p className="text-sm text-success-dark">Your number carries {p.codes.map(c => c.replace('+', ' and ')).join(', ')}</p>
            <Source s={p.source} id={p.id} owner={owner} />
          </div>
        ))}
      </div>
    </Section>
  );
}

function YearAhead({ s, nameNo, owner, eyebrow }) {
  const [tab, setTab] = useState(0);
  const y = s.years[tab];
  const groups = CAT_ORDER.map(c => [c, y.items.filter(i => i.cat === c)]).filter(([, l]) => l.length);
  return (
    <Section id="year-ahead" eyebrow={eyebrow} title="Your year ahead"
      intro="Your personal year comes from your birth day, birth month and the year. Each year number brings its own guidance.">
      <div className="inline-flex self-start rounded-full border bg-muted p-1" role="tablist" aria-label="Year">
        {s.years.map((yy, i) => (
          <button key={yy.year} role="tab" aria-selected={tab === i} type="button" onClick={() => setTab(i)}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold ${tab === i ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'}`}>
            {yy.year}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-4 rounded-lg bg-accent-soft p-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-accent text-2xl font-bold text-accent-foreground">{y.number}</span>
        <p className="text-[15px]"><strong>{y.year} is personal year {y.number} for you.</strong>{nameNo ? <span className="text-muted-foreground"> Your name number is {nameNo}.</span> : null}</p>
      </div>
      {groups.map(([c, list]) => (
        <div key={c}>
          <h3 className="mb-1.5 text-xs font-bold uppercase tracking-[0.08em] text-muted-foreground">{CAT[c]}</h3>
          <div className="grid gap-2">
            {list.map(i => (
              <div key={i.id} className={`item ${i.appliesToName ? 'item-care' : 'item-neutral'}`}>
                {i.appliesToName && <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-care-dark">Applies to your name number</p>}
                <p className="text-[15px] leading-relaxed">{i.text}</p>
                <Source s={i.source} id={i.id} owner={owner} />
              </div>
            ))}
          </div>
        </div>
      ))}
      {s.forEveryone.length > 0 && (
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer font-semibold">For every year</summary>
          <ul className="mt-2 grid list-disc gap-1.5 pl-5 text-[15px]">{s.forEveryone.map(i => <li key={i.id}>{i.text}</li>)}</ul>
        </details>
      )}
    </Section>
  );
}

function NameNumber({ s, eyebrow }) {
  return (
    <Section id="name" eyebrow={eyebrow} title="Your name number" intro="The letters of your name, added by the Chaldean method and reduced to one digit.">
      <div className="flex items-center gap-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-primary text-2xl font-bold text-primary-foreground">{s.number}</span>
        <p className="text-[15px]">Your name adds up to {s.total}, which reduces to <strong>{s.number}</strong>. Look for “Your name” in your year ahead for what this means this year.</p>
      </div>
    </Section>
  );
}

function IfKept({ s, owner, eyebrow }) {
  const items = [...s.items.filter(x => x.forConcern), ...s.items.filter(x => !x.forConcern)];
  return (
    <Section id="if-kept" eyebrow={eyebrow} title="If you keep this number"
      intro="These are the parts of your number that need care. Each one has a way forward in your correction & protection.">
      <ShowMore items={items} owner={owner} noun="points" render={x => (
        <div key={x.id} className="item item-care">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="font-bold">{x.title}</h3>
            {x.forConcern && <span className="chip bg-primary text-primary-foreground">about what you shared</span>}
          </div>
          <p className="mt-1 text-[15px] leading-relaxed">{x.text}</p>
        </div>
      )} />
      <button type="button" onClick={() => jump('protection')} className="justify-self-start text-sm font-semibold text-primary-dark">See your correction & protection →</button>
    </Section>
  );
}

function Protection({ s, eyebrow }) {
  const cards = [
    ['Phone screen saver', s.screenSaver.length ? s.screenSaver.join(' Or: ') : null],
    ['Bracelet', s.bracelet],
    ['Mani', s.mani]
  ].filter(([, v]) => v);
  return (
    <Section id="protection" eyebrow={eyebrow} title="Your correction & protection"
      intro={`For your birth number ${s.birthNumber}, these are the remedies for your mobile number.`}>
      <div className="grid gap-2 sm:grid-cols-3">
        {cards.map(([t, v]) => (
          <div key={t} className="item bg-accent-soft">
            <h3 className="text-xs font-bold uppercase tracking-[0.08em] text-warning-dark">{t}</h3>
            <p className="mt-1 text-[15px] leading-relaxed">{v}</p>
          </div>
        ))}
      </div>
      {s.yogaRemedies.map(r => (
        <div key={r.id} className="item item-neutral">
          <h3 className="font-bold">For {r.title}</h3>
          <p className="mt-1 text-[15px] leading-relaxed">{r.text}</p>
        </div>
      ))}
    </Section>
  );
}

function BetterNumber({ s, eyebrow }) {
  return (
    <Section id="better-number" eyebrow={eyebrow} title="What to look for in a new number"
      intro="If you choose a new number, these patterns are worth checking. To test a specific number before you buy it, tap “Check another number” and tick “Planning to buy a new number?”.">
      {s.lookFor.length > 0 && <h3 className="text-sm font-bold uppercase tracking-[0.08em] text-success-dark">Look for</h3>}
      {s.lookFor.map(x => (
        <div key={x.id} className="item item-good">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="font-bold">{x.title}</h3>
            <span className="text-xs text-muted-foreground">{x.pattern}</span>
            {x.have && <span className="chip bg-success text-primary-foreground">your number has this</span>}
          </div>
          <p className="mt-1 text-[15px] leading-relaxed">{x.why}</p>
        </div>
      ))}
      {s.avoid.length > 0 && (
        <details className="rounded-lg border p-4">
          <summary className="cursor-pointer font-semibold">Avoid ({s.avoid.length}): the patterns that need care in your current number</summary>
          <div className="mt-3 grid gap-2">
            {s.avoid.map(x => (
              <div key={x.id} className="item item-care">
                <div className="flex flex-wrap items-baseline gap-2"><h3 className="font-bold">{x.title}</h3><span className="text-xs text-muted-foreground">{x.pattern}</span></div>
                <p className="mt-1 text-[15px] leading-relaxed">{x.why}</p>
              </div>
            ))}
          </div>
        </details>
      )}
    </Section>
  );
}

function Compare({ s, eyebrow }) {
  return s.comparisons.map((c, i) => {
    const n = c.counts, L = c.lists;
    const list = (title, arr, cls, open) => arr.length > 0 && (
      <details open={open} className="rounded-lg border p-4">
        <summary className="cursor-pointer font-semibold">{title} ({arr.length})</summary>
        <div className="mt-3 grid gap-2">
          {arr.map(x => <div key={x.id} className={`item ${cls}`}><h3 className="font-bold">{x.title}</h3><p className="mt-1 text-[15px] leading-relaxed">{x.text}</p></div>)}
        </div>
      </details>
    );
    const fc = c.forConcern;
    return (
      <Section key={c.planned} id={`compare-${i}`} eyebrow={`${eyebrow}${s.comparisons.length > 1 ? ` · number ${i + 1}` : ''}`}
        title={`Your number vs ${fmt(c.planned)}`} intro={`What changes if you move from ${fmt(s.current)} to ${fmt(c.planned)}. Your birth-date yogas stay the same either way.`}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[['Problems that go away', n.problemsRemoved, 'item-good'], ['New problems it brings', n.problemsAdded, 'item-care'], ['Problems that stay', n.problemsStay, 'item-mixed'],
            ['Strengths gained', n.strengthsGained, 'item-good'], ['Strengths lost', n.strengthsLost, 'item-care'], ['Strengths kept', n.strengthsKept, 'item-neutral']].map(([t, v, cls]) => (
            <div key={t} className={`item ${cls}`}><p className="text-2xl font-bold tabular-nums">{v}</p><p className="text-sm">{t}</p></div>
          ))}
        </div>
        {fc && <p className="rounded-lg bg-primary-soft px-4 py-3 text-[15px]"><strong>For what you shared:</strong> {plural(fc.problemsRemoved.length, 'problem goes', 'problems go')} away, {plural(fc.problemsAdded.length, 'new problem', 'new problems')}, {plural(fc.strengthsGained.length, 'strength', 'strengths')} gained, {fc.strengthsLost.length} lost.</p>}
        {list('Problems that go away', L.problemsRemoved, 'item-good', true)}
        {list('New problems it brings', L.problemsAdded, 'item-care', true)}
        {list('Problems that stay', L.problemsStay, 'item-mixed', false)}
        {list('Strengths gained', L.strengthsGained, 'item-good', false)}
        {list('Strengths lost', L.strengthsLost, 'item-care', false)}
        {list('Strengths kept', L.strengthsKept, 'item-neutral', false)}
        {(L.professionsGained.length > 0 || L.professionsLost.length > 0) && (
          <p className="text-[15px] text-muted-foreground">Career links: gains {L.professionsGained.join(', ') || 'none'}; loses {L.professionsLost.join(', ') || 'none'}.</p>
        )}
      </Section>
    );
  });
}

function Cta({ s, href }) {
  return (
    <section id="r-cta-end" data-wa-cta className="rounded-lg border-2 border-primary/25 bg-primary-soft p-6 text-center animate-rise">
      <h2 className="text-2xl font-bold">Want to go deeper?</h2>
      <p className="mx-auto mt-2 max-w-md text-[15px] text-muted-foreground">Consult with us about your number, your remedies, or choosing a new number that suits your birth date.</p>
      {href
        ? <WaButton href={href} className="mt-5 px-6">Consult with us on WhatsApp</WaButton>
        : <p className="mt-4 text-sm font-semibold text-muted-foreground">WhatsApp contact coming soon.</p>}
      {s.healthNote && <p className="mt-4 text-sm text-muted-foreground">For any health concern mentioned in your reading, please also consult a doctor.</p>}
    </section>
  );
}

export default function Story({ result, config, onAgain }) {
  const { input, numbers, sections } = result;
  const by = id => sections.find(s => s.id === id);
  const owner = result.owner === true;
  const word = input.name.split(' ')[0];
  const first = word.charAt(0).toUpperCase() + word.slice(1);
  const rootRef = useRef(null);
  const href = whatsappLink(config, first, result.leadRef);

  const concern = by('concern');
  const ifKept = by('if-kept');
  const concernIds = useMemo(() => new Set(concern.items.map(i => i.id)), [concern]);
  const remedyFor = useMemo(() => Object.fromEntries(by('protection').yogaRemedies.map(r => [r.id, r.text])), [sections]);
  const carePoints = ifKept ? ifKept.items.length : 0;

  // The order of the reading: the visitor's own question first, then the detail.
  const chapters = useMemo(() => [
    { id: 'overview', label: 'At a glance' },
    concern.items.length > 3 && { id: 'concern', label: 'Your concern' },
    { id: 'decoded', label: 'Your number' },
    { id: 'mobile-grid', label: 'Number grid' },
    { id: 'dob-grid', label: 'Birth date' },
    by('career') && { id: 'career', label: 'Career' },
    { id: 'year-ahead', label: 'Year ahead' },
    by('name') && { id: 'name', label: 'Name' },
    ifKept && { id: 'if-kept', label: 'Needs care' },
    { id: 'protection', label: 'Remedies' },
    { id: 'better-number', label: 'New number' },
    by('compare') && { id: 'compare-0', label: 'Compare' }
  ].filter(Boolean), [sections]);
  const eyebrow = id => `Chapter ${chapters.findIndex(c => c.id === id)}`;

  return (
    <div ref={rootRef} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 pb-20 sm:pb-0">
      <div className="animate-rise">
        <p className="text-sm font-semibold uppercase tracking-[0.08em] text-primary-dark">Your free reading</p>
        <h2 className="mt-1 text-3xl font-bold leading-tight sm:text-4xl">{first}, here is what {fmt(input.mobile)} says</h2>
        <div className="mt-4 flex flex-wrap gap-2 text-sm font-semibold">
          <span className="rounded-full bg-muted px-3 py-1">Birth number {numbers.birth}</span>
          <span className="rounded-full bg-muted px-3 py-1">Destiny number {numbers.destiny}</span>
          <span className="rounded-full bg-accent-soft px-3 py-1">Personal year {numbers.personalYear}</span>
          {numbers.name && <span className="rounded-full bg-primary-soft px-3 py-1 text-primary-dark">Name number {numbers.name}</span>}
        </div>
        {owner && <p className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-dark">Owner view: each line shows the rule and source it came from, and every list is open.</p>}
      </div>

      <ChapterBar chapters={chapters} rootRef={rootRef} />

      <Overview by={by} href={href} carePoints={carePoints} />
      {concern.items.length > 3 && <Concern s={concern} owner={owner} eyebrow={eyebrow('concern')} />}
      {concern.items.length > 3 && <InlineCta href={href} title="Want guidance on this?" text="Ask us on WhatsApp. Your reading comes with you, so you won't need to explain it again." />}
      <Decoded s={by('decoded')} owner={owner} eyebrow={eyebrow('decoded')} concernIds={concernIds} />
      <MobileGrid s={by('mobile-grid')} owner={owner} eyebrow={eyebrow('mobile-grid')} concernIds={concernIds} remedyFor={remedyFor} />
      <DobGrid s={by('dob-grid')} dob={input.dob} owner={owner} eyebrow={eyebrow('dob-grid')} concernIds={concernIds} remedyFor={remedyFor} />
      {by('career') && <Career s={by('career')} owner={owner} eyebrow={eyebrow('career')} />}
      <YearAhead s={by('year-ahead')} nameNo={numbers.name} owner={owner} eyebrow={eyebrow('year-ahead')} />
      {by('name') && <NameNumber s={by('name')} eyebrow={eyebrow('name')} />}
      {ifKept && <IfKept s={ifKept} owner={owner} eyebrow={eyebrow('if-kept')} />}
      <Protection s={by('protection')} eyebrow={eyebrow('protection')} />
      <InlineCta href={href} title="Not sure which remedy to start with?" text="Ask us on WhatsApp and we'll guide you, based on your reading." />
      <BetterNumber s={by('better-number')} eyebrow={eyebrow('better-number')} />
      {by('compare') && <Compare s={by('compare')} eyebrow={eyebrow('compare-0')} />}
      <Cta s={by('cta')} href={href} />
      <button type="button" onClick={onAgain} className="justify-self-center rounded-full border px-5 py-2.5 text-sm font-semibold hover:border-primary">
        Check another number
      </button>
      <StickyWhatsApp href={href} />
    </div>
  );
}
