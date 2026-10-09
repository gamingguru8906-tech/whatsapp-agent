import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Sparkles, ArrowLeftRight, Briefcase, Cake, CalendarDays, ChevronDown, ChevronRight, Circle, Gem, Grid3x3, Hash, Leaf,
  MessageCircle, PenLine, Search, ShieldCheck, Smartphone
} from 'lucide-react';
import VedicGrid from './VedicGrid.jsx';
import { clarity } from '../../../engine/clarity.js';

// Every numerology sentence here comes from the reading the engine returns (rule wording approved by the owner).
// The page only adds headings, short "how this works" intros, navigation and layout.

const fmt = m => `${m.slice(0, 5)} ${m.slice(5)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const CAT = { theme: 'The year', do: 'Do', avoid: 'Avoid', money: 'Money', career: 'Work', relationship: 'Love and marriage', health: 'Health', education: 'Study', travel: 'Travel', home: 'Home', colours: 'Colours', accessories: 'Wear', crystal: 'Crystal', remedy: 'Remedy', name: 'Your name', chart: 'Birth chart' };
const CAT_ORDER = Object.keys(CAT);
const AREA = { money: 'Money', career: 'Career', relationship: 'Love and marriage', family: 'Family', health: 'Health', mind: 'Peace of mind', education: 'Education', legal: 'Court and legal', government: 'Government', travel: 'Travel and abroad', home: 'Home', spiritual: 'Spiritual' };
const dot = p => ({ positive: 'dot-good', negative: 'dot-care', mixed: 'dot-mixed' }[p] || 'dot-neutral');

// Points about what the visitor shared come first in every list.
const concernFirst = (items, ids) => [...items.filter(x => ids.has(x.id)), ...items.filter(x => !ids.has(x.id))];

function jump(id) {
  document.getElementById(`r-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// A chapter: icon and title above, content in grouped cards below (iOS inset grouped style).
