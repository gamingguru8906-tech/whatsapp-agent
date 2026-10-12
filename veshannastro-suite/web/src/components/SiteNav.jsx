import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronRight, Mail, Menu, Phone, X } from 'lucide-react';
import { Lockup } from './Brand.jsx';

// Navigation shared by the two sites (main page and readings site): the phone menu, the footer and the contact
// details. Same file in mobile-numerology and veshannastro-suite (a test keeps the copies identical).

export const SUITE = 'https://veshannastro-suite.veshannastro.workers.dev';
export const READINGS = 'https://veshannastro-numerology.veshannastro.workers.dev';
export const MAIN_SITE = 'https://www.veshannastro.co.in';

// One number for calls and WhatsApp, one email, everywhere on both sites.
export const CONTACT = {
  phone: '+917646952745', phoneLabel: '+91 76469 52745',
  email: 'veshannastro7@gmail.com',
  whatsapp: '917646952745', whatsappLabel: '+91 76469 52745'
};
export const waLink = (text, ref) => `https://wa.me/${CONTACT.whatsapp}?text=${encodeURIComponent(`${text} (Ref: ${ref})`)}`;

const FIRST_YEAR = 2025;

const WaGlyph = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18a8 8 0 0 1-4.1-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8 8 0 1 1 12 20Z" /></svg>
);

// Links for each site. On its own site a page is a plain path (in-page navigation picks it up); across sites, a full URL.
export function siteLinks(site) {
  const r = path => (site === 'readings' ? path : READINGS + path);
  const s = hash => (site === 'suite' ? hash : `${SUITE}/${hash}`);
  return {
    readings: [
      ['Read my watch', r('/watch')],
      ['Which watch should I wear this year?', r('/watch/year')],
      ['Mobile number reading', r('/')],
      ['My readings', r('/my')]
    ],
    about: [
      ['How the watch reading works', s('#how')],
      ['All readings', s('#readings')],
      ['Who reads your numbers', s('#about')],
      ['veshannastro.co.in', MAIN_SITE]
    ]
  };
}

function ContactRow({ refCode, onPick }) {
  return (
    <div className="grid gap-2">
      <a href={waLink('Hi, I would like a watch and numerology consultation.', refCode)} target="_blank" rel="noopener noreferrer"
        onClick={onPick} className="btn-whatsapp w-full"><WaGlyph size={20} />Consult on WhatsApp</a>
      <div className="grid grid-cols-2 gap-2">
        <a href={`tel:${CONTACT.phone}`} onClick={onPick} className="sitenav-chip"><Phone size={17} aria-hidden="true" />Call us</a>
        <a href={`mailto:${CONTACT.email}`} onClick={onPick} className="sitenav-chip"><Mail size={17} aria-hidden="true" />Email us</a>
      </div>
    </div>
  );
}

/** The menu button for phones (hidden from sm up) and the sheet it opens. */
export function MobileMenu({ site, refCode = 'WEB-MENU', className = '' }) {
  const [open, setOpen] = useState(false);
  const button = useRef(null);
  const sheet = useRef(null);
  const id = useId();
  const links = siteLinks(site);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = e => { if (e.key === 'Escape') setOpen(false); };
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = 'hidden'; // the page behind stays still while the menu is open
    document.addEventListener('keydown', onKey);
    // The sheet and its shade start right under the header (the two sites' headers differ in height).
    const top = Math.round(button.current?.closest('header')?.getBoundingClientRect().bottom ?? 64);
    sheet.current?.parentElement?.style.setProperty('--sitenav-top', `${top}px`);
    requestAnimationFrame(() => sheet.current?.querySelector('a')?.focus({ preventScroll: true }));
    return () => {
      html.style.overflow = before;
      document.removeEventListener('keydown', onKey);
      button.current?.focus({ preventScroll: true });
    };
  }, [open]);

  const close = () => setOpen(false);
  return (
    <div className={`sm:hidden ${className}`}>
      <button ref={button} type="button" aria-expanded={open} aria-controls={id} aria-label={open ? 'Close menu' : 'Open menu'}
        onClick={() => setOpen(o => !o)} className="sitenav-toggle">
        {open ? <X size={22} aria-hidden="true" /> : <Menu size={22} aria-hidden="true" />}
      </button>
      <div className={`sitenav-backdrop ${open ? 'is-open' : ''}`} onClick={close} aria-hidden="true" />
      <nav id={id} ref={sheet} aria-label="Menu" className={`sitenav-sheet ${open ? 'is-open' : ''}`} inert={open ? undefined : ''}>
        <p className="sitenav-head">Readings</p>
        <ul>{links.readings.map(([label, href]) => <li key={href}><a href={href} onClick={close}>{label}</a></li>)}</ul>
        <p className="sitenav-head">Veshannastro</p>
        <ul>{links.about.map(([label, href]) => <li key={href}><a href={href} onClick={close}>{label}</a></li>)}</ul>
        <div className="mt-5"><ContactRow refCode={refCode} onPick={close} /></div>
        <p className="mt-4 flex gap-5 text-[14px]">
          <a href="/privacy" onClick={close} className="text-muted-foreground">Privacy policy</a>
          <a href="/terms" onClick={close} className="text-muted-foreground">Terms and conditions</a>
        </p>
      </nav>
    </div>
  );
}

