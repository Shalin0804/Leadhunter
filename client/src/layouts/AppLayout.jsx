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
  FiRadio,
  FiZap,
  FiCpu,
  FiDatabase,
  FiUser,
  FiUsers,
  FiUserCheck,
  FiBarChart2,
  FiActivity,
  FiEye,
  FiShield,
  FiSettings,
  FiCompass,
  FiMap,
  FiTag,
  FiClock,
  FiBookOpen,
} from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import { initials } from '../utils/format';
import { ROLE_LABELS } from '../utils/rbac';

// Visibility follows the server's permissions (the API enforces them regardless).
const NAV = [
  {
    section: 'Dashboard',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: <FiGrid />, perm: 'dashboard.view' },
      { to: '/leads', label: 'All Leads', icon: <FiTarget />, perm: 'leads.view', end: true },
      { to: '/my-leads', label: 'My Leads', icon: <FiUser />, perm: 'leads.view' },
      { to: '/lead-discovery', label: 'Lead Discovery', icon: <FiCompass />, perm: 'discovery.run' },
      { to: '/contacts', label: 'Contacts', icon: <FiBookOpen />, perm: 'leads.view' },
      { to: '/pipeline', label: 'Pipeline', icon: <FiColumns />, perm: 'leads.view' },
      { to: '/tasks', label: 'Tasks & Follow-ups', icon: <FiCheckSquare />, perm: 'leads.view' },
      { to: '/notes', label: 'Notes', icon: <FiFileText />, perm: 'leads.view' },
    ],
  },
  {
    section: 'Lead Discovery',
    items: [
      { to: '/discovery', label: 'Companies', icon: <FiSearch />, perm: 'discovery.use' },
      { to: '/discovery-jobs', label: 'Scheduled Discovery', icon: <FiClock />, perm: 'discovery.use' },
      { to: '/categories', label: 'Business Categories', icon: <FiTag />, perm: 'settings.manage' },
      { to: '/automation', label: 'Automatic Lead Gen', icon: <FiZap />, perm: 'discovery.use' },
      { to: '/leads/automatic', label: 'Automatic Leads', icon: <FiCpu />, perm: 'discovery.use' },
      { to: '/explorium', label: 'Explorium Leads', icon: <FiDatabase />, perm: 'discovery.use' },
      { to: '/signals', label: 'Buying Signals', icon: <FiRadio />, perm: 'discovery.use' },
      { to: '/imports', label: 'CSV Import', icon: <FiUploadCloud />, perm: 'discovery.use' },
    ],
  },
  {
    section: 'Team',
    items: [
      { to: '/team', label: 'Team Management', icon: <FiUsers />, perm: 'team.view' },
      { to: '/assignment', label: 'Lead Assignment', icon: <FiUserCheck />, perm: 'leads.assign' },
      { to: '/locations', label: 'Location Management', icon: <FiMap />, perm: 'locations.manage' },
      { to: '/performance', label: 'Team Performance', icon: <FiBarChart2 />, perm: 'performance.view' },
    ],
  },
  {
    section: 'Security & Tracking',
    items: [
      { to: '/activity', label: 'Activity Log', icon: <FiActivity />, perm: 'audit.view' },
      { to: '/access-history', label: 'Lead Access History', icon: <FiEye />, perm: 'audit.view' },
      { to: '/audit-trail', label: 'Audit Trail', icon: <FiShield />, perm: 'settings.manage' },
    ],
  },
  {
    section: 'Settings',
    items: [{ to: '/admin-settings', label: 'Admin Settings', icon: <FiSettings />, perm: 'settings.manage' }],
  },
];

export default function AppLayout() {
  const { user, logout, can } = useAuth();
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
          {NAV.map((group) => {
            const items = group.items.filter((n) => can(n.perm));
            if (!items.length) return null;
            return (
              <div key={group.section}>
                <div className="nav-section">{group.section}</div>
                {items.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    end={n.end}
                    className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`}
                    onClick={() => setOpen(false)}
                  >
                    {n.icon}
                    {n.label}
                  </NavLink>
                ))}
              </div>
            );
          })}
        </nav>
        <div className="sidebar-footer">
          <div style={{ color: '#fff', fontWeight: 600 }}>{user?.name}</div>
          <div style={{ opacity: 0.7, fontSize: 11 }}>{user?.email}</div>
          <div style={{ opacity: 0.85, fontSize: 11, marginTop: 2 }}>{ROLE_LABELS[user?.role] || user?.role}</div>
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
