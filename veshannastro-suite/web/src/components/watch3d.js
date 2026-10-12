// The watch overview in 3D: an original steel watch with a blue glitter dial and a stone-set bezel, built from code
// (no model file to download). It turns gently, catches the light, keeps real time, and labels the parts the reading
// looks at (strap, hands, dial colour, numerals, metal), with leader lines that follow the parts as it moves.
// Same file in mobile-numerology and veshannastro-suite (a test keeps the two copies identical).

import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CircleGeometry, Color,
  CylinderGeometry, DirectionalLight, DoubleSide, ExtrudeGeometry, Group, HemisphereLight, IcosahedronGeometry, InstancedMesh,
  MathUtils, Matrix4, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, PerspectiveCamera, PMREMGenerator, Points,
  Quaternion, RingGeometry, Scene, ShaderMaterial, Shape, SphereGeometry, SRGBColorSpace, TorusGeometry, Vector3, WebGLRenderer
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';

const PINK = '#E83E7B', MAROON = '#7A1E3A';
const TAU = Math.PI * 2;

// ---------- The dial: deep blue with fine glitter, a minute track and the brand ----------
function dialTexture(maxAniso) {
  const S = 1024, c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S * 0.45, S * 0.4, S * 0.05, S / 2, S / 2, S / 2);
  grad.addColorStop(0, '#2a5cc0'); grad.addColorStop(0.55, '#173f93'); grad.addColorStop(1, '#0b2259');
  g.fillStyle = grad; g.fillRect(0, 0, S, S);
  // glitter: thousands of tiny flecks in lighter and darker blues
  const flecks = ['#4f86e6', '#7fa8f0', '#0e2b6e', '#a9c4f7', '#ffffff'];
  for (let i = 0; i < 26000; i++) {
    const r = Math.sqrt(Math.random()) * S / 2, a = Math.random() * TAU;
    g.globalAlpha = 0.25 + Math.random() * 0.55;
    g.fillStyle = flecks[(Math.random() * (Math.random() < 0.04 ? 5 : 4)) | 0];
    const s = Math.random() < 0.85 ? 1.5 : 2.5;
    g.fillRect(S / 2 + r * Math.cos(a), S / 2 + r * Math.sin(a), s, s);
  }
  g.globalAlpha = 1;
  // minute track
  g.strokeStyle = 'rgba(225,232,242,0.75)';
  for (let m = 0; m < 60; m++) {
    if (m % 5 === 0) continue;
    const a = (m / 60) * TAU - Math.PI / 2;
    g.lineWidth = 2.5;
    g.beginPath();
    g.moveTo(S / 2 + Math.cos(a) * S * 0.455, S / 2 + Math.sin(a) * S * 0.455);
    g.lineTo(S / 2 + Math.cos(a) * S * 0.475, S / 2 + Math.sin(a) * S * 0.475);
    g.stroke();
  }
  // the monogram under 12: a high-contrast V (thick left stroke, hairline right, fine serifs), as a jeweller
  // would engrave it, in polished silver, under the brand's pink dot
  const cx = S / 2, y0 = S * 0.282, h = 90, k = 1.2;
  const silver = g.createLinearGradient(0, y0, 0, y0 + h);
  silver.addColorStop(0, '#FFFFFF'); silver.addColorStop(0.55, '#DCE3EE'); silver.addColorStop(1, '#AEB9CB');
  g.fillStyle = silver;
  g.shadowColor = 'rgba(4, 14, 40, 0.55)'; g.shadowBlur = 4; g.shadowOffsetY = 2;
  g.beginPath();
  g.moveTo(cx - 31 * k, y0);            // thick stroke, outer top
  g.lineTo(cx - 14 * k, y0);            // thick stroke, inner top
  g.lineTo(cx + 4 * k, y0 + h * 0.74);  // where the two strokes meet inside
  g.lineTo(cx + 26 * k, y0);            // hairline, inner top
  g.lineTo(cx + 31 * k, y0);            // hairline, outer top
  g.lineTo(cx + 4 * k, y0 + h);         // the point
  g.lineTo(cx - 2 * k, y0 + h);
  g.closePath();
  g.fill();
  g.fillRect(cx - 40 * k, y0, 35 * k, 3.5);   // serifs
  g.fillRect(cx + 19 * k, y0, 21 * k, 2.5);
  g.shadowColor = 'transparent'; g.shadowBlur = 0; g.shadowOffsetY = 0;
  g.fillStyle = PINK;
  g.beginPath(); g.arc(cx, S * 0.25, 7, 0, TAU); g.fill();
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = Math.min(8, maxAniso);
  return t;
}

