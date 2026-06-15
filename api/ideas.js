// =========================================================================
//  /api/ideas — the only server-side surface of "A Silly Idea".
//
//  The browser NEVER talks to the database. This serverless function is the
//  one door: it validates, rate-limits, AI-moderates, then writes to Neon
//  over a connection string that only ever lives here — never in the client.
//
//  GET  /api/ideas        → published ideas (newest first) + a real live count
//  POST /api/ideas {text} → validate → rate-limit → moderate → save
// =========================================================================

const crypto = require("crypto");
const { neon } = require("@neondatabase/serverless");
const { z } = require("zod");

// ---- Env validation: crash-loud if anything's missing (per security rules) --
// Validated once at cold-start. If it fails, every request returns a generic
// 500 and the real reason is logged server-side — never leaked to the client.
const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash"),
  GEMINI_EMBED_MODEL: z.string().min(1).default("gemini-embedding-001"),
  IP_HASH_SALT: z.string().min(1),
});

let env = null;
let envError = null;
try {
  env = envSchema.parse(process.env);
} catch (err) {
  envError = err;
  console.error("[ideas] env validation failed:", err?.issues || err);
}

// Neon's HTTP driver. Tagged-template calls bind values as parameters, so
// `${userText}` is NEVER concatenated into SQL — injection-safe by construction.
const sql = env ? neon(env.DATABASE_URL) : null;

// Self-provision the table on first use. Idempotent + cached, so it runs at most
// once per warm instance (not per request). Lets the app stand itself up on a
// fresh database with no separate migration step — `scripts/setup-db.js` stays
// available for explicit/local setup but isn't required.
let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await sql`
        create table if not exists ideas (
          id          uuid primary key default gen_random_uuid(),
          text        text not null check (char_length(text) between 1 and 280),
          name        text check (name is null or char_length(name) <= 40),
          status      text not null default 'published'
                      check (status in ('published','held','rejected')),
          ip_hash     text,
          created_at  timestamptz not null default now()
        )
      `;
      await sql`
        create index if not exists ideas_published_idx
          on ideas (created_at desc) where status = 'published'
      `;
      await sql`
        create index if not exists ideas_iphash_idx on ideas (ip_hash, created_at)
      `;
      // semantic-orbit fields (added idempotently so existing DBs upgrade in place)
      await sql`alter table ideas add column if not exists embedding real[]`;
      await sql`alter table ideas add column if not exists embedded_at timestamptz`;
    })().catch((err) => {
      schemaReady = null; // let a later request retry if this one failed
      throw err;
    });
  }
  return schemaReady;
}

// ---- Input contract: .strict() rejects any field we didn't ask for -------
const ideaSchema = z
  .object({
    text: z.string().trim().min(1, "say a word or two").max(280, "keep it short"),
    name: z.string().trim().max(40).optional(),
  })
  .strict();

const RATE_LIMIT = 5; // submissions...
const RATE_WINDOW_MIN = 10; // ...per this many minutes, per device

// ---- Helpers -------------------------------------------------------------
function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "0.0.0.0";
}

function hashIp(ip) {
  return crypto.createHash("sha256").update(ip + env.IP_HASH_SALT).digest("hex");
}

// Gemini has no dedicated moderation endpoint, so we point its cheap Flash
// model at the text and have it classify, returning structured JSON {flagged}.
const MODERATION_INSTRUCTION =
  "You are a strict content moderator for a public wall of short, playful " +
  "'silly ideas'. Flag the text ONLY if it contains: hate speech or slurs, " +
  "harassment or bullying of a real person, sexual content involving minors, " +
  "graphic sexual content, credible threats or incitement of violence, " +
  "personal data / doxxing, or spam/scam links. Weird, dumb, absurd, or silly " +
  "ideas are the entire point of the wall — do NOT flag those. Respond with JSON only.";

