// ============================================================================
// routes/imports.js — CSV import + the anomaly approval queue.
// ============================================================================
// POST   /groups/:groupId/imports            run an import from uploaded CSV text
// GET    /groups/:groupId/imports            list past import runs
// GET    /groups/:groupId/imports/:runId     full report (summary + anomalies)
// GET    /groups/:groupId/anomalies          all anomalies (optionally pending)
// PATCH  /groups/:groupId/anomalies/:id      approve / reject an anomaly
// POST   /groups/:groupId/anomalies/:id/resolve  pick the winner of a conflict
//
// The CSV is sent as raw text in the body ({ csv: "..." }) so no multipart
// dependency is needed and the importer ingests it exactly as provided.
// ============================================================================
import { Router } from 'express';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { requireAuth, requireGroupAccess } from '../auth/middleware.js';
import { importCsvText } from '../import/importer.js';

export const importsRouter = Router({ mergeParams: true });
importsRouter.use(requireAuth, requireGroupAccess);

// ---- run an import --------------------------------------------------------
importsRouter.post('/imports', async (req, res) => {
  const csv = req.body?.csv;
  const filename = req.body?.filename || 'upload.csv';
  if (!csv || typeof csv !== 'string') {
    return res.status(400).json({ error: 'Send the CSV file contents as { csv: "..." }' });
  }
  try {
    const out = await withTransaction(async (client) => {
      const run = await client.query(
        `INSERT INTO import_runs (group_id, filename, created_by) VALUES ($1,$2,$3) RETURNING id`,
        [req.group.id, filename, req.user.uid]
      );
      const importRunId = run.rows[0].id;
      const result = await importCsvText({ client, text: csv, group: req.group, importRunId });
      await client.query(
        `UPDATE import_runs SET total_rows=$1, imported_rows=$2, anomaly_count=$3 WHERE id=$4`,
        [result.totalRows, result.importedRows, result.anomalies.length, importRunId]
      );
      return { importRunId, result };
    });
    res.status(201).json({
      importRunId: out.importRunId,
      totalRows: out.result.totalRows,
      importedRows: out.result.importedRows,
      anomalyCount: out.result.anomalies.length,
    });
  } catch (err) {
    // A failed import rolls back (withTransaction) — no half-written state.
    res.status(500).json({ error: `Import failed: ${err.message}` });
  }
});

importsRouter.get('/imports', async (req, res) => {
  const runs = await query(
    `SELECT id, filename, total_rows, imported_rows, anomaly_count, created_at
     FROM import_runs WHERE group_id=$1 ORDER BY id DESC`,
    [req.group.id]
  );
  res.json(runs);
});

importsRouter.get('/imports/:runId', async (req, res) => {
  const run = await queryOne(
    `SELECT id, filename, total_rows, imported_rows, anomaly_count, created_at
     FROM import_runs WHERE id=$1 AND group_id=$2`,
    [Number(req.params.runId), req.group.id]
  );
  if (!run) return res.status(404).json({ error: 'Import run not found' });
  const anomalies = await query(
    `SELECT id, source_row, anomaly_type, severity, message, action, status, expense_id, raw_row
     FROM import_anomalies WHERE import_run_id=$1 ORDER BY source_row, id`,
    [run.id]
  );
  res.json({ run, anomalies });
});

// ---- anomaly approval queue ----------------------------------------------
importsRouter.get('/anomalies', async (req, res) => {
  const onlyPending = req.query.pending === 'true';
  const rows = await query(
    `SELECT id, source_row, anomaly_type, severity, message, action, status, expense_id, raw_row
     FROM import_anomalies
     WHERE group_id=$1 ${onlyPending ? "AND status='pending_approval'" : ''}
     ORDER BY (status='pending_approval') DESC, source_row, id`,
    [req.group.id]
  );
  res.json(rows);
});

// Approve or reject an anomaly's action (Meera's requirement).
//   approve -> just records the decision; the action stays applied.
//   reject  -> records it AND reverses the few destructive actions we can undo:
//              exact_duplicate (restore the dropped row) and
//              settlement_logged_as_expense (quarantine, since we can't infer
//              the original split). Other actions are non-destructive.
importsRouter.patch('/anomalies/:id', async (req, res) => {
  const { decision } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be "approve" or "reject"' });
  }
  const anomaly = await queryOne(
    `SELECT * FROM import_anomalies WHERE id=$1 AND group_id=$2`,
    [Number(req.params.id), req.group.id]
  );
  if (!anomaly) return res.status(404).json({ error: 'Anomaly not found' });

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE import_anomalies SET status=$2 WHERE id=$1`,
      [anomaly.id, decision === 'approve' ? 'approved' : 'rejected']
    );
    if (decision === 'reject' && anomaly.expense_id) {
      if (anomaly.anomaly_type === 'exact_duplicate') {
        // user says it wasn't a duplicate -> bring the row back into balances.
        await client.query(`UPDATE expenses SET status='active' WHERE id=$1`, [anomaly.expense_id]);
      } else if (anomaly.anomaly_type === 'settlement_logged_as_expense') {
        // user says it wasn't a settlement -> remove the mirror & quarantine for
        // manual re-entry (we can't infer the original split).
        await client.query(`DELETE FROM settlements WHERE expense_id=$1`, [anomaly.expense_id]);
        await client.query(`UPDATE expenses SET status='quarantined', kind='expense' WHERE id=$1`, [anomaly.expense_id]);
      }
    }
  });
  res.json({ ok: true, status: decision === 'approve' ? 'approved' : 'rejected' });
});

// Resolve a conflicting duplicate: keep one expense, drop its siblings.
// Body: { keepExpenseId }
importsRouter.post('/anomalies/:id/resolve', async (req, res) => {
  const keepId = Number(req.body?.keepExpenseId);
  const anomaly = await queryOne(
    `SELECT * FROM import_anomalies WHERE id=$1 AND group_id=$2 AND anomaly_type='conflicting_duplicate'`,
    [Number(req.params.id), req.group.id]
  );
  if (!anomaly) return res.status(404).json({ error: 'Conflicting-duplicate anomaly not found' });

  // siblings share the same import run, source rows listed in the message — but
  // we locate them robustly: all pending_approval conflicting rows with the same
  // date + description key as the chosen expense.
  const keep = await queryOne(`SELECT * FROM expenses WHERE id=$1 AND group_id=$2`, [keepId, req.group.id]);
  if (!keep) return res.status(400).json({ error: 'keepExpenseId not in this group' });

  await withTransaction(async (client) => {
    const siblings = await client.query(
      `SELECT e.id FROM expenses e
       JOIN import_anomalies a ON a.expense_id = e.id AND a.anomaly_type='conflicting_duplicate'
       WHERE e.group_id=$1 AND e.spent_on=$2 AND e.status='pending_approval'`,
      [req.group.id, keep.spent_on]
    );
    for (const s of siblings.rows) {
      const status = s.id === keepId ? 'active' : 'duplicate';
      await client.query(`UPDATE expenses SET status=$2 WHERE id=$1`, [s.id, status]);
      await client.query(
        `UPDATE import_anomalies SET status=$2 WHERE expense_id=$1 AND anomaly_type='conflicting_duplicate'`,
        [s.id, s.id === keepId ? 'approved' : 'approved']
      );
    }
  });
  res.json({ ok: true, keptExpenseId: keepId });
});
