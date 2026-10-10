import React, { useMemo, useRef } from 'react';
import { CalendarCheck, Circle, Sparkles, Watch as WatchIcon } from 'lucide-react';
import { Chapter, Source, WaButton, callLink, CallRow, plural } from './ui.jsx';
import { Numbers, Timing, LoShu, NameChapter } from './BrainChapters.jsx';

// The Wristwatch Numerology reading: the answer first, then what the watch says, the right watch for the year,
// and the same numbers, Lo Shu and name chapters as the mobile segment.

const DOT = { good: 'dot-good', care: 'dot-care', mixed: 'dot-mixed' };
const MATCH = {
  full: { word: 'matches', tone: 'text-success-dark' },
  partly: { word: 'partly matches', tone: 'text-care-dark' },
  different: { word: 'is different from', tone: 'text-care-dark' },
  unknown: { word: 'could not be compared with', tone: 'text-muted-foreground' }
};

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

function headline(a) {
  const y = a.thisYear;
  if (y?.match === 'full') return `Your watch suits your year ${y.year}.`;
  if (y?.match === 'partly') return `Your watch partly suits your year ${y.year}.`;
  if (y?.match === 'different') return `Your watch is not the one for your year ${y.year}.`;
  return 'Here is what your watch says about you.';
}

function Answer({ a, href, bracelet }) {
  const total = Math.max(1, a.strengths + a.care);
  const y = a.thisYear;
  const steps = [];
  if (y && y.match !== 'full') steps.push({ title: `Wear the watch for ${y.year}`, text: `For your personal year ${y.personalYear}: ${y.text.split('. ')[0].replace(/\.$/, '')}.` });
  if (bracelet) steps.push({ title: 'Wear your bracelet', text: `For birth number ${bracelet.birthNumber}: the ${bracelet.bracelet.name}.`, link: bracelet.bracelet });
  steps.push({ title: 'Talk to us about your watch', text: 'In a consultation, we read your watch with your numbers and choose the right one for you. Your reading comes with you on WhatsApp.', wa: true });
  return (
    <section id="r-answer" className="group-card scroll-mt-32 shadow-soft">
      <div className="border-t-[3px] border-t-primary px-5 pb-5 pt-6 sm:px-7 sm:pt-7">
        <h2 className="font-display text-[1.75rem] font-bold leading-[1.12] tracking-[-0.015em] text-maroon sm:text-[2.125rem]">{headline(a)}</h2>
        <p className="mt-3 text-[17px] leading-[1.5] text-muted-foreground">
          {a.total > 0 ? `${plural(a.total, 'part of your watch says', 'parts of your watch say')} something about you: ${a.strengths} ${a.strengths === 1 ? 'is a strength' : 'are strengths'}${a.mixed ? `, ${a.care} ${a.care === 1 ? 'needs' : 'need'} care and ${a.mixed} ${a.mixed === 1 ? 'is' : 'are'} both` : ` and ${a.care} ${a.care === 1 ? 'needs' : 'need'} care`}.` : 'Add more watch details for a fuller reading.'}
          {y && y.match !== 'unknown' && ` The watch named for your personal year ${y.personalYear} is: ${y.text.split('. ')[0].replace(/\.$/, '').toLowerCase()}.`}
        </p>
        {a.total > 0 && (
          <div className="mt-5">
            <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${a.strengths} strengths and ${a.care} points that need care`}>
              <span className="bg-success" style={{ width: `${(a.strengths / total) * 100}%` }} />
              <span className="bg-care" style={{ width: `${(a.care / total) * 100}%` }} />
            </div>
            <p className="mt-2 flex gap-4 font-display text-[14px] text-muted-foreground">
              <span><span className="dot dot-good mr-1.5 mt-0 align-middle" aria-hidden="true" />{plural(a.strengths, 'strength', 'strengths')}</span>
              <span><span className="dot dot-care mr-1.5 mt-0 align-middle" aria-hidden="true" />{a.care} {a.care === 1 ? 'needs' : 'need'} care</span>
            </p>
          </div>
        )}
      </div>
      <div className="border-t border-border/70 px-5 py-5 sm:px-7">
        <h3 className="text-[15px] font-semibold text-maroon">What to do next</h3>
        <ol className="mt-3 grid gap-4">
          {steps.map((st, i) => (
            <li key={st.title} className="flex gap-3.5">
              <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border-[1.5px] border-maroon/40 font-display text-[14px] font-semibold text-maroon">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="t-headline">{st.title}</p>
                <p className="t-body mt-0.5 text-foreground/80">{st.text}</p>
                {st.link && <a href={st.link.url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block font-display text-[15px] font-semibold text-primary-dark">₹{st.link.price.toLocaleString('en-IN')} in our shop ›</a>}
                {st.wa && href && <div data-wa-cta><WaButton href={href} className="mt-3 w-full whitespace-normal text-center leading-tight sm:w-auto">Book a call about my watch</WaButton></div>}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function WatchSays({ w, owner, call }) {
  return (
    <Chapter id="watch" icon={WatchIcon} title="What your watch says" intro="Each detail of your watch is read on its own; together they describe how you think, act and relate.">
      {w.groups.map(g => (
        <div key={g.key} className="group-card rows">
          <div className="row flex items-baseline justify-between gap-3">
            <h3 className="t-headline">{g.label.replace(/\?$/, '')}</h3>
            <span className="chip bg-muted text-foreground">{g.valueLabel}</span>
          </div>
          {g.items.map(x => <Say key={x.id} x={x} owner={owner} />)}
        </div>
      ))}
      {w.therapy.length > 0 && (
        <div className="group-card rows">
          <div className="row"><h3 className="t-headline">For what you want to improve</h3></div>
          {w.therapy.map(x => <Say key={x.id} x={x} owner={owner} />)}
          <CallRow href={call} text="Book a call: choose your watch change with us" />
        </div>
      )}
    </Chapter>
  );
}

function YearWatch({ s, owner, call }) {
  return (
    <Chapter id="year-watch" icon={CalendarCheck} title="The right watch for your year" intro="Each personal year has its own watch. Your personal year comes from your birth day, birth month and the year.">
      <div className="group-card rows">
        {s.items.map(y => (
          <div key={y.year} className="row flex items-start gap-4">
            <span className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-maroon-soft font-display text-[1.5rem] font-bold text-maroon">{y.personalYear}</span>
            <div className="min-w-0">
              <h3 className="t-headline">{y.year}: {y.text.split('. ')[0].replace(/\.$/, '')}</h3>
              <p className={`mt-1 font-display text-[15px] font-semibold ${MATCH[y.match].tone}`}>Your watch {MATCH[y.match].word} this.</p>
              {owner && <Source s={{ file: y.source.file, quote: y.source.quote }} id={y.id} owner />}
            </div>
          </div>
        ))}
        {s.items.some(y => y.match !== 'full') && <CallRow href={call} text="Book a call: help choosing your watch for the year" />}
      </div>
    </Chapter>
  );
}

function Bracelet({ s }) {
  if (!s.bracelet) return null;
  return (
    <Chapter id="bracelet" icon={Circle} title="Your bracelet" intro={`For birth number ${s.birthNumber}. Worn on the wrist with your watch.`}>
      <div className="group-card row flex items-center justify-between gap-4">
        <div>
          <h3 className="t-headline">{s.bracelet.name}</h3>
          <p className="t-note mt-0.5">{s.bracelet.gemstones}</p>
        </div>
        <a href={s.bracelet.url} target="_blank" rel="noopener noreferrer" className="btn-plain min-h-[44px] shrink-0 bg-card px-4 text-[15px] shadow-[0_0_0_1px_hsl(var(--border))]">
          ₹{s.bracelet.price.toLocaleString('en-IN')} · Shop
        </a>
      </div>
    </Chapter>
  );
}

export default function WatchStory({ result, config, onAgain }) {
  const by = id => result.sections.find(s => s.id === id);
  const owner = result.owner === true;
  const word = result.input.name.split(' ')[0];
  const first = word.charAt(0).toUpperCase() + word.slice(1);
  const call = topic => callLink(config, first, result.leadRef, topic, 'WEB-WATCH');
  const brain = by('brain');
  const rootRef = useRef(null);
  const href = useMemo(() => call('my watch reading'), [result, config]);
  return (
    <div ref={rootRef} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-8">
      <div>
        <p className="font-display text-[15px] font-medium text-muted-foreground">Your free watch reading</p>
        <h2 className="t-title mt-1">{first}, here's your answer</h2>
        {owner && <p className="mt-3 rounded-[12px] bg-accent-soft px-4 py-2.5 text-[14px] text-warning-dark">Owner view: each line shows the rule and source it came from.</p>}
      </div>
      <Answer a={by('watch-answer')} href={href} bracelet={by('bracelet')} />
      {brain.watch && <WatchSays w={brain.watch} owner={owner} call={call('changing my watch')} />}
      <YearWatch s={by('year-watch')} owner={owner} call={call('choosing my watch for this year')} />
      <Numbers b={brain} owner={owner} />
      <LoShu b={brain} owner={owner} call={call('remedies for my missing numbers')} />
      <Timing b={brain} owner={owner} />
      <NameChapter b={brain} owner={owner} call={call('correcting my name spelling')} />
      <Bracelet s={by('bracelet')} />
      <section data-wa-cta className="group-card px-6 py-9 text-center shadow-soft">
        <h2 className="t-title">Want a watch chosen for you?</h2>
        <p className="mx-auto mt-2 max-w-md text-[17px] text-muted-foreground">We read your watch with your numbers and choose the right one for your year.</p>
        {href && <WaButton href={href} className="mt-6">Book a call on WhatsApp</WaButton>}
      </section>
      <button type="button" onClick={onAgain} className="btn-plain justify-self-center bg-card px-6 shadow-[0_0_0_1px_hsl(var(--border))]">Read another watch</button>
    </div>
  );
}
