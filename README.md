# A Silly Idea

A scroll-driven, philosophical web experience about how one small, ridiculous
idea avalanches into a movement. One persistent particle field lives behind the
whole page and morphs through five phases as you scroll — then hands you a live
input to drop your own spark into the field.

> Every avalanche starts as a single, ridiculous flake.

## The journey

| Scroll | Phase | What the field does |
|--------|-------|---------------------|
| 0% | **the spark** | a single warm ember glowing in the dark |
| ~15% | the whisper | a few particles drift loose |
| ~40% | **the avalanche** | it catches — particles multiply and cascade; a live counter climbs |
| ~65% | the wave | they snap into a moving rhythm |
| ~90% | **the we** | they settle into a connected constellation, warm ember cooled to starlight |
| end | your turn | type your own idea → it drops a new spark into the field |

## How it works (the one trick worth stealing)

The smoothness comes from **decoupling**. Scrolling only sets a *target*
progress value (0 → 1). Everything you see — particle positions, the colour
shift, the counter — eases toward its target on the animation clock, independent
of the scroll input. So even a janky trackpad flick reads as butter.

One canvas drives the entire thing. The text sections just scroll *over* it,
which is what makes the whole page feel like a single journey instead of eight
disconnected slides.

## Run it

It's a static site — no build, no dependencies, no backend.

**Easiest:** open `index.html` directly in a browser.

**With a local server** (recommended, avoids any file:// quirks):

```bash
node server.js
# → http://localhost:4173
```

Any static host works too:

```bash
npx serve .
```

## Deploy

Drop the folder on Vercel, Netlify, or any static host. Nothing to configure.

```bash
# Vercel
vercel --prod

# Netlify
netlify deploy --prod --dir .
```

## Files

| File | Role |
|------|------|
| `index.html` | structure + copy (the 8 chapters) |
| `styles.css` | the dark editorial look — Fraunces display, Space Grotesk UI |
| `app.js` | the field engine — particles, phases, scroll, the live input |
| `server.js` | tiny static server for local preview (optional) |

## Notes

- **No backend, no data, no secrets.** It's pure view-layer. Submitted ideas
  never leave the browser; a per-device count is kept in `localStorage` only.
- **Accessible-minded:** respects `prefers-reduced-motion`, the field is
  `aria-hidden`, the form has a real label and a live status region.
- **Self-healing canvas:** the field re-measures every frame, so it survives
  odd load orders and window resizes without ever getting stuck at the wrong size.

---

Built because it sounded a little dumb. That's usually the tell.