// Returns true when the text should be HELD (flagged or moderation failed).
// Fails closed: if the call errors or returns no verdict, we hold rather than
// publish unscreened — better to delay one good idea than show one bad one.
async function isFlagged(parts) {
  const input = parts.filter(Boolean).join("\n").slice(0, 4000);
  if (!input) return false;
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: MODERATION_INSTRUCTION }] },
          contents: [{ role: "user", parts: [{ text: input }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                flagged: { type: "boolean" },
                reason: { type: "string" },
              },
              required: ["flagged"],
            },
          },
          // Let the model CLASSIFY harmful text instead of refusing to answer;
          // our prompt is the policy, not Gemini's built-in generation filter.
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
          ],
        }),
      }
    );
    if (!res.ok) {
      console.error("[ideas] moderation http", res.status);
      return true; // fail closed
    }
    const data = await res.json();
    // If Gemini blocked the prompt outright, that's a strong signal — hold it.
    if (data?.promptFeedback?.blockReason) return true;
    const txt = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!txt) return true; // no verdict → fail closed
    return Boolean(JSON.parse(txt).flagged);
  } catch (err) {
    console.error("[ideas] moderation error:", err);
    return true; // fail closed
  }
}

// =========================================================================
//  Semantic embeddings (Gemini) — computed + stored server-side. The browser
//  never sees a raw vector or the key; GET returns only 2D coordinates.
// =========================================================================
const EMBED_DIMS = 768;

// MANDATORY: gemini-embedding-001 returns NON-normalized vectors when
// outputDimensionality < 3072, so cosine == dot only after manual L2-norm.
// Skip this and clustering silently looks random.
function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n === 0 || !isFinite(n)) return null;
  for (let i = 0; i < v.length; i++) v[i] = v[i] / n;
  return v;
}

// number[768] L2-normalized, or null on ANY failure. FAIL-OPEN: a missing
// embedding is cosmetic (the layout cold-start handles it) and must never
// block a publish — opposite of moderation, by design.
async function embed(text) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_EMBED_MODEL}:embedContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          model: `models/${env.GEMINI_EMBED_MODEL}`,
          content: { parts: [{ text: String(text).slice(0, 2000) }] },
          taskType: "SEMANTIC_SIMILARITY",
          outputDimensionality: EMBED_DIMS,
        }),
      }
    );
    if (!res.ok) {
      console.error("[ideas] embed http", res.status);
      return null;
    }
    const data = await res.json();
    const v = data?.embedding?.values; // SINGULAR for :embedContent
    if (!Array.isArray(v) || v.length !== EMBED_DIMS) return null;
    return l2normalize(v.map(Number));
  } catch (err) {
    console.error("[ideas] embed error:", err);
    return null;
  }
}

async function publishedCount() {
  const rows = await sql`
    select count(*)::int as count from ideas where status = 'published'
  `;
  return rows[0]?.count || 0;
}

