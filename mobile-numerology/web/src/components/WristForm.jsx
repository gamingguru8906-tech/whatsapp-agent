import React, { useEffect, useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { MONTHS, YEARS, dobFrom, Picker } from './ReadingForm.jsx';
import Turnstile from './Turnstile.jsx';
import { readWrist, shrinkPhoto, track } from '../api.js';

// "Which watch should I wear this year?": a photo of the wrist (read at once, never kept), then name, number and
// birth date, side by side, so the answer is ready the moment the form is sent.

export const WRIST = {
  size: { q: 'Wrist size', options: { slim: 'Slim', medium: 'Medium', broad: 'Broad' } },
  undertone: { q: 'Skin undertone', hint: 'Veins look greenish: warm. Bluish: cool. Both: neutral.', options: { warm: 'Warm', cool: 'Cool', neutral: 'Neutral' } },
  style: { q: 'Your usual style', options: { formal: 'Formal', casual: 'Casual', sporty: 'Sporty', traditional: 'Traditional' } }
};

function WristPicks({ wrist, setWrist, fromPhoto, invalid }) {
  return Object.entries(WRIST).map(([k, a]) => (
    <div key={k} className="row">
      <div className="flex items-baseline justify-between gap-2">
        <label className="field-label" htmlFor={`wr-${k}`}>{a.q}</label>
        {fromPhoto.has(k) && <span className="chip mb-1 shrink-0 bg-accent-soft text-warning-dark">From photo · check</span>}
      </div>
      <Picker id={`wr-${k}`} value={wrist[k] ?? ''} onChange={e => setWrist(k, e.target.value || undefined)} label={a.q} invalid={invalid && k === 'size'}>
        <option value="">Choose</option>
        {Object.entries(a.options).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </Picker>
      {a.hint && <p className="t-note mt-1">{a.hint}</p>}
    </div>
  ));
}

export default function WristForm({ config, status, errors, onSubmit, year }) {
  const [f, setF] = useState({ name: '', mobile: '', consent: false, website: '' });
  const [dob, setDob] = useState({ day: '', month: '', year: '' });
  const [wrist, setW] = useState({});
  const [fromPhoto, setFromPhoto] = useState(new Set());
  const [photo, setPhoto] = useState({ state: 'idle', msg: '', preview: null });
  const [manual, setManual] = useState(false);
  const [token, setToken] = useState('');
  const [reset, setReset] = useState(0);
  const [local, setLocal] = useState({});
  const fileRef = useRef(null);
  const set = k => e => setF(s => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setD = k => e => setDob(s => ({ ...s, [k]: e.target.value }));
  const setWrist = (k, v) => {
    setW(s => { const n = { ...s }; if (v === undefined) delete n[k]; else n[k] = v; return n; });
    if (fromPhoto.has(k)) track('wrist', 'details_changed', { detail: { key: k } });
    setFromPhoto(p => { const n = new Set(p); n.delete(k); return n; });
  };
  const err = { ...errors, ...local };
  // The preview lives only in this page's memory and is released when it changes or the page closes.
  useEffect(() => () => { if (photo.preview) URL.revokeObjectURL(photo.preview); }, [photo.preview]);

  async function onPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    track('wrist', 'photo_added');
    setPhoto({ state: 'loading', msg: '', preview: URL.createObjectURL(file) });
    let image;
    try { image = await shrinkPhoto(file, 768); } catch {
      setPhoto(p => ({ ...p, state: 'error', msg: 'That file could not be opened as a photo. Please try another, or choose below.' }));
      setManual(true); track('wrist', 'photo_failed', { detail: { reason: 'file' } }); return;
    }
    const r = await readWrist(image);
    image = null;
    if (!r.ok) {
      setPhoto(p => ({ ...p, state: 'error', msg: r.error })); setManual(true);
      track('wrist', 'photo_failed', { detail: { reason: 'model' } }); return;
    }
    setW(s => ({ ...s, ...r.wrist }));
    setFromPhoto(new Set(r.filled));
    setManual(true);
    setPhoto(p => ({ ...p, state: 'done', msg: r.filled.length === 3 ? 'Here is what we see. Change anything that is not right.' : 'We could read part of it. Please choose the rest.' }));
    track('wrist', 'photo_read', { detail: { filled: r.filled.length } });
  }

  async function submit(e) {
    e.preventDefault();
    const iso = dobFrom(dob);
    const miss = {};
    if (!wrist.size) miss.wrist = 'Add a photo of your wrist, or choose your wrist size.';
    if (f.name.trim().length < 2) miss.name = 'Enter your name.';
    if (f.mobile.replace(/\D/g, '').length < 10) miss.mobile = 'Enter your 10-digit mobile number.';
    if (!iso) miss.dob = 'Choose your day, month and year of birth.';
    else if (iso === 'invalid') miss.dob = 'That date does not exist. Check the day and month.';
    if (!f.consent) miss.consent = 'Tick this box so we can show your answer.';
    setLocal(miss);
    if (Object.keys(miss).length) {
      if (miss.wrist) setManual(true);
      const k = Object.keys(miss)[0];
      requestAnimationFrame(() => document.getElementById(k === 'wrist' ? 'wr-size' : `f-${k}`)?.focus());
      return;
    }
    track('wrist', 'form_sent', { detail: { photo: fromPhoto.size > 0 } });
    const ok = await onSubmit({ ...f, dob: iso, wrist, turnstileToken: token });
    if (!ok) setReset(r => r + 1);
  }

  const busy = status === 'loading';
  return (
    <form onSubmit={submit} noValidate aria-labelledby="form-title" className="grid gap-5">
      <div>
        <h2 id="form-title" className="t-section">Find your watch for {year}</h2>
        <p className="mt-1 text-[15px] text-muted-foreground">A photo of your wrist and your birth date. Your answer appears right here.</p>
      </div>

      <div>
        <h3 className="mb-2 px-1 font-display text-[15px] font-semibold text-maroon">1. Your wrist</h3>
        <div className="group-card rows shadow-soft">
          <div className="row flex items-center gap-4 py-4">
            {photo.preview
              ? <img src={photo.preview} alt="Your wrist photo" className="h-16 w-16 shrink-0 rounded-[14px] object-cover" />
              : <span className="grid h-16 w-16 shrink-0 place-items-center rounded-[14px] bg-primary-soft text-primary-dark"><Camera size={26} aria-hidden="true" /></span>}
            <div className="min-w-0 flex-1">
              <p className="t-headline">{photo.state === 'loading' ? 'Reading your wrist…' : photo.preview ? 'Your wrist photo' : 'Add a photo of your wrist'}</p>
              <p className="t-note mt-0.5">Bare wrist and hand, in daylight. The photo is read once and never kept.</p>
            </div>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPhoto} aria-label="Choose a photo of your wrist" />
            <button type="button" onClick={() => fileRef.current?.click()} disabled={photo.state === 'loading'}
              className="btn-plain min-h-[44px] shrink-0 bg-card px-4 text-[15px] shadow-[0_0_0_1px_hsl(var(--border))] disabled:opacity-70">
              {photo.state === 'loading' ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" aria-label="Reading" /> : photo.preview ? 'Change' : 'Add photo'}
            </button>
          </div>
          {photo.msg && <p role="status" className={`row text-[15px] ${photo.state === 'error' ? 'text-danger-dark' : 'text-warning-dark'}`}>{photo.msg}</p>}
          {manual
            ? <WristPicks wrist={wrist} setWrist={setWrist} fromPhoto={fromPhoto} invalid={!!err.wrist} />
            : <button type="button" onClick={() => setManual(true)} className="row w-full text-left text-[16px] font-medium text-primary-dark">No photo? Choose your wrist size instead</button>}
          {err.wrist && <p className="row error mt-0">{err.wrist}</p>}
        </div>
      </div>

      <div>
        <h3 className="mb-2 px-1 font-display text-[15px] font-semibold text-maroon">2. You</h3>
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
            <legend className="field-label float-left w-full">Date of birth <span className="font-normal text-muted-foreground">(sets your watch for the year)</span></legend>
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
      </div>

      <input type="text" name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')}
        className="absolute -left-[9999px] h-px w-px opacity-0" aria-hidden="true" />

      <label className="flex cursor-pointer items-start gap-3 px-1 text-[15px] leading-snug">
        <input id="f-consent" type="checkbox" className="mt-0.5 h-5 w-5 shrink-0 accent-[hsl(var(--primary))]" checked={f.consent} onChange={set('consent')} aria-invalid={!!err.consent} />
        <span>I agree that Veshannastro stores my name, number and date of birth to show this answer. The photo is not stored.</span>
      </label>
      {err.consent && <p className="error -mt-3 pl-9">{err.consent}</p>}

      <Turnstile siteKey={config.turnstileSiteKey} onToken={setToken} resetSignal={reset} />
      {err.form && <p className="error rounded-[12px] bg-danger-soft px-4 py-3">{err.form}</p>}

      <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-70">
        {busy ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground" /> Finding your watch…</> : `Show my watch for ${year}`}
      </button>
    </form>
  );
}
