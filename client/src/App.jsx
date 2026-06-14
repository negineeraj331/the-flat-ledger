import { Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Group from './pages/Group.jsx';

export default function App() {
  const { user, loading, logout } = useAuth();
  const navigate = useNavigate();

  if (loading) return <div className="center muted">Loading…</div>;

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">🏠 Flatshare Expenses</Link>
        {user && (
          <div className="topbar-right">
            <span className="muted">{user.name || user.email}</span>
            <button className="link" onClick={async () => { await logout(); navigate('/login'); }}>
              Log out
            </button>
          </div>
        )}
      </header>
      <main className="container">
        <Routes>
          <Route path="/login" element={user ? <Navigate to="/" /> : <Login />} />
          <Route path="/" element={user ? <Dashboard /> : <Navigate to="/login" />} />
          <Route path="/groups/:groupId/*" element={user ? <Group /> : <Navigate to="/login" />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
