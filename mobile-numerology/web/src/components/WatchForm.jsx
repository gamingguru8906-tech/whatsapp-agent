import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { MONTHS, YEARS, dobFrom, Picker } from './ReadingForm.jsx';
import Turnstile from './Turnstile.jsx';
import attributes from '../../../../brain/data/watch-attributes.json';

// Wristwatch segment form: the person's details, then their watch, picked by hand (same look as the mobile form).
const ATTRS = attributes.attributes;
const FIRST = ['dialColour', 'dialShape', 'caseMetal', 'dialSize', 'wrist', 'markers', 'strapMaterial'];
const MAIN = FIRST.map(k => ATTRS.find(a => a.key === k)).filter(Boolean);
const MORE = ATTRS.filter(a => !FIRST.includes(a.key) && !a.multi);
const GOAL = ATTRS.find(a => a.key === 'goal');

function AttrRow({ a, value, onChange, invalid }) {
  return (
    <div className="row">
      <label className="field-label" htmlFor={`w-${a.key}`}>{a.q}</label>
      <Picker id={`w-${a.key}`} value={value ?? ''} onChange={e => onChange(a.key, e.target.value || undefined)} label={a.q} invalid={invalid}>
        <option value="">Choose</option>
        {Object.entries(a.options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </Picker>
    </div>
  );
}

export default function WatchForm({ config, status, errors, onSubmit }) {
  const [f, setF] = useState({ name: '', mobile: '', consent: false, waOptIn: false, website: '' });
  const [dob, setDob] = useState({ day: '', month: '', year: '' });
  const [w, setW] = useState({});
  const [more, setMore] = useState(false);
  const [token, setToken] = useState('');
  const [reset, setReset] = useState(0);
  const [local, setLocal] = useState({});
  const set = k => e => setF(s => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setD = k => e => setDob(s => ({ ...s, [k]: e.target.value }));
  const setAttr = (k, v) => setW(s => { const n = { ...s }; if (v === undefined) delete n[k]; else n[k] = v; return n; });
  const toggleGoal = k => setW(s => {
    const g = new Set(s.goal ?? []);
    g.has(k) ? g.delete(k) : g.add(k);
    return { ...s, goal: [...g] };
  });
  const err = { ...errors, ...local };
  const visible = a => !a.onlyIf || Object.entries(a.onlyIf).every(([k, vs]) => vs.includes(w[k]));

  async function submit(e) {
    e.preventDefault();
    const iso = dobFrom(dob);
    const miss = {};
    if (f.name.trim().length < 2) miss.name = 'Enter your name.';
    if (f.mobile.replace(/\D/g, '').length < 10) miss.mobile = 'Enter your 10-digit mobile number.';
    if (!iso) miss.dob = 'Choose your day, month and year of birth.';
    else if (iso === 'invalid') miss.dob = 'That date does not exist. Check the day and month.';
    if (!w.dialColour || !w.dialShape) miss.watch = 'Pick at least the dial colour and the dial shape.';
    if (!f.consent) miss.consent = 'Tick this box so we can show your reading.';
    setLocal(miss);
    if (Object.keys(miss).length) {
      const firstKey = Object.keys(miss)[0];
      document.getElementById(firstKey === 'watch' ? 'w-dialColour' : `f-${firstKey}`)?.focus();
      return;
    }
    const ok = await onSubmit({ ...f, dob: iso, watch: w, turnstileToken: token });
    if (!ok) setReset(r => r + 1);
  }

  const busy = status === 'loading';
  return (
    <form onSubmit={submit} noValidate aria-labelledby="form-title" className="grid gap-5">
      <div>
        <h2 id="form-title" className="t-section">Get your free watch reading</h2>
        <p className="mt-1 text-[15px] text-muted-foreground">Your details, then your watch. Your reading appears right here.</p>
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
            <span className="font-display text-[17px] text-muted-foreground">+91</span>
            <input id="f-mobile" className="field" type="tel" inputMode="numeric" autoComplete="tel-national" placeholder="98765 43210"
              value={f.mobile} onChange={set('mobile')} aria-invalid={!!err.mobile} />
          </div>
          {err.mobile && <p className="error">{err.mobile}</p>}
        </div>
        <fieldset className="row">
          <legend className="field-label float-left w-full">Date of birth</legend>
          <div className="clear-both grid grid-cols-[4.75rem_1fr_6rem] gap-2.5">
            <Picker id="f-dob" value={dob.day} onChange={setD('day')} label="Day of birth" invalid={!!err.dob}>
              <option value="">Day</option>
              {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
            </Picker>
            <Picker value={dob.month} onChange={setD('month')} label="Month of birth">
              <option value="">Month</option>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </Picker>
            <Picker value={dob.year} onChange={setD('year')} label="Year of birth">
              <option value="">Year</option>
              {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
            </Picker>
          </div>
          {err.dob && <p className="error">{err.dob}</p>}
        </fieldset>
      </div>

      <div>
        <h3 className="mb-2 px-1 font-display text-[15px] font-semibold text-maroon">Your watch</h3>
        <div className="group-card rows">
          {MAIN.map(a => <AttrRow key={a.key} a={a} value={w[a.key]} onChange={setAttr} invalid={!!err.watch && ['dialColour', 'dialShape'].includes(a.key)} />)}
          {err.watch && <p className="row error mt-0">{err.watch}</p>}
          <button type="button" onClick={() => setMore(m => !m)} aria-expanded={more}
            className="row flex w-full items-center justify-between text-left text-[17px] font-medium text-primary-dark">
            {more ? 'Fewer details' : 'More details (numerals, date window, hands, strap…)'}
            <ChevronDown size={20} className={`shrink-0 transition-transform ${more ? 'rotate-180' : ''}`} aria-hidden="true" />
          </button>
          {more && MORE.filter(visible).map(a => <AttrRow key={a.key} a={a} value={w[a.key]} onChange={setAttr} />)}
        </div>
      </div>

      {GOAL && (
        <div>
          <p className="mb-2 px-1 font-display text-[13px] font-medium text-muted-foreground">{GOAL.q} (optional)</p>
          <div className="grid gap-2">
            {Object.entries(GOAL.options).map(([k, v]) => {
              const on = (w.goal ?? []).includes(k);
              return (
                <button key={k} type="button" aria-pressed={on} onClick={() => toggleGoal(k)}
                  className={`min-h-[44px] rounded-[12px] border px-3 py-2 text-left text-[15px] leading-tight transition-colors ${on ? 'border-primary bg-primary-soft text-maroon' : 'border-primary/15 bg-card text-maroon hover:border-primary/50'}`}>
                  {v}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <input type="text" name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')}
        className="absolute -left-[9999px] h-px w-px opacity-0" aria-hidden="true" />

      <div className="grid gap-3 px-1">
        <label className="flex cursor-pointer items-start gap-3 text-[15px] leading-snug">
          <input id="f-consent" type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]" checked={f.consent} onChange={set('consent')} aria-invalid={!!err.consent} />
          <span>I agree that Veshannastro stores my name, number, date of birth and my watch details, to show this reading.</span>
        </label>
        {err.consent && <p className="error -mt-1 pl-8">{err.consent}</p>}
        <label className="flex cursor-pointer items-start gap-3 text-[15px] leading-snug">
          <input id="f-wa" type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]" checked={f.waOptIn} onChange={set('waOptIn')} />
          <span>Send me updates and offers on WhatsApp <span className="text-muted-foreground">(optional)</span></span>
        </label>
      </div>

      <Turnstile siteKey={config.turnstileSiteKey} onToken={setToken} resetSignal={reset} />
      {err.form && <p className="error rounded-[12px] bg-danger-soft px-4 py-3">{err.form}</p>}

      <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-70">
        {busy ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground" /> Reading your watch…</> : 'Show my watch reading'}
      </button>
    </form>
  );
}
