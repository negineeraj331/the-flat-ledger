// ============================================================================
// money.js — all monetary arithmetic lives here.
// ============================================================================
// Rules (see DECISIONS.md):
//   * Money is represented as INTEGER minor units (paise for INR, cents for USD).
//     We never do arithmetic on floating-point rupees.
//   * Parsing tolerates the mess in the CSV: thousands separators ("1,200"),
//     surrounding whitespace (" 1450 "), and sub-paise precision (899.995).
//   * Splitting uses the LARGEST-REMAINDER method so the per-person shares
//     always sum back to the exact total — no rounding leak, no lost paise.
// ============================================================================

/**
 * Parse a raw amount string from the CSV into integer minor units.
 * Handles: thousands separators, leading/trailing spaces, decimals, sign.
 * Rounds to the nearest minor unit using round-half-up (so 899.995 -> 90000
 * paise = 900.00). Returns { minor, hadComma, hadWhitespace, hadSubMinor }.
 *
 * @param {string|number} raw
 * @param {number} minorPerUnit  100 for INR/USD (two decimal places)
 */
export function parseAmountToMinor(raw, minorPerUnit = 100) {
  if (raw === null || raw === undefined) {
    return { minor: null, error: 'empty' };
  }
  const original = String(raw);
  const trimmed = original.trim();
  if (trimmed === '') return { minor: null, error: 'empty' };

  const hadWhitespace = original !== trimmed;
  const hadComma = trimmed.includes(',');

  // Strip thousands separators. We only support the comma-as-thousands
  // convention that appears in the file ("1,200"); a comma decimal would be
  // ambiguous and none appear here.
  const cleaned = trimmed.replace(/,/g, '');

  if (!/^-?\d*\.?\d+$/.test(cleaned)) {
    return { minor: null, error: `unparseable amount: "${original}"` };
  }

  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    return { minor: null, error: `unparseable amount: "${original}"` };
  }

  // Detect sub-minor precision (more decimal places than the currency allows).
  const dot = cleaned.indexOf('.');
  const decimals = dot === -1 ? 0 : cleaned.length - dot - 1;
  const hadSubMinor = decimals > 2;

  const minor = roundHalfUp(value * minorPerUnit);

  return { minor, hadComma, hadWhitespace, hadSubMinor, parsedValue: value };
}

/**
 * Round half-up, symmetric for negatives (so -0.5 -> -1 in magnitude away from
 * zero would be inconsistent; we use "round half away from zero" which is the
 * intuitive bank-receipt behaviour for refunds too).
 */
export function roundHalfUp(n) {
  return Math.sign(n) * Math.round(Math.abs(n));
}

/**
 * Format integer minor units as a human string in the given currency.
 * e.g. formatMinor(48000_00, 'INR') -> "₹48,000.00"
 */
export function formatMinor(minor, currency = 'INR') {
  const symbol = { INR: '₹', USD: '$' }[currency] ?? '';
  const negative = minor < 0;
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  const majorStr = major.toLocaleString('en-IN');
  return `${negative ? '-' : ''}${symbol}${majorStr}.${cents}`;
}

/**
 * Allocate `total` minor units across `weights` using the largest-remainder
 * method. Returns an integer array, same length as weights, that sums EXACTLY
 * to `total`. Works for negative totals (refunds) too.
 *
 * Example: total=100, weights=[1,1,1] -> [34,33,33]  (sum 100)
 *
 * @param {number} total    integer minor units (may be negative)
 * @param {number[]} weights non-negative numbers; at least one must be > 0
 */
export function allocateByWeights(total, weights) {
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) {
    throw new Error('allocateByWeights: weights must sum to a positive number');
  }

  // Work in the sign of total, allocate the magnitude, then re-apply the sign.
  const sign = total < 0 ? -1 : 1;
  const magnitude = Math.abs(total);

  // Ideal (fractional) share for each weight.
  const ideal = weights.map((w) => (magnitude * w) / sumW);
  const floors = ideal.map((x) => Math.floor(x));
  let allocated = floors.reduce((a, b) => a + b, 0);
  let remainder = magnitude - allocated; // how many minor units still to hand out

  // Hand the leftover units, one each, to the entries with the largest
  // fractional part (ties broken by original index for determinism).
  const order = ideal
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);

  const result = floors.slice();
  for (let k = 0; k < remainder; k++) {
    result[order[k % order.length].i] += 1;
  }

  return result.map((x) => x * sign);
}

/**
 * Equal split of `total` across `n` participants. Convenience wrapper over
 * allocateByWeights with unit weights. The first `remainder` participants (in
 * the order given by the caller) absorb the extra paise.
 */
export function allocateEqually(total, n) {
  return allocateByWeights(total, new Array(n).fill(1));
}
