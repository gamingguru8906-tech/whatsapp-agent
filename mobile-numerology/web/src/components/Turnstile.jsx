import React, { useEffect, useRef } from 'react';

// Cloudflare Turnstile: a free, mostly invisible check that stops bots filling the Sheet. Shown only when a site key is configured.
let scriptPromise;
const loadScript = () => scriptPromise ??= new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true;
  s.onload = resolve;
  s.onerror = reject;
  document.head.append(s);
});

export default function Turnstile({ siteKey, onToken, resetSignal }) {
  const box = useRef(null);
  const widget = useRef(null);
  useEffect(() => {
    if (!siteKey) return;
    let gone = false;
    loadScript().then(() => {
      if (gone || !box.current || !window.turnstile) return;
      widget.current = window.turnstile.render(box.current, {
        sitekey: siteKey, appearance: 'interaction-only',
        callback: t => onToken(t), 'expired-callback': () => onToken(''), 'error-callback': () => onToken('')
      });
    }).catch(() => onToken(''));
    return () => { gone = true; if (widget.current && window.turnstile) window.turnstile.remove(widget.current); };
  }, [siteKey]);
  useEffect(() => { if (resetSignal && widget.current && window.turnstile) window.turnstile.reset(widget.current); }, [resetSignal]);
  return siteKey ? <div ref={box} className="min-h-[1px]" /> : null;
}
