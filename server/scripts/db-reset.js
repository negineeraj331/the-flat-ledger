// ============================================================================
// db-reset.js — drop & recreate all tables from schema.sql.
// Usage: npm --workspace server run db:reset
// ============================================================================
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pool } from '../db/pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const schemaPath = join(__dirname, '..', 'db', 'schema.sql');
  const sql = await readFile(schemaPath, 'utf8');
  console.log('Applying schema from', schemaPath);
  await pool.query(sql);
  console.log('✅ Schema applied (all tables recreated).');
  await pool.end();
}

main().catch((err) => {
  console.error('❌ db-reset failed:', err.message);
  process.exit(1);
});
