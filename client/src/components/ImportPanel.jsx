import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

const SEV_TAG = { error: 'err', warning: 'warn', info: 'muted' };

export default function ImportPanel({ groupId }) {
  const [runs, setRuns] = useState([]);
  const [report, setReport] = useState(null);
  const [anomalies, setAnomalies] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [filter, setFilter] = useState('all'); // all | pending | error | warning

  const loadRuns = useCallback(async () => {
    const r = await api.get(`/groups/${groupId}/imports`);
    setRuns(r);
    if (r[0]) loadReport(r[0].id);
    loadAnomalies();
  }, [groupId]); // eslint-disable-line

  const loadReport = async (runId) => setReport(await api.get(`/groups/${groupId}/imports/${runId}`));
  const loadAnomalies = async () => setAnomalies(await api.get(`/groups/${groupId}/anomalies`));

  useEffect(() => { loadRuns(); }, [loadRuns]);

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true); setError(''); setMsg('');
    try {
      const csv = await file.text();
      const res = await api.post(`/groups/${groupId}/imports`, { csv, filename: file.name });
      setMsg(`Imported ${res.importedRows}/${res.totalRows} rows · ${res.anomalyCount} anomalies detected.`);
      await loadRuns();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); e.target.value = ''; }
  };

  const decide = async (id, decision) => {
    await api.patch(`/groups/${groupId}/anomalies/${id}`, { decision });
    await Promise.all([loadAnomalies(), report && loadReport(report.run.id)]);
  };

  const resolveConflict = async (anomaly, keepExpenseId) => {
    await api.post(`/groups/${groupId}/anomalies/${anomaly.id}/resolve`, { keepExpenseId });
    await Promise.all([loadAnomalies(), report && loadReport(report.run.id)]);
  };

  const shown = anomalies.filter((a) =>
    filter === 'all' ? true :
    filter === 'pending' ? a.status === 'pending_approval' :
    a.severity === filter);

  return (
    <div>
      <div className="card">
        <div className="section-eyebrow">Posting the books</div>
        <h3>Import expenses_export.csv</h3>
        <p className="muted small">Upload the CSV exactly as exported — no hand-editing. The importer detects
          each data problem, applies a documented policy, and logs it below. Re-importing creates a new run.</p>
        <input type="file" accept=".csv" onChange={onFile} disabled={busy} />
        {busy && <span className="muted"> importing…</span>}
        {msg && <p className="ok-text">{msg}</p>}
        {error && <p className="error">{error}</p>}
      </div>

      {report && (
        <div className="card">
          <h3>Import report — run #{report.run.id} <span className="muted small">{report.run.filename}</span></h3>
          <div className="stats">
            <Stat label="Rows in file" value={report.run.total_rows} />
            <Stat label="Imported (active)" value={report.run.imported_rows} />
            <Stat label="Anomalies" value={report.run.anomaly_count} />
            <Stat label="Pending approval" value={anomalies.filter((a) => a.status === 'pending_approval').length} />
          </div>
        </div>
      )}

      <div className="card">
        <div className="row spread">
          <div>
            <div className="section-eyebrow">Reconciliation</div>
            <h3>Anomaly log & approval queue</h3>
          </div>
          <div className="filters">
            {['all', 'pending', 'error', 'warning'].map((f) => (
              <button key={f} className={filter === f ? 'tab active' : 'tab'} onClick={() => setFilter(f)}>{f}</button>
            ))}
          </div>
        </div>
        <table className="table">
          <thead><tr><th>Row</th><th>Severity</th><th>Type</th><th>What happened / action</th><th>Status</th><th>Approve?</th></tr></thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.id}>
                <td className="muted">{a.source_row}</td>
                <td><span className={'tag ' + SEV_TAG[a.severity]}>{a.severity}</span></td>
                <td><code>{a.anomaly_type}</code></td>
                <td>{a.message}<br /><span className="muted small">→ {a.action}</span></td>
                <td><span className={'tag ' + (a.status === 'pending_approval' ? 'warn' : a.status === 'rejected' ? 'err' : 'ok')}>{a.status}</span></td>
                <td>
                  {a.status === 'pending_approval' && a.anomaly_type === 'conflicting_duplicate' ? (
                    <ConflictResolver anomaly={a} groupId={groupId} onResolve={resolveConflict} />
                  ) : a.status === 'pending_approval' ? (
                    <div className="row">
                      <button className="link" onClick={() => decide(a.id, 'approve')}>approve</button>
                      <button className="link danger" onClick={() => decide(a.id, 'reject')}>reject</button>
                    </div>
                  ) : <span className="muted small">—</span>}
                </td>
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={6} className="muted">No anomalies for this filter.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return <div className="stat"><div className="stat-value">{value}</div><div className="stat-label muted">{label}</div></div>;
}

// For a conflicting duplicate, let the user pick which row to keep.
function ConflictResolver({ anomaly, onResolve }) {
  // raw_row holds the original CSV row; we offer "keep this row".
  return (
    <button className="link" onClick={() => onResolve(anomaly, anomaly.expense_id)}>
      keep row {anomaly.source_row}
    </button>
  );
}