function Chapter({ id, icon: Icon, title, intro, children }) {
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

function Source({ s, id, owner }) {
  if (!owner || !s) return null;
  return <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">{id} · {s.file}{s.ref ? ` ${s.ref}` : ''}: “{s.quote}”</p>;
}

function Line({ kind, children }) {
  const label = { good: 'Strength', care: 'Needs care', trait: 'Your nature', remedy: 'Remedy' }[kind];
  const color = { good: 'text-success-dark', care: 'text-care-dark', trait: 'text-muted-foreground', remedy: 'text-primary-dark' }[kind];
  return <p className="t-body"><span className={`mr-1.5 font-semibold ${color}`}>{label}</span>{children}</p>;
}

// Shows the first few rows; the rest open with one tap. The owner sees everything, to check each line.
function ShowMore({ items, initial = 3, owner, noun, render }) {
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

function RuleRow({ x, owner, title, extra }) {
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

function YogaRow({ y, owner, remedy }) {
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
  return <a href={href} target="_blank" rel="noopener noreferrer" className={`btn-whatsapp ${className}`}><WaIcon />{children}</a>;
}

function InlineCta({ href, title, text }) {
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

// ---------- Your answer (first thing they see) ----------
// One plain verdict and three next steps, built by engine/clarity.js from the reading. The strongest colour on the
// page is the one action that helps them most: the WhatsApp button.

function Answer({ a, href, onCompare }) {
  const total = Math.max(1, a.strengths + a.carePoints);
  const wa = a.change ? 'Get my number chosen' : 'Ask us on WhatsApp';
  // Keep pair names like 5-6 together on one line.
  const nb = t => t.replace(/(\d)-(\d)/g, '$1\u2011$2');
  return (
    <section id="r-answer" className="group-card scroll-mt-32 shadow-soft">
      <div className="border-t-[3px] border-t-primary px-5 pb-5 pt-6 sm:px-7 sm:pt-7">
        <h2 className="font-display text-[1.75rem] font-bold leading-[1.12] tracking-[-0.015em] text-maroon sm:text-[2.125rem]">{a.headline}</h2>
        <p className="mt-3 text-[17px] leading-[1.5] text-muted-foreground">{a.why}</p>
        <div className="mt-5">
          <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${a.strengths} strengths and ${a.carePoints} points that need care in your number`}>
            <span className="bg-success" style={{ width: `${(a.strengths / total) * 100}%` }} />
            <span className="bg-care" style={{ width: `${(a.carePoints / total) * 100}%` }} />
          </div>
          <p className="mt-2 flex gap-4 text-[14px] text-muted-foreground">
            <span><span className="dot dot-good mr-1.5 mt-0 align-middle" aria-hidden="true" />{plural(a.strengths, 'strength', 'strengths')}</span>
            <span><span className="dot dot-care mr-1.5 mt-0 align-middle" aria-hidden="true" />{a.carePoints} {a.carePoints === 1 ? 'needs' : 'need'} care</span>
          </p>
        </div>
      </div>

      <div className="border-t border-border/70 px-5 py-5 sm:px-7">
        <h3 className="text-[15px] font-semibold text-maroon">What to do next</h3>
        <ol className="mt-3 grid gap-4">
          {a.steps.map((st, i) => (
            <li key={st.id} className="flex gap-3.5">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border-[1.5px] border-maroon/40 text-[14px] font-semibold text-maroon">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="t-headline">{st.title}</p>
                <p className="t-body mt-0.5 text-foreground/80">{nb(st.text)}</p>
                {st.jump && (
                  <button type="button" onClick={() => jump(st.jump)} className="mt-1 text-[15px] font-medium text-primary-dark">See your protection</button>
                )}
                {st.action === 'compare' && (
                  <button type="button" onClick={onCompare} className="btn-plain mt-3 min-h-[44px] w-full whitespace-normal bg-card text-center text-[16px] leading-tight shadow-[0_0_0_1px_hsl(var(--border))] sm:w-auto">
                    Check a new number
                  </button>
                )}
                {st.action === 'whatsapp' && href && (
                  <div data-wa-cta><WaButton href={href} className="mt-3 w-full whitespace-normal text-center leading-tight sm:w-auto">{wa}</WaButton></div>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ---------- Why: the points behind the answer ----------

function Why({ by, mobile, area }) {
  const concern = by('concern');
  const top = concern.items.slice(0, 3);
  const more = concern.items.length > 3;
  return (
    <Chapter id="why" icon={Sparkles} title="Why this answer" intro={`The parts of your reading that touch ${area}.`}>
      <div className="group-card rows">
        <div className="row flex flex-wrap items-center gap-5 py-5">
          <VedicGrid size="lg" counts={by('mobile-grid').counts} lightOrder={[...mobile].map(Number).filter(Boolean)} />
          <div className="min-w-0 flex-1 basis-40">
            <p className="t-headline">“{concern.text}”</p>
            {concern.areas.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{concern.areas.map(a => <span key={a} className="chip bg-muted text-foreground">{AREA[a] || a}</span>)}</div>}
            {!concern.areas.length && <p className="mt-1 text-[15px] text-muted-foreground">No rule speaks to this directly, so your answer looks at your whole number.</p>}
            {concern.areas.length > 0 && !top.length && <p className="mt-1 text-[15px] text-muted-foreground">Nothing in your number or birth date speaks directly to this, so your answer looks at your whole number.</p>}
          </div>
        </div>
        {top.map(x => (
          <div key={`${x.id}${x.fromDob ? 'd' : ''}`} className="row flex gap-3">
            <span className={`dot ${dot(x.polarity)}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h3 className="t-headline">{x.kind === 'yoga' ? `${x.title} (${x.pattern})` : x.title}</h3>
                {x.fromDob && <span className="chip bg-muted text-muted-foreground">from your birth date</span>}
              </div>
              <div className="mt-1 grid gap-1">
                {x.care && <Line kind="care">{x.care}</Line>}
                {x.good && <Line kind="good">{x.good}</Line>}
              </div>
            </div>
          </div>
        ))}
        {more && (
          <button type="button" onClick={() => jump('concern')} className="row flex w-full items-center justify-between text-left text-[17px] font-medium text-primary-dark">
            {plural(concern.items.length - 3, 'more point', 'more points')} about this
            <ChevronRight size={20} aria-hidden="true" />
          </button>
        )}
      </div>
    </Chapter>
  );
}

// ---------- Chapter bar ----------

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
    <nav aria-label="Chapters of your reading" style={{ top }} className="material sticky z-10 -mx-5 min-w-0 border-b border-border/60 sm:mx-0 sm:rounded-[16px] sm:border">
      <div ref={navRef} className="no-scrollbar flex gap-1 overflow-x-auto px-3 py-2">
        {chapters.map(c => (
          <button key={c.id} data-id={c.id} type="button" onClick={() => jump(c.id)} aria-current={active === c.id ? 'true' : undefined}
            className={`min-h-[36px] shrink-0 rounded-full px-3.5 text-[15px] font-medium transition-colors ${active === c.id ? 'bg-maroon text-white' : 'text-muted-foreground hover:bg-primary-soft hover:text-maroon'}`}>
            {c.label}
          </button>
        ))}
      </div>
      <div className="h-[2px] bg-transparent" aria-hidden="true">
        <div className="h-full bg-primary transition-[width] duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
      </div>
    </nav>
  );
}

