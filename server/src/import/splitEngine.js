// ============================================================================
// splitEngine.js — turn a split definition into exact per-member shares.
// ============================================================================
// Supports every split type that appears in the CSV:
//   equal      — divide equally among participants
//   unequal    — explicit currency amount per person
//   percentage — percentage per person (normalised if it doesn't total 100)
//   share      — integer/decimal weights per person ("Aisha 1; Rohan 2")
//
// Every function returns { shares, anomalies } where:
//   shares    = [{ member, share_minor }] and SUM(share_minor) === amountMinor
//   anomalies = [{ type, severity, message }] describing anything off (e.g.
//               percentages that didn't total 100, explicit amounts that don't
//               sum to the total). The caller decides how to surface/persist.
//
// All allocation goes through money.allocateByWeights so totals are exact.
// ============================================================================
import { allocateByWeights } from '../lib/money.js';

/** equal split among `members` (array of member objects). */
export function computeEqual(amountMinor, members) {
  if (members.length === 0) {
    return { shares: [], anomalies: [errEmpty()] };
  }
  const alloc = allocateByWeights(amountMinor, members.map(() => 1));
  return {
    shares: members.map((m, i) => ({ member: m, share_minor: alloc[i] })),
    anomalies: [],
  };
}

/** weighted "share" split. entries = [{ member, weight }]. */
export function computeShares(amountMinor, entries) {
  if (entries.length === 0) return { shares: [], anomalies: [errEmpty()] };
  const weights = entries.map((e) => e.weight);
  if (weights.some((w) => !(w >= 0)) || weights.reduce((a, b) => a + b, 0) <= 0) {
    return {
      shares: [],
      anomalies: [{
        type: 'invalid_shares',
        severity: 'error',
        message: `share weights are invalid: [${weights.join(', ')}]`,
      }],
    };
  }
  const alloc = allocateByWeights(amountMinor, weights);
  return {
    shares: entries.map((e, i) => ({ member: e.member, share_minor: alloc[i] })),
    anomalies: [],
  };
}

/**
 * unequal split with explicit per-person amounts (already in minor units).
 * entries = [{ member, amount_minor }]. If the explicit amounts don't sum to
 * the expense total we flag it and SCALE proportionally so the books still
 * balance (documented policy; alternative would be to quarantine).
 */
export function computeUnequal(amountMinor, entries) {
  if (entries.length === 0) return { shares: [], anomalies: [errEmpty()] };
  const sum = entries.reduce((a, e) => a + e.amount_minor, 0);
  if (sum === amountMinor) {
    return {
      shares: entries.map((e) => ({ member: e.member, share_minor: e.amount_minor })),
      anomalies: [],
    };
  }
  // Mismatch: re-allocate the true total by the given amounts as weights.
  const alloc = allocateByWeights(amountMinor, entries.map((e) => Math.abs(e.amount_minor) || 1));
  return {
    shares: entries.map((e, i) => ({ member: e.member, share_minor: alloc[i] })),
    anomalies: [{
      type: 'unequal_sum_mismatch',
      severity: 'warning',
      message: `explicit amounts summed to ${sum} but expense total is ${amountMinor}; re-scaled proportionally`,
    }],
  };
}

/**
 * percentage split. entries = [{ member, pct }]. If percentages don't total
 * 100 we NORMALISE proportionally (each pct / total) and flag it, so balances
 * stay exact rather than rejecting an otherwise-usable row.
 */
export function computePercentage(amountMinor, entries) {
  if (entries.length === 0) return { shares: [], anomalies: [errEmpty()] };
  const total = entries.reduce((a, e) => a + e.pct, 0);
  const anomalies = [];
  if (Math.abs(total - 100) > 0.001) {
    anomalies.push({
      type: 'percentage_sum_not_100',
      severity: 'warning',
      message: `percentages sum to ${total}%, not 100%; normalised proportionally`,
    });
  }
  // Use the percentages directly as weights — allocateByWeights normalises by
  // their sum, which is exactly "proportional normalisation".
  const alloc = allocateByWeights(amountMinor, entries.map((e) => e.pct));
  return {
    shares: entries.map((e, i) => ({ member: e.member, share_minor: alloc[i] })),
    anomalies,
  };
}

function errEmpty() {
  return {
    type: 'no_participants',
    severity: 'error',
    message: 'no participants to split among',
  };
}
