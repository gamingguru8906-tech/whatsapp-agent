import React, { useEffect, useRef, useState } from 'react';
import poster from './watch3d-poster.webp';

// The watch overview: a still picture first (it shows at once), then the 3D watch fades in over it once the page is
// idle. Without WebGL the still picture stays. Same file in mobile-numerology and veshannastro-suite.

function canRender3D() {
  try {
    const c = document.createElement('canvas');
    return Boolean(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch {
    return false;
  }
}

export default function Watch3D({ className = '', dark = false }) {
  const host = useRef(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    // Hidden on this screen size, or no WebGL: keep the still picture and skip the download.
    if (!host.current?.getClientRects().length || !canRender3D()) return undefined;
    let dispose = null, cancelled = false;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const start = () => import('./watch3d.js').then(({ mountWatch }) => {
      if (cancelled || !host.current) return;
      try {
        dispose = mountWatch(host.current, { reduced, dark });
        requestAnimationFrame(() => requestAnimationFrame(() => !cancelled && setLive(true)));
      } catch {
        dispose?.();
        dispose = null;
      }
    }).catch(() => {});
    const idle = window.requestIdleCallback ? window.requestIdleCallback(start, { timeout: 1500 }) : window.setTimeout(start, 400);
    return () => {
      cancelled = true;
      window.cancelIdleCallback ? window.cancelIdleCallback(idle) : window.clearTimeout(idle);
      dispose?.();
    };
  }, []);

  return (
    <div className={`relative aspect-[7/8] ${className}`} role="img"
      aria-label="A steel watch with a blue dial, turning slowly, with its strap, hands, dial colour, numerals and metal labelled">
      <img src={poster} alt="" aria-hidden="true" width="840" height="960" decoding="async"
        className={`absolute inset-0 h-full w-full object-contain transition-opacity duration-700 ${live ? 'opacity-0' : 'opacity-100'}`} />
      <div ref={host} className={`absolute inset-0 transition-opacity duration-700 ${live ? 'opacity-100' : 'opacity-0'}`} />
    </div>
  );
}
