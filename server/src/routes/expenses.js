// ============================================================================
// routes/expenses.js — list / create / update-status / delete expenses.
// ============================================================================
// Create supports every split type (equal, unequal, percentage, share) and runs
// the SAME splitEngine the importer uses, so a hand-entered expense and an
// imported one are split by identical rules.
// ============================================================================
import { Router } from 'express';
import { query, queryOne, withTransaction } from '../../db/pool.js';
import { requireAuth, requireGroupAccess } from '../auth/middleware.js';
import { convertMinor, isSupportedCurrency } from '../lib/fx.js';
import { parseAmountToMinor } from '../lib/money.js';
import { isActiveOn } from '../import/roster.js';
import {
  computeEqual, computeShares, computeUnequal, computePercentage,
} from '../import/splitEngine.js';

export const expensesRouter = Router({ mergeParams: true });
expensesRouter.use(requireAuth, requireGroupAccess);

// List expenses with their splits (most recent first). Includes member names so
// the client can render without extra lookups.
expensesRouter.get('/', async (req, res) => {
  const expenses = await query(
    `SELECT e.*, m.name AS paid_by_name
     FROM expenses e LEFT JOIN members m ON m.id = e.paid_by
     WHERE e.group_id = $1
     ORDER BY e.spent_on NULLS LAST, e.id`,
    [req.group.id]
  );
  const splits = await query(
    `SELECT s.expense_id, s.member_id, s.share_minor, m.name
     FROM expense_splits s JOIN members m ON m.id = s.member_id
     JOIN expenses e ON e.id = s.expense_id
     WHERE e.group_id = $1`,
    [req.group.id]
  );
  const byExpense = new Map();
  for (const s of splits) {
    if (!byExpense.has(s.expense_id)) byExpense.set(s.expense_id, []);
    byExpense.get(s.expense_id).push({
      member_id: s.member_id, name: s.name, share_minor: Number(s.share_minor),
    });
  }
  res.json(
    expenses.map((e) => ({
      ...e,
      amount_minor: Number(e.amount_minor),
      original_amount_minor: Number(e.original_amount_minor),
      splits: byExpense.get(e.id) || [],
    }))
  );
});

// Create an expense. Body:
// { spentOn, description, paidBy(memberId), amount, currency,
//   splitType, participants: [{ memberId, weight?, pct?, amount? }] }
expensesRouter.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.description || b.amount == null || !b.paidBy) {
    return res.status(400).json({ error: 'description, amount and paidBy are required' });
  }
  const currency = (b.currency || req.group.base_currency).toUpperCase();
  if (!isSupportedCurrency(currency, req.group.base_currency)) {
    return res.status(400).json({ error: `Unsupported currency ${currency}` });
  }
  const amt = parseAmountToMinor(String(b.amount));
  if (amt.minor == null) return res.status(400).json({ error: 'Invalid amount' });

  const { minor: amountMinor, rate } = convertMinor(amt.minor, currency, req.group.base_currency);
  const splitType = (b.splitType || 'equal').toLowerCase();

  // Load the named participants as member rows and enforce membership windows.
  const memberIds = (b.participants || []).map((p) => p.memberId);
  const memberRows = await query(
    `SELECT id, name, member_type, joined_on::text, left_on::text
     FROM members WHERE group_id = $1 AND id = ANY($2)`,
    [req.group.id, memberIds]
  );
  const memById = new Map(memberRows.map((m) => [m.id, m]));
  const active = [];
  for (const p of b.participants || []) {
    const m = memById.get(p.memberId);
    if (!m) continue;
    if (b.spentOn && !isActiveOn(m, b.spentOn)) continue; // skip inactive members
    active.push({ member: m, ...p });
  }
  if (active.length === 0) {
    return res.status(400).json({ error: 'No active participants for this expense/date' });
  }

  // Compute shares via the shared engine.
  let result;
  switch (splitType) {
    case 'equal':
      result = computeEqual(amountMinor, active.map((a) => a.member)); break;
    case 'share':
      result = computeShares(amountMinor, active.map((a) => ({ member: a.member, weight: Number(a.weight) || 1 }))); break;
    case 'unequal':
      result = computeUnequal(amountMinor, active.map((a) => ({ member: a.member, amount_minor: parseAmountToMinor(String(a.amount)).minor || 0 }))); break;
    case 'percentage':
      result = computePercentage(amountMinor, active.map((a) => ({ member: a.member, pct: Number(a.pct) || 0 }))); break;
    default:
      return res.status(400).json({ error: `Unknown splitType ${splitType}` });
  }

  const created = await withTransaction(async (client) => {
    const e = await client.query(
      `INSERT INTO expenses
         (group_id, spent_on, description, paid_by, amount_minor,
          original_amount_minor, original_currency, fx_rate, split_type, kind, status, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'expense','active',$10) RETURNING id`,
      [req.group.id, b.spentOn || null, b.description, b.paidBy, amountMinor,
       amt.minor, currency, rate, splitType, b.notes || null]
    );
    const id = e.rows[0].id;
    for (const s of result.shares) {
      await client.query(
        `INSERT INTO expense_splits (expense_id, member_id, share_minor) VALUES ($1,$2,$3)`,
        [id, s.member.id, s.share_minor]
      );
    }
    return id;
  });
  res.status(201).json({ id: created, warnings: result.anomalies });
});

// Change an expense's status (e.g. un-skip, restore a duplicate, quarantine).
expensesRouter.patch('/:expenseId/status', async (req, res) => {
  const { status } = req.body || {};
  const allowed = ['active', 'duplicate', 'quarantined', 'skipped', 'pending_approval'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const e = await queryOne(
    `UPDATE expenses SET status=$3 WHERE id=$1 AND group_id=$2 RETURNING id, status`,
    [Number(req.params.expenseId), req.group.id, status]
  );
  if (!e) return res.status(404).json({ error: 'Expense not found' });
  res.json(e);
});

expensesRouter.delete('/:expenseId', async (req, res) => {
  const e = await queryOne(
    `DELETE FROM expenses WHERE id=$1 AND group_id=$2 RETURNING id`,
    [Number(req.params.expenseId), req.group.id]
  );
  if (!e) return res.status(404).json({ error: 'Expense not found' });
  res.json({ ok: true });
});