/**
 * The footer: a contact card (email, call, WhatsApp, each one tap), then the
 * site links, then the copyright and legal links. `children` adds a site's own notes (disclaimer, what we store).
 */
export function SiteFooter({ site, refCode = 'WEB-FOOTER', children }) {
  const links = siteLinks(site);
  const year = new Date().getFullYear();
  const wa = waLink('Hi, I would like a watch and numerology consultation.', refCode);
  const rows = [
    { href: `mailto:${CONTACT.email}`, icon: <Mail size={20} aria-hidden="true" />, label: 'Email',
      value: <>{CONTACT.email.split('@')[0]}@<wbr />{CONTACT.email.split('@')[1]}</> }, // on a narrow phone it breaks after the @
    { href: `tel:${CONTACT.phone}`, icon: <Phone size={20} aria-hidden="true" />, label: 'Call', value: CONTACT.phoneLabel },
    { href: wa, icon: <WaGlyph size={20} />, label: 'WhatsApp', value: CONTACT.whatsappLabel, external: true, wa: true }
  ];
  const col = (title, items) => (
    <div>
      <p className="sitenav-foothead">{title}</p>
      <ul className="mt-2 grid gap-1.5">
        {items.map(([label, href]) => <li key={href}><a href={href} className="sitenav-footlink inline-block">{label}</a></li>)}
      </ul>
    </div>
  );
  return (
    <footer className="site-footer">
      <div className="mx-auto max-w-5xl px-5 pb-10 pt-24">
        <section className="footer-card" aria-labelledby="footer-contact">
          <div className="grid grid-cols-1 gap-7 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] md:items-center md:gap-10">
            <div>
              <p className="footer-eyebrow">Contact</p>
              <h2 id="footer-contact" className="footer-title">Talk to Veshannastro</h2>
              <p className="mt-3 max-w-[26rem] text-[16px] leading-relaxed text-muted-foreground">
                Questions about your watch, your numbers or a consultation. Write to us, call, or message us on WhatsApp.
              </p>
            </div>
            <ul className="footer-rows">
              {rows.map(r => (
                <li key={r.label}>
                  <a href={r.href} {...(r.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} className="footer-row">
                    <span className={`footer-row-icon ${r.wa ? 'is-wa' : ''}`}>{r.icon}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">{r.label}</span>
                      <span className="block font-display text-[16px] font-semibold text-foreground [overflow-wrap:break-word] min-[380px]:text-[18px]">{r.value}</span>
                    </span>
                    <ChevronRight size={20} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <div className="mt-12 grid grid-cols-1 gap-9 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-3 text-[14px] leading-relaxed text-muted-foreground">
            <Lockup size={26} />
            {children}
          </div>
          {col('Readings', links.readings)}
          {col('Veshannastro', links.about)}
        </div>

        <div className="sitenav-copy flex flex-wrap gap-x-5 gap-y-2">
          <span>© {year > FIRST_YEAR ? `${FIRST_YEAR}–${year}` : year} Veshannastro · All rights reserved</span>
          <a href="/privacy" className="sitenav-footlink p-0 text-[13px]">Privacy policy</a>
          <a href="/terms" className="sitenav-footlink p-0 text-[13px]">Terms and conditions</a>
        </div>
      </div>
    </footer>
  );
}
