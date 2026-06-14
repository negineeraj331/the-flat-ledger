import { useEffect, useState } from 'react';
import { api, formatMinor } from '../api.js';

const STATUS_TAG = {
  active: 'ok', duplicate: 'warn', quarantined: 'err',
  skipped: 'muted', pending_approval: 'warn',
};

export default function Expenses({ groupId, members, baseCurrency }) {
  const [expenses, setExpenses] = useState([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const load = () =>
    api.get(`/groups/${groupId}/expenses`).then(setExpenses).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [groupId]);

  const fmt = (m, c) => formatMinor(m, c || baseCurrency);

  return (
    <div>
      <div className="row spread">
        <h3>Expenses ({expenses.length})</h3>
        <button className="primary" onClick={() => setShowForm((s) => !s)}>{showForm ? 'Close' : '+ Add expense'}</button>
      </div>
      {error && <p className="error">{error}</p>}
      {showForm && <ExpenseForm groupId={groupId} members={members} baseCurrency={baseCurrency}
        onDone={() => { setShowForm(false); load(); }} />}

      <div className="card">
        <table className="table">
          <thead><tr>
            <th>Row</th><th>Date</th><th>Description</th><th>Paid by</th>
            <th className="r">Amount</th><th>Split</th><th>Status</th>
          </tr></thead>
          <tbody>
            {expenses.map((e) => (
              <tr key={e.id} className={e.status !== 'active' ? 'dim' : ''}>
                <td className="muted">{e.source_row || '—'}</td>
                <td>{e.spent_on || <span className="tag err">no date</span>}</td>
                <td>
                  {e.description}
                  {e.kind === 'settlement' && <span className="tag">settlement</span>}
                  {e.original_currency !== baseCurrency &&
                    <span className="muted small"> · {fmt(e.original_amount_minor, e.original_currency)} @ {e.fx_rate}</span>}
                </td>
                <td>{e.paid_by_name || <span className="tag err">none</span>}</td>
                <td className="r">{fmt(e.amount_minor)}</td>
                <td>{e.split_type}</td>
                <td><span className={'tag ' + (STATUS_TAG[e.status] || '')}>{e.status}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExpenseForm({ groupId, members, baseCurrency, onDone }) {
  const active = members; // could filter by date; kept simple
  const [form, setForm] = useState({
    spentOn: '', description: '', paidBy: '', amount: '', currency: baseCurrency, splitType: 'equal',
  });
  const [selected, setSelected] = useState({}); // memberId -> {checked, weight, pct, amount}
  const [error, setError] = useState('');

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggle = (id) => setSelected((s) => ({ ...s, [id]: { ...(s[id] || {}), checked: !s[id]?.checked } }));
  const setField = (id, k, v) => setSelected((s) => ({ ...s, [id]: { ...(s[id] || {}), [k]: v } }));

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const participants = members
      .filter((m) => selected[m.id]?.checked)
      .map((m) => ({
        memberId: m.id,
        weight: selected[m.id]?.weight,
        pct: selected[m.id]?.pct,
        amount: selected[m.id]?.amount,
      }));
    if (participants.length === 0) return setError('Pick at least one participant.');
    try {
      await api.post(`/groups/${groupId}/expenses`, { ...form, paidBy: Number(form.paidBy), participants });
      onDone();
    } catch (err) { setError(err.message); }
  };

  return (
    <div className="card">
      <form onSubmit={submit}>
        <div className="row">
          <label>Date<input type="date" value={form.spentOn} onChange={(e) => set('spentOn', e.target.value)} /></label>
          <label>Description<input value={form.description} onChange={(e) => set('description', e.target.value)} required /></label>
        </div>
        <div className="row">
          <label>Paid by
            <select value={form.paidBy} onChange={(e) => set('paidBy', e.target.value)} required>
              <option value="">—</option>
              {active.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label>Amount<input type="number" step="0.001" value={form.amount} onChange={(e) => set('amount', e.target.value)} required /></label>
          <label>Currency
            <select value={form.currency} onChange={(e) => set('currency', e.target.value)}>
              <option>INR</option><option>USD</option>
            </select>
          </label>
          <label>Split type
            <select value={form.splitType} onChange={(e) => set('splitType', e.target.value)}>
              <option value="equal">equal</option>
              <option value="unequal">unequal (amounts)</option>
              <option value="percentage">percentage</option>
              <option value="share">share (weights)</option>
            </select>
          </label>
        </div>
        <div className="participants">
          <h4>Participants</h4>
          {active.map((m) => (
            <div key={m.id} className="participant">
              <label className="check">
                <input type="checkbox" checked={!!selected[m.id]?.checked} onChange={() => toggle(m.id)} /> {m.name}
              </label>
              {selected[m.id]?.checked && form.splitType === 'share' &&
                <input className="mini" type="number" placeholder="weight" value={selected[m.id]?.weight || ''} onChange={(e) => setField(m.id, 'weight', e.target.value)} />}
              {selected[m.id]?.checked && form.splitType === 'percentage' &&
                <input className="mini" type="number" placeholder="%" value={selected[m.id]?.pct || ''} onChange={(e) => setField(m.id, 'pct', e.target.value)} />}
              {selected[m.id]?.checked && form.splitType === 'unequal' &&
                <input className="mini" type="number" placeholder="amount" value={selected[m.id]?.amount || ''} onChange={(e) => setField(m.id, 'amount', e.target.value)} />}
            </div>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <button className="primary">Save expense</button>
      </form>
    </div>
  );
}
