import React, { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import Turnstile from './Turnstile.jsx';
import { Tick, Collapse } from './ui.jsx';
import { scrollToEl } from '../motion.js';

const CHIPS = ['Money is not staying with me', 'Career growth / job', 'Business not working', 'Marriage delay', 'Relationship problems', 'Debt and loans', 'Health worries', 'Stress and anxiety'];
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const istNow = () => new Date(Date.now() + 5.5 * 3600e3);
export const YEARS = (() => { const y = istNow().getUTCFullYear(); return Array.from({ length: y - 1900 + 1 }, (_, i) => y - i); })();
const pad = n => String(n).padStart(2, '0');

// Day, month and year as three pickers (a browser date box can show mm/dd/yyyy and get entered wrongly).
export function dobFrom(d) {
  if (!d.day || !d.month || !d.year) return '';
  const iso = `${d.year}-${pad(d.month)}-${pad(d.day)}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return t.getUTCDate() === Number(d.day) && t.getUTCMonth() + 1 === Number(d.month) ? iso : 'invalid';
}

// A native picker (the phone's own wheel or list) styled as a quiet field with a chevron.
export function Picker({ id, value, onChange, label, invalid, children, className = '' }) {
  return (
    <span className={`relative mt-1 block ${className}`}>
      <select id={id} value={value} onChange={onChange} aria-label={label} aria-invalid={invalid}
        className={`w-full cursor-pointer appearance-none rounded-[11px] bg-muted py-2.5 pl-2.5 pr-7 font-ui text-[17px] tracking-[-0.01em] transition-[background-color,box-shadow] duration-200 hover:bg-border/60 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary ${invalid ? 'ring-1 ring-danger/60' : ''} ${value ? 'text-foreground' : 'text-muted-foreground'}`}>
        {children}
      </select>
      <ChevronDown size={16} strokeWidth={2.5} className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
    </span>
  );
}

export function Switch({ id, checked, onChange, children, hint }) {
  return (
    <label htmlFor={id} className="row flex cursor-pointer items-center justify-between gap-4">
      <span>
        <span className="t-headline block">{children}</span>
        {hint && <span className="mt-0.5 block text-[14px] leading-snug text-muted-foreground">{hint}</span>}
      </span>
      <span className="relative inline-flex shrink-0">
        <input id={id} type="checkbox" role="switch" className="peer sr-only" checked={checked} onChange={onChange} />
        <span className="h-[31px] w-[51px] rounded-full bg-border transition-colors duration-300 peer-checked:bg-primary peer-focus-visible:ring-2 peer-focus-visible:ring-primary peer-focus-visible:ring-offset-2" />
        <span className="absolute left-[2px] top-[2px] h-[27px] w-[27px] rounded-full bg-white shadow-[0_3px_8px_rgba(0,0,0,0.15),0_1px_1px_rgba(0,0,0,0.16)] transition-transform duration-300 ease-ios peer-checked:translate-x-[20px] peer-active:w-[31px] peer-checked:peer-active:translate-x-[16px]" />
      </span>
    </label>
  );
}

export default function ReadingForm({ config, status, errors, onSubmit }) {
  const [f, setF] = useState({ name: '', mobile: '', concern: '', consent: false, waOptIn: false, website: '' });
  const [dob, setDob] = useState({ day: '', month: '', year: '' });
  const [planning, setPlanning] = useState(false);
  const [planned, setPlanned] = useState(['']);
  const [token, setToken] = useState('');
  const [reset, setReset] = useState(0);
  const [local, setLocal] = useState({});
  const set = k => e => setF(s => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  // "Check a number before you buy it" from the reading: their details stay filled in; open the compare switch
  // and put the cursor in the new-number box.
  useEffect(() => {
    const open = () => {
      setPlanning(true);
      setTimeout(() => {
        scrollToEl(document.getElementById('f-planning')?.closest('.group-card'), { block: 'center' });
        document.getElementById('f-planned-0')?.focus({ preventScroll: true });
      }, 60);
    };
    window.addEventListener('nm:compare', open);
    return () => window.removeEventListener('nm:compare', open);
  }, []);
  const setD = k => e => setDob(s => ({ ...s, [k]: e.target.value }));
  const err = { ...errors, ...local };

  function addChip(c) {
    setF(s => ({ ...s, concern: s.concern.trim() ? `${s.concern.trim().replace(/[.,]$/, '')}, ${c.toLowerCase()}` : c }));
  }

  async function submit(e) {
    e.preventDefault();
    const iso = dobFrom(dob);
    const miss = {};
    if (f.name.trim().length < 2) miss.name = 'Enter your name.';
    if (f.mobile.replace(/\D/g, '').length < 10) miss.mobile = 'Enter your 10-digit mobile number.';
    if (!iso) miss.dob = 'Choose your day, month and year of birth.';
    else if (iso === 'invalid') miss.dob = 'That date does not exist. Check the day and month.';
    if (f.concern.trim().length < 2) miss.concern = 'Tell us what is worrying you, or pick one below.';
    if (!f.consent) miss.consent = 'Tick this box so we can show your reading.';
    setLocal(miss);
    if (Object.keys(miss).length) {
      document.getElementById(`f-${Object.keys(miss)[0]}`)?.focus();
      return;
    }
    const ok = await onSubmit({ ...f, dob: iso, planned: planning ? planned.filter(p => p.trim()) : [], turnstileToken: token });
    if (!ok) setReset(r => r + 1);
  }

  const busy = status === 'loading';
  return (
    <form onSubmit={submit} noValidate aria-labelledby="form-title" className="grid min-w-0 grid-cols-1 gap-5">
      <div>
        <h2 id="form-title" className="t-section">Get your free reading</h2>
        <p className="mt-1 text-[15px] text-muted-foreground">Four details. Your reading appears right here.</p>
      </div>

      <div className="group-card rows shadow-soft">
        <div className="row">
          <label className="field-label" htmlFor="f-name">Your name</label>
          <input id="f-name" className="field" autoComplete="name" placeholder="Full name" value={f.name} onChange={set('name')} aria-invalid={!!err.name} />
          {err.name && <p className="error">{err.name}</p>}
        </div>

        <div className="row">
          <label className="field-label" htmlFor="f-mobile">Mobile number</label>
          <div className="flex items-baseline gap-2">
            <span className="font-ui text-[17px] tracking-[-0.01em] text-muted-foreground">+91</span>
            <input id="f-mobile" className="field" type="tel" inputMode="numeric" autoComplete="tel-national" placeholder="98765 43210"
              value={f.mobile} onChange={set('mobile')} aria-invalid={!!err.mobile} />
          </div>
          {err.mobile && <p className="error">{err.mobile}</p>}
        </div>

        <fieldset className="row">
          <legend className="field-label float-left w-full">Date of birth</legend>
          <div className="clear-both grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-2.5 min-[390px]:grid-cols-[4.5rem_minmax(0,1fr)_5.5rem]">
            <Picker id="f-dob" value={dob.day} onChange={setD('day')} label="Day of birth" invalid={!!err.dob}>
              <option value="">Day</option>
              {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
            </Picker>
            <Picker value={dob.month} onChange={setD('month')} label="Month of birth">
              <option value="">Month</option>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m.slice(0, 3)}</option>)}
            </Picker>
            <Picker value={dob.year} onChange={setD('year')} label="Year of birth" className="col-span-2 min-[390px]:col-span-1">
              <option value="">Year</option>
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </Picker>
          </div>
          {err.dob && <p className="error">{err.dob}</p>}
        </fieldset>

        <div className="row">
          <label className="field-label" htmlFor="f-concern">What is worrying you?</label>
          <textarea id="f-concern" className="field min-h-[72px] resize-y" maxLength={300} placeholder="In your own words, in English or Hinglish"
            value={f.concern} onChange={set('concern')} aria-invalid={!!err.concern} />
          {err.concern && <p className="error">{err.concern}</p>}
        </div>
      </div>

      <div>
        <p className="mb-2 px-1 font-display text-[13px] font-medium text-muted-foreground">Or tap what fits</p>
        <div className="grid grid-cols-2 gap-2" aria-label="Quick choices">
          {CHIPS.map(c => (
            <button key={c} type="button" onClick={() => addChip(c)}
              className="min-h-[44px] rounded-[12px] border border-primary/15 bg-card px-3 py-2 text-left text-[15px] leading-tight text-maroon transition-colors hover:border-primary/50 hover:bg-primary-soft active:bg-primary-soft">
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="group-card rows">
        <Switch id="f-planning" checked={planning} onChange={e => setPlanning(e.target.checked)}
          hint="See what changes: problems that go away, new ones, strengths gained or lost.">
          Compare a number before you buy it
        </Switch>
        <Collapse open={planning}><div className="rows">
        {planned.map((p, i) => (
          <div key={i} className="row flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <label className="field-label" htmlFor={`f-planned-${i}`}>New number {planned.length > 1 ? i + 1 : ''}</label>
              <input id={`f-planned-${i}`} className="field" type="tel" inputMode="numeric" placeholder="98765 43210"
                value={p} onChange={e => setPlanned(list => list.map((x, j) => j === i ? e.target.value : x))} />
            </div>
            {planned.length > 1 && (
              <button type="button" className="text-[15px] font-medium text-primary-dark" aria-label={`Remove number ${i + 1}`}
                onClick={() => setPlanned(list => list.filter((_, j) => j !== i))}>Remove</button>
            )}
          </div>
        ))}
        {planned.length < 3 && (
          <button type="button" className="pressable-row row w-full text-left text-[16px] font-medium text-primary-dark" onClick={() => setPlanned(l => [...l, ''])}>
            Add another number
          </button>
        )}
        </div></Collapse>
        {planning && err.planned && <p className="row error mt-0">{err.planned}</p>}
      </div>

      <input type="text" name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')}
        className="absolute -left-[9999px] h-px w-px opacity-0" aria-hidden="true" />

      <div className="grid gap-3 px-1">
        <Tick id="f-consent" checked={f.consent} onChange={set('consent')} invalid={!!err.consent}>
          I agree that Veshannastro stores my name, number, date of birth and what I shared, to show this reading. <a href="/privacy" target="_blank" className="font-medium text-primary-dark">Privacy policy</a> · <a href="/terms" target="_blank" className="font-medium text-primary-dark">Terms</a>
        </Tick>
        {err.consent && <p className="error -mt-1 pl-9">{err.consent}</p>}
        <Tick id="f-wa" checked={f.waOptIn} onChange={set('waOptIn')}>
          Send me updates and offers on WhatsApp <span className="text-muted-foreground">(optional)</span>
        </Tick>
      </div>

      <Turnstile siteKey={config.turnstileSiteKey} onToken={setToken} resetSignal={reset} />

      {err.form && <p role="alert" className="error rounded-[12px] bg-danger-soft px-4 py-3">{err.form}</p>}

      <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-70">
        {busy ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground" /> Reading your number…</> : 'Show my reading'}
      </button>
    </form>
  );
}
