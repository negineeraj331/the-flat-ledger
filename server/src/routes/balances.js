// ============================================================================
// routes/balances.js — group balances, "who pays whom", per-member ledger.
// ============================================================================
import { Router } from 'express';
import { requireAuth, requireGroupAccess } from '../auth/middleware.js';
import { getBalances, simplifyDebts, getMemberLedger } from '../balances/compute.js';

export const balancesRouter = Router({ mergeParams: true });
balancesRouter.use(requireAuth, requireGroupAccess);

// Aisha's request: one net number per person + the minimal "who pays whom".
balancesRouter.get('/', async (req, res) => {
  const balances = await getBalances(req.group.id);
  const transfers = simplifyDebts(balances);
  res.json({ balances, transfers, baseCurrency: req.group.base_currency });
});

// Rohan's request: exactly which expenses make up one member's balance.
balancesRouter.get('/:memberId/ledger', async (req, res) => {
  const ledger = await getMemberLedger(req.group.id, Number(req.params.memberId));
  res.json(ledger);
});
