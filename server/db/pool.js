// ============================================================================
// pool.js — a single shared pg connection pool plus small query helpers.
// ============================================================================
// Using node-postgres (`pg`) with plain SQL rather than an ORM: this app's
// hardest logic is arithmetic and import policy, not data modelling, and plain
// SQL keeps every query inspectable for the live walkthrough.
// ============================================================================
import pg from 'pg';
import { config } from '../src/config.js';

const { Pool } = pg;

// Neon (and most hosted Postgres) require SSL. Locally we usually don't.
const needsSsl =
  config.isProd ||
  (config.databaseUrl && /\bsslmode=require\b/.test(config.databaseUrl)) ||
  (config.databaseUrl && /neon\.tech/.test(config.databaseUrl));

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
});

/** Run a query and return the rows. */
export async function query(text, params) {
  const res = await pool.query(text, params);
  return res.rows;
}

/** Run a query and return the first row (or undefined). */
export async function queryOne(text, params) {
  const rows = await query(text, params);
  return rows[0];
}

/**
 * Run `fn` inside a transaction. The callback receives a dedicated client whose
 * `.query` is committed atomically (or rolled back on throw). Used by the
 * importer so a failed import leaves no half-written state.
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
