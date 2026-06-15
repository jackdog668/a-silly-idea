/* =========================================================================
   A SILLY IDEA — the field engine
   ------------------------------------------------------------------------
   One canvas, one global scroll-progress value (0 → 1), five phases:

     0  seed       a single ember in the dark
     1  scatter    a few drift loose
     2  avalanche  it catches — particles multiply and cascade
     3  wave       they snap into a moving rhythm
     4  network    they settle into a connected constellation (a "we")

   The smoothness comes from DECOUPLING: scroll sets a *target* progress,
   but everything the eye sees eases toward its target on the animation
   clock. Janky wheel input still reads as butter.
   ========================================================================= */

(() => {
  "use strict";

  const canvas = document.getElementById("field");
  const ctx = canvas.getContext("2d", { alpha: true });

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- tunables -----------------------------------------------------------
  const PHASES = ["seed", "scatter", "avalanche", "wave", "network"];
  const PHASE_LABELS = ["the spark", "the spark", "the avalanche", "the wave", "the we"];

  let W = 0, H = 0, DPR = 1;
  let particles = [];
  let COUNT = 0;

  // progress: target follows scroll, shown eases toward it
  let targetProgress = 0;
  let shownProgress = 0;

  // pointer (for gentle parallax)
  const pointer = { x: 0.5, y: 0.5, active: false };

  // user-added sparks (ephemeral, client-side only)
  let userSparks = [];

  // idea-constellation: activation level (0..1) eased from scroll in the loop,
  // and the cap on how many recent ideas become bright interactive stars.
  let constActive = 0;
  // focus-fade (0 overview → 1 fully zoomed into a star); the constellation
  // sets it from the camera each frame, the loop uses it to dim the ambient
  // field so a focused idea sits clean and readable on near-black.
  let constFocusFade = 0;
  const MAX_STARS = 150;

  // -------------------------------------------------------------------------
  // sizing
  // -------------------------------------------------------------------------
  function resize() {
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.floor(W * DPR);
    canvas.height = Math.floor(H * DPR);
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

    // particle count scales with screen area, capped for 60fps
    const area = W * H;
    COUNT = Math.max(90, Math.min(360, Math.round(area / 5200)));

    buildParticles();
    constellation.relayout();
  }

  // -------------------------------------------------------------------------
  // particle construction — each holds a home position for every phase
  // -------------------------------------------------------------------------
  function rand(a, b) { return a + Math.random() * (b - a); }

  function buildParticles() {
    particles = [];
    const cx = W * 0.5;
    const cy = H * 0.42;

    for (let i = 0; i < COUNT; i++) {
      // seed: nearly all collapsed onto the central ember
      const seed = { x: cx + rand(-2, 2), y: cy + rand(-2, 2) };

      // scatter: a loose drift around the centre
      const sa = rand(0, Math.PI * 2);
      const sr = rand(20, Math.min(W, H) * 0.22);
      const scatter = { x: cx + Math.cos(sa) * sr, y: cy + Math.sin(sa) * sr * 0.7 };

      // avalanche: wide spread, biased downward like falling snow/embers
      const avalanche = {
        x: rand(W * 0.06, W * 0.94),
        y: rand(H * 0.1, H * 0.96),
      };

      // wave: distributed across width, y resolved live in the loop
      const waveX = (i / COUNT) * (W * 0.92) + W * 0.04;
      const wave = { x: waveX, y: cy, phase: rand(0, Math.PI * 2) };

      // network: stable scattered constellation across the whole field
      const network = {
        x: rand(W * 0.05, W * 0.95),
        y: rand(H * 0.08, H * 0.92),
      };

      // when this particle "is born" — staggers the multiplication feel.
      // a handful exist from the very start; most ignite during the avalanche.
      const birth = i === 0 ? 0 : (i < 6 ? rand(0.04, 0.18) : rand(0.2, 0.5));

      particles.push({
        seed, scatter, avalanche, wave, network,
        x: seed.x, y: seed.y,
        vx: 0, vy: 0,
        birth,
        size: rand(0.8, 2.2),
        twk: rand(0, Math.PI * 2),     // twinkle offset
        tws: rand(0.6, 1.8),           // twinkle speed
        wob: rand(0.3, 1.1),           // drift wobble amount
      });
    }
  }

  // -------------------------------------------------------------------------
  // easing + colour helpers
  // -------------------------------------------------------------------------
  const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

  // map global progress (0..1) onto a 0..(PHASES-1) float position
  function phaseFloat(p) { return clamp01(p) * (PHASES.length - 1); }

  // warm ember → cool starlight as the idea becomes a movement
  function fieldColor(p) {
    // ember (255,157,77) → starlight (207,227,255)
    const t = easeInOut(clamp01((p - 0.45) / 0.5)); // shift mostly in back half
    const r = Math.round(lerp(255, 207, t));
    const g = Math.round(lerp(157, 227, t));
    const b = Math.round(lerp(77, 255, t));
    return { r, g, b };
  }

  // -------------------------------------------------------------------------
  // per-phase target for a particle at a given phase-float
  // -------------------------------------------------------------------------
  function targetFor(pt, pf, time) {
    const idx = Math.floor(pf);
    const frac = pf - idx;
    const a = PHASES[idx];
    const b = PHASES[Math.min(idx + 1, PHASES.length - 1)];

    const posA = resolvePhasePos(pt, a, time);
    const posB = resolvePhasePos(pt, b, time);
    const t = easeInOut(frac);
    return { x: lerp(posA.x, posB.x, t), y: lerp(posA.y, posB.y, t) };
  }

  function resolvePhasePos(pt, phase, time) {
    switch (phase) {
      case "seed":     return pt.seed;
      case "scatter":  return pt.scatter;
      case "avalanche":return pt.avalanche;
      case "wave": {
        const amp = H * 0.16;
        const y = H * 0.42 + Math.sin(pt.wave.x * 0.012 + time * 1.4 + pt.wave.phase) * amp;
        return { x: pt.wave.x, y };
      }
      case "network":  return pt.network;
      default:         return pt.seed;
    }
  }

  // -------------------------------------------------------------------------
  // the loop
  // -------------------------------------------------------------------------
  let t0 = null;
  function frame(ts) {
    if (t0 === null) t0 = ts;
    const time = (ts - t0) / 1000;

    // Self-heal: the very first measurement can land before the browser
    // reports real viewport dimensions (headless / early DOMContentLoaded),
    // which would leave the field built at 0×0. Re-measure every frame and
    // rebuild only when the size genuinely changed.
    const vw = window.innerWidth, vh = window.innerHeight;
    if (vw > 0 && vh > 0 && (vw !== W || vh !== H)) {
      resize();
      onScroll();
    }
    if (W === 0 || H === 0) { requestAnimationFrame(frame); return; }

    // ease shown progress toward target (the butter)
    shownProgress += (targetProgress - shownProgress) * (reduceMotion ? 1 : 0.06);
    const p = shownProgress;
    const pf = phaseFloat(p);
    const col = fieldColor(p);

    // the idea-constellation fades in over the final stretch of the scroll
    constActive = clamp01((p - 0.8) / 0.12);

    // fade the scroll rail + phase label out so the bare sky is full-bleed
    const chromeFade = (1 - clamp01(constActive * 1.5)).toFixed(2);
    if (railEl) railEl.style.opacity = chromeFade;
    if (phaseLabel) phaseLabel.style.opacity = chromeFade;

    ctx.clearRect(0, 0, W, H);

    // pointer parallax offset (subtle)
    const px = (pointer.x - 0.5);
    const py = (pointer.y - 0.5);
    const parallax = pointer.active ? 18 : 0;

    // the ambient web stays PRESENT in the finale (the big constellation you
    // roam) and only fades right out when you dive into a single star.
    const linkAlpha = clamp01((p - 0.62) / 0.3) * (1 - 0.55 * constActive) * (1 - 0.95 * constFocusFade);

    // ---- update positions ----
    for (let i = 0; i < particles.length; i++) {
      const pt = particles[i];
      const tgt = targetFor(pt, pf, time);

      // gentle idle wobble so nothing ever looks frozen
      const wob = reduceMotion ? 0 : Math.sin(time * pt.tws + pt.twk) * pt.wob;

      const dx = (tgt.x + px * parallax * pt.wob) - pt.x;
      const dy = (tgt.y + wob + py * parallax * pt.wob) - pt.y;

      // spring toward target
      pt.vx = pt.vx * 0.82 + dx * 0.045;
      pt.vy = pt.vy * 0.82 + dy * 0.045;
      pt.x += pt.vx;
      pt.y += pt.vy;
    }

    // ---- draw connections (grid neighbour search, only when relevant) ----
    if (linkAlpha > 0.01) drawLinks(col, linkAlpha, p);

    // ---- draw particles ----
    for (let i = 0; i < particles.length; i++) {
      const pt = particles[i];

      // birth fade-in. Particles with birth <= 0 are the original ember(s) —
      // always lit, so the hero shows a single glow even at p === 0.
      const born = pt.birth <= 0 ? 1 : clamp01((p - pt.birth) / 0.06);
      if (born <= 0) continue;

      const twinkle = reduceMotion ? 1 : 0.7 + 0.3 * Math.sin(time * pt.tws + pt.twk);
      // ambient particles remain as the rich constellation backdrop in the
      // finale, then fade out when you dive into a star.
      const alpha = born * twinkle * (1 - 0.45 * constActive) * (1 - 0.9 * constFocusFade);
      if (alpha <= 0.01) continue;
      const r = pt.size * (0.9 + born * 0.5);

      // soft glow
      ctx.beginPath();
      ctx.fillStyle = `rgba(${col.r},${col.g},${col.b},${alpha * 0.18})`;
      ctx.arc(pt.x, pt.y, r * 4.5, 0, Math.PI * 2);
      ctx.fill();

      // core
      ctx.beginPath();
      ctx.fillStyle = `rgba(${col.r},${col.g},${col.b},${alpha})`;
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- draw user sparks (ephemeral, brighter, always lit) ----
    drawUserSparks(time, col);

    // ---- draw the idea-constellation on top (the finale) ----
    constellation.draw(time);

    requestAnimationFrame(frame);
  }

  // -------------------------------------------------------------------------
  // grid-based neighbour connections (keeps it ~O(n) instead of O(n²))
  // -------------------------------------------------------------------------
  const LINK_DIST = 130;
  function drawLinks(col, strength, p) {
    const cell = LINK_DIST;
    const cols = Math.ceil(W / cell) + 1;
    const grid = new Map();

    for (let i = 0; i < particles.length; i++) {
      const pt = particles[i];
      if (p < pt.birth) continue;
      const gx = Math.floor(pt.x / cell);
      const gy = Math.floor(pt.y / cell);
      const key = gx + gy * cols;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(pt);
    }

    ctx.lineWidth = 1;
    for (let i = 0; i < particles.length; i++) {
      const a = particles[i];
      if (p < a.birth) continue;
      const gx = Math.floor(a.x / cell);
      const gy = Math.floor(a.y / cell);

      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const bucket = grid.get((gx + ox) + (gy + oy) * cols);
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k++) {
            const b = bucket[k];
            if (b === a || b.x < a.x) continue; // dedupe pairs
            const ddx = a.x - b.x;
            const ddy = a.y - b.y;
            const d2 = ddx * ddx + ddy * ddy;
            if (d2 > LINK_DIST * LINK_DIST) continue;
            const d = Math.sqrt(d2);
            const al = (1 - d / LINK_DIST) * strength * 0.5;
            if (al <= 0.01) continue;
            ctx.strokeStyle = `rgba(${col.r},${col.g},${col.b},${al})`;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.stroke();
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // user sparks
  // -------------------------------------------------------------------------
  function addUserSpark() {
    userSparks.push({
      x: rand(W * 0.2, W * 0.8),
      y: rand(H * 0.2, H * 0.7),
      vx: rand(-0.3, 0.3),
      vy: rand(-0.3, 0.3),
      born: performance.now(),
      size: rand(2.2, 3.6),
    });
    if (userSparks.length > 60) userSparks.shift();
  }

  function drawUserSparks(time, col) {
    for (let i = 0; i < userSparks.length; i++) {
      const s = userSparks[i];
      s.x += s.vx; s.y += s.vy;
      s.vx *= 0.99; s.vy *= 0.99;
      const pulse = 0.75 + 0.25 * Math.sin(time * 2 + i);

      ctx.beginPath();
      ctx.fillStyle = `rgba(255,205,140,${0.16 * pulse})`;
      ctx.arc(s.x, s.y, s.size * 6, 0, Math.PI * 2);
      ctx.fill();

      ctx.beginPath();
      ctx.fillStyle = `rgba(255,225,190,${pulse})`;
      ctx.arc(s.x, s.y, s.size, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // -------------------------------------------------------------------------
  // scroll → progress, plus UI side-effects (rail, counter, phase label)
  // -------------------------------------------------------------------------
  const railFill = document.getElementById("railFill");
  const railEl = document.querySelector(".rail");
  const counterEl = document.getElementById("counter");
  const phaseLabel = document.getElementById("phaseLabel");

  function onScroll() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    targetProgress = max > 0 ? clamp01(window.scrollY / max) : 0;

    railFill.style.height = (targetProgress * 100).toFixed(2) + "%";

    // phase label
    const idx = Math.round(phaseFloat(targetProgress));
    phaseLabel.textContent = PHASE_LABELS[idx];

    updateCounter(targetProgress);
  }

  // counter climbs on an eased exponential so it feels like it's accelerating
  let counterShown = 1;
  function updateCounter(p) {
    // climbs through the proof-stories section and tops out near the end
    const t = clamp01((p - 0.14) / 0.72);
    const eased = Math.pow(t, 2.4);
    const target = Math.round(1 + eased * 2_400_000);
    counterShown += (target - counterShown) * 0.2;
    if (counterEl) counterEl.textContent = Math.round(counterShown).toLocaleString("en-US");
  }

  // -------------------------------------------------------------------------
  // reveal-on-scroll for text panels
  // -------------------------------------------------------------------------
  function initReveals() {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.25 }
    );
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
  }

  // -------------------------------------------------------------------------
  // the idea-constellation — every recent idea is a star you can read; a freshly
  // submitted one flies up from the form and settles among the others.
  // -------------------------------------------------------------------------
  const constellation = (() => {
    let stars = [];
    let hovered = null;
    let pinned = null;
    let pinnedUntil = 0;
    const tip = document.getElementById("ideaTip");

    // ---- camera (decoupled-target easing, the project's signature trick) ----
    // (cam.x, cam.y) = the WORLD point pinned to screen centre; cam.zoom scales.
    const cam = { zoom: 1, x: 0, y: 0, tZoom: 1, tx: 0, ty: 0 };
    let camInit = false;
    const CAM_K = 0.085;          // ease rate
    const FOCUS_ZOOM = 3.2;       // zoom level when a star is focused
    const ZOOM_OPEN_PANEL = 2.1;  // the idea "page" fades in past this zoom

    // ---- view state machine: overview → flying-in → focused → flying-out ----
    let view = "overview";
    let focusStar = null;
    let focusNeighbors = [];
    const TAU = 0.35, ORBIT_K = 6, R_NEAR = 70, R_FAR = 150, ECLIPTIC = 0.62;

    // screen ↔ world (exact inverses — the #1 bug-risk pair; asserted in tests)
    function screenToWorld(sx, sy) {
      return { x: (sx - W / 2) / cam.zoom + cam.x, y: (sy - H / 2) / cam.zoom + cam.y };
    }
    function worldToScreen(wx, wy) {
      return { x: (wx - cam.x) * cam.zoom + W / 2, y: (wy - cam.y) * cam.zoom + H / 2 };
    }

    // ---- deterministic per-star "personality" (depth / breath / drift) ----
    function seededUnit(id, salt) {
      const str = String(id) + ":" + salt;
      let h = 2166136261 >>> 0;
      for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
      h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
      return ((h >>> 0) % 100000) / 100000;
    }
    function drift(t, a, b) {
      return Math.sin(t * 0.13 + a) * 0.6 + Math.sin(t * 0.27 + b) * 0.3 + Math.sin(t * 0.07 + a * 1.7) * 0.5;
    }

    // ---- cached glow sprites (one per age bucket) → drawImage beats per-frame gradients ----
    const GLOW_BUCKETS = 6;
    let glowSprites = null;
    function buildGlowSprites() {
      glowSprites = [];
      for (let b = 0; b < GLOW_BUCKETS; b++) {
        const t = b / (GLOW_BUCKETS - 1);
        const cr = Math.round(lerp(255, 190, t)), cg = Math.round(lerp(170, 214, t)), cb = Math.round(lerp(90, 255, t));
        const size = 64;
        const c = document.createElement("canvas"); c.width = c.height = size;
        const g = c.getContext("2d");
        const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        grad.addColorStop(0, `rgba(${cr},${cg},${cb},0.85)`);
        grad.addColorStop(0.35, `rgba(${cr},${cg},${cb},0.22)`);
        grad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        g.fillStyle = grad; g.fillRect(0, 0, size, size);
        glowSprites.push(c);
      }
    }
    function glowFor(t) {
      const i = Math.max(0, Math.min(GLOW_BUCKETS - 1, Math.round(t * (GLOW_BUCKETS - 1))));
      return glowSprites[i];
    }

    let drawOrder = []; // star indices sorted far→near (painter's algorithm for depth)
    function rebuildDepthOrder() {
      drawOrder = stars.map((_, i) => i).sort((a, b) => stars[a].z - stars[b].z);
      if (!glowSprites) buildGlowSprites();
    }

    // ---- placement: prefer the server's semantic coords; else spiral fallback ----
    function semanticToWorld(sx, sy) {            // server [-1,1] → canvas px (0.8 squash = wide sky)
      const R = Math.min(W, H) * 0.46;
      return { x: W * 0.5 + sx * R, y: H * 0.5 + sy * R * 0.8 };
    }
    function spiralHome(i, n) {                   // cold-start golden-angle spiral (the old layout)
      const cx = W * 0.5, cy = H * 0.5;
      const golden = Math.PI * (3 - Math.sqrt(5));
      const maxR = Math.min(W, H) * 0.44;
      const denom = Math.max(n, 14);
      const r = Math.max(Math.min(W, H) * 0.06, Math.sqrt(i / denom) * maxR);
      const a = i * golden;
      return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.8 };
    }
    function home(i, n, idea) {
      if (idea && typeof idea.x === "number" && typeof idea.y === "number") {
        return semanticToWorld(idea.x, idea.y);
      }
      return spiralHome(i, n);
    }
    // age (0 newest → 1 oldest) across the actual set, for the ember→starlight tint
    function ageT(i, n) { return i / Math.max(n - 1, 1); }

    function relayout() {
      const n = stars.length;
      for (let i = 0; i < n; i++) {
        const s = stars[i];
        const h = home(i, n, s._idea);
        s.hx = h.x; s.hy = h.y; s.t = ageT(i, n);
      }
      rebuildDepthOrder();
      reaim();
    }

    function makeStar(idea, i, n) {
      const h = home(i, n, idea);
      return {
        id: idea.id, text: idea.text, name: idea.name || "", created_at: idea.created_at,
        hx: h.x, hy: h.y, x: h.x, y: h.y, vx: 0, vy: 0,
        t: ageT(i, n), born: 1, fly: null, pulse: 0,
        z: seededUnit(idea.id, "z"),
        breathPhase: seededUnit(idea.id, "bp") * Math.PI * 2,
        breathSpeed: lerp(0.5, 1.1, seededUnit(idea.id, "bs")),
        driftA: seededUnit(idea.id, "da") * 100,
        driftB: seededUnit(idea.id, "db") * 100,
        selfOrbit: (seededUnit(idea.id, "so") - 0.5) * 0.18,
        cluster: idea.cluster != null ? idea.cluster : -1,
        neighbors: [], _idea: idea, _orbit: null, _homeBackup: null,
      };
    }

    // (re)build from a newest-first ideas array, reusing existing star objects so
    // positions stay stable; then bind each star's neighbor ids → star refs.
    function sync(ideas) {
      if (!ideas) return;
      const byId = new Map(stars.map((s) => [s.id, s]));
      const slice = ideas.slice(0, MAX_STARS);
      const n = slice.length;
      stars = slice.map((idea, i) => {
        const ex = byId.get(idea.id);
        if (ex) {
          ex._idea = idea;
          ex.cluster = idea.cluster != null ? idea.cluster : -1;
          const h = home(i, n, idea);
          ex.hx = h.x; ex.hy = h.y; ex.t = ageT(i, n);
          return ex;
        }
        return makeStar(idea, i, n);
      });
      const sById = new Map(stars.map((s) => [s.id, s]));
      for (const s of stars) {
        const nb = (s._idea && s._idea.neighbors) || [];
        s.neighbors = nb.map((e) => ({ star: sById.get(e.id), sim: e.sim })).filter((e) => e.star);
      }
      rebuildDepthOrder();
    }

    // a freshly submitted idea flies in from (sx,sy); it has no semantic home yet
    // (server lays it out on the next GET), so it lands near centre, neighbors:[].
    function add(idea, sx, sy) {
      if (stars.some((s) => s.id === idea.id)) return;
      const star = makeStar(idea, 0, stars.length + 1);
      star.pulse = 1;
      stars.unshift(star);
      if (stars.length > MAX_STARS) stars.pop();
      relayout();
      if (reduceMotion || sx == null) {
        star.x = star.hx; star.y = star.hy;
      } else {
        star.x = sx; star.y = sy; star.born = 0;
        star.fly = {
          t: 0, sx, sy,
          cx: (sx + star.hx) / 2 + rand(-70, 70),
          cy: Math.min(sy, star.hy) - rand(80, 200),
        };
      }
      reveal(star, 3800);
    }

    function reveal(star, ms) { pinned = star; pinnedUntil = performance.now() + ms; }
    function setHover(star) { hovered = star; }

    // nearest star to a SCREEN point — converts to world + scales the hit radius
    // by 1/zoom so the touch target stays ~28 screen px at any zoom.
    function hitTest(sx, sy) {
      const w = screenToWorld(sx, sy);
      let best = null, bd = (28 / cam.zoom) ** 2;
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        const dx = s.x - w.x, dy = s.y - w.y, d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; best = s; }
      }
      return best;
    }

    // hover label (overview only) — placed via worldToScreen so it tracks the star
    function showTip(star) {
      if (!tip || !star) return;
      const p = worldToScreen(star.x, star.y);
      tip.textContent = "";
      const q = document.createElement("span");
      q.className = "idea-tip__text"; q.textContent = star.text; tip.appendChild(q);
      const nm = document.createElement("span");
      nm.className = "idea-tip__name";
      nm.textContent = star.name ? `— ${star.name}` : "— anonymous"; tip.appendChild(nm);
      tip.style.left = Math.max(14, Math.min(W - 14, p.x)) + "px";
      tip.style.top = Math.max(14, p.y - 16) + "px";
      tip.hidden = false;
    }
    function hideTip() { if (tip && !tip.hidden) tip.hidden = true; }

    // ---- focus: fly the camera into a star; its kindred ideas form its orbit ----
    function resolveOrbit(F) { return (F.neighbors || []).slice(0, ORBIT_K).filter((n) => n.star && n.sim >= TAU); }
    function applyOrbitHomes(F, neigh) {
      const m = Math.max(neigh.length, 1);
      neigh.forEach((nb, rank) => {
        const s = nb.star;
        s._homeBackup = { hx: s.hx, hy: s.hy };
        const sNorm = clamp01((nb.sim - TAU) / (1 - TAU));
        s._orbit = { baseR: lerp(R_FAR, R_NEAR, sNorm), ang0: rank * (Math.PI * 2 / m) };
      });
    }
    function restoreOrbitHomes() {
      focusNeighbors.forEach((nb) => {
        const s = nb.star; if (!s) return;
        if (s._homeBackup) { s.hx = s._homeBackup.hx; s.hy = s._homeBackup.hy; }
        s._homeBackup = null; s._orbit = null;
      });
    }
    // aim a touch above the star so the idea text (screen-centred) clears its glow
    function focusCamY(s) { return s.hy - (H * 0.12) / FOCUS_ZOOM; }
    function focus(s) {
      if (!s) return;
      if (view !== "overview") { focusStar = s; cam.tx = s.hx; cam.ty = focusCamY(s); return; } // re-aim mid-flight
      focusStar = s; view = "flying-in";
      cam.tx = s.hx; cam.ty = focusCamY(s); cam.tZoom = FOCUS_ZOOM;
      focusNeighbors = resolveOrbit(s); applyOrbitHomes(s, focusNeighbors);
      setHash(s.id); openFocusUI(s, focusNeighbors);
      hovered = null; pinned = null; hideTip();
    }
    function unfocus() {
      if (view === "overview") return;
      view = "flying-out";
      cam.tx = W / 2; cam.ty = H / 2; cam.tZoom = 1;
      restoreOrbitHomes(); clearHash(); closeFocusUI();
      focusStar = null; focusNeighbors = [];
    }
    function reaim() { if (focusStar) { cam.tx = focusStar.hx; cam.ty = focusCamY(focusStar); } }
    function focusStarById(id) { const s = stars.find((x) => x.id === id); if (s) focus(s); }
    function isFocused() { return view !== "overview"; }

    // transitions are driven by the camera reaching its target (no timers)
    function syncFocusUI() {
      if (view === "flying-in" && Math.abs(cam.zoom - FOCUS_ZOOM) < 0.05) view = "focused";
      if (view === "flying-out" && cam.zoom < 1.05) { view = "overview"; finishCloseFocusUI(); }
      // hide page chrome (footer) while diving into a star
      document.body.classList.toggle("sky-focused", view !== "overview");
      const panel = el("ideaFocus");
      if (!panel) return;
      const show = (view === "focused" || view === "flying-in") && cam.zoom >= ZOOM_OPEN_PANEL;
      panel.classList.toggle("is-open", show);
    }

    // ---- the focused-idea "page" (DOM overlay, textContent-only = XSS-safe) ----
    function el(id) { return document.getElementById(id); }
    function openFocusUI(s, neigh) {
      const panel = el("ideaFocus"), t = el("ideaFocusText"), a = el("ideaFocusAuthor"), r = el("ideaFocusRelations");
      if (!panel) return;
      if (t) t.textContent = s.text;
      if (a) a.textContent = s.name ? `— ${s.name}` : "— anonymous";
      if (r) r.textContent = neigh.length
        ? `near ${neigh.length} kindred idea${neigh.length > 1 ? "s" : ""}`
        : "this one's still looking for its people";
      panel.hidden = false;
      requestAnimationFrame(() => { try { panel.focus(); } catch (_) {} });
    }
    function closeFocusUI() { const p = el("ideaFocus"); if (p) p.classList.remove("is-open"); }
    function finishCloseFocusUI() {
      const p = el("ideaFocus");
      if (p && view === "overview") { p.hidden = true; const sky = el("sky"); if (sky && sky.focus) try { sky.focus({ preventScroll: true }); } catch (_) {} }
    }
    function maybeCloseFocusUI() { if (view !== "overview") unfocus(); }

    // ---- deep-link (#idea/<id>) via replaceState (clean Back button) ----
    function setHash(id) { try { history.replaceState(null, "", `#idea/${id}`); } catch (_) {} }
    function clearHash() { try { history.replaceState(null, "", location.pathname + location.search); } catch (_) {} }

    function draw(time) {
      if (constActive <= 0.01 || !stars.length) { hideTip(); maybeCloseFocusUI(); return; }
      if (!glowSprites) buildGlowSprites();
      const now = performance.now();
      if (pinned && now > pinnedUntil) pinned = null;

      // ---- ease the camera toward its target (the butter), then settle states ----
      if (!camInit) { cam.x = cam.tx = W / 2; cam.y = cam.ty = H / 2; camInit = true; }
      const ck = reduceMotion ? 1 : CAM_K;
      cam.zoom += (cam.tZoom - cam.zoom) * ck;
      cam.x += (cam.tx - cam.x) * ck;
      cam.y += (cam.ty - cam.y) * ck;
      // how "dived in" we are — the loop fades the ambient field out by this
      constFocusFade = clamp01((cam.zoom - 1) / (FOCUS_ZOOM - 1));
      syncFocusUI();

      ctx.save();
      ctx.setTransform(                                   // fold the camera INTO the DPR transform
        DPR * cam.zoom, 0, 0, DPR * cam.zoom,
        DPR * (W / 2 - cam.x * cam.zoom),
        DPR * (H / 2 - cam.y * cam.zoom)
      );

      const focusing = (view === "focused" || view === "flying-in");
      const hl = (view === "overview") ? (pinned || hovered) : focusStar;

      // ---- update positions + stash per-star render values ----
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];

        // focused neighbours revolve in a tilted orbit around the focus star
        if (s._orbit && focusStar && focusing) {
          const ang = s._orbit.ang0 + (reduceMotion ? 0 : time * 0.18);
          s.hx = focusStar.hx + Math.cos(ang) * s._orbit.baseR;
          s.hy = focusStar.hy + Math.sin(ang) * s._orbit.baseR * ECLIPTIC;
        }

        if (s.fly) {
          s.fly.t += reduceMotion ? 1 : 0.018;
          const u = easeInOut(clamp01(s.fly.t));
          const iu = 1 - u;
          s.x = iu * iu * s.fly.sx + 2 * iu * u * s.fly.cx + u * u * s.hx;
          s.y = iu * iu * s.fly.sy + 2 * iu * u * s.fly.cy + u * u * s.hy;
          s.born = u;
          if (s.fly.t >= 1) { s.fly = null; s.x = s.hx; s.y = s.hy; s.born = 1; }
        } else {
          const dz = s.z;
          const parallaxK = lerp(0.2, 1.0, dz);
          const driftK = lerp(0.35, 1.0, dz);
          let aimX = s.hx, aimY = s.hy;
          if (!reduceMotion) {
            aimX += drift(time, s.driftA, s.driftB) * 9 * driftK + Math.cos(s.selfOrbit * time) * 3 * driftK + (pointer.x - 0.5) * 30 * parallaxK;
            aimY += drift(time, s.driftB, s.driftA) * 9 * driftK + Math.sin(s.selfOrbit * time) * 3 * driftK + (pointer.y - 0.5) * 30 * parallaxK;
          }
          s.vx = s.vx * 0.84 + (aimX - s.x) * 0.05;
          s.vy = s.vy * 0.84 + (aimY - s.y) * 0.05;
          s.x += s.vx; s.y += s.vy;
          if (s.born < 1) s.born = clamp01(s.born + 0.04);
        }
        if (s.pulse > 0) s.pulse = Math.max(0, s.pulse - 0.012);

        // depth → size/alpha/glow; breathing + twinkle; focus dim
        const dz = s.z;
        const depthAlpha = lerp(0.32, 1.0, dz);
        const glowScale = lerp(1.9, 1.0, dz);
        const breath = reduceMotion ? 1 : 1 + 0.11 * Math.sin(time * s.breathSpeed + s.breathPhase);
        const twinkle = reduceMotion ? 1 : 0.80 + 0.20 * Math.sin(time * (1.0 + dz) + s.breathPhase * 1.7);
        let focusDim = 1;
        if (focusing && focusStar) focusDim = (s === focusStar) ? 1 : (s._orbit ? 0.92 : 0.18);
        const isHL = s === hl;
        s._cr = Math.round(lerp(255, 190, s.t));
        s._cg = Math.round(lerp(170, 214, s.t));
        s._cb = Math.round(lerp(90, 255, s.t));
        s._ra = clamp01((0.5 + 0.5 * (1 - s.t)) * depthAlpha * s.born * constActive * twinkle * focusDim * (isHL ? 1.3 : 1));
        s._rr = (2.0 + (1 - s.t) * 1.8) * lerp(0.55, 1.65, dz) * breath * (1 + s.pulse * 1.2) * (isHL ? 1.7 : 1);
        s._gs = glowScale;
        s._hl = isHL;
      }

      // ---- links: faint global web in overview; just the orbit edges when focused ----
      if (view === "overview") {
        ctx.lineWidth = 1 / cam.zoom;
        for (let i = 0; i < stars.length; i++) {
          const a = stars[i];
          for (let j = i + 1; j < stars.length; j++) {
            const b = stars[j];
            const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy;
            if (d2 > 120 * 120) continue;
            const al = (1 - Math.sqrt(d2) / 120) * 0.14 * constActive;
            if (al <= 0.01) continue;
            ctx.strokeStyle = `rgba(207,227,255,${al})`;
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
          }
        }
      } else if (focusStar) {
        ctx.lineWidth = 1.2 / cam.zoom;
        for (const nb of focusNeighbors) {
          if (!nb.star) continue;
          const al = clamp01((nb.sim - TAU) / (1 - TAU)) * 0.6 * constActive;
          if (al <= 0.01) continue;
          ctx.strokeStyle = `rgba(255,225,190,${al})`;
          ctx.beginPath(); ctx.moveTo(focusStar.hx, focusStar.hy); ctx.lineTo(nb.star.x, nb.star.y); ctx.stroke();
        }
      }

      // ---- glow pass (additive bloom via cached sprites) ----
      ctx.globalCompositeOperation = "lighter";
      for (const idx of drawOrder) {
        const s = stars[idx];
        if (s._ra <= 0.01) continue;
        const gw = s._rr * 9 * s._gs;
        ctx.globalAlpha = s._ra;
        ctx.drawImage(glowFor(s.t), s.x - gw / 2, s.y - gw / 2, gw, gw);
      }
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";

      // ---- core pass (+ focus ring) ----
      for (const idx of drawOrder) {
        const s = stars[idx];
        if (s._ra <= 0.01) continue;
        ctx.beginPath();
        ctx.fillStyle = `rgba(${s._cr},${s._cg},${s._cb},${s._ra})`;
        ctx.arc(s.x, s.y, s._rr, 0, Math.PI * 2); ctx.fill();
        if (s._hl) {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(255,225,190,${0.6 * constActive})`;
          ctx.lineWidth = 1.4 / cam.zoom;
          ctx.arc(s.x, s.y, s._rr + 6 / cam.zoom, 0, Math.PI * 2); ctx.stroke();
        }
      }

      ctx.restore();
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);   // MANDATORY reset — keeps the story engine pristine

      // overview hover tooltip (DOM, screen coords); never while focused
      if (view === "overview" && (pinned || hovered)) showTip(pinned || hovered); else hideTip();
    }

    return {
      sync, add, draw, hitTest, setHover, reveal, relayout, count: () => stars.length,
      focus, unfocus, focusStarById, isFocused, reaim,
      _cam: cam, _screenToWorld: screenToWorld, _worldToScreen: worldToScreen, _stars: () => stars,
    };
  })();

  // -------------------------------------------------------------------------
  // the nexus — shared wall of ideas, read from + written to /api/ideas
  // -------------------------------------------------------------------------
  const ideaSource = (() => {
    const countEl = document.getElementById("ideaCount");
    const listEl = document.getElementById("skyList");
    let all = [];

    function setCount(total) {
      if (!countEl) return;
      const n = total.toLocaleString("en-US");
      countEl.textContent = total === 1
        ? "1 spark in the sky, and counting."
        : `${n} sparks in the sky, and counting.`;
    }

    // accessible text path: one focusable button per idea = "click a star" by keyboard.
    // textContent only — user text NEVER touches innerHTML (XSS).
    function addListItem(idea, prepend) {
      if (!listEl) return;
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = idea.name ? `${idea.text} — ${idea.name}` : idea.text;
      b.addEventListener("click", () => constellation.focusStarById(idea.id));
      li.appendChild(b);
      if (prepend) listEl.insertBefore(li, listEl.firstChild); else listEl.appendChild(li);
    }

    async function load() {
      try {
        const res = await fetch(`/api/ideas?limit=${MAX_STARS}`);
        if (!res.ok) throw new Error(`GET ${res.status}`);
        const data = await res.json();
        all = data.ideas || [];
        constellation.sync(all);
        setCount(data.total || 0);
        if (listEl) { listEl.textContent = ""; all.forEach((i) => addListItem(i, false)); }
        applyHashDeepLink();
      } catch (err) {
        // the sky just stays empty for now; the ambient field is still alive
      }
    }

    // called by the form on a successful submit — launches the new star into the
    // sky, updates the count, and prepends it to the accessible list.
    function prepend(idea, total, sx, sy) {
      all.unshift(idea);
      constellation.add(idea, sx, sy);
      setCount(total);
      addListItem(idea, true);
    }

    return { load, prepend };
  })();

  // deep-link: /#idea/<id> scrolls into the sky and falls into that star
  function applyHashDeepLink() {
    const m = location.hash.match(/^#idea\/([0-9a-f-]{6,})$/i);
    if (!m) return;
    const sky = document.getElementById("sky");
    if (sky) sky.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
    const tryFocus = () => {
      if (constellation.count() && constActive > 0.2) constellation.focusStarById(m[1]);
      else requestAnimationFrame(tryFocus);
    };
    requestAnimationFrame(tryFocus);
  }

  // -------------------------------------------------------------------------
  // the interactive form — now writes a real, shared spark to /api/ideas
  // -------------------------------------------------------------------------
  function initForm() {
    const form = document.getElementById("sparkForm");
    const input = document.getElementById("sparkInput");
    const nameInput = document.getElementById("sparkName");
    const status = document.getElementById("sparkStatus");
    const btn = document.getElementById("sparkBtn");
    if (!form) return;

    const lines = [
      "added to the field. it's moving now.",
      "that one's light enough to travel.",
      "somewhere, that just caught.",
      "noted. the avalanche got a little bigger.",
      "good. the silly ones are the only ones that move.",
    ];

    function say(msg) {
      status.textContent = msg;
      status.classList.add("show");
    }

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const val = input.value.trim();
      const name = nameInput ? nameInput.value.trim() : "";
      if (!val) {
        say("even a blank thought counts — but try a word or two.");
        return;
      }

      if (btn) { btn.disabled = true; }
      say("sending it into the field…");

      try {
        const res = await fetch("/api/ideas", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(name ? { text: val, name } : { text: val }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.status === 429) {
          say(data.error || "easy now — a few sparks at a time. try again shortly.");
          return;
        }
        if (!res.ok && res.status !== 200) {
          say(data.error || "that one didn't catch. try again?");
          return;
        }

        targetProgress = Math.max(targetProgress, 0.92);
        input.value = "";
        if (nameInput) nameInput.value = "";

        if (data.held) {
          addUserSpark();
          say(data.message || "that one's being looked at before it joins the field.");
          return;
        }

        // if we were zoomed into a star, drift back out before the new one flies in
        if (constellation.isFocused()) constellation.unfocus();
        // launch the new idea as a star flying up from the button into the sky
        const rect = btn ? btn.getBoundingClientRect() : null;
        const sx = rect ? rect.left + rect.width / 2 : W * 0.5;
        const sy = rect ? rect.top + rect.height / 2 : H * 0.85;
        const line = lines[Math.floor(Math.random() * lines.length)];
        say(`${line}  there it goes — that's yours, up with the rest ↑`);
        if (data.idea) ideaSource.prepend(data.idea, data.total || 0, sx, sy);
      } catch (err) {
        say("the connection flickered — try once more.");
      } finally {
        if (btn) { btn.disabled = false; }
      }
    });
  }

  // -------------------------------------------------------------------------
  // pointer parallax
  // -------------------------------------------------------------------------
  function initPointer() {
    // pointer over real UI (form, links, the focus panel) never triggers stars
    function overUI(t) {
      return !!(t && t.closest && t.closest(
        ".spark-form, button, input, a, .footer, .to-nexus, .idea-focus, .idea-focus__back"
      ));
    }
    window.addEventListener("pointermove", (e) => {
      pointer.x = e.clientX / W;
      pointer.y = e.clientY / H;
      pointer.active = true;
      // hover labels are an overview-only affordance
      if (constActive < 0.25 || constellation.isFocused() || overUI(e.target)) {
        constellation.setHover(null); return;
      }
      constellation.setHover(constellation.hitTest(e.clientX, e.clientY));
    }, { passive: true });
    window.addEventListener("pointerleave", () => {
      pointer.active = false;
      constellation.setHover(null);
    });
    // click: focused → drift back out; overview → fall into the nearest star
    window.addEventListener("click", (e) => {
      if (overUI(e.target)) return;
      if (constellation.isFocused()) { constellation.unfocus(); return; }
      if (constActive < 0.25) return;
      const s = constellation.hitTest(e.clientX, e.clientY);
      if (s) constellation.focus(s);
    }, { passive: true });
    // escape drifts back out of a focused star
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && constellation.isFocused()) constellation.unfocus();
    });
  }

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------
  function init() {
    resize();
    initReveals();
    initForm();
    ideaSource.load();
    initPointer();
    const backBtn = document.getElementById("ideaFocusBack");
    if (backBtn) backBtn.addEventListener("click", () => constellation.unfocus());
    onScroll();

    window.addEventListener("resize", () => { resize(); onScroll(); }, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("hashchange", () => {
      const m = location.hash.match(/^#idea\/([0-9a-f-]{6,})$/i);
      if (m) constellation.focusStarById(m[1]);
      else if (constellation.isFocused()) constellation.unfocus();
    });

    // local-only hook so the constellation can be exercised with mock data
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      window.__c = constellation;
    }

    requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
