import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function Dashboard() {
  const [groups, setGroups] = useState([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get('/groups').then(setGroups).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const createGroup = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try { await api.post('/groups', { name }); setName(''); await load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  const createDemo = async () => {
    setBusy(true);
    try { await api.post('/groups/demo'); await load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h1>Your groups</h1>
      {error && <p className="error">{error}</p>}
      <div className="grid">
        {groups.map((g) => (
          <Link key={g.id} to={`/groups/${g.id}`} className="card group-card">
            <h3>{g.name}</h3>
            <span className="muted">base {g.base_currency} · {g.role}</span>
          </Link>
        ))}
        {groups.length === 0 && <p className="muted">No groups yet. Create one below.</p>}
      </div>

      <div className="card">
        <h3>New group</h3>
        <form onSubmit={createGroup} className="row">
          <input placeholder="Group name (e.g. Flat 4B)" value={name} onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={busy}>Create</button>
        </form>
        <hr />
        <p className="muted">Or spin up the pre-seeded <strong>Flat 4B</strong> demo (Aisha, Rohan, Priya,
          Meera→left, Sam→joined, Dev guest) so you can import <code>expenses_export.csv</code> immediately.</p>
        <button onClick={createDemo} disabled={busy}>Create demo group “Flat 4B”</button>
      </div>
    </div>
  );
}
