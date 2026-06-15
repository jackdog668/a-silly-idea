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

    ctx.clearRect(0, 0, W, H);

    // pointer parallax offset (subtle)
    const px = (pointer.x - 0.5);
    const py = (pointer.y - 0.5);
    const parallax = pointer.active ? 18 : 0;

    // connection strength ramps up in wave→network, then yields to the idea-stars
    const linkAlpha = clamp01((p - 0.62) / 0.3) * (1 - 0.55 * constActive);

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
      const alpha = born * twinkle * (1 - 0.55 * constActive);
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

    // golden-angle spiral: newest (i=0) sits near centre, warm + bright; older
    // ideas spiral outward, cooling toward starlight and fading into depth.
    // distribute across the sky proportional to the ACTUAL count (n), so a
    // handful of ideas still fill the field instead of knotting in the centre.
    function home(i, n) {
      const cx = W * 0.5, cy = H * 0.5;
      const golden = Math.PI * (3 - Math.sqrt(5));
      const maxR = Math.min(W, H) * 0.44;
      const denom = Math.max(n, 14);
      const r = Math.max(Math.min(W, H) * 0.06, Math.sqrt(i / denom) * maxR);
      const a = i * golden;
      return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r * 0.8 };
    }

    // age (0 newest → 1 oldest) across the actual set, for the ember→starlight tint
    function ageT(i, n) { return i / Math.max(n - 1, 1); }

    function relayout() {
      const n = stars.length;
      for (let i = 0; i < n; i++) {
        const h = home(i, n);
        stars[i].hx = h.x; stars[i].hy = h.y; stars[i].t = ageT(i, n);
      }
    }

    function makeStar(idea, i, n) {
      const h = home(i, n);
      return {
        id: idea.id, text: idea.text, name: idea.name || "", created_at: idea.created_at,
        hx: h.x, hy: h.y, x: h.x, y: h.y, vx: 0, vy: 0,
        t: ageT(i, n), born: 1, fly: null, pulse: 0,
      };
    }

    // (re)build from a newest-first ideas array, reusing existing star objects
    // so positions stay stable as the list refreshes.
    function sync(ideas) {
      if (!ideas) return;
      const byId = new Map(stars.map((s) => [s.id, s]));
      const slice = ideas.slice(0, MAX_STARS);
      const n = slice.length;
      stars = slice.map((idea, i) => {
        const ex = byId.get(idea.id);
        if (ex) {
          const h = home(i, n);
          ex.hx = h.x; ex.hy = h.y; ex.t = ageT(i, n);
          return ex;
        }
        return makeStar(idea, i, n);
      });
    }

    // a freshly submitted idea flies in from (sx,sy) and settles near the centre
    function add(idea, sx, sy) {
      if (stars.some((s) => s.id === idea.id)) return; // already synced in
      const star = makeStar(idea, 0, stars.length + 1);
      star.pulse = 1;
      stars.unshift(star);
      if (stars.length > MAX_STARS) stars.pop();
      relayout(); // sets the newcomer's home (index 0) using the new count
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

    // nearest star to a screen point, within a forgiving radius
    function hitTest(mx, my) {
      let best = null, bd = 30 * 30;
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        const dx = s.x - mx, dy = s.y - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < bd) { bd = d2; best = s; }
      }
      return best;
    }

    function showTip(star) {
      if (!tip || !star) return;
      tip.textContent = "";
      const q = document.createElement("span");
      q.className = "idea-tip__text";
      q.textContent = star.text;
      tip.appendChild(q);
      const n = document.createElement("span");
      n.className = "idea-tip__name";
      n.textContent = star.name ? `— ${star.name}` : "— anonymous";
      tip.appendChild(n);
      tip.style.left = Math.max(14, Math.min(W - 14, star.x)) + "px";
      tip.style.top = Math.max(14, star.y - 16) + "px";
      tip.hidden = false;
    }
    function hideTip() { if (tip && !tip.hidden) tip.hidden = true; }

    function draw(time) {
      if (constActive <= 0.01 || !stars.length) { hideTip(); return; }
      const now = performance.now();
      if (pinned && now > pinnedUntil) pinned = null;

      // ---- update positions ----
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        if (s.fly) {
          s.fly.t += reduceMotion ? 1 : 0.018;
          const u = easeInOut(clamp01(s.fly.t));
          const iu = 1 - u;
          s.x = iu * iu * s.fly.sx + 2 * iu * u * s.fly.cx + u * u * s.hx;
          s.y = iu * iu * s.fly.sy + 2 * iu * u * s.fly.cy + u * u * s.hy;
          s.born = u;
          if (s.fly.t >= 1) { s.fly = null; s.x = s.hx; s.y = s.hy; s.born = 1; }
        } else {
          s.vx = s.vx * 0.84 + (s.hx - s.x) * 0.05;
          s.vy = s.vy * 0.84 + (s.hy - s.y) * 0.05;
          s.x += s.vx; s.y += s.vy;
          if (s.born < 1) s.born = clamp01(s.born + 0.04);
        }
        if (s.pulse > 0) s.pulse = Math.max(0, s.pulse - 0.012);
      }

      const focus = pinned || hovered;

      // ---- faint links between nearby stars ----
      ctx.lineWidth = 1;
      for (let i = 0; i < stars.length; i++) {
        const a = stars[i];
        for (let j = i + 1; j < stars.length; j++) {
          const b = stars[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d2 = dx * dx + dy * dy;
          if (d2 > 120 * 120) continue;
          const al = (1 - Math.sqrt(d2) / 120) * 0.16 * constActive;
          if (al <= 0.01) continue;
          ctx.strokeStyle = `rgba(207,227,255,${al})`;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }

      // ---- the stars ----
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        const cr = Math.round(lerp(255, 190, s.t));
        const cg = Math.round(lerp(170, 214, s.t));
        const cb = Math.round(lerp(90, 255, s.t));
        const isFocus = s === focus;
        const baseA = (0.5 + 0.5 * (1 - s.t)) * s.born * constActive;
        const twinkle = reduceMotion ? 1 : 0.82 + 0.18 * Math.sin(time * 1.3 + i);
        const a = clamp01(baseA * twinkle * (isFocus ? 1.25 : 1));
        const rad = (2.0 + (1 - s.t) * 1.8) * (1 + s.pulse * 1.2) * (isFocus ? 1.7 : 1);

        ctx.beginPath();
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${a * 0.16})`;
        ctx.arc(s.x, s.y, rad * 5, 0, Math.PI * 2); ctx.fill();

        ctx.beginPath();
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${a})`;
        ctx.arc(s.x, s.y, rad, 0, Math.PI * 2); ctx.fill();

        if (isFocus) {
          ctx.beginPath();
          ctx.strokeStyle = `rgba(255,225,190,${0.6 * constActive})`;
          ctx.lineWidth = 1.2;
          ctx.arc(s.x, s.y, rad + 6, 0, Math.PI * 2); ctx.stroke();
        }
      }

      if (focus) showTip(focus); else hideTip();
    }

    return { sync, add, draw, hitTest, setHover, reveal, relayout, count: () => stars.length };
  })();

  // -------------------------------------------------------------------------
  // the nexus — shared wall of ideas, read from + written to /api/ideas
  // -------------------------------------------------------------------------
  const nexus = (() => {
    const grid = document.getElementById("nexusGrid");
    const countEl = document.getElementById("nexusCount");
    const emptyEl = document.getElementById("nexusEmpty");
    const moreBtn = document.getElementById("nexusMore");

    // friendly relative time without pulling in a library
    function ago(iso) {
      const then = new Date(iso).getTime();
      const s = Math.max(0, Math.round((Date.now() - then) / 1000));
      if (s < 45) return "just now";
      const m = Math.round(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.round(m / 60);
      if (h < 24) return `${h}h ago`;
      const d = Math.round(h / 24);
      if (d < 30) return `${d}d ago`;
      return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }

    // build a card with textContent only — user text NEVER touches innerHTML (XSS)
    function card(idea) {
      const el = document.createElement("article");
      el.className = "idea-card";

      const p = document.createElement("p");
      p.className = "idea-card__text";
      p.textContent = idea.text;
      el.appendChild(p);

      const meta = document.createElement("p");
      meta.className = "idea-card__meta";
      const who = document.createElement("span");
      who.className = "idea-card__name";
      who.textContent = idea.name ? `— ${idea.name}` : "— anonymous";
      meta.appendChild(who);
      const t = document.createElement("time");
      t.textContent = ` · ${ago(idea.created_at)}`;
      meta.appendChild(t);
      el.appendChild(meta);

      return el;
    }

    function setCount(total) {
      if (!countEl) return;
      const n = total.toLocaleString("en-US");
      countEl.textContent = total === 1
        ? `1 spark in the field, and counting.`
        : `${n} sparks in the field, and counting.`;
    }

    function clearEmpty() {
      if (emptyEl && emptyEl.parentNode) emptyEl.remove();
    }

    function render(ideas, where) {
      if (!grid || !ideas || !ideas.length) return;
      clearEmpty();
      ideas.forEach((idea) => {
        const el = card(idea);
        if (where === "prepend") grid.insertBefore(el, grid.firstChild);
        else grid.appendChild(el);
      });
    }

    function showEmpty(msg) {
      if (emptyEl) emptyEl.textContent = msg;
    }

    let cursor = null;
    let loading = false;
    let all = []; // every idea loaded so far, newest-first — drives the stars

    async function loadPage(before) {
      if (loading) return;
      loading = true;
      try {
        const limit = before ? 60 : MAX_STARS;
        const url = before
          ? `/api/ideas?limit=${limit}&before=${encodeURIComponent(before)}`
          : `/api/ideas?limit=${limit}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`GET ${res.status}`);
        const data = await res.json();
        render(data.ideas, "append");
        setCount(data.total || 0);
        all = before ? all.concat(data.ideas || []) : (data.ideas || []);
        constellation.sync(all);
        cursor = data.nextCursor;
        if (moreBtn) moreBtn.hidden = !cursor;
        if (!before && (!data.ideas || !data.ideas.length)) {
          showEmpty("no sparks yet. yours could be the first one to catch.");
        }
      } catch (err) {
        if (!before) showEmpty("the field's quiet for a moment — refresh to try again.");
      } finally {
        loading = false;
      }
    }

    function init() {
      if (!grid) return;
      loadPage(null);
      if (moreBtn) moreBtn.addEventListener("click", () => cursor && loadPage(cursor));
    }

    // called by the form on a successful submit — adds the card, updates the
    // count, and launches the new star flying up into the constellation.
    function prepend(idea, total, sx, sy) {
      render([idea], "prepend");
      setCount(total);
      all.unshift(idea);
      constellation.add(idea, sx, sy);
    }

    return { init, prepend };
  })();

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

        // launch the new idea as a star flying up from the button into the sky
        const rect = btn ? btn.getBoundingClientRect() : null;
        const sx = rect ? rect.left + rect.width / 2 : W * 0.5;
        const sy = rect ? rect.top + rect.height / 2 : H * 0.85;
        const line = lines[Math.floor(Math.random() * lines.length)];
        say(`${line}  there it goes — that's yours, up with the rest ↑`);
        if (data.idea) nexus.prepend(data.idea, data.total || 0, sx, sy);
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
    // pointer over real UI (cards, form, links) should never trigger star reads
    function overUI(t) {
      return !!(t && t.closest && t.closest(
        ".idea-card, .spark-form, button, input, a, .footer, .nexus__more, .to-nexus"
      ));
    }
    window.addEventListener("pointermove", (e) => {
      pointer.x = e.clientX / W;
      pointer.y = e.clientY / H;
      pointer.active = true;
      if (constActive < 0.25 || overUI(e.target)) { constellation.setHover(null); return; }
      constellation.setHover(constellation.hitTest(e.clientX, e.clientY));
    }, { passive: true });
    window.addEventListener("pointerleave", () => {
      pointer.active = false;
      constellation.setHover(null);
    });
    // tap-to-read on touch (and click on desktop) pins a star's label briefly
    window.addEventListener("click", (e) => {
      if (constActive < 0.25 || overUI(e.target)) return;
      const s = constellation.hitTest(e.clientX, e.clientY);
      if (s) constellation.reveal(s, 4500);
    }, { passive: true });
  }

  // -------------------------------------------------------------------------
  // boot
  // -------------------------------------------------------------------------
  function init() {
    resize();
    initReveals();
    initForm();
    nexus.init();
    initPointer();
    onScroll();

    window.addEventListener("resize", () => { resize(); onScroll(); }, { passive: true });
    window.addEventListener("scroll", onScroll, { passive: true });

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
