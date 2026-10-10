import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight, LogOut, Smartphone, Watch as WatchIcon } from 'lucide-react';
import { startLogin, loginStatus, signOut, getMyReadings, openMyReading } from '../api.js';
import { WaIcon } from './ui.jsx';
import Story from './Story.jsx';
import WatchStory from './WatchStory.jsx';

// "My readings": sign in with WhatsApp (send a code from your own number), then every reading saved for that number.

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const day = iso => { const d = new Date(iso); return `${d.getDate()} ${MONTH[d.getMonth()]} ${d.getFullYear()}`; };
const dob = s => { const [y, m, d] = s.split('-').map(Number); return `${d} ${MONTH[m - 1]} ${y}`; };
const masked = p => `+91 ${p.slice(0, 2)}xxx x${p.slice(6)}`;

function SignIn({ onSignedIn }) {
  const [step, setStep] = useState({ state: 'start' }); // start | code | error
  const timer = useRef(null);
  useEffect(() => () => clearInterval(timer.current), []);

  async function begin() {
    setStep({ state: 'loading' });
    const r = await startLogin();
    if (!r.ok) { setStep({ state: 'error', msg: r.error }); return; }
    const num = String(r.whatsappNumber || '').replace(/\D/g, '');
    setStep({ state: 'code', code: r.code, href: num ? `https://wa.me/${num}?text=${encodeURIComponent(`LOGIN ${r.code}`)}` : null, until: Date.now() + r.minutes * 60e3 });
    clearInterval(timer.current);
    timer.current = setInterval(async () => {
      if (document.visibilityState === 'hidden') return; // check again when they come back from WhatsApp
      const s = await loginStatus();
      if (s.state === 'signed-in') { clearInterval(timer.current); onSignedIn(s.phone); }
      else if (s.state === 'expired') { clearInterval(timer.current); setStep({ state: 'error', msg: 'That code has expired. Please get a new one.' }); }
    }, 3000);
  }

  return (
    <div className="group-card mx-auto max-w-md px-6 py-8 text-center shadow-soft">
      <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-whatsapp text-white"><WaIcon size={28} /></span>
      <h2 className="t-title mt-4">See all your readings</h2>
      {step.state !== 'code' ? (
        <>
          <p className="mx-auto mt-2 max-w-sm text-[17px] text-muted-foreground">Sign in with your WhatsApp number. You send us a short code on WhatsApp, and every reading made with your number appears here.</p>
          {step.state === 'error' && <p role="alert" className="error mt-4 rounded-[12px] bg-danger-soft px-4 py-3">{step.msg}</p>}
          <button type="button" onClick={begin} disabled={step.state === 'loading'} className="btn-whatsapp mt-6 w-full disabled:opacity-70">
            <WaIcon />{step.state === 'loading' ? 'Getting your code…' : 'Sign in with WhatsApp'}
          </button>
        </>
      ) : (
        <>
          <p className="mx-auto mt-2 max-w-sm text-[17px] text-muted-foreground">Send this code to us on WhatsApp from your own number. This page signs you in as soon as it arrives.</p>
          <p className="mt-5 font-display text-[2.5rem] font-bold tracking-[0.18em] text-maroon" aria-label={`Your code: ${step.code.split('').join(' ')}`}>{step.code}</p>
          {step.href && <a href={step.href} target="_blank" rel="noopener noreferrer" className="btn-whatsapp mt-5 w-full"><WaIcon />Send the code on WhatsApp</a>}
          <p className="mt-4 flex items-center justify-center gap-2 text-[15px] text-muted-foreground" role="status">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" aria-hidden="true" />
            Waiting for your message…
          </p>
          <p className="t-note mt-3">The code works once, for 15 minutes. Do not share it with anyone.</p>
        </>
      )}
    </div>
  );
}

