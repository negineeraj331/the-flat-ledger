import { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../api.js';
import Balances from '../components/Balances.jsx';
import Expenses from '../components/Expenses.jsx';
import Members from '../components/Members.jsx';
import ImportPanel from '../components/ImportPanel.jsx';

const TABS = ['Balances', 'Expenses', 'Members', 'Import & Anomalies'];

export default function Group() {
  const { groupId } = useParams();
  const [group, setGroup] = useState(null);
  const [members, setMembers] = useState([]);
  const [tab, setTab] = useState('Balances');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api.get(`/groups/${groupId}`);
      setGroup(d.group);
      setMembers(d.members);
    } catch (e) { setError(e.message); }
  }, [groupId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <p className="error">{error}</p>;
  if (!group) return <p className="muted">Loading…</p>;

  return (
    <div>
      <Link to="/" className="muted">← all groups</Link>
      <h1>{group.name} <span className="muted small">base {group.base_currency}</span></h1>

      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? 'tab active' : 'tab'} onClick={() => setTab(t)}>{t}</button>
        ))}
      </nav>

      {tab === 'Balances' && <Balances groupId={groupId} members={members} baseCurrency={group.base_currency} />}
      {tab === 'Expenses' && <Expenses groupId={groupId} members={members} baseCurrency={group.base_currency} />}
      {tab === 'Members' && <Members groupId={groupId} members={members} reload={load} />}
      {tab === 'Import & Anomalies' && <ImportPanel groupId={groupId} baseCurrency={group.base_currency} />}
    </div>
  );
}