// A hand: tapered, pointed, with a little thickness; pivot at the origin, pointing up (12 o'clock).
function hand(len, base, tip, tail, mat) {
  const s = new Shape();
  s.moveTo(-base / 2, -tail); s.lineTo(base / 2, -tail); s.lineTo(tip / 2, len * 0.9); s.lineTo(0, len); s.lineTo(-tip / 2, len * 0.9); s.closePath();
  const geo = new ExtrudeGeometry(s, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 2, curveSegments: 4 });
  return new Mesh(geo, mat);
}

// Sparkles: glitter on the dial and glints on the stones, as additive star points that flash now and then.
function sparkles(points, colour, size) {
  const n = points.length;
  const pos = new Float32Array(n * 3), phase = new Float32Array(n), speed = new Float32Array(n), sz = new Float32Array(n);
  points.forEach((p, i) => {
    pos.set(p, i * 3);
    phase[i] = Math.random() * TAU; speed[i] = 0.6 + Math.random() * 1.6; sz[i] = size * (0.6 + Math.random() * 0.8);
  });
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('aPhase', new BufferAttribute(phase, 1));
  geo.setAttribute('aSpeed', new BufferAttribute(speed, 1));
  geo.setAttribute('aSize', new BufferAttribute(sz, 1));
  const mat = new ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uScale: { value: 1 }, uColor: { value: new Color(colour) } },
    vertexShader: `
      attribute float aPhase; attribute float aSpeed; attribute float aSize;
      uniform float uTime; uniform float uScale; varying float vA;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float tw = pow(max(0.0, sin(uTime * aSpeed + aPhase)), 14.0);
        vA = tw;
        gl_PointSize = aSize * uScale * (0.35 + tw) / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; varying float vA;
      void main() {
        vec2 p = gl_PointCoord - 0.5;
        float core = smoothstep(0.5, 0.0, length(p));
        float star = max(smoothstep(0.07, 0.0, abs(p.x)) * smoothstep(0.5, 0.0, abs(p.y)),
                         smoothstep(0.07, 0.0, abs(p.y)) * smoothstep(0.5, 0.0, abs(p.x)));
        float a = (core * core * 0.9 + star) * vA;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor * a, a);
      }`,
    transparent: true, depthWrite: false, blending: AdditiveBlending
  });
  return new Points(geo, mat);
}

