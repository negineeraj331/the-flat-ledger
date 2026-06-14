import { useState } from 'react';
import { api } from '../api.js';

// Manage membership over time. Editing "left on" is what makes Meera stop
// affecting expenses after she moves out; "joined on" is what keeps Sam off
// March bills.
export default function Members({ groupId, members, reload }) {
  const [error, setError] = useState('');
  const [adding, setAdding] = useState({ name: '', memberType: 'resident', joinedOn: '', leftOn: '' });

  const save = async (m, patch) => {
    setError('');
    try { await api.patch(`/groups/${groupId}/members/${m.id}`, patch); await reload(); }
    catch (e) { setError(e.message); }
  };

  const add = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api.post(`/groups/${groupId}/members`, {
        name: adding.name, memberType: adding.memberType,
        joinedOn: adding.joinedOn || null, leftOn: adding.leftOn || null,
      });
      setAdding({ name: '', memberType: 'resident', joinedOn: '', leftOn: '' });
      await reload();
    } catch (err) { setError(err.message); }
  };

  return (
    <div className="card">
      <h3>Members & membership windows</h3>
      {error && <p className="error">{error}</p>}
      <table className="table">
        <thead><tr><th>Name</th><th>Type</th><th>Joined</th><th>Left</th><th></th></tr></thead>
        <tbody>
          {members.map((m) => (
            <MemberRow key={m.id} m={m} onSave={save} />
          ))}
        </tbody>
      </table>

      <h4>Add member</h4>
      <form onSubmit={add} className="row">
        <input placeholder="Name" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} required />
        <select value={adding.memberType} onChange={(e) => setAdding({ ...adding, memberType: e.target.value })}>
          <option value="resident">resident</option><option value="guest">guest</option>
        </select>
        <label className="inline">joined<input type="date" value={adding.joinedOn} onChange={(e) => setAdding({ ...adding, joinedOn: e.target.value })} /></label>
        <label className="inline">left<input type="date" value={adding.leftOn} onChange={(e) => setAdding({ ...adding, leftOn: e.target.value })} /></label>
        <button className="primary">Add</button>
      </form>
    </div>
  );
}

function MemberRow({ m, onSave }) {
  const [joinedOn, setJoinedOn] = useState(m.joined_on || '');
  const [leftOn, setLeftOn] = useState(m.left_on || '');
  const dirty = (joinedOn || null) !== (m.joined_on || null) || (leftOn || null) !== (m.left_on || null);
  return (
    <tr>
      <td>{m.name}</td>
      <td><span className="tag">{m.member_type}</span></td>
      <td><input type="date" value={joinedOn} onChange={(e) => setJoinedOn(e.target.value)} /></td>
      <td><input type="date" value={leftOn} onChange={(e) => setLeftOn(e.target.value)} /></td>
      <td>{dirty && <button className="link" onClick={() => onSave(m, { joinedOn: joinedOn || null, leftOn: leftOn || null })}>save</button>}</td>
    </tr>
  );
}
