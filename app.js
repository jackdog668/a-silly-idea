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

    ctx.clearRect(0, 0, W, H);

    // pointer parallax offset (subtle)
    const px = (pointer.x - 0.5);
    const py = (pointer.y - 0.5);
    const parallax = pointer.active ? 18 : 0;

    // connection strength ramps up in wave→network
    const linkAlpha = clamp01((p - 0.62) / 0.3);

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
      const alpha = born * twinkle;
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

    async function loadPage(before) {
      if (loading) return;
      loading = true;
      try {
        const url = before
          ? `/api/ideas?limit=40&before=${encodeURIComponent(before)}`
          : `/api/ideas?limit=40`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`GET ${res.status}`);
        const data = await res.json();
        render(data.ideas, "append");
        setCount(data.total || 0);
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

    // called by the form on a successful submit
    function prepend(idea, total) {
      render([idea], "prepend");
      setCount(total);
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

        // the delightful part survives: the ember still ignites + the field moves
        addUserSpark();
        targetProgress = Math.max(targetProgress, 0.9);
        input.value = "";
        if (nameInput) nameInput.value = "";

        if (data.held) {
          say(data.message || "that one's being looked at before it joins the field.");
          return;
        }

        const line = lines[Math.floor(Math.random() * lines.length)];
        say(`${line}  it's on the wall now — scroll down to read the rest ↓`);
        if (data.idea) nexus.prepend(data.idea, data.total || 0);
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
    window.addEventListener("pointermove", (e) => {
      pointer.x = e.clientX / W;
      pointer.y = e.clientY / H;
      pointer.active = true;
    }, { passive: true });
    window.addEventListener("pointerleave", () => { pointer.active = false; });
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

    requestAnimationFrame(frame);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
