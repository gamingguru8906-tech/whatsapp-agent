import React from 'react';
import { CalendarClock, Grid2x2, Hash, PenLine } from 'lucide-react';
import VedicGrid from './VedicGrid.jsx';
import { Chapter, ShowMore, Source, CallRow } from './ui.jsx';

// The chapters both segments share, built from the brain's reading (section id "brain"): your numbers, your good and
// difficult months, your Lo Shu grid and your name. Every line is an approved rule's wording; sources show only to
// the owner.

const PLANET = { 1: 'Sun', 2: 'Moon', 3: 'Jupiter', 4: 'Rahu', 5: 'Mercury', 6: 'Venus', 7: 'Ketu', 8: 'Saturn', 9: 'Mars' };
const DOT = { good: 'dot-good', care: 'dot-care', mixed: 'dot-mixed' };

function Say({ x, owner }) {
  return (
    <div className="row flex gap-3">
      <span className={`dot ${DOT[x.polarity] || 'dot-neutral'}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="t-body">{x.say}</p>
        {owner && x.source && <Source s={{ file: x.source.book, ref: `p. ${x.source.pages.join(', ')}`, quote: x.source.quote }} id={x.id} owner />}
      </div>
    </div>
  );
}

function NumberHead({ n, title, sub }) {
  return (
    <div className="row flex items-center gap-4 py-4">
      <span className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-maroon-soft font-display text-[1.75rem] font-bold text-maroon">{n}</span>
      <div className="min-w-0">
        <h3 className="t-headline">{title}</h3>
        {sub && <p className="t-note mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

const many = (items, owner, noun) => <ShowMore items={items} owner={owner} noun={noun} initial={3} render={x => <Say key={x.id} x={x} owner={owner} />} />;

// ---------- Your numbers ----------
export function Numbers({ b, owner }) {
  const n = b.numbers;
  return (
    <Chapter id="numbers" icon={Hash} title="Your numbers" intro="From your date of birth and your name. Each number has its own planet and its own nature.">
      <div className="group-card rows">
        <NumberHead n={n.psychic.value} title={`Birth number ${n.psychic.value}`} sub={`${PLANET[n.psychic.value]}. From the day you were born; how you think and act.`} />
        {many(n.psychic.items, owner, 'points')}
      </div>
      <div className="group-card rows">
        <NumberHead n={n.destiny.value} title={`Destiny number ${n.destiny.value}`}
          sub={`${PLANET[n.destiny.value]}. From your full date of birth; the direction of your life.${n.pair.relation ? ` It is ${n.pair.relation} with your birth number.` : ''}`} />
        {many(n.destiny.items, owner, 'points')}
        {n.pair.items.map(x => <Say key={x.id} x={x} owner={owner} />)}
      </div>
      {n.master && (
        <div className="group-card rows">
          <NumberHead n={n.master.value} title={`Master number ${n.master.value}`} sub="Your month, day and year add up to a master number." />
          {many(n.master.items, owner, 'points')}
        </div>
      )}
      {n.karmic && (
        <div className="group-card rows">
          <NumberHead n={n.karmic.value} title={`Karmic number ${n.karmic.value}`} sub={`You were born on the ${n.karmic.value}th, a karmic number.`} />
          {many(n.karmic.items, owner, 'points')}
        </div>
      )}
      {(n.personality || n.maturity) && (
        <div className="group-card rows">
          {n.personality && <>
            <NumberHead n={n.personality.value} title={`Personality number ${n.personality.value}`} sub="From the consonants of your name; how others see you." />
            {n.personality.items.map(x => <Say key={x.id} x={x} owner={owner} />)}
          </>}
          {n.maturity && <>
            <NumberHead n={n.maturity.value} title={`Maturity number ${n.maturity.value}`} sub="Your destiny and name numbers together; who you grow into later in life." />
            {n.maturity.items.map(x => <Say key={x.id} x={x} owner={owner} />)}
          </>}
        </div>
      )}
    </Chapter>
  );
}

// ---------- Good and difficult months ----------
export function Timing({ b, owner }) {
  if (!b.timing.length) return null;
  const sorted = [...b.timing].sort((x, y) => (y.period.now - x.period.now) || (x.polarity === 'good' ? -1 : 1));
  return (
    <Chapter id="timing" icon={CalendarClock} title="Your good and difficult months" intro={`For birth number ${b.numbers.psychic.value}. These repeat every year.`}>
      <div className="group-card rows">
        {sorted.map(t => (
          <div key={t.id} className="row flex gap-3">
            <span className={`dot ${DOT[t.polarity] || 'dot-neutral'}`} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <h3 className="t-headline">{t.period.label}</h3>
                {t.period.now && <span className="chip bg-primary-soft text-primary-dark">now</span>}
              </div>
              <p className="t-body mt-1">{t.say}</p>
              {owner && t.source && <Source s={{ file: t.source.book, ref: `p. ${t.source.pages.join(', ')}`, quote: t.source.quote }} id={t.id} owner />}
            </div>
          </div>
        ))}
      </div>
    </Chapter>
  );
}

// ---------- Lo Shu grid ----------
export function LoShu({ b, owner, call }) {
  const l = b.loshu;
  const planesOff = l.planes.filter(p => p.state === 'missing');
  const planesFull = l.planes.filter(p => p.state === 'full');
  const items = [...l.items.planes, ...l.items.missing, ...l.items.repeats, ...l.items.present];
  return (
    <Chapter id="loshu" icon={Grid2x2} title="Your Lo Shu grid"
      intro="The digits of your date of birth on the Lo Shu grid. Its lines (planes) show what comes easily and what needs work.">
      <div className="group-card rows">
        <div className="row flex flex-wrap items-start gap-5 py-5">
          <VedicGrid size="lg" counts={l.counts} layout={l.layout} label="Your Lo Shu grid" />
          <div className="min-w-0 flex-1 basis-48">
            {l.missing.length > 0 && <p className="t-body"><strong className="font-semibold">Missing numbers:</strong> {l.missing.join(', ')}</p>}
            {l.repeats.length > 0 && <p className="t-body mt-1"><strong className="font-semibold">Repeated:</strong> {l.repeats.map(r => `${r.digit} (${r.times} times)`).join(', ')}</p>}
            {planesFull.length > 0 && <p className="t-body mt-1"><strong className="font-semibold">Complete planes:</strong> {planesFull.map(p => `${p.name} (${p.digits.join('-')})`).join(', ')}</p>}
            {planesOff.length > 0 && <p className="t-body mt-1"><strong className="font-semibold">Empty planes:</strong> {planesOff.map(p => `${p.name} (${p.digits.join('-')})`).join(', ')}</p>}
          </div>
        </div>
        {many(items, owner, 'points')}
        {l.missing.length > 0 && <CallRow href={call} text="Book a call: remedies for your missing numbers" />}
      </div>
    </Chapter>
  );
}

// ---------- Name ----------
export function NameChapter({ b, owner, call }) {
  const n = b.name;
  if (!n) return null;
  const fit = [n.withBirth && `${n.withBirth} with your birth number`, n.withDestiny && `${n.withDestiny} with your destiny number`].filter(Boolean).join(' and ');
  const needsWork = n.items.some(x => x.polarity === 'care') || [n.withBirth, n.withDestiny].includes('unfriendly');
  return (
    <Chapter id="name" icon={PenLine} title="Your name" intro="Each letter of your name has a number (Chaldean values). The full total carries the meaning; it reduces to one digit.">
      <div className="group-card rows">
        <NumberHead n={n.total} title={`Name total ${n.total}, which reduces to ${n.root}`} sub={fit ? `Your name number ${n.root} is ${fit}.` : null} />
        <div className="row flex flex-wrap gap-1.5">
          {n.parts.map((p, i) => <span key={i} className="chip bg-muted text-foreground"><strong className="font-semibold">{p.word}</strong>{p.total}</span>)}
        </div>
        {many(n.items, owner, 'points')}
        {n.firstLetterItems.map(x => <Say key={x.id} x={{ ...x, say: `Starting with ${n.firstLetter}: ${x.say}` }} owner={owner} />)}
        {needsWork && <CallRow href={call} text="Book a call: get your name spelling corrected" />}
      </div>
    </Chapter>
  );
}
