import pkg from "pg";

const { Pool } = pkg;

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set");
}

// Railway (and most cloud providers) require SSL for PostgreSQL.
// rejectUnauthorized: false is needed because Railway uses self-signed certs.
const isProduction = process.env.NODE_ENV === "production";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : undefined,
});

pool.on("error", (err) => {
  console.error("[DB] Pool error:", err.message);
});

// Simple one-shot query — for reads and non-transactional writes
export async function query(sql: string, params?: unknown[]) {
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

// Run multiple queries in a real ACID transaction on ONE connection
export async function withTransaction<T>(
  fn: (client: pkg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
