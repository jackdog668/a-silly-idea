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
  OPENAI_API_KEY: z.string().min(1),
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

// Returns true when the text should be HELD (flagged or moderation failed).
// Fails closed: if the moderation call errors, we hold rather than publish
// unscreened — better to delay one good idea than show one bad one to everyone.
async function isFlagged(parts) {
  const input = parts.filter(Boolean).join("\n").slice(0, 4000);
  try {
    const res = await fetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "omni-moderation-latest", input }),
    });
    if (!res.ok) {
      console.error("[ideas] moderation http", res.status);
      return true; // fail closed
    }
    const data = await res.json();
    return Boolean(data?.results?.[0]?.flagged);
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
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 40, 1), 100);
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
