// ============================================================================
// compute.js — balance calculation.
// ============================================================================
// Definitions (all in base-currency minor units):
//   paid_minor       = sum of ACTIVE expenses this member paid for
//   owed_minor       = sum of this member's shares across ACTIVE expenses
//   settle_out_minor = settlements this member PAID to others
//   settle_in_minor  = settlements this member RECEIVED from others
//
//   net_minor = paid_minor - owed_minor + settle_out_minor - settle_in_minor
//
//   net > 0  => the group owes this member (creditor)
//   net < 0  => this member owes the group (debtor)
//
// Only expenses with status='active' AND kind='expense' contribute. Duplicates,
// quarantined, skipped, and pending_approval rows are excluded. Settlements
// always contribute. Across ALL members the nets sum to zero.
// ============================================================================
import { query } from '../../db/pool.js';

const ACTIVE = `status = 'active' AND kind = 'expense'`;

/** Per-member balance rows for a group. */
export async function getBalances(groupId) {
  const rows = await query(
    `
    WITH paid AS (
      SELECT paid_by AS member_id, COALESCE(SUM(amount_minor),0) AS amt
      FROM expenses
      WHERE group_id = $1 AND ${ACTIVE} AND paid_by IS NOT NULL
      GROUP BY paid_by
    ),
    owed AS (
      SELECT s.member_id, COALESCE(SUM(s.share_minor),0) AS amt
      FROM expense_splits s
      JOIN expenses e ON e.id = s.expense_id
      WHERE e.group_id = $1 AND e.${ACTIVE}
      GROUP BY s.member_id
    ),
    settle_out AS (
      SELECT from_member AS member_id, COALESCE(SUM(amount_minor),0) AS amt
      FROM settlements WHERE group_id = $1 GROUP BY from_member
    ),
    settle_in AS (
      SELECT to_member AS member_id, COALESCE(SUM(amount_minor),0) AS amt
      FROM settlements WHERE group_id = $1 GROUP BY to_member
    )
    SELECT
      m.id, m.name, m.member_type, m.joined_on::text, m.left_on::text,
      COALESCE(p.amt,0)  AS paid_minor,
      COALESCE(o.amt,0)  AS owed_minor,
      COALESCE(so.amt,0) AS settle_out_minor,
      COALESCE(si.amt,0) AS settle_in_minor,
      COALESCE(p.amt,0) - COALESCE(o.amt,0)
        + COALESCE(so.amt,0) - COALESCE(si.amt,0) AS net_minor
    FROM members m
    LEFT JOIN paid       p  ON p.member_id  = m.id
    LEFT JOIN owed       o  ON o.member_id  = m.id
    LEFT JOIN settle_out so ON so.member_id = m.id
    LEFT JOIN settle_in  si ON si.member_id = m.id
    WHERE m.group_id = $1
    ORDER BY net_minor DESC, m.name
    `,
    [groupId]
  );
  // pg returns BIGINT as strings; coerce the numeric fields to numbers.
  return rows.map((r) => ({
    ...r,
    paid_minor: Number(r.paid_minor),
    owed_minor: Number(r.owed_minor),
    settle_out_minor: Number(r.settle_out_minor),
    settle_in_minor: Number(r.settle_in_minor),
    net_minor: Number(r.net_minor),
  }));
}

/**
 * Minimal "who pays whom" plan (Aisha's request). Greedy: repeatedly match the
 * biggest creditor with the biggest debtor. Produces at most (n-1) transfers.
 * Input is the balance rows from getBalances(); we only need name + net_minor.
 */
export function simplifyDebts(balances) {
  // clone so we don't mutate the caller's data
  const creditors = balances
    .filter((b) => b.net_minor > 0)
    .map((b) => ({ id: b.id, name: b.name, amt: b.net_minor }))
    .sort((a, b) => b.amt - a.amt);
  const debtors = balances
    .filter((b) => b.net_minor < 0)
    .map((b) => ({ id: b.id, name: b.name, amt: -b.net_minor }))
    .sort((a, b) => b.amt - a.amt);

  const transfers = [];
  let ci = 0;
  let di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c = creditors[ci];
    const d = debtors[di];
    const pay = Math.min(c.amt, d.amt);
    if (pay > 0) {
      transfers.push({
        from_id: d.id, from: d.name,
        to_id: c.id, to: c.name,
        amount_minor: pay,
      });
    }
    c.amt -= pay;
    d.amt -= pay;
    if (c.amt === 0) ci++;
    if (d.amt === 0) di++;
  }
  return transfers;
}

/**
 * Per-member ledger (Rohan's "show me exactly which expenses make up my
 * balance"). Returns every line item that affects this member's net, each with
 * the source row so it can be traced back to the CSV.
 */
export async function getMemberLedger(groupId, memberId) {
  // expenses this member owes a share of
  const owes = await query(
    `SELECT e.id, e.spent_on::text, e.description, e.amount_minor,
            e.original_amount_minor, e.original_currency, e.source_row,
            s.share_minor,
            (SELECT name FROM members WHERE id = e.paid_by) AS paid_by_name
     FROM expense_splits s
     JOIN expenses e ON e.id = s.expense_id
     WHERE e.group_id = $1 AND e.${ACTIVE} AND s.member_id = $2
     ORDER BY e.spent_on, e.id`,
    [groupId, memberId]
  );

  // expenses this member paid for
  const paid = await query(
    `SELECT id, spent_on::text, description, amount_minor, source_row
     FROM expenses
     WHERE group_id = $1 AND ${ACTIVE} AND paid_by = $2
     ORDER BY spent_on, id`,
    [groupId, memberId]
  );

  // settlements involving this member
  const settlements = await query(
    `SELECT s.id, s.paid_on::text, s.amount_minor, s.note, s.source_row,
            fm.name AS from_name, tm.name AS to_name,
            s.from_member, s.to_member
     FROM settlements s
     JOIN members fm ON fm.id = s.from_member
     JOIN members tm ON tm.id = s.to_member
     WHERE s.group_id = $1 AND ($2 IN (s.from_member, s.to_member))
     ORDER BY s.paid_on, s.id`,
    [groupId, memberId]
  );

  return {
    owes: owes.map(numify(['amount_minor', 'original_amount_minor', 'share_minor'])),
    paid: paid.map(numify(['amount_minor'])),
    settlements: settlements.map(numify(['amount_minor'])),
  };
}

function numify(fields) {
  return (row) => {
    const out = { ...row };
    for (const f of fields) if (out[f] != null) out[f] = Number(out[f]);
    return out;
  };
}
