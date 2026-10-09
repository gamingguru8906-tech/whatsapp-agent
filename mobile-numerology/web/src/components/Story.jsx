import React, { useState } from 'react';
import VedicGrid from './VedicGrid.jsx';

// Every numerology sentence here comes from the reading the engine returns (rule wording approved by the owner).
// The page only adds headings, short "how this works" intros and layout.

const fmt = m => `${m.slice(0, 5)} ${m.slice(5)}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const CAT = { theme: 'The year', do: 'Do', avoid: 'Avoid', money: 'Money', career: 'Work', relationship: 'Love & marriage', health: 'Health', education: 'Study', travel: 'Travel', home: 'Home', colours: 'Colours', accessories: 'Wear', crystal: 'Crystal', remedy: 'Remedy', name: 'Your name', chart: 'Birth chart' };
const CAT_ORDER = Object.keys(CAT);
const AREA = { money: 'Money', career: 'Career', relationship: 'Love & marriage', family: 'Family', health: 'Health', mind: 'Peace of mind', education: 'Education', legal: 'Court & legal', government: 'Government', travel: 'Travel & abroad', home: 'Home', spiritual: 'Spiritual' };
const tone = p => ({ positive: 'item-good', negative: 'item-care', mixed: 'item-mixed' }[p] || 'item-neutral');

function Section({ id, eyebrow, title, intro, children }) {
  return (
    <section id={`r-${id}`} className="section animate-rise scroll-mt-20">
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
  const label = { good: 'Strength', care: 'Needs care', trait: 'Your nature' }[kind];
  const color = { good: 'text-success-dark', care: 'text-danger-dark', trait: 'text-muted-foreground' }[kind];
  return (
    <p className="text-[15px] leading-relaxed">
      <span className={`mr-1.5 text-[11px] font-bold uppercase tracking-wide ${color}`}>{label}</span>{children}
    </p>
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

function YogaItem({ y, owner }) {
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
        </div>
        <Source s={y.source} id={y.id} owner={owner} />
      </div>
    </div>
  );
}

function Decoded({ s, owner }) {
  return (
    <Section id="decoded" eyebrow="Chapter 1" title="Your number, decoded"
      intro="Every two neighbouring digits in your number form a pair, and each pair has a meaning. Zeros are skipped, so the digits on either side of a zero count as neighbours.">
      <div className="flex flex-wrap gap-1.5" aria-label={`Your number ${s.mobile}`}>
        {[...s.mobile].map((c, i) => (
          <span key={i} style={{ animationDelay: `${i * 45}ms` }}
            className={`digit animate-pop ${c === '0' ? 'bg-transparent text-faint line-through' : ''} ${i === 5 ? 'ml-2' : ''}`}>{c}</span>
        ))}
      </div>
      {s.pairs.map(p => <RuleItem key={p.id} x={p} owner={owner} />)}
    </Section>
  );
}

function MobileGrid({ s, owner }) {
  const [open, setOpen] = useState(false);
  return (
    <Section id="mobile-grid" eyebrow="Chapter 2" title="Your number's grid"
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
            {s.yogas.map(y => <YogaItem key={y.id} y={y} owner={owner} />)}</>
        : <p className="text-[15px] text-muted-foreground">No yogas form on your number's grid.</p>}
    </Section>
  );
}

function DobGrid({ s, dob, owner }) {
  return (
    <Section id="dob-grid" eyebrow="Chapter 3" title="Yogas you were born with"
      intro={`The digits of your birth date (${dob.split('-').reverse().join('/')}) on the same grid. These stay with you whichever number you use.`}>
      <div className="flex flex-wrap items-start gap-5">
        <VedicGrid size="lg" counts={s.counts} />
        <div className="grid min-w-0 flex-1 basis-64 gap-3">
          {s.yogas.length ? s.yogas.map(y => <YogaItem key={y.id} y={y} owner={owner} />) : <p className="text-[15px] text-muted-foreground">No yogas form on your birth-date grid.</p>}
        </div>
      </div>
    </Section>
  );
}

function Concern({ s, owner }) {
  return (
    <Section id="concern" eyebrow="Chapter 4" title="For what you shared" intro={`“${s.text}”`}>
      {s.areas.length
        ? <>
            <div className="flex flex-wrap gap-1.5">{s.areas.map(a => <span key={a} className="chip bg-primary-soft text-primary-dark">{AREA[a] || a}</span>)}</div>
            {s.items.length
              ? s.items.map(x => <RuleItem key={`${x.id}${x.fromDob ? 'd' : ''}`} x={x} owner={owner}
                  extra={x.fromDob ? <span className="chip bg-background/70 text-muted-foreground">from your birth date</span> : null}
                  title={x.kind === 'yoga' ? `${x.title} (${x.pattern})` : undefined} />)
              : <p className="text-[15px] text-muted-foreground">Nothing in your number or birth date speaks directly to this. Your full reading continues below.</p>}
          </>
        : <p className="text-[15px] text-muted-foreground">Thank you for sharing. Your full reading below covers every part of life your number touches.</p>}
    </Section>
  );
}

function Career({ s, owner }) {
  return (
    <Section id="career" eyebrow="Chapter 5" title="Your number & your career" intro="Certain combinations in a mobile number are linked with certain fields of work.">
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

function YearAhead({ s, nameNo, owner }) {
  const [tab, setTab] = useState(0);
  const y = s.years[tab];
  const groups = CAT_ORDER.map(c => [c, y.items.filter(i => i.cat === c)]).filter(([, l]) => l.length);
  return (
    <Section id="year-ahead" eyebrow="Chapter 6" title="Your year ahead"
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
                {i.appliesToName && <p className="mb-1 text-[11px] font-bold uppercase tracking-wide text-danger-dark">Applies to your name number</p>}
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

function NameNumber({ s }) {
  return (
    <Section id="name" eyebrow="Chapter 7" title="Your name number" intro="The letters of your name, added by the Chaldean method and reduced to one digit.">
      <div className="flex items-center gap-4">
        <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-primary text-2xl font-bold text-primary-foreground">{s.number}</span>
        <p className="text-[15px]">Your name adds up to {s.total}, which reduces to <strong>{s.number}</strong>. Look for “Your name” in your year ahead for what this means this year.</p>
      </div>
    </Section>
  );
}

function IfKept({ s }) {
  return (
    <Section id="if-kept" eyebrow="Chapter 8" title="If you keep this number"
      intro="These are the parts of your number that need care. Each one has a way forward in the next chapters.">
      {s.items.map(x => (
        <div key={x.id} className="item item-care">
          <div className="flex flex-wrap items-baseline gap-2">
            <h3 className="font-bold">{x.title}</h3>
            {x.forConcern && <span className="chip bg-primary text-primary-foreground">about what you shared</span>}
          </div>
          <p className="mt-1 text-[15px] leading-relaxed">{x.text}</p>
        </div>
      ))}
    </Section>
  );
}

function Protection({ s }) {
  const cards = [
    ['Phone screen saver', s.screenSaver.length ? s.screenSaver.join(' Or: ') : null],
    ['Bracelet', s.bracelet],
    ['Mani', s.mani]
  ].filter(([, v]) => v);
  return (
    <Section id="protection" eyebrow="Chapter 9" title="Your correction & protection"
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

function BetterNumber({ s }) {
  return (
    <Section id="better-number" eyebrow="Chapter 10" title="What to look for in a new number"
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

function Compare({ s }) {
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
      <Section key={c.planned} id={`compare-${i}`} eyebrow={`Chapter 11${s.comparisons.length > 1 ? ` · number ${i + 1}` : ''}`}
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

function Cta({ s, config, name, leadRef }) {
  const num = (config.whatsappNumber || '').replace(/\D/g, '');
  // "(Ref: WEB-NUMEROLOGY)" tags the lead's source in the WhatsApp bot's CRM (growth.js extractRef), which removes it from the text.
  // The Reading ID lets Kamala open this exact reading, even when they write from a different number.
  const id = /^NM-[0-9a-f]{8}$/.test(leadRef || '') ? ` Reading ID: ${leadRef}.` : '';
  const text = encodeURIComponent(`Hi, I'm ${name}. I just got my free mobile numerology reading and would like a consultation.${id} (Ref: WEB-NUMEROLOGY)`);
  return (
    <section className="rounded-lg border-2 border-primary/25 bg-primary-soft p-6 text-center animate-rise">
      <h2 className="text-2xl font-bold">Want to go deeper?</h2>
      <p className="mx-auto mt-2 max-w-md text-[15px] text-muted-foreground">Consult with us about your number, your remedies, or choosing a new number that suits your birth date.</p>
      {num
        ? <a href={`https://wa.me/${num}?text=${text}`} target="_blank" rel="noopener noreferrer"
            className="mt-5 inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-success px-6 text-base font-bold text-primary-foreground no-underline shadow-soft hover:bg-success-dark">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 20Z" /></svg>
            Consult with us on WhatsApp
          </a>
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
  const ifKept = by('if-kept');
  return (
    <div className="grid gap-5">
      <div className="animate-rise">
        <p className="text-sm font-semibold uppercase tracking-[0.08em] text-primary-dark">Your free reading</p>
        <h2 className="mt-1 text-3xl font-bold leading-tight sm:text-4xl">{first}, here is what {fmt(input.mobile)} says</h2>
        <div className="mt-4 flex flex-wrap gap-2 text-sm font-semibold">
          <span className="rounded-full bg-muted px-3 py-1">Birth number {numbers.birth}</span>
          <span className="rounded-full bg-muted px-3 py-1">Destiny number {numbers.destiny}</span>
          <span className="rounded-full bg-accent-soft px-3 py-1">Personal year {numbers.personalYear}</span>
          {numbers.name && <span className="rounded-full bg-primary-soft px-3 py-1 text-primary-dark">Name number {numbers.name}</span>}
        </div>
        {owner && <p className="mt-3 rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-dark">Owner view: each line shows the rule and source it came from.</p>}
      </div>
      <Decoded s={by('decoded')} owner={owner} />
      <MobileGrid s={by('mobile-grid')} owner={owner} />
      <DobGrid s={by('dob-grid')} dob={input.dob} owner={owner} />
      <Concern s={by('concern')} owner={owner} />
      {by('career') && <Career s={by('career')} owner={owner} />}
      <YearAhead s={by('year-ahead')} nameNo={numbers.name} owner={owner} />
      {by('name') && <NameNumber s={by('name')} />}
      {ifKept && <IfKept s={ifKept} />}
      <Protection s={by('protection')} />
      <BetterNumber s={by('better-number')} />
      {by('compare') && <Compare s={by('compare')} />}
      <Cta s={by('cta')} config={config} name={first} leadRef={result.leadRef} />
      <button type="button" onClick={onAgain} className="justify-self-center rounded-full border px-5 py-2.5 text-sm font-semibold hover:border-primary">
        Check another number
      </button>
    </div>
  );
}