function List({ phone, readings, onOpen, onSignOut, busy }) {
  return (
    <div className="mx-auto grid max-w-[44rem] gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="font-display text-[15px] font-medium text-muted-foreground">Signed in as {masked(phone)}</p>
          <h2 className="t-title mt-1">My readings</h2>
        </div>
        <button type="button" onClick={onSignOut} className="btn-plain min-h-[44px] bg-card px-4 text-[15px] shadow-[0_0_0_1px_hsl(var(--border))]">
          <LogOut size={17} aria-hidden="true" /> Sign out
        </button>
      </div>
      {readings.length === 0 ? (
        <div className="group-card px-6 py-8 text-center">
          <p className="t-headline">No readings for this number yet</p>
          <p className="t-body mt-1 text-muted-foreground">Readings appear here when your mobile number is entered in the form.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-3">
            <a href="/" className="btn-plain bg-card px-5 shadow-[0_0_0_1px_hsl(var(--border))]">Mobile number reading</a>
            <a href="/watch" className="btn-plain bg-card px-5 shadow-[0_0_0_1px_hsl(var(--border))]">Wristwatch reading</a>
          </div>
        </div>
      ) : (
        <div className="group-card rows">
          {readings.map(r => {
            const Icon = r.segment === 'watch' ? WatchIcon : Smartphone;
            return (
              <button key={r.id} type="button" onClick={() => onOpen(r)} disabled={busy}
                className="row flex w-full items-center gap-4 text-left transition-colors hover:bg-muted/40 disabled:opacity-70">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-maroon-soft text-maroon"><Icon size={21} aria-hidden="true" /></span>
                <span className="min-w-0 flex-1">
                  <span className="t-headline block">{r.segment === 'watch' ? 'Wristwatch reading' : 'Mobile number reading'}</span>
                  <span className="t-note mt-0.5 block truncate">{r.name} · born {dob(r.dob)} · {day(r.createdAt)}</span>
                </span>
                <ChevronRight size={20} className="shrink-0 text-muted-foreground" aria-hidden="true" />
              </button>
            );
          })}
        </div>
      )}
      <p className="t-note px-1">Each reading opens with this year's timing. Readings are found by the mobile number entered in the form.</p>
    </div>
  );
}

export default function MyReadings({ config }) {
  const [who, setWho] = useState({ state: 'checking' });
  const [list, setList] = useState(null);
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const top = useRef(null);

  async function load(phone) {
    setWho({ state: 'signed-in', phone });
    const r = await getMyReadings();
    if (r.ok) setList(r.readings);
    else if (r.state) { setWho({ state: 'signed-out' }); }
    else setErr(r.error);
  }
  useEffect(() => {
    loginStatus().then(s => (s.state === 'signed-in' ? load(s.phone) : setWho({ state: 'signed-out' })));
  }, []);

  async function onOpen(r) {
    setBusy(true); setErr('');
    const res = await openMyReading(r.id);
    setBusy(false);
    if (!res.ok) { setErr(res.error || 'That reading could not be opened.'); return; }
    setOpen(res);
    requestAnimationFrame(() => top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }
  async function onSignOut() { await signOut(); setList(null); setOpen(null); setWho({ state: 'signed-out' }); }
  const back = () => { setOpen(null); requestAnimationFrame(() => top.current?.scrollIntoView({ block: 'start' })); };

  return (
    <section ref={top} className="mx-auto max-w-5xl scroll-mt-20 px-5 pb-16 pt-8 sm:pt-12">
      {err && <p role="alert" className="error mx-auto mb-5 max-w-[44rem] rounded-[12px] bg-danger-soft px-4 py-3">{err}</p>}
      {who.state === 'checking' && <p className="text-center text-muted-foreground" role="status">Loading…</p>}
      {who.state === 'signed-out' && <SignIn onSignedIn={load} />}
      {who.state === 'signed-in' && !open && (list ? <List phone={who.phone} readings={list} onOpen={onOpen} onSignOut={onSignOut} busy={busy} /> : <p className="text-center text-muted-foreground" role="status">Loading your readings…</p>)}
      {open && (
        <div className="mx-auto max-w-[44rem]">
          <button type="button" onClick={back} className="btn-plain mb-6 bg-card px-4 text-[15px] shadow-[0_0_0_1px_hsl(var(--border))]">‹ My readings</button>
          {open.segment === 'watch'
            ? <WatchStory result={open} config={config} onAgain={back} againLabel="Back to my readings" saved={false} />
            : <Story result={open} config={config} onAgain={back} againLabel="Back to my readings" saved={false} />}
        </div>
      )}
    </section>
  );
}
