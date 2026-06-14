import { Fragment, useEffect, useState } from 'react';
import { api, formatMinor, formatAccounting } from '../api.js';

export default function Balances({ groupId, members, baseCurrency }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [openMember, setOpenMember] = useState(null);
  const [ledger, setLedger] = useState(null);
  const [settleFor, setSettleFor] = useState(null);

  const load = () =>
    api.get(`/groups/${groupId}/balances`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [groupId]);

  const showLedger = async (m) => {
    if (openMember === m.id) { setOpenMember(null); setLedger(null); return; }
    setOpenMember(m.id);
    setLedger(await api.get(`/groups/${groupId}/balances/${m.id}/ledger`));
  };

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Loading…</p>;

  const fmt = (m) => formatMinor(m, baseCurrency);

  return (
    <div>
      {/* Aisha: one number per person */}
      <div className="card">
        <div className="section-eyebrow">Statement of accounts</div>
        <h3>Net balance per person</h3>
        <p className="muted small">Read it like a ledger: a plain figure is owed <em>to</em> them
          (in the black); a red <span className="debit">(figure)</span> is what they owe
          (in the red). Click a row to see every expense behind it (Rohan’s view).</p>
        <table className="table">
          <thead><tr><th>Member</th><th className="r">Paid</th><th className="r">Share of expenses</th><th className="r">Net</th><th></th></tr></thead>
          <tbody>
            {data.balances.map((b) => (
              <Fragment key={b.id}>
                <tr className="clickable" onClick={() => showLedger(b)}>
                  <td>{b.name} {b.member_type === 'guest' && <span className="tag">guest</span>}</td>
                  <td className="r">{fmt(b.paid_minor)}</td>
                  <td className="r">{fmt(b.owed_minor)}</td>
                  <td className={'r net ' + (b.net_minor >= 0 ? 'credit' : 'debit')}>
                    <strong>{formatAccounting(b.net_minor, baseCurrency)}</strong>
                  </td>
                  <td className="r"><button className="link" onClick={(e) => { e.stopPropagation(); setSettleFor(b); }}>settle</button></td>
                </tr>
                {openMember === b.id && ledger && (
                  <tr><td colSpan={5}><Ledger ledger={ledger} fmt={fmt} name={b.name} /></td></tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {/* Aisha: who pays whom */}
      <div className="card">
        <div className="section-eyebrow">Closing entries</div>
        <h3>Who pays whom</h3>
        <p className="muted small">The fewest payments that settle every balance at once.</p>
        {data.transfers.length === 0 && <p className="muted">All settled up — the ledger is balanced.</p>}
        <ul className="transfers">
          {data.transfers.map((t, i) => (
            <li key={i}>
              <span className="who"><strong>{t.from}</strong> <span className="arrow">──▶</span> <strong>{t.to}</strong></span>
              <span className="leader" />
              <span className="amt">{fmt(t.amount_minor)}</span>
            </li>
          ))}
        </ul>
      </div>

      {settleFor && (
        <SettleModal groupId={groupId} members={members} prefill={settleFor}
          baseCurrency={baseCurrency} onClose={() => setSettleFor(null)}
          onDone={() => { setSettleFor(null); load(); }} />
      )}
    </div>
  );
}

function Ledger({ ledger, fmt, name }) {
  return (
    <div className="ledger">
      <div className="ledger-col">
        <h4>{name} owes a share of</h4>
        <table className="table small">
          <tbody>
            {ledger.owes.map((o) => (
              <tr key={o.id}>
                <td className="muted">row {o.source_row}</td>
                <td>{o.spent_on} · {o.description}</td>
                <td className="r">{fmt(o.share_minor)}</td>
              </tr>
            ))}
            {ledger.owes.length === 0 && <tr><td className="muted">nothing</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="ledger-col">
        <h4>{name} paid for</h4>
        <table className="table small">
          <tbody>
            {ledger.paid.map((p) => (
              <tr key={p.id}><td className="muted">row {p.source_row}</td><td>{p.spent_on} · {p.description}</td><td className="r">{fmt(p.amount_minor)}</td></tr>
            ))}
            {ledger.paid.length === 0 && <tr><td className="muted">nothing</td></tr>}
          </tbody>
        </table>
        {ledger.settlements.length > 0 && (
          <>
            <h4>Settlements</h4>
            <table className="table small"><tbody>
              {ledger.settlements.map((s) => (
                <tr key={s.id}><td>{s.from_name} → {s.to_name}</td><td className="r">{fmt(s.amount_minor)}</td></tr>
              ))}
            </tbody></table>
          </>
        )}
      </div>
    </div>
  );
}

function SettleModal({ groupId, members, prefill, baseCurrency, onClose, onDone }) {
  // If the member owes (net<0) they are the payer; if owed, they receive.
  const isDebtor = prefill.net_minor < 0;
  const [from, setFrom] = useState(isDebtor ? prefill.id : '');
  const [to, setTo] = useState(isDebtor ? '' : prefill.id);
  const [amount, setAmount] = useState(Math.abs(prefill.net_minor) / 100);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/groups/${groupId}/settlements`, {
        fromMember: Number(from), toMember: Number(to), amount: String(amount),
      });
      onDone();
    } catch (err) { setError(err.message); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="card modal" onClick={(e) => e.stopPropagation()}>
        <h3>Record a payment</h3>
        <form onSubmit={submit}>
          <label>From (payer)
            <select value={from} onChange={(e) => setFrom(e.target.value)} required>
              <option value="">—</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label>To (receiver)
            <select value={to} onChange={(e) => setTo(e.target.value)} required>
              <option value="">—</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label>Amount ({baseCurrency})
            <input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </label>
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button className="primary">Record</button>
            <button type="button" className="link" onClick={onClose}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
