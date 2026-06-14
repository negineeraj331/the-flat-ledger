// ============================================================================
// import-cli.js — import a CSV from the command line and print the report.
// Usage: npm --workspace server run import:csv  (defaults to the bundled CSV)
//   or:  node scripts/import-cli.js path/to/file.csv
//
// This creates a fresh "Flat 4B" group, seeds the roster, imports the file, and
// prints the same import report the app produces. Handy for the live session.
// ============================================================================
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pool, withTransaction } from '../db/pool.js';
import { setupDefaultGroup } from '../src/import/setupGroup.js';
import { importCsvText } from '../src/import/importer.js';
import { renderReport } from '../src/import/report.js';

async function main() {
  const file = process.argv[2] || '../data/expenses_export.csv';
  const path = resolve(process.cwd(), file);
  const text = await readFile(path, 'utf8');

  const result = await withTransaction(async (client) => {
    const group = await setupDefaultGroup(client);
    const run = await client.query(
      `INSERT INTO import_runs (group_id, filename) VALUES ($1,$2) RETURNING id`,
      [group.id, file]
    );
    const importRunId = run.rows[0].id;
    const res = await importCsvText({ client, text, group, importRunId });
    await client.query(
      `UPDATE import_runs SET total_rows=$1, imported_rows=$2, anomaly_count=$3 WHERE id=$4`,
      [res.totalRows, res.importedRows, res.anomalies.length, importRunId]
    );
    return { group, ...res };
  });

  console.log(renderReport(result));
  await pool.end();
}

main().catch((err) => {
  console.error('❌ import failed:', err);
  process.exit(1);
});
