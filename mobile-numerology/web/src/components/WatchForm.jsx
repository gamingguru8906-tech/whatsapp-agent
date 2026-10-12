import React, { useEffect, useRef, useState } from 'react';
import { Camera, Check } from 'lucide-react';
import { MONTHS, YEARS, dobFrom, Picker } from './ReadingForm.jsx';
import Turnstile from './Turnstile.jsx';
import { readPhoto, shrinkPhoto, track } from '../api.js';
import { Segmented, Pills, CheckList, Tick } from './ui.jsx';
import { scrollToEl } from '../motion.js';
import attributes from '../../../../brain/data/watch-attributes.json';

// Wristwatch segment: one photo of the watch (read at once, never kept) and two questions the photo cannot answer
// for sure — the strap and the wrist. Everything else on the watch comes from the photo.

const ATTRS = Object.fromEntries(attributes.attributes.map(a => [a.key, a]));
const STRAP_MAIN = ['metal', 'leather', 'rubber', 'silicone', 'fabric'];
// What the photo read, in the order a person looks at a watch.
const SHOW = ['dialColour', 'dialShape', 'caseMetal', 'markers', 'dateWindow', 'hands', 'watchType', 'dialArt'];

function seenLine(watch) {
  return SHOW.filter(k => watch[k] !== undefined).map(k => {
    const a = ATTRS[k], v = watch[k];
    if (k === 'dateWindow') return v === 'none' ? 'No date window' : `${{ date: 'Date', day: 'Day', dayDate: 'Day and date' }[v]} window${watch.datePosition ? ` at ${watch.datePosition}` : ''}`;
    if (k === 'dialArt') return v.map(x => a.options[x]).join(', ');
    if (k === 'dialColour') return `${a.options[v]} dial`;
    if (k === 'dialShape') return `${a.options[v]} shape`;
    if (k === 'caseMetal') return `${a.options[v]} case`;
    if (k === 'hands') return a.options[v];
    return a.options[v];
  });
}