// =========================================================================
//  Semantic-orbit layout — turns the embeddings into a 2D star field where
//  related ideas sit near each other. Deterministic (seeded), so the same
//  set of ideas always produces the same sky, and adding one idea barely
//  nudges the others. Runs once per idea-set (cached), off the request path.
// =========================================================================
const LAYOUT_K = 6;       // neighbors per idea
const LAYOUT_TAU = 0.35;  // min cosine similarity to count as "related"
const LAYOUT_ITERS = 300;

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fnv1a(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// per-id init point: seeding each id independently keeps existing stars put as
// the corpus grows (seeding only a global RNG would reshuffle the whole sky).
function seededInitDisc(id) {
  const h = fnv1a(String(id));
  const r1 = mulberry32(h)();
  const r2 = mulberry32(h ^ 0x9e3779b9)();
  const ang = r1 * Math.PI * 2;
  const rad = Math.sqrt(r2) * 0.9;
  return { x: Math.cos(ang) * rad, y: Math.sin(ang) * rad };
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function isVec(v) { return Array.isArray(v) && v.length === EMBED_DIMS; }
function round3(x) { return Math.round(x * 1000) / 1000; }
function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

// golden-angle spiral fallback (mirrors app.js spiralHome), coords in [-1,1]
function goldenAngleLayout(ideas) {
  const n = ideas.length;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const denom = Math.max(n, 14);
  return ideas.map((idea, i) => {
    const r = Math.max(0.06, Math.sqrt(i / denom) * 0.92);
    const a = i * golden;
    return {
      id: idea.id, text: idea.text, name: idea.name, created_at: idea.created_at,
      x: Math.cos(a) * r, y: Math.sin(a) * r, cluster: -1, neighbors: [],
    };
  });
}

let layoutCache = null;
function layoutCacheKey(ideas) { return `${ideas.length}:${ideas[0] ? ideas[0].id : "0"}`; }

function computeLayout(ideas) {
  const n = ideas.length;
  const key = layoutCacheKey(ideas);
  if (layoutCache && layoutCache.key === key) return layoutCache.data;

  const vecs = ideas.map((d) => (isVec(d.embedding) ? d.embedding : null));
  const haveVecs = vecs.filter(Boolean).length;

  // cold start: too few / too sparsely embedded → spiral, NO fake edges
  if (n < 8 || haveVecs < n * 0.6) {
    const data = goldenAngleLayout(ideas);
    layoutCache = { key, data };
    return data;
  }

  // 1. similarity (cosine == dot, vectors L2-normalized at store time)
  const sim = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = vecs[i] && vecs[j] ? dot(vecs[i], vecs[j]) : 0;
      sim[i][j] = s; sim[j][i] = s;
    }
  }

  // 2. top-K neighbors per node → undirected edge set
  const neighborIdx = [];
  for (let i = 0; i < n; i++) {
    const cand = [];
    for (let j = 0; j < n; j++) {
      if (j !== i && sim[i][j] > LAYOUT_TAU) cand.push([j, sim[i][j]]);
    }
    cand.sort((a, b) => b[1] - a[1]);
    neighborIdx.push(cand.slice(0, LAYOUT_K).map((c) => c[0]));
  }
  const edgeMap = new Map();
  for (let i = 0; i < n; i++) for (const j of neighborIdx[i]) {
    const a = Math.min(i, j), b = Math.max(i, j);
    edgeMap.set(a + "_" + b, [a, b]);
  }
  const edges = [...edgeMap.values()];

  // 3. deterministic init
  const pos = ideas.map((d) => seededInitDisc(d.id));

  // 4. Fruchterman–Reingold relaxation
  const k = 0.85 * Math.sqrt(1.0 / n);
  let temp = 0.12;
  for (let step = 0; step < LAYOUT_ITERS; step++) {
    const disp = Array.from({ length: n }, () => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++) {                 // 4a all-pairs repulsion
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
        const dist = Math.max(Math.hypot(dx, dy), 1e-4);
        const f = (k * k) / dist, ux = dx / dist, uy = dy / dist;
        disp[i].x += ux * f; disp[i].y += uy * f;
        disp[j].x -= ux * f; disp[j].y -= uy * f;
      }
    }
    for (const [i, j] of edges) {                 // 4b sim-weighted attraction
      const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y;
      const dist = Math.max(Math.hypot(dx, dy), 1e-4);
      const w = clamp01((sim[i][j] - 0.3) / 0.7);
      const f = (dist * dist / k) * (0.4 + 0.6 * w), ux = dx / dist, uy = dy / dist;
      disp[i].x -= ux * f; disp[i].y -= uy * f;
      disp[j].x += ux * f; disp[j].y += uy * f;
    }
    for (let i = 0; i < n; i++) {                 // 4c gentle centering
      disp[i].x += -pos[i].x * 0.012; disp[i].y += -pos[i].y * 0.012;
    }
    for (let i = 0; i < n; i++) {                 // 4d integrate, cap, cool
      const m = Math.max(Math.hypot(disp[i].x, disp[i].y), 1e-4);
      const cap = Math.min(m, temp);
      pos[i].x += (disp[i].x / m) * cap;
      pos[i].y += (disp[i].y / m) * cap;
    }
    temp *= 0.985;
  }

  // 5. fit bounding box into [-0.92, 0.92]
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pos) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-4);
  const cxm = (minX + maxX) / 2, cym = (minY + maxY) / 2, scale = (0.92 * 2) / span;
  for (const p of pos) { p.x = (p.x - cxm) * scale; p.y = (p.y - cym) * scale; }

  // 6. communities (connected components over strong edges) for optional hue
  const parent = ideas.map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for (const [i, j] of edges) if (sim[i][j] > 0.55) parent[find(i)] = find(j);
  const rootToCluster = new Map();
  const cluster = ideas.map((_, i) => {
    const r = find(i);
    if (!rootToCluster.has(r)) rootToCluster.set(r, rootToCluster.size);
    return rootToCluster.get(r);
  });

  // 7. assemble — DROP the raw embedding
  const data = ideas.map((idea, i) => ({
    id: idea.id, text: idea.text, name: idea.name, created_at: idea.created_at,
    x: pos[i].x, y: pos[i].y, cluster: cluster[i],
    neighbors: neighborIdx[i]
      .map((j) => ({ id: ideas[j].id, sim: round3(sim[i][j]) }))
      .filter((e) => e.sim > LAYOUT_TAU)
      .slice(0, LAYOUT_K),
  }));
  layoutCache = { key, data };
  return data;
}

