import { useState } from 'react';
import { NavLink, useNavigate, Outlet } from 'react-router-dom';
import {
  FiGrid,
  FiSearch,
  FiTarget,
  FiColumns,
  FiCheckSquare,
  FiFileText,
  FiUploadCloud,
  FiLogOut,
  FiMenu,
} from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import { initials } from '../utils/format';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: <FiGrid /> },
  { to: '/discovery', label: 'Company Discovery', icon: <FiSearch /> },
  { to: '/leads', label: 'Leads', icon: <FiTarget /> },
  { to: '/pipeline', label: 'Pipeline', icon: <FiColumns /> },
  { to: '/tasks', label: 'Tasks & Follow-ups', icon: <FiCheckSquare /> },
  { to: '/notes', label: 'Notes', icon: <FiFileText /> },
  { to: '/imports', label: 'CSV Import', icon: <FiUploadCloud /> },
];

export default function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const onSearch = (e) => {
    e.preventDefault();
    if (search.trim()) navigate(`/discovery?search=${encodeURIComponent(search.trim())}`);
  };

  return (
    <div className="app-shell">
      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-brand">
          <span className="logo-mark">
            <FiTarget />
          </span>
          LeadHunter CRM
        </div>
        <div className="sidebar-tag">New-Company Intelligence</div>
        <nav className="sidebar-nav">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
              onClick={() => setOpen(false)}
            >
              {n.icon}
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <div style={{ color: '#fff', fontWeight: 600 }}>{user?.name}</div>
          <div style={{ opacity: 0.7, fontSize: 11 }}>{user?.email}</div>
          <button className="btn btn-sm mt-2 btn-block" onClick={() => logout()}>
            <FiLogOut /> Sign out
          </button>
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <button className="hamburger" onClick={() => setOpen((v) => !v)} aria-label="Menu">
            <FiMenu />
          </button>
          <form className="topbar-search" onSubmit={onSearch}>
            <FiSearch />
            <input
              placeholder="Search companies by name, CIN, city…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>
          <div className="topbar-user">
            <div className="avatar">{initials(user?.name)}</div>
          </div>
        </header>
        <main>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
