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
| end | your turn | type your own idea → it's saved to a **shared nexus** everyone can read |
| nexus | the wall | a browsable grid of every real idea people have added, with a live count |

## How it works (the one trick worth stealing)

The smoothness comes from **decoupling**. Scrolling only sets a *target*
progress value (0 → 1). Everything you see — particle positions, the colour
shift, the counter — eases toward its target on the animation clock, independent
of the scroll input. So even a janky trackpad flick reads as butter.

One canvas drives the entire thing. The text sections just scroll *over* it,
which is what makes the whole page feel like a single journey instead of eight
disconnected slides.

## Run it

The front-end is still a static site. The new part is a small backend: one
serverless function in `api/` that saves and reads ideas, backed by **Neon**
(serverless Postgres). The browser never touches the database or any secret —
the function is the only door, and Neon exposes no public client at all.

**1. Make a Neon database.** Easiest: Vercel dashboard → this project →
**Storage** → **Create Database** → **Neon Postgres**. Vercel auto-sets
`DATABASE_URL`. (Or create one at [neon.tech](https://neon.tech) and copy the
connection string.)

**2. Set the three env vars** (in Vercel → Settings → Environment Variables):

| Var | Where |
|-----|-------|
| `DATABASE_URL` | Neon connection string (auto-set by the Vercel integration) |
| `GEMINI_API_KEY` | Google AI Studio — Flash screens each idea ([get a key](https://aistudio.google.com/apikey)) |
| `IP_HASH_SALT` | any long random string (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |

**3. Run locally** (functions need the Vercel dev runtime, not `node server.js`):

```bash
npm install
vercel env pull .env.local   # mirror the three vars locally
npm run setup-db             # create the ideas table (run once)
npm run dev                  # vercel dev → http://localhost:3000
```

> `node server.js` still serves the static files for a quick front-end preview,
> but the `/api/ideas` endpoint only runs under `vercel dev`.

## Deploy

The three env vars are already in your Vercel project, so just ship. Static
files + the `api/` function deploy together — no framework preset.

```bash
npm run deploy       # vercel --prod
```

## The data model

One Neon table, `ideas`. No RLS needed — unlike Supabase, Neon has no anonymous
HTTP client, so the only way to the table is the connection string inside the
serverless function:

```sql
create table ideas (
  id uuid primary key default gen_random_uuid(),
  text text not null check (char_length(text) between 1 and 280),
  name text check (name is null or char_length(name) <= 40),
  status text not null default 'published' check (status in ('published','held','rejected')),
  ip_hash text,
  created_at timestamptz not null default now()
);
```

`npm run setup-db` creates this for you. Every submission is validated (Zod
`.strict()`, parameterized queries), rate-limited per device by counting recent
rows, and run through AI moderation. Clean ideas publish instantly; flagged ones
are held and never shown.

## Files

| File | Role |
|------|------|
| `index.html` | structure + copy + the nexus section |
| `styles.css` | the dark editorial look — Fraunces display, Space Grotesk UI |
| `app.js` | the field engine + the form + the nexus wall renderer |
| `api/ideas.js` | the only server surface — validate, rate-limit, moderate, save/read |
| `server.js` | tiny static server for previewing the front-end only (no API) |

## Notes

- **Secrets stay server-side.** All keys are server-only env vars validated at
  startup. The browser only ever calls `/api/ideas` — it never sees a key or
  touches the database.
- **Moderated + rate-limited.** A public submission wall gets abused; every idea
  is AI-screened and capped at 5 per 10 min per device.
- **Accessible-minded:** respects `prefers-reduced-motion`, the field is
  `aria-hidden`, the form has real labels and a live status region.
- **Self-healing canvas:** the field re-measures every frame, so it survives
  odd load orders and window resizes without ever getting stuck at the wrong size.

---

Built because it sounded a little dumb. That's usually the tell.
