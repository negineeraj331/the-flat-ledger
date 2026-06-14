// ============================================================================
// routes/settlements.js — record a payment between two members (settle debts).
// ============================================================================
import { Router } from 'express';
import { query, queryOne } from '../../db/pool.js';
import { requireAuth, requireGroupAccess } from '../auth/middleware.js';
import { parseAmountToMinor } from '../lib/money.js';
import { convertMinor, isSupportedCurrency } from '../lib/fx.js';

export const settlementsRouter = Router({ mergeParams: true });
settlementsRouter.use(requireAuth, requireGroupAccess);

settlementsRouter.get('/', async (req, res) => {
  const rows = await query(
    `SELECT s.id, s.paid_on::text, s.amount_minor, s.note, s.source_row,
            fm.name AS from_name, tm.name AS to_name, s.from_member, s.to_member
     FROM settlements s
     JOIN members fm ON fm.id = s.from_member
     JOIN members tm ON tm.id = s.to_member
     WHERE s.group_id = $1 ORDER BY s.paid_on NULLS LAST, s.id`,
    [req.group.id]
  );
  res.json(rows.map((r) => ({ ...r, amount_minor: Number(r.amount_minor) })));
});

// Record a payment: { fromMember, toMember, amount, currency?, paidOn?, note? }
settlementsRouter.post('/', async (req, res) => {
  const b = req.body || {};
  if (!b.fromMember || !b.toMember || b.amount == null) {
    return res.status(400).json({ error: 'fromMember, toMember and amount are required' });
  }
  if (b.fromMember === b.toMember) {
    return res.status(400).json({ error: 'A member cannot settle with themselves' });
  }
  const currency = (b.currency || req.group.base_currency).toUpperCase();
  if (!isSupportedCurrency(currency, req.group.base_currency)) {
    return res.status(400).json({ error: `Unsupported currency ${currency}` });
  }
  const amt = parseAmountToMinor(String(b.amount));
  if (amt.minor == null || amt.minor <= 0) return res.status(400).json({ error: 'Invalid amount' });
  const { minor } = convertMinor(amt.minor, currency, req.group.base_currency);

  const row = await queryOne(
    `INSERT INTO settlements (group_id, paid_on, from_member, to_member, amount_minor, note)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [req.group.id, b.paidOn || null, b.fromMember, b.toMember, minor, b.note || null]
  );
  res.status(201).json({ id: row.id });
});

settlementsRouter.delete('/:settlementId', async (req, res) => {
  const r = await queryOne(
    `DELETE FROM settlements WHERE id=$1 AND group_id=$2 RETURNING id`,
    [Number(req.params.settlementId), req.group.id]
  );
  if (!r) return res.status(404).json({ error: 'Settlement not found' });
  res.json({ ok: true });
});
