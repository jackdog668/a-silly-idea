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

async function publishedCount() {
  const rows = await sql`
    select count(*)::int as count from ideas where status = 'published'
  `;
  return rows[0]?.count || 0;
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

  // Two branches keep the tagged-template parameterization clean and safe.
  const ideas = before
    ? await sql`
        select id, text, name, created_at from ideas
        where status = 'published' and created_at < ${before}
        order by created_at desc limit ${limit}
      `
    : await sql`
        select id, text, name, created_at from ideas
        where status = 'published'
        order by created_at desc limit ${limit}
      `;

  const total = await publishedCount();
  const nextCursor =
    ideas.length === limit ? ideas[ideas.length - 1].created_at : null;

  // Short CDN cache — the wall can lag a few seconds, that's fine.
  res.setHeader("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
  return res.status(200).json({ ideas, total, nextCursor });
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

  const inserted = await sql`
    insert into ideas (text, name, status, ip_hash)
    values (${text}, ${name || null}, ${status}, ${ipHash})
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
