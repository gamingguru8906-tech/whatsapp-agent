import React, { useState } from 'react';
import Turnstile from './Turnstile.jsx';

const CHIPS = ['Money is not staying with me', 'Career growth / job', 'Business not working', 'Marriage delay', 'Relationship problems', 'Debt and loans', 'Health worries', 'Stress and anxiety'];
const today = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export default function ReadingForm({ config, status, errors, onSubmit }) {
  const [f, setF] = useState({ name: '', mobile: '', dob: '', concern: '', consent: false, waOptIn: false, website: '' });
  const [planning, setPlanning] = useState(false);
  const [planned, setPlanned] = useState(['']);
  const [token, setToken] = useState('');
  const [reset, setReset] = useState(0);
  const [local, setLocal] = useState({});
  const set = k => e => setF(s => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const err = { ...errors, ...local };

  function addChip(c) {
    setF(s => ({ ...s, concern: s.concern.trim() ? `${s.concern.trim().replace(/[.,]$/, '')}, ${c.toLowerCase()}` : c }));
  }

  async function submit(e) {
    e.preventDefault();
    const miss = {};
    if (f.name.trim().length < 2) miss.name = 'Please enter your name.';
    if (f.mobile.replace(/\D/g, '').length < 10) miss.mobile = 'Please enter your 10-digit mobile number.';
    if (!f.dob) miss.dob = 'Please enter your date of birth.';
    if (f.concern.trim().length < 2) miss.concern = 'Please tell us what is worrying you.';
    if (!f.consent) miss.consent = 'Please tick the box to agree, so we can show your reading.';
    setLocal(miss);
    if (Object.keys(miss).length) {
      document.getElementById(`f-${Object.keys(miss)[0]}`)?.focus();
      return;
    }
    const ok = await onSubmit({ ...f, planned: planning ? planned.filter(p => p.trim()) : [], turnstileToken: token });
    if (!ok) setReset(r => r + 1);
  }

  const busy = status === 'loading';
  return (
    <form onSubmit={submit} noValidate className="rounded-lg border bg-card p-5 shadow-soft sm:p-6" aria-labelledby="form-title">
      <h2 id="form-title" className="text-xl font-bold">Get your free reading</h2>
      <p className="mt-1 text-sm text-muted-foreground">Four details. Your reading appears right below.</p>

      <div className="mt-5 grid gap-4">
        <div>
          <label className="label" htmlFor="f-name">Your name</label>
          <input id="f-name" className="field" autoComplete="name" value={f.name} onChange={set('name')} aria-invalid={!!err.name} />
          {err.name && <p className="error">{err.name}</p>}
        </div>

        <div>
          <label className="label" htmlFor="f-mobile">Mobile number</label>
          <div className="flex">
            <span className="inline-flex items-center rounded-l-lg border border-r-0 border-input bg-muted px-3 text-sm font-semibold text-muted-foreground">+91</span>
            <input id="f-mobile" className="field rounded-l-none" type="tel" inputMode="numeric" autoComplete="tel-national" placeholder="98765 43210"
              value={f.mobile} onChange={set('mobile')} aria-invalid={!!err.mobile} />
          </div>
          {err.mobile && <p className="error">{err.mobile}</p>}
        </div>

        <div>
          <label className="label" htmlFor="f-dob">Date of birth</label>
          <input id="f-dob" className="field" type="date" max={today()} min="1900-01-01" value={f.dob} onChange={set('dob')} aria-invalid={!!err.dob} />
          {err.dob && <p className="error">{err.dob}</p>}
        </div>

        <div>
          <label className="label" htmlFor="f-concern">What is worrying you?</label>
          <textarea id="f-concern" className="field min-h-[84px] resize-y" maxLength={300} placeholder="In your own words, in English or Hinglish"
            value={f.concern} onChange={set('concern')} aria-invalid={!!err.concern} />
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Quick choices">
            {CHIPS.map(c => (
              <button key={c} type="button" onClick={() => addChip(c)}
                className="rounded-full border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground hover:border-primary hover:text-primary-dark">
                + {c}
              </button>
            ))}
          </div>
          {err.concern && <p className="error">{err.concern}</p>}
        </div>

        <div className="rounded-lg border border-dashed border-primary/30 bg-primary-soft/50 p-3.5">
          <label className="flex cursor-pointer items-start gap-2.5 text-sm font-semibold">
            <input id="f-planning" type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" checked={planning} onChange={e => setPlanning(e.target.checked)} />
            <span>Planning to buy a new number? Compare it with yours
              <span className="block font-normal text-muted-foreground">See what changes: problems that go away, new ones it brings, strengths gained or lost.</span>
            </span>
          </label>
          {planning && (
            <div className="mt-3 grid gap-2">
              {planned.map((p, i) => (
                <div key={i} className="flex gap-2">
                  <input id={`f-planned-${i}`} className="field" type="tel" inputMode="numeric" placeholder={`New number ${i + 1}`} aria-label={`Number you plan to buy ${i + 1}`}
                    value={p} onChange={e => setPlanned(list => list.map((x, j) => j === i ? e.target.value : x))} />
                  {planned.length > 1 && (
                    <button type="button" className="rounded-lg border px-3 text-sm text-muted-foreground" aria-label={`Remove number ${i + 1}`}
                      onClick={() => setPlanned(list => list.filter((_, j) => j !== i))}>Remove</button>
                  )}
                </div>
              ))}
              {planned.length < 3 && (
                <button type="button" className="justify-self-start text-sm font-semibold text-primary-dark" onClick={() => setPlanned(l => [...l, ''])}>
                  + Add another number (up to 3)
                </button>
              )}
              {err.planned && <p className="error">{err.planned}</p>}
            </div>
          )}
        </div>

        <input type="text" name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')}
          className="absolute -left-[9999px] h-px w-px opacity-0" aria-hidden="true" />

        <div className="grid gap-2.5">
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input id="f-consent" type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" checked={f.consent} onChange={set('consent')} aria-invalid={!!err.consent} />
            <span>I agree that Veshannastro stores my name, number, date of birth and what I shared, to show this reading.</span>
          </label>
          {err.consent && <p className="error -mt-1">{err.consent}</p>}
          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input id="f-wa" type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" checked={f.waOptIn} onChange={set('waOptIn')} />
            <span>Send me updates and offers on WhatsApp <span className="text-muted-foreground">(optional)</span></span>
          </label>
        </div>

        <Turnstile siteKey={config.turnstileSiteKey} onToken={setToken} resetSignal={reset} />

        {err.form && <p className="error rounded-lg bg-danger-soft px-3 py-2">{err.form}</p>}

        <button type="submit" disabled={busy}
          className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-primary px-5 text-base font-bold text-primary-foreground shadow-soft transition hover:bg-primary-dark disabled:opacity-70">
          {busy ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground" /> Reading your number…</> : 'Show my reading'}
        </button>
        <p className="text-center text-xs text-muted-foreground">Guidance, not a guarantee. Free, always.</p>
      </div>
    </form>
  );
}
