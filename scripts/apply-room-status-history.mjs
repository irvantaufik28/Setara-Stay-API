import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const tag = "0028_room_status_history";
const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8"));
const entry = journal.entries.find((item) => item.tag === tag);
if (!entry) throw new Error(`Migration ${tag} is missing from the local journal`);

const migrationSql = readFileSync(`drizzle/${tag}.sql`, "utf8");
const migrationHash = createHash("sha256").update(migrationSql).digest("hex");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const client = new pg.Client({ connectionString: databaseUrl });
await client.connect();

try {
  await client.query("BEGIN");

  const { rows: targetRows } = await client.query(
    "SELECT current_database() AS database, to_regclass('greenhero.room_status_events') AS history_table",
  );
  const target = targetRows[0];
  if (target.database !== "greenhero") {
    throw new Error(`Expected database greenhero, got ${target.database}`);
  }

  const { rows: migrationRows } = await client.query(
    "SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1",
  );
  const latestMigrationAt = Number(migrationRows[0]?.created_at ?? 0);

  if (latestMigrationAt >= entry.when) {
    if (!target.history_table) {
      throw new Error("Migration journal is ahead of 0028, but room_status_events is missing");
    }
    await client.query("COMMIT");
    console.log(`${tag} is already applied to ${target.database}`);
  } else {
    if (target.history_table) {
      throw new Error("room_status_events exists, but migration 0028 is not recorded");
    }
    await client.query(migrationSql);
    await client.query(
      "INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)",
      [migrationHash, entry.when],
    );
    await client.query("COMMIT");
    console.log(`${tag} applied to ${target.database}`);
  }
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  await client.end();
}
