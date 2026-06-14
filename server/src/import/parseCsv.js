// ============================================================================
// parseCsv.js — read the export file into raw row objects.
// ============================================================================
// We do NOT clean anything here. The job of this module is only to faithfully
// turn CSV text into JS objects (handling quoted fields, embedded commas, etc.)
// so the rest of the pipeline sees exactly what the file contained. All cleanup
// and anomaly handling happens later, where it can be logged.
// ============================================================================
import { parse } from 'csv-parse/sync';

/**
 * Parse CSV text into rows.
 * @returns {Array<object>} each row is the column->value map, plus a
 *   `_row` field = the 1-based line number in the file (header is line 1, so the
 *   first data row is line 2). This is the number we surface in the import
 *   report and store on expenses.source_row for traceability.
 */
export function parseCsv(text) {
  const records = parse(text, {
    columns: true,          // use the header row as keys
    skip_empty_lines: true,
    relax_column_count: true, // tolerate rows with stray/missing trailing cols
    trim: false,            // keep whitespace so we can DETECT it as an anomaly
  });

  return records.map((rec, i) => ({
    ...rec,
    _row: i + 2, // +1 for 0-based -> 1-based, +1 for the header line
  }));
}

export const EXPECTED_COLUMNS = [
  'date',
  'description',
  'paid_by',
  'amount',
  'currency',
  'split_type',
  'split_with',
  'split_details',
  'notes',
];