export default function WatchForm({ config, status, errors, onSubmit }) {
  const [f, setF] = useState({ name: '', mobile: '', consent: false, waOptIn: false, website: '' });
  const [dob, setDob] = useState({ day: '', month: '', year: '' });
  const [seen, setSeen] = useState({});          // what the photo read
  const [strap, setStrap] = useState('');
  const [strapFromPhoto, setStrapFromPhoto] = useState(false);
  const [wrist, setWrist] = useState('');
  const [goal, setGoal] = useState([]);          // what they want to improve: one or more suggestions and/or their own words
  const [goalText, setGoalText] = useState('');
  const toggleGoal = k => { setGoal(g => (g.includes(k) ? g.filter(x => x !== k) : [...g, k])); setLocal(l => ({ ...l, goal: undefined })); };
  const [photo, setPhoto] = useState({ state: 'idle', msg: '', preview: null });
  const [token, setToken] = useState('');
  const [reset, setReset] = useState(0);
  const [local, setLocal] = useState({});
  const fileRef = useRef(null);
  const pending = useRef(null);                  // the photo read in progress, so "submit" can wait for it
  const set = k => e => setF(s => ({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const setD = k => e => setDob(s => ({ ...s, [k]: e.target.value }));
  const err = { ...errors, ...local };
  useEffect(() => () => { if (photo.preview) URL.revokeObjectURL(photo.preview); }, [photo.preview]);

  async function onPhoto(e) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    track('watch', 'photo_added');
    setLocal(l => ({ ...l, photo: undefined }));
    setSeen({});
    setPhoto({ state: 'loading', msg: '', preview: URL.createObjectURL(file) });
    const job = (async () => {
      let image;
      try { image = await shrinkPhoto(file); } catch { return { ok: false, error: 'That file could not be opened as a photo. Please try another.' }; }
      return readPhoto(image);
    })();
    pending.current = job;
    const r = await job;
    if (pending.current !== job) return;          // a newer photo was chosen meanwhile
    pending.current = null;
    if (!r.ok || !(r.watch.dialColour || r.watch.dialShape)) {
      setPhoto(p => ({ ...p, state: 'error', msg: r.ok ? 'The dial is not clear in this photo. Please take a closer photo of the watch face.' : r.error }));
      track('watch', 'photo_failed');
      return;
    }
    const { strapMaterial, ...rest } = r.watch;
    setSeen(rest);
    if (strapMaterial && !strap) { setStrap(strapMaterial); setStrapFromPhoto(true); }
    setPhoto(p => ({ ...p, state: 'done', msg: '' }));
    track('watch', 'photo_read', { detail: { filled: r.filled.length } });
  }

  async function submit(e) {
    e.preventDefault();
    const iso = dobFrom(dob);
    const miss = {};
    if (photo.state === 'idle') miss.photo = 'Add a photo of your watch.';
    else if (photo.state === 'error') miss.photo = 'Please add a clearer photo of your watch.';
    if (!strap) miss.strap = 'Choose your strap.';
    if (!wrist) miss.wrist = 'Choose your wrist.';
    if (!goal.length && goalText.trim().length < 3) miss.goal = 'Pick what you would like to improve, or type it.';
    if (f.name.trim().length < 2) miss.name = 'Enter your name.';
    if (f.mobile.replace(/\D/g, '').length < 10) miss.mobile = 'Enter your 10-digit mobile number.';
    if (!iso) miss.dob = 'Choose your day, month and year of birth.';
    else if (iso === 'invalid') miss.dob = 'That date does not exist. Check the day and month.';
    if (!f.consent) miss.consent = 'Tick this box so we can show your reading.';
    setLocal(miss);
    if (Object.keys(miss).length) {
      const id = { photo: 'w-photo', strap: 'w-strap', wrist: 'w-wrist', goal: 'w-goal' }[Object.keys(miss)[0]] ?? `f-${Object.keys(miss)[0]}`;
      document.getElementById(id)?.focus();
      scrollToEl(document.getElementById(id), { block: 'center' });
      return;
    }
    track('watch', 'form_sent');
    // The photo may still be reading: wait for it, so the reading uses everything the photo shows.
    let watch = seen;
    if (pending.current) {
      const r = await pending.current;
      if (!r.ok) return;
      const { strapMaterial, ...rest } = r.watch; watch = rest;
    }
    const ok = await onSubmit({ ...f, dob: iso, watch: { ...watch, strapMaterial: strap, wrist, ...(goal.length ? { goal } : {}) }, goalText: goalText.trim(), turnstileToken: token });
    if (!ok) setReset(r => r + 1);
  }

  const busy = status === 'loading';
  const lines = seenLine(seen);
  const strapOther = strap && !STRAP_MAIN.includes(strap);
  return (
    <form onSubmit={submit} noValidate aria-labelledby="form-title" className="grid min-w-0 grid-cols-1 gap-5">
      <div>
        <h2 id="form-title" className="t-section">Get your free watch reading</h2>
        <p className="mt-1 text-[15px] text-muted-foreground">A photo of your watch and two quick answers. Your reading appears right here.</p>
      </div>

      <div className="group-card rows shadow-soft">
        <div className="row flex flex-wrap items-center gap-x-4 gap-y-3 py-4 sm:flex-nowrap">
          {photo.preview
            ? <img src={photo.preview} alt="Your watch photo" className="h-16 w-16 shrink-0 sm:h-20 sm:w-20 rounded-[16px] object-cover" />
            : <span className="grid h-16 w-16 shrink-0 place-items-center rounded-[16px] bg-primary-soft sm:h-20 sm:w-20 text-primary-dark"><Camera size={30} aria-hidden="true" /></span>}
          <div className="min-w-0 flex-1 basis-[10rem]">
            <p className="t-headline">{photo.state === 'loading' ? 'Reading your watch…' : photo.state === 'done' ? 'Your watch' : 'Photo of your watch'}</p>
            <p className="t-note mt-0.5">{photo.state === 'done' ? 'Read from your photo.' : 'The watch face, straight on, in good light. The photo is never kept.'}</p>
          </div>
          <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPhoto} aria-label="Choose a photo of your watch" />
          <button id="w-photo" type="button" onClick={() => fileRef.current?.click()} disabled={photo.state === 'loading'}
            className={`min-h-[44px] w-full shrink-0 px-4 text-[15px] disabled:opacity-70 sm:w-auto ${photo.preview ? 'btn-plain bg-card shadow-[0_0_0_1px_hsl(var(--border))]' : 'btn-primary'}`}>
            {photo.state === 'loading' ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary/30 border-t-primary" aria-label="Reading" /> : photo.preview ? 'Change' : 'Add photo'}
          </button>
        </div>
        {lines.length > 0 && (
          <ul className="row flex flex-wrap gap-x-4 gap-y-1.5" aria-label="What we see in your photo">
            {lines.map(l => <li key={l} className="flex items-center gap-1.5 font-ui text-[15px] tracking-[-0.01em] text-foreground/85"><Check size={15} className="shrink-0 text-success-dark" aria-hidden="true" />{l}</li>)}
          </ul>
        )}
        {(photo.msg || err.photo) && <p role="alert" className="row text-[15px] text-danger-dark">{photo.msg || err.photo}</p>}

        <div className="row">
          <div className="flex items-baseline justify-between gap-2">
            <p className="field-label" id="w-strap-label">Strap</p>
            {strapFromPhoto && <span className="chip mb-1 shrink-0 bg-accent-soft text-warning-dark">From photo · check</span>}
          </div>
          <Pills id="w-strap" label="Strap" value={strap} invalid={!!err.strap} onChange={k => { setStrap(k); setStrapFromPhoto(false); }}
            options={[...STRAP_MAIN.map(k => [k, ATTRS.strapMaterial.options[k]]), ...(strapOther ? [[strap, ATTRS.strapMaterial.options[strap]]] : [])]} />
          {!strapOther && (
            <select aria-label="Other strap" value="" onChange={e => { if (e.target.value) { setStrap(e.target.value); setStrapFromPhoto(false); } }}
              className="mt-2.5 cursor-pointer bg-transparent text-[15px] font-medium text-primary-dark">
              <option value="">Something else…</option>
              {Object.entries(ATTRS.strapMaterial.options).filter(([k]) => !STRAP_MAIN.includes(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          )}
          {err.strap && <p className="error">{err.strap}</p>}
        </div>
        <div className="row">
          <p className="field-label">Which wrist do you wear it on?</p>
          <Segmented id="w-wrist" label="Wrist" value={wrist} invalid={!!err.wrist} onChange={setWrist} options={Object.entries(ATTRS.wrist.options)} />
          {err.wrist && <p className="error">{err.wrist}</p>}
        </div>
      </div>

      <div id="w-goal" tabIndex={-1}>
        <h3 className="mb-2 px-1 font-display text-[17px] font-semibold tracking-[-0.01em] text-maroon">{ATTRS.goal.q}</h3>
        <CheckList label={ATTRS.goal.q} values={goal} onToggle={toggleGoal} invalid={!!err.goal}
          options={Object.entries(ATTRS.goal.options)} />
        <div className={`group-card mt-2 px-4 py-3 transition-[box-shadow] duration-200 sm:px-5 ${goalText.trim() ? 'ring-2 ring-primary/70' : err.goal ? 'ring-1 ring-danger/60' : ''}`}>
          <label htmlFor="f-goal" className="sr-only">Something else you would like to improve</label>
          <input id="f-goal" className="field text-[16px]" maxLength={120} placeholder="Or type your own"
            value={goalText} onChange={e => { setGoalText(e.target.value); setLocal(l => ({ ...l, goal: undefined })); }} />
        </div>
        {err.goal && <p className="error px-1">{err.goal}</p>}
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
      </div>

      <input type="text" name="website" tabIndex={-1} autoComplete="off" value={f.website} onChange={set('website')}
        className="absolute -left-[9999px] h-px w-px opacity-0" aria-hidden="true" />

      <div className="grid gap-3 px-1">
        <Tick id="f-consent" checked={f.consent} onChange={set('consent')} invalid={!!err.consent}>
          I agree that Veshannastro stores my name, number, date of birth and my watch details, to show this reading. <a href="/privacy" target="_blank" className="font-medium text-primary-dark">Privacy policy</a> · <a href="/terms" target="_blank" className="font-medium text-primary-dark">Terms</a>
        </Tick>
        {err.consent && <p className="error -mt-1 pl-9">{err.consent}</p>}
        <Tick id="f-wa" checked={f.waOptIn} onChange={set('waOptIn')}>
          Send me updates and offers on WhatsApp <span className="text-muted-foreground">(optional)</span>
        </Tick>
      </div>

      <Turnstile siteKey={config.turnstileSiteKey} onToken={setToken} resetSignal={reset} />
      {err.form && <p role="alert" className="error rounded-[12px] bg-danger-soft px-4 py-3">{err.form}</p>}

      <button type="submit" disabled={busy} className="btn-primary w-full disabled:opacity-70">
        {busy ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground/40 border-t-primary-foreground" /> Reading your watch…</> : 'Show my watch reading'}
      </button>
    </form>
  );
}