// ---------- Floating WhatsApp button on phones ----------

function StickyWhatsApp({ href }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const onScroll = () => {
      const answer = document.getElementById('r-answer');
      const past = answer ? answer.getBoundingClientRect().bottom < 0 : false;
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
      className={`btn-whatsapp fixed right-4 z-30 rounded-full shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition-all duration-200 sm:hidden ${show ? 'translate-y-0 opacity-100' : 'pointer-events-none translate-y-3 opacity-0'}`}>
      <WaIcon />Ask us on WhatsApp
    </a>
  );
}

// ---------- Chapters ----------

// The first 3 points about their concern are in "At a glance"; this chapter holds the rest (none = no chapter).
function Concern({ s, owner }) {
  return (
    <Chapter id="concern" icon={MessageCircle} title="More about what you shared" intro={`“${s.text}”`}>
      <div className="group-card rows">
        <ShowMore items={s.items.slice(3)} initial={4} owner={owner} noun="points" render={x => (
          <RuleRow key={`${x.id}${x.fromDob ? 'd' : ''}`} x={x} owner={owner}
            extra={x.fromDob ? <span className="chip bg-muted text-muted-foreground">from your birth date</span> : null}
            title={x.kind === 'yoga' ? `${x.title} (${x.pattern})` : undefined} />)} />
      </div>
    </Chapter>
  );
}

function Decoded({ s, owner, concernIds }) {
  return (
    <Chapter id="decoded" icon={Hash} title="Your number, decoded"
      intro="Every two neighbouring digits form a pair, and each pair has a meaning. Zeros are skipped, so the digits on either side of a zero count as neighbours.">
      <div className="group-card rows">
        <div className="row flex flex-wrap gap-1.5 py-4" aria-label={`Your number ${s.mobile}`}>
          {[...s.mobile].map((c, i) => (
            <span key={i} className={`digit ${c === '0' ? 'text-faint line-through shadow-none' : ''} ${i === 5 ? 'ml-2' : ''}`}>{c}</span>
          ))}
        </div>
        <ShowMore items={concernFirst(s.pairs, concernIds)} owner={owner} noun="pairs" render={p => <RuleRow key={p.id} x={p} owner={owner} />} />
      </div>
    </Chapter>
  );
}

