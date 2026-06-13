// =========================================================================
//  One-off migration: create the `ideas` table in Neon.
//  Run once after DATABASE_URL is in your environment:
//
//      node scripts/setup-db.js
//
//  Idempotent — safe to run again; it won't clobber existing data.
//  Reads .env.local automatically so you don't have to export anything.
// =========================================================================

const fs = require("fs");
const path = require("path");
const { neon } = require("@neondatabase/serverless");

// Tiny .env.local loader (no dotenv dependency needed for a one-off script).
function loadEnvLocal() {
  const file = path.join(__dirname, "..", ".env.local");
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2].trim().replace(/^["']|["']$/g, "");
    if (!process.env[m[1]]) process.env[m[1]] = val;
  }
}

async function main() {
  loadEnvLocal();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "✗ DATABASE_URL not found. Put it in .env.local (run `vercel env pull .env.local`) and retry."
    );
    process.exit(1);
  }

  const sql = neon(url);

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
    create index if not exists ideas_iphash_idx
      on ideas (ip_hash, created_at)
  `;

  const rows = await sql`select count(*)::int as count from ideas`;
  console.log(`✓ ideas table ready. current rows: ${rows[0].count}`);
}

main().catch((err) => {
  console.error("✗ setup failed:", err.message || err);
  process.exit(1);
});
