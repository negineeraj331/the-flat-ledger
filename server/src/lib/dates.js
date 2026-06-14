// ============================================================================
// dates.js — tolerant date parsing for the messy CSV.
// ============================================================================
// Formats that actually appear in expenses_export.csv:
//   * ISO            2026-02-01
//   * DD/MM/YYYY     01/03/2026          (NOT MM/DD — see note below)
//   * Month-day      "Mar 14"            (no year)
//   * Ambiguous      04/05/2026          (could be 4 May or 5 Apr)
//
// Why DD/MM/YYYY and not MM/DD/YYYY:
//   Several slash dates have a first component > 12 (15/03, 18/03, 20/03,
//   22/03, 25/03, 28/03). Those are only valid if the first field is the DAY.
//   So the file's slash convention is unambiguously DD/MM/YYYY, and we apply
//   that convention uniformly. The one row that is still genuinely ambiguous in
//   meaning (04/05/2026, sitting among the April rows) is parsed by the same
//   DD/MM rule -> 4 May 2026, but the caller flags it for human review.
// ============================================================================

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// The dataset spans Feb–Apr 2026; rows with no year ("Mar 14") get this year.
const DEFAULT_YEAR = 2026;

/**
 * Parse a raw date string. Returns:
 *   { iso: 'YYYY-MM-DD', format: '...', ambiguous: bool }  on success
 *   { iso: null, error: '...' }                            on failure
 */
export function parseDate(raw, defaultYear = DEFAULT_YEAR) {
  if (raw == null) return { iso: null, error: 'empty date' };
  const s = String(raw).trim();
  if (s === '') return { iso: null, error: 'empty date' };

  // ISO: YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    return finalize(+m[1], +m[2], +m[3], 'ISO', false);
  }

  // Slash: D/M/YYYY (treated as DD/MM/YYYY per the note above).
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const day = +m[1];
    const month = +m[2];
    const year = +m[3];
    // Genuinely ambiguous only when BOTH components are 1..12 (either could be
    // the month). We still commit to DD/MM, but tell the caller it's ambiguous.
    const ambiguous = day <= 12 && month <= 12;
    return finalize(year, month, day, 'DD/MM/YYYY', ambiguous);
  }

  // Month name + day, no year: "Mar 14"
  m = s.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2})$/);
  if (m) {
    const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (month) {
      return finalize(defaultYear, month, +m[2], 'Mon DD (year inferred)', false);
    }
  }

  return { iso: null, error: `unrecognised date format: "${s}"` };
}

function finalize(year, month, day, format, ambiguous) {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { iso: null, error: `out-of-range date: ${year}-${month}-${day}` };
  }
  const iso = `${year}-${pad(month)}-${pad(day)}`;
  // Validate the calendar date really exists (e.g. reject 31 Feb).
  const d = new Date(`${iso}T00:00:00Z`);
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() + 1 !== month ||
    d.getUTCDate() !== day
  ) {
    return { iso: null, error: `invalid calendar date: ${iso}` };
  }
  return { iso, format, ambiguous };
}

function pad(n) {
  return String(n).padStart(2, '0');
}
