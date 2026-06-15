// =========================================================================
//  One-off backfill: compute + store Gemini embeddings for published ideas
//  that don't have one yet. Idempotent (only touches `embedding IS NULL`).
//
//      node scripts/backfill-embeddings.js
//
//  Reads .env.local automatically (DATABASE_URL + GEMINI_API_KEY). Run once
//  after deploying the embeddings change so existing stars get semantic homes.
// =========================================================================

const fs = require("fs");
const path = require("path");
const { neon } = require("@neondatabase/serverless");

const EMBED_DIMS = 768;

function loadEnvLocal() {
  const file = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

// MANDATORY L2-norm — see api/ideas.js: the model returns non-normalized
// vectors at dims < 3072, so cosine==dot only after this.
function l2normalize(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s);
  if (n === 0 || !isFinite(n)) return null;
  for (let i = 0; i < v.length; i++) v[i] = v[i] / n;
  return v;
}

async function main() {
  loadEnvLocal();
  const url = process.env.DATABASE_URL;
  const key = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-001";
  if (!url) { console.error("✗ DATABASE_URL missing (run `vercel env pull .env.local`)."); process.exit(1); }
  if (!key) { console.error("✗ GEMINI_API_KEY missing in .env.local."); process.exit(1); }

  const sql = neon(url);

  // self-provision the columns so the backfill works before any deploy
  // (the serverless function's ensureSchema() also creates these in prod)
  await sql`alter table ideas add column if not exists embedding real[]`;
  await sql`alter table ideas add column if not exists embedded_at timestamptz`;

  let embedded = 0;

  for (;;) {
    const rows = await sql`
      select id, text from ideas
      where status = 'published' and embedding is null
      order by created_at desc limit 100
    `;
    if (!rows.length) break;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          requests: rows.map((r) => ({
            model: `models/${model}`,
            content: { parts: [{ text: String(r.text).slice(0, 2000) }] },
            taskType: "SEMANTIC_SIMILARITY",
            outputDimensionality: EMBED_DIMS,
          })),
        }),
      }
    );
    if (!res.ok) {
      console.error("✗ batchEmbedContents http", res.status, await res.text().catch(() => ""));
      process.exit(1);
    }
    const data = await res.json();
    const embs = data && data.embeddings;
    if (!Array.isArray(embs) || embs.length !== rows.length) {
      console.error("✗ embedding count mismatch", embs && embs.length, "vs", rows.length);
      process.exit(1);
    }

    for (let i = 0; i < rows.length; i++) {
      const raw = embs[i] && embs[i].values;
      const v = Array.isArray(raw) && raw.length === EMBED_DIMS ? l2normalize(raw.map(Number)) : null;
      if (!v) { console.warn("  · skipped (no vector):", rows[i].id); continue; }
      await sql`update ideas set embedding = ${v}, embedded_at = now() where id = ${rows[i].id}`;
      embedded++;
    }
    console.log(`  · embedded ${embedded} so far…`);
  }

  console.log(`✓ done. embedded ${embedded} idea(s).`);
}

main().catch((err) => {
  console.error("✗ backfill failed:", err.message || err);
  process.exit(1);
});