// still: one frame at 10:10, no labels (used to make the picture shown before the 3D loads).
export function mountWatch(host, { reduced = false, still = false, dark = false } = {}) {
  const INK = dark ? '#FFE9F1' : MAROON, LINE = dark ? '#FFFFFF' : MAROON;
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power', preserveDrawingBuffer: still });
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.92;
  const canvas = renderer.domElement;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;'
    + '-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 13%,#000 87%,transparent 100%);'
    + 'mask-image:linear-gradient(to bottom,transparent 0,#000 13%,#000 87%,transparent 100%);';
  host.appendChild(canvas);

  const scene = new Scene();
  const pmrem = new PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;
  const camera = new PerspectiveCamera(28, 1, 0.1, 50);
  camera.position.set(0, 0, 10.5);

  const key = new DirectionalLight(0xffffff, 1.7);
  scene.add(key, new HemisphereLight(0xfff4f8, 0x2b1020, 0.35));

  const disposables = [];
  const keep = x => (disposables.push(x), x);

  const polished = keep(new MeshPhysicalMaterial({ color: 0xd2d6dc, metalness: 1, roughness: 0.2, clearcoat: 0.3, clearcoatRoughness: 0.12, envMapIntensity: 0.9 }));
  const brushed = keep(new MeshStandardMaterial({ color: 0xaeb3ba, metalness: 1, roughness: 0.52, envMapIntensity: 0.75 }));
  const stoneMat = keep(new MeshPhysicalMaterial({ color: 0xf4f8ff, metalness: 0.3, roughness: 0.0, clearcoat: 1, envMapIntensity: 2.6, flatShading: true, iridescence: 0.6, iridescenceIOR: 1.8 }));
  const pinkMat = keep(new MeshStandardMaterial({ color: PINK, metalness: 0.4, roughness: 0.35 }));

  const watch = new Group();
  scene.add(watch);

  // Case, bezel, stones, flange, crown, lugs
  const caseBody = new Mesh(keep(new CylinderGeometry(1.2, 1.16, 0.26, 128, 1)), polished);
  caseBody.rotation.x = Math.PI / 2; caseBody.position.z = -0.03;
  const bezel = new Mesh(keep(new TorusGeometry(1.1, 0.078, 24, 160)), polished);
  bezel.position.z = 0.11;
  const STONES = 60;
  const stones = new InstancedMesh(keep(new IcosahedronGeometry(0.05, 0)), stoneMat, STONES);
  const m4 = new Matrix4(), q = new Quaternion(), sc = new Vector3(1, 1, 0.7);
  const stonePoints = [];
  for (let i = 0; i < STONES; i++) {
    const a = (i / STONES) * TAU, p = new Vector3(Math.cos(a) * 1.1, Math.sin(a) * 1.1, 0.18);
    q.setFromAxisAngle(new Vector3(Math.random(), Math.random(), Math.random()).normalize(), Math.random() * TAU);
    stones.setMatrixAt(i, m4.compose(p, q, sc));
    stonePoints.push([p.x, p.y, p.z + 0.04]);
  }
  const flange = new Mesh(keep(new RingGeometry(0.99, 1.045, 128)), brushed);
  flange.position.z = 0.135;
  const crown = new Mesh(keep(new CylinderGeometry(0.075, 0.075, 0.14, 32)), polished);
  crown.rotation.z = Math.PI / 2; crown.position.set(1.27, 0, -0.02);
  const crownStone = new Mesh(keep(new SphereGeometry(0.045, 24, 16)), pinkMat);
  crownStone.position.set(1.345, 0, -0.02); crownStone.scale.set(0.6, 1, 1);
  const lugGeo = keep(new RoundedBoxGeometry(0.2, 0.34, 0.16, 3, 0.05));
  const lugs = [[-0.26, 1.13], [0.26, 1.13], [-0.26, -1.13], [0.26, -1.13]].map(([x, y]) => {
    const l = new Mesh(lugGeo, polished); l.position.set(x, y, -0.06); return l;
  });
  watch.add(caseBody, bezel, stones, flange, crown, crownStone, ...lugs);

  // Dial and its glitter
  const dial = new Mesh(keep(new CircleGeometry(1.0, 128)), keep(new MeshStandardMaterial({
    map: keep(dialTexture(renderer.capabilities.getMaxAnisotropy())), metalness: 0.12, roughness: 0.62, envMapIntensity: 0.6
  })));
  dial.position.z = 0.13;
  const glitterPts = [];
  for (let i = 0; i < 420; i++) {
    const r = Math.sqrt(Math.random()) * 0.96, a = Math.random() * TAU;
    glitterPts.push([Math.cos(a) * r, Math.sin(a) * r, 0.135]);
  }
  const glitter = sparkles(glitterPts, '#bcd3ff', 0.05);   // sizes in watch units
  const glints = sparkles(stonePoints, '#ffffff', 0.24);
  watch.add(dial, glitter, glints);

  // Hour markers: polished batons, a double one at 12
  const baton = keep(new BoxGeometry(0.036, 0.17, 0.03));
  const markers = [];
  for (let h = 0; h < 12; h++) {
    const a = (h / 12) * TAU;
    for (const off of h === 0 ? [-0.032, 0.032] : [0]) {
      const m = new Mesh(baton, polished);
      const r = 0.76;
      m.position.set(Math.sin(a) * r + Math.cos(a) * off, Math.cos(a) * r - Math.sin(a) * off, 0.15);
      m.rotation.z = -a;
      watch.add(m); markers.push(m);
    }
  }

  // Hands (real time) and centre cap
  const hourHand = hand(0.5, 0.06, 0.034, 0.06, polished); hourHand.position.z = 0.15;
  const minuteHand = hand(0.78, 0.045, 0.024, 0.07, polished); minuteHand.position.z = 0.168;
  const secondHand = hand(0.86, 0.013, 0.008, 0.2, pinkMat); secondHand.position.z = 0.186;
  const cap = new Mesh(keep(new CylinderGeometry(0.045, 0.045, 0.03, 32)), polished);
  cap.rotation.x = Math.PI / 2; cap.position.z = 0.205;
  const capDot = new Mesh(keep(new CylinderGeometry(0.022, 0.022, 0.032, 24)), pinkMat);
  capDot.rotation.x = Math.PI / 2; capDot.position.z = 0.207;
  watch.add(hourHand, minuteHand, secondHand, cap, capDot);
  [hourHand, minuteHand, secondHand].forEach(h => disposables.push(h.geometry));

  // Crystal: a nearly clear glass that throws a soft reflection
  const crystal = new Mesh(keep(new CircleGeometry(1.03, 96)), keep(new MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.02, transparent: true, opacity: 0.12, clearcoat: 1, envMapIntensity: 1.6, side: DoubleSide
  })));
  crystal.position.z = 0.215;
  crystal.renderOrder = 2;
  watch.add(crystal);

  // Bracelet: three-row links curving away like round a wrist
  const centreGeo = keep(new RoundedBoxGeometry(0.3, 0.23, 0.11, 3, 0.05));
  const sideGeo = keep(new RoundedBoxGeometry(0.19, 0.26, 0.09, 3, 0.04));
  const WRIST_R = 2.6, PITCH = 0.29;
  let strapAnchor = null;
  for (const sign of [1, -1]) {
    for (let i = 0; i < 10; i++) {
      const s = 0.15 + i * PITCH, th = s / WRIST_R;
      const link = new Group();
      const c = new Mesh(centreGeo, polished);
      const l = new Mesh(sideGeo, brushed); l.position.x = -0.26;
      const r = new Mesh(sideGeo, brushed); r.position.x = 0.26;
      link.add(c, l, r);
      link.position.set(0, sign * (1.28 + WRIST_R * Math.sin(th)), -0.06 - WRIST_R * (1 - Math.cos(th)));
      link.rotation.x = -sign * th;
      watch.add(link);
      if (sign === 1 && i === 3) strapAnchor = l;
    }
  }

  // ---------- Labels with leader lines that follow the parts ----------
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none;';
  host.appendChild(svg);
  const LABELS = [
    { text: 'Strap', side: 'left', y: 0.15, obj: () => strapAnchor, at: [0, 0, 0.05] },
    { text: 'Hands', side: 'right', y: 0.29, obj: () => minuteHand, at: [0, 0.5, 0.01] },
    { text: 'Dial colour', side: 'left', y: 0.5, obj: () => dial, at: [-0.45, -0.38, 0] },
    { text: 'Numerals', side: 'right', y: 0.64, obj: () => markers[5], at: [0, 0, 0.02] },
    { text: 'Metal', side: 'left', y: 0.78, obj: () => bezel, at: [-0.8, -0.78, 0.04] }
  ].map((d, i) => {
    const g = document.createElementNS(NS, 'g');
    g.style.cssText = `opacity:0;transition:opacity .4s cubic-bezier(0.23,1,0.32,1) ${reduced ? 0 : 0.3 + i * 0.08}s`;
    const line = document.createElementNS(NS, 'path');
    line.setAttribute('fill', 'none'); line.setAttribute('stroke', LINE); line.setAttribute('stroke-opacity', dark ? '0.4' : '0.45'); line.setAttribute('stroke-width', '1.25');
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('r', '3.2'); dot.setAttribute('fill', PINK);
    const halo = document.createElementNS(NS, 'circle');
    halo.setAttribute('r', '7'); halo.setAttribute('fill', PINK); halo.setAttribute('fill-opacity', '0.18');
    const text = document.createElementNS(NS, 'text');
    text.textContent = d.text;
    text.setAttribute('font-family', 'League Spartan, sans-serif'); text.setAttribute('font-weight', '600'); text.setAttribute('fill', INK);
    text.setAttribute('text-anchor', d.side === 'left' ? 'start' : 'end');
    g.append(line, halo, dot, text);
    svg.appendChild(g);
    return { ...d, g, line, dot, halo, text, local: new Vector3(...d.at) };
  });
  requestAnimationFrame(() => LABELS.forEach(l => { l.g.style.opacity = '1'; }));

  // Each label's text width, measured once per font size (and again once the web font has loaded), never per frame.
  const textWidth = (l, fs) => {
    if (l.fs !== fs) { l.text.setAttribute('font-size', fs); l.w = l.text.getComputedTextLength(); l.fs = fs; }
    return l.w;
  };
  document.fonts?.ready.then(() => LABELS.forEach(l => { l.fs = 0; }));

  const tmp = new Vector3();
  function placeLabels(w, h) {
    const fs = w < 360 ? 13 : 15;
    for (const l of LABELS) {
      tmp.copy(l.local);
      l.obj().localToWorld(tmp);
      tmp.project(camera);
      const ax = (tmp.x * 0.5 + 0.5) * w, ay = (-tmp.y * 0.5 + 0.5) * h;
      const ty = l.y * h;
      const tx = l.side === 'left' ? 2 : w - 2;
      const tw = textWidth(l, fs);
      const ex = l.side === 'left' ? tx + tw + 8 : tx - tw - 8;
      l.text.setAttribute('x', tx); l.text.setAttribute('y', ty + fs * 0.35);
      l.line.setAttribute('d', `M${ex} ${ty} L${(ex + ax) / 2} ${ty} L${ax} ${ay}`);
      l.dot.setAttribute('cx', ax); l.dot.setAttribute('cy', ay);
      l.halo.setAttribute('cx', ax); l.halo.setAttribute('cy', ay);
    }
  }

  // ---------- Size and loop ----------
  let W = 0, H = 0;
  function resize() {
    const r = host.getBoundingClientRect();
    W = Math.max(1, r.width); H = Math.max(1, r.height);
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5); // sharp enough for a moving model, far lighter than 2x
    renderer.setPixelRatio(dpr);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    // keep the case about half the width on narrow boxes
    camera.position.z = W / H < 0.8 ? 10.5 * (0.8 / (W / H)) * 0.92 : 10.5;
    camera.updateProjectionMatrix();
    const scale = H * dpr / (2 * Math.tan(MathUtils.degToRad(camera.fov / 2)));
    glitter.material.uniforms.uScale.value = scale;
    glints.material.uniforms.uScale.value = scale;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();


  let visible = true, raf = 0, scrollingUntil = 0, lastDraw = -1e9;
  // While the page is scrolling, or the phone menu covers it, the watch holds still: the scroll or the menu gets the
  // whole frame budget.
  const onScroll = () => { scrollingUntil = performance.now() + 140; };
  window.addEventListener('scroll', onScroll, { passive: true });
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible && !raf) raf = requestAnimationFrame(frame); });
  io.observe(host);

  const t0 = performance.now();
  // The hands start at 10:10, exactly as in the still picture, and once the picture has faded out (about 0.75s) they
  // sweep to the real time over 0.6s. For reduced motion (and the still picture itself) they stay at 10:10.
  const TEN_TEN = new Date(2026, 0, 1, 10, 10, 31);
  const handAngles = d => {
    const s = d.getSeconds() + d.getMilliseconds() / 1000, m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60;
    return [-(s / 60) * TAU, -(m / 60) * TAU, -(h / 12) * TAU];
  };
  const shortest = a => ((a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  const easeInOut = k => (k < 0.5 ? 8 * k ** 4 : 1 - (-2 * k + 2) ** 4 / 2); // close to cubic-bezier(0.77, 0, 0.175, 1)
  const born = performance.now(), SWEEP_AT = 750, SWEEP = 600;
  function setTime(now = performance.now()) {
    let a = handAngles(still || reduced ? TEN_TEN : new Date());
    const k = (now - born - SWEEP_AT) / SWEEP;
    if (!still && !reduced && k < 1) {
      const from = handAngles(TEN_TEN), e = k <= 0 ? 0 : easeInOut(k);
      a = from.map((f, i) => f + shortest(a[i] - f) * e);
    }
    [secondHand.rotation.z, minuteHand.rotation.z, hourHand.rotation.z] = a;
  }

  function frame(now) {
    raf = 0;
    if (!visible || document.hidden) return;
    // The sway is slow, so 30 frames a second looks the same as 60 for half the work.
    if (!still && (now < scrollingUntil || now - lastDraw < 30 || document.documentElement.dataset.menu === 'open')) { raf = requestAnimationFrame(frame); return; }
    lastDraw = now;
    const t = (now - t0) / 1000;
    setTime(now);
    // At t = 0 the pose matches the still picture, so the switch from picture to 3D is seamless.
    if (!reduced && !still) {
      watch.rotation.y = 0.22 + Math.sin(t * 0.45) * 0.4;
      watch.rotation.x = -0.18 + Math.sin(t * 0.32) * 0.07;
      watch.rotation.z = Math.sin(t * 0.27) * 0.04;
      watch.position.y = Math.sin(t * 0.8) * 0.05;
      key.position.set(3 * Math.cos(t * 0.5), 2 + Math.sin(t * 0.7), 4);
    } else {
      watch.rotation.set(-0.18, 0.22, 0);
      key.position.set(3, 2, 4);
    }
    glitter.material.uniforms.uTime.value = t;
    glints.material.uniforms.uTime.value = t * 1.3;
    renderer.render(scene, camera);
    if (still) { svg.style.display = 'none'; return; }
    placeLabels(W, H);
    if (reduced && t > 0.5) return; // one settled frame; the hands do not need to move for reduced motion
    raf = requestAnimationFrame(frame);
  }
  const onVis = () => { if (!document.hidden && visible && !raf) raf = requestAnimationFrame(frame); };
  document.addEventListener('visibilitychange', onVis);
  raf = requestAnimationFrame(frame);

  return function dispose() {
    cancelAnimationFrame(raf);
    ro.disconnect(); io.disconnect();
    document.removeEventListener('visibilitychange', onVis);
    window.removeEventListener('scroll', onScroll);
    disposables.forEach(d => d.dispose?.());
    [glitter, glints].forEach(p => { p.geometry.dispose(); p.material.dispose(); });
    envRT.dispose(); pmrem.dispose(); renderer.dispose();
    canvas.remove(); svg.remove();
  };
}
