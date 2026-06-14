// ============================================================================
// report.js — turn an import result into a human-readable report.
// ============================================================================
// Backs the "Import report" deliverable: every anomaly detected and the action
// taken. renderReport() returns plain text (for the CLI / a downloadable file);
// the API also returns the structured anomaly rows for the in-app report view.
// ============================================================================

export function renderReport(result) {
  const { group, totalRows, importedRows, anomalies } = result;
  const lines = [];
  const rule = '─'.repeat(72);

  lines.push(rule);
  lines.push(`IMPORT REPORT — ${group?.name ?? 'group'}`);
  lines.push(rule);
  lines.push(`Total rows in file : ${totalRows}`);
  lines.push(`Imported (active)  : ${importedRows}`);
  lines.push(`Anomalies detected : ${anomalies.length}`);

  const bySeverity = countBy(anomalies, (a) => a.severity);
  lines.push(
    `  errors: ${bySeverity.error || 0}   ` +
    `warnings: ${bySeverity.warning || 0}   ` +
    `info: ${bySeverity.info || 0}`
  );
  const pending = anomalies.filter((a) => a.status === 'pending_approval').length;
  lines.push(`Awaiting approval  : ${pending}`);
  lines.push('');

  // group by anomaly_type for a tidy summary
  const byType = groupBy(anomalies, (a) => a.type);
  lines.push('BY TYPE');
  lines.push(rule);
  for (const [type, items] of Object.entries(byType).sort()) {
    lines.push(`• ${type} — ${items.length}`);
  }
  lines.push('');

  // full per-row detail, sorted by source row
  lines.push('DETAIL (by CSV row)');
  lines.push(rule);
  const sorted = [...anomalies].sort(
    (a, b) => (a.source_row || 0) - (b.source_row || 0)
  );
  for (const a of sorted) {
    const flag = a.status === 'pending_approval' ? ' [NEEDS APPROVAL]' : '';
    lines.push(
      `row ${String(a.source_row).padStart(3)} ` +
      `[${a.severity.toUpperCase()}] ${a.type}${flag}`
    );
    lines.push(`         ${a.message}`);
    lines.push(`         → action: ${a.action}`);
  }
  lines.push(rule);
  return lines.join('\n');
}

function countBy(arr, fn) {
  const out = {};
  for (const x of arr) out[fn(x)] = (out[fn(x)] || 0) + 1;
  return out;
}

function groupBy(arr, fn) {
  const out = {};
  for (const x of arr) (out[fn(x)] ||= []).push(x);
  return out;
}