// ---- Handler -------------------------------------------------------------
module.exports = async function handler(req, res) {
  if (envError || !sql) {
    return res.status(500).json({ error: "service unavailable" });
  }

  try {
    await ensureSchema();
    if (req.method === "GET") return await handleGet(req, res);
    if (req.method === "POST") return await handlePost(req, res);
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error("[ideas] unhandled:", err);
    return res.status(500).json({ error: "something went sideways" });
  }
};

// ---- GET: read the nexus -------------------------------------------------
async function handleGet(req, res) {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 150);
  const before = typeof req.query.before === "string" ? req.query.before : null;

  // Pull embeddings too — computeLayout consumes then strips them, so the
  // browser receives only 2D coordinates, never a raw vector.
  const ideas = before
    ? await sql`
        select id, text, name, created_at, embedding from ideas
        where status = 'published' and created_at < ${before}
        order by created_at desc limit ${limit}
      `
    : await sql`
        select id, text, name, created_at, embedding from ideas
        where status = 'published'
        order by created_at desc limit ${limit}
      `;

  const total = await publishedCount();
  const nextCursor =
    ideas.length === limit ? ideas[ideas.length - 1].created_at : null;

  const laidOut = computeLayout(ideas); // adds x/y/cluster/neighbors, drops embedding

  // Short CDN cache — the wall can lag a few seconds, that's fine.
  res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
  return res.status(200).json({ ideas: laidOut, total, nextCursor });
}

// ---- POST: add a spark ---------------------------------------------------
async function handlePost(req, res) {
  const ipHash = hashIp(clientIp(req));

  // Rate limit by counting this device's recent rows — no extra service needed.
  const recent = await sql`
    select count(*)::int as count from ideas
    where ip_hash = ${ipHash}
      and created_at > now() - make_interval(mins => ${RATE_WINDOW_MIN})
  `;
  if ((recent[0]?.count || 0) >= RATE_LIMIT) {
    res.setHeader("Retry-After", String(RATE_WINDOW_MIN * 60));
    return res
      .status(429)
      .json({ error: "easy now — a few sparks at a time. try again shortly." });
  }

  // Validate (.strict rejects unexpected fields).
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  const parsed = ideaSchema.safeParse(body || {});
  if (!parsed.success) {
    const msg = parsed.error.issues[0]?.message || "that didn't go through";
    return res.status(400).json({ error: msg });
  }
  const { text, name } = parsed.data;

  // Moderate. Flagged → held (saved but never shown), gentle non-committal reply.
  const flagged = await isFlagged([text, name]);
  const status = flagged ? "held" : "published";

  // Embed only published text (don't spend a call on held/rejected). Fail-open:
  // a null embedding just means this star gets its semantic home on the next GET.
  const embedding = status === "published" ? await embed(text) : null;

  const inserted = await sql`
    insert into ideas (text, name, status, ip_hash, embedding, embedded_at)
    values (${text}, ${name || null}, ${status}, ${ipHash},
            ${embedding}, ${embedding ? new Date().toISOString() : null})
    returning id, text, name, created_at
  `;
  const idea = inserted[0];

  if (flagged) {
    // No troll feedback loop: looks like success, simply never joins the wall.
    return res.status(200).json({
      ok: true,
      held: true,
      message: "that one's being looked at before it joins the field.",
    });
  }

  const total = await publishedCount();
  return res.status(201).json({ ok: true, idea, total });
}