function MobileGrid({ s, owner, concernIds, remedyFor }) {
  const [open, setOpen] = useState(false);
  return (
    <Chapter id="mobile-grid" icon={Grid3x3} title="Your number's grid" intro="Your digits are placed on the Vedic grid. Where they line up, they form yogas.">
      <div className="group-card rows">
        <div className="row flex flex-wrap items-start gap-5 py-5">
          <VedicGrid size="lg" counts={s.counts} />
          <div className="min-w-0 flex-1 basis-52">
            <p className="t-headline">Planets in your number</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {s.planets.map(p => <span key={p.id} className="chip bg-muted text-foreground"><strong className="font-semibold">{p.digit}</strong>{p.planet}</span>)}
            </div>
          </div>
        </div>
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
          className="row flex w-full items-center justify-between text-left text-[17px] font-medium text-primary-dark">
          {open ? 'Hide what each digit means' : 'What each digit means'}
          <ChevronDown size={20} className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
        {open && s.planets.map(p => (
          <div key={p.id} className="row">
            <h3 className="t-headline">{p.digit}, {p.planet}{p.count > 1 ? ` (×${p.count})` : ''}</h3>
            <p className="t-body mt-1">{p.trait}</p>
            <p className="mt-1 text-[15px] text-muted-foreground">Signifies: {p.signifies}</p>
            <Source s={p.source} id={p.id} owner={owner} />
          </div>
        ))}
      </div>
      {s.yogas.length
        ? <div className="group-card rows">
            <p className="row t-note">{s.yogas.length} {s.yogas.length === 1 ? 'yoga forms' : 'yogas form'} on your number's grid</p>
            <ShowMore items={concernFirst(s.yogas, concernIds)} owner={owner} noun="yogas"
              render={y => <YogaRow key={y.id} y={y} owner={owner} remedy={remedyFor[y.id]} />} />
          </div>
        : <p className="px-1 text-[15px] text-muted-foreground">No yogas form on your number's grid.</p>}
    </Chapter>
  );
}

function DobGrid({ s, dob, owner, concernIds, remedyFor }) {
  return (
    <Chapter id="dob-grid" icon={Cake} title="Yogas you were born with"
      intro={`The digits of your birth date (${dob.split('-').reverse().join('/')}) on the same grid. These stay with you whichever number you use.`}>
      <div className="group-card rows">
        <div className="row py-5"><VedicGrid size="lg" counts={s.counts} /></div>
        {s.yogas.length
          ? <ShowMore items={concernFirst(s.yogas, concernIds)} owner={owner} noun="yogas"
              render={y => <YogaRow key={y.id} y={y} owner={owner} remedy={remedyFor[y.id]} />} />
          : <p className="row text-[15px] text-muted-foreground">No yogas form on your birth-date grid.</p>}
      </div>
    </Chapter>
  );
}

function Career({ s, owner }) {
  return (
    <Chapter id="career" icon={Briefcase} title="Your number and your career" intro="Certain combinations in a mobile number are linked with certain fields of work.">
      <div className="group-card rows">
        {s.professions.map(p => (
          <div key={p.id} className="row flex gap-3">
            <span className="dot dot-good" aria-hidden="true" />
            <div>
              <h3 className="t-headline">{p.title}</h3>
              <p className="text-[15px] text-muted-foreground">Your number carries {p.codes.map(c => c.replace('+', ' and ')).join(', ')}</p>
              <Source s={p.source} id={p.id} owner={owner} />
            </div>
          </div>
        ))}
      </div>
    </Chapter>
  );
}

function YearAhead({ s, nameNo, owner }) {
  const [tab, setTab] = useState(0);
  const y = s.years[tab];
  const groups = CAT_ORDER.map(c => [c, y.items.filter(i => i.cat === c)]).filter(([, l]) => l.length);
  return (
    <Chapter id="year-ahead" icon={CalendarDays} title="Your year ahead"
      intro="Your personal year comes from your birth day, birth month and the year. Each year number brings its own guidance.">
      <div className="inline-flex self-start rounded-[10px] bg-border/50 p-[3px]" role="tablist" aria-label="Year">
        {s.years.map((yy, i) => (
          <button key={yy.year} role="tab" aria-selected={tab === i} type="button" onClick={() => setTab(i)}
            className={`min-h-[32px] rounded-[8px] px-5 text-[15px] font-semibold transition ${tab === i ? 'bg-card text-maroon shadow-[0_3px_8px_rgba(0,0,0,0.12),0_3px_1px_rgba(0,0,0,0.04)]' : 'text-muted-foreground'}`}>
            {yy.year}
          </button>
        ))}
      </div>
      <div className="group-card row flex items-center gap-4 py-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-maroon-soft font-display text-[1.75rem] font-bold text-maroon">{y.number}</span>
        <p className="t-body"><strong className="font-semibold text-maroon">{y.year} is personal year {y.number} for you.</strong>{nameNo ? <span className="text-muted-foreground"> Your name number is {nameNo}.</span> : null}</p>
      </div>
      {groups.map(([c, list]) => (
        <div key={c}>
          <h3 className="mb-1.5 px-1 text-[13px] font-medium text-muted-foreground">{CAT[c]}</h3>
          <div className="group-card rows">
            {list.map(i => (
              <div key={i.id} className="row">
                {i.appliesToName && <p className="mb-1 text-[13px] font-semibold text-care-dark">Applies to your name number</p>}
                <p className="t-body">{i.text}</p>
                <Source s={i.source} id={i.id} owner={owner} />
              </div>
            ))}
          </div>
        </div>
      ))}
      {s.forEveryone.length > 0 && (
        <details className="group-card">
          <summary className="row flex cursor-pointer list-none items-center justify-between text-[17px] font-medium text-primary-dark">
            For every year <ChevronDown size={20} aria-hidden="true" />
          </summary>
          <ul className="grid list-disc gap-1.5 px-9 pb-4 text-[16px]">{s.forEveryone.map(i => <li key={i.id}>{i.text}</li>)}</ul>
        </details>
      )}
    </Chapter>
  );
}

function NameNumber({ s }) {
  return (
    <Chapter id="name" icon={PenLine} title="Your name number" intro="The letters of your name, added by the Chaldean method and reduced to one digit.">
      <div className="group-card row flex items-center gap-4 py-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-maroon-soft font-display text-[1.75rem] font-bold text-maroon">{s.number}</span>
        <p className="t-body">Your name adds up to {s.total}, which reduces to <strong className="font-semibold">{s.number}</strong>. Look for “Your name” in your year ahead for what this means this year.</p>
      </div>
    </Chapter>
  );
}

function IfKept({ s, owner }) {
  const items = [...s.items.filter(x => x.forConcern), ...s.items.filter(x => !x.forConcern)];
  return (
    <Chapter id="if-kept" icon={Leaf} title="If you keep this number"
      intro="These are the parts of your number that need care. Each one has a way forward in your protection, below.">
      <div className="group-card rows">
        <ShowMore items={items} owner={owner} noun="points" render={x => (
          <div key={x.id} className="row flex gap-3">
            <span className="dot dot-care" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <h3 className="t-headline">{x.title}</h3>
                {x.forConcern && <span className="chip bg-primary-soft text-primary-dark">about what you shared</span>}
              </div>
              <p className="t-body mt-1">{x.text}</p>
            </div>
          </div>
        )} />
        <button type="button" onClick={() => jump('protection')} className="row flex w-full items-center justify-between text-left text-[17px] font-medium text-primary-dark">
          See your protection <ChevronRight size={20} aria-hidden="true" />
        </button>
      </div>
    </Chapter>
  );
}

function Protection({ s }) {
  const rows = [
    [Smartphone, 'Phone screen saver', s.screenSaver.length ? s.screenSaver.join(' Or: ') : null],
    [Circle, 'Bracelet', s.bracelet],
    [Gem, 'Mani', s.mani]
  ].filter(([, , v]) => v);
  return (
    <Chapter id="protection" icon={ShieldCheck} title="Your correction and protection" intro={`For your birth number ${s.birthNumber}, these are the remedies for your mobile number.`}>
      <div className="group-card rows">
        {rows.map(([Icon, t, v]) => (
          <div key={t} className="row flex gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[10px] bg-muted text-maroon"><Icon size={18} aria-hidden="true" /></span>
            <div className="min-w-0">
              <h3 className="t-headline">{t}</h3>
              <p className="t-body mt-0.5">{v}</p>
            </div>
          </div>
        ))}
        {s.yogaRemedies.map(r => (
          <div key={r.id} className="row">
            <h3 className="t-headline">For {r.title}</h3>
            <p className="t-body mt-0.5">{r.text}</p>
          </div>
        ))}
      </div>
    </Chapter>
  );
}

function BetterNumber({ s }) {
  return (
    <Chapter id="better-number" icon={Search} title="What to look for in a new number"
      intro="If you choose a new number, these patterns are worth checking. To test a specific number, tap “Check another number” and turn on “Compare a number before you buy it”.">
      {s.lookFor.length > 0 && (
        <div className="group-card rows">
          {s.lookFor.map(x => (
            <div key={x.id} className="row flex gap-3">
              <span className="dot dot-good" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h3 className="t-headline">{x.title}</h3>
                  {x.have && <span className="chip bg-success-soft text-success-dark">your number has this</span>}
                </div>
                <p className="t-note">{x.pattern}</p>
                <p className="t-body mt-1">{x.why}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      {s.avoid.length > 0 && (
        <details className="group-card">
          <summary className="row flex cursor-pointer list-none items-center justify-between gap-3 text-[17px] font-medium text-primary-dark">
            Avoid: {plural(s.avoid.length, 'pattern', 'patterns')} that need care in your current number <ChevronDown size={20} className="shrink-0" aria-hidden="true" />
          </summary>
          <div className="rows">
            {s.avoid.map(x => (
              <div key={x.id} className="row flex gap-3">
                <span className="dot dot-care" aria-hidden="true" />
                <div><h3 className="t-headline">{x.title}</h3><p className="t-note">{x.pattern}</p><p className="t-body mt-1">{x.why}</p></div>
              </div>
            ))}
          </div>
        </details>
      )}
    </Chapter>
  );
}

function Compare({ s }) {
  return s.comparisons.map((c, i) => {
    const n = c.counts, L = c.lists;
    const list = (title, arr, d, open) => arr.length > 0 && (
      <details open={open} className="group-card">
        <summary className="row flex cursor-pointer list-none items-center justify-between text-[17px] font-medium">
          <span>{title} <span className="text-muted-foreground">({arr.length})</span></span><ChevronDown size={20} className="text-faint" aria-hidden="true" />
        </summary>
        <div className="rows">
          {arr.map(x => <div key={x.id} className="row flex gap-3"><span className={`dot ${d}`} aria-hidden="true" /><div><h3 className="t-headline">{x.title}</h3><p className="t-body mt-0.5">{x.text}</p></div></div>)}
        </div>
      </details>
    );
    const fc = c.forConcern;
    return (
      <Chapter key={c.planned} id={`compare-${i}`} icon={ArrowLeftRight} title={`Your number vs ${fmt(c.planned)}`}
        intro={`What changes if you move from ${fmt(s.current)} to ${fmt(c.planned)}. Your birth-date yogas stay the same either way.`}>
        <div className="group-card grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-3">
          {[['Problems that go away', n.problemsRemoved, 'text-success-dark'], ['New problems it brings', n.problemsAdded, 'text-care-dark'], ['Problems that stay', n.problemsStay, 'text-foreground'],
            ['Strengths gained', n.strengthsGained, 'text-success-dark'], ['Strengths lost', n.strengthsLost, 'text-care-dark'], ['Strengths kept', n.strengthsKept, 'text-foreground']].map(([t, v, cls]) => (
            <div key={t} className="bg-card px-4 py-4">
              <p className={`font-display text-[2rem] font-bold leading-none tabular-nums ${cls}`}>{v}</p>
              <p className="mt-1 text-[15px] leading-snug">{t}</p>
            </div>
          ))}
        </div>
        {fc && <p className="group-card row t-body"><strong className="font-semibold">For what you shared:</strong> {plural(fc.problemsRemoved.length, 'problem goes', 'problems go')} away, {plural(fc.problemsAdded.length, 'new problem', 'new problems')}, {plural(fc.strengthsGained.length, 'strength', 'strengths')} gained, {fc.strengthsLost.length} lost.</p>}
        {list('Problems that go away', L.problemsRemoved, 'dot-good', true)}
        {list('New problems it brings', L.problemsAdded, 'dot-care', true)}
        {list('Problems that stay', L.problemsStay, 'dot-care', false)}
        {list('Strengths gained', L.strengthsGained, 'dot-good', false)}
        {list('Strengths lost', L.strengthsLost, 'dot-care', false)}
        {list('Strengths kept', L.strengthsKept, 'dot-good', false)}
        {(L.professionsGained.length > 0 || L.professionsLost.length > 0) && (
          <p className="px-1 text-[15px] text-muted-foreground">Career links: gains {L.professionsGained.join(', ') || 'none'}; loses {L.professionsLost.join(', ') || 'none'}.</p>
        )}
      </Chapter>
    );
  });
}

function Cta({ s, href }) {
  return (
    <section id="r-cta-end" data-wa-cta className="group-card px-6 py-9 text-center shadow-soft">
      <h2 className="t-title">Want to go deeper?</h2>
      <p className="mx-auto mt-2 max-w-md text-[17px] text-muted-foreground">Consult with us about your number, your remedies, or choosing a new number that suits your birth date.</p>
      {href
        ? <WaButton href={href} className="mt-6">Consult with us on WhatsApp</WaButton>
        : <p className="mt-5 text-[15px] font-semibold text-muted-foreground">WhatsApp contact coming soon.</p>}
      {s.healthNote && <p className="t-note mt-5">For any health concern mentioned in your reading, please also consult a doctor.</p>}
    </section>
  );
}

export default function Story({ result, config, onAgain }) {
  const { input, sections } = result;
  const by = id => sections.find(s => s.id === id);
  const owner = result.owner === true;
  const word = input.name.split(' ')[0];
  const first = word.charAt(0).toUpperCase() + word.slice(1);
  const rootRef = useRef(null);
  const href = whatsappLink(config, first, result.leadRef);
  const answer = useMemo(() => clarity(result), [result]);

  const concern = by('concern');
  const ifKept = by('if-kept');
  const concernIds = useMemo(() => new Set(concern.items.map(i => i.id)), [concern]);
  const remedyFor = useMemo(() => Object.fromEntries(by('protection').yogaRemedies.map(r => [r.id, r.text])), [sections]);
  const more = concern.items.length > 3;
  // "Check a number before you buy it": the form keeps their details; it opens the compare switch for them.
  const compare = () => window.dispatchEvent(new CustomEvent('nm:compare'));

  // The order of the reading: the answer first, then why, then the detail.
  const chapters = useMemo(() => [
    { id: 'answer', label: 'Your answer' },
    { id: 'why', label: 'Why' },
    more && { id: 'concern', label: 'Your concern' },
    { id: 'decoded', label: 'Your number' },
    { id: 'mobile-grid', label: 'Number grid' },
    { id: 'dob-grid', label: 'Birth date' },
    by('career') && { id: 'career', label: 'Career' },
    { id: 'year-ahead', label: 'Year ahead' },
    by('name') && { id: 'name', label: 'Name' },
    ifKept && { id: 'if-kept', label: 'Needs care' },
    { id: 'protection', label: 'Protection' },
    { id: 'better-number', label: 'New number' },
    by('compare') && { id: 'compare-0', label: 'Compare' }
  ].filter(Boolean), [sections]);

  return (
    <div ref={rootRef} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-8 pb-20 sm:pb-0">
      <div>
        <p className="text-[15px] font-medium text-muted-foreground">Your free reading for {fmt(input.mobile)}</p>
        <h2 className="t-title mt-1">{first}, here's your answer</h2>
        {owner && <p className="mt-3 rounded-[12px] bg-accent-soft px-4 py-2.5 text-[14px] text-warning-dark">Owner view: each line shows the rule and source it came from, and every list is open.</p>}
      </div>

      <Answer a={answer} href={href} onCompare={compare} />
      <ChapterBar chapters={chapters} rootRef={rootRef} />
      <Why by={by} mobile={input.mobile} area={answer.area} />
      {more && <Concern s={concern} owner={owner} />}
      <Decoded s={by('decoded')} owner={owner} concernIds={concernIds} />
      <MobileGrid s={by('mobile-grid')} owner={owner} concernIds={concernIds} remedyFor={remedyFor} />
      <DobGrid s={by('dob-grid')} dob={input.dob} owner={owner} concernIds={concernIds} remedyFor={remedyFor} />
      {by('career') && <Career s={by('career')} owner={owner} />}
      <YearAhead s={by('year-ahead')} nameNo={result.numbers.name} owner={owner} />
      {by('name') && <NameNumber s={by('name')} />}
      {ifKept && <IfKept s={ifKept} owner={owner} />}
      <Protection s={by('protection')} />
      <InlineCta href={href} title="Not sure which remedy to start with?" text="Ask us on WhatsApp and we'll guide you, based on your reading." />
      <BetterNumber s={by('better-number')} />
      {by('compare') && <Compare s={by('compare')} />}
      <Cta s={by('cta')} href={href} />
      <button type="button" onClick={onAgain} className="btn-plain justify-self-center bg-card px-6 shadow-[0_0_0_1px_hsl(var(--border))]">
        Check another number
      </button>
      <StickyWhatsApp href={href} />
    </div>
  );
}
