import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { Loader } from './components/ui';
import AppLayout from './layouts/AppLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Discovery from './pages/Discovery';
import CompanyProfile from './pages/CompanyProfile';
import Leads from './pages/Leads';
import AutomaticLeads from './pages/AutomaticLeads';
import LeadProfile from './pages/LeadProfile';
import Pipeline from './pages/Pipeline';
import Tasks from './pages/Tasks';
import Notes from './pages/Notes';
import Imports from './pages/Imports';
import ImportDetail from './pages/ImportDetail';
import Signals from './pages/Signals';
import Automation from './pages/Automation';
import AutomationRunDetail from './pages/AutomationRunDetail';
import ExploriumLeads from './pages/ExploriumLeads';
import SetPassword from './pages/SetPassword';
import TeamManagement from './pages/TeamManagement';
import LeadAssignment from './pages/LeadAssignment';
import TeamPerformance from './pages/TeamPerformance';
import ActivityLog from './pages/ActivityLog';
import AdminSettings from './pages/AdminSettings';
import LocationManagement from './pages/LocationManagement';
import LeadDiscovery from './pages/LeadDiscovery';
import BusinessCategories from './pages/BusinessCategories';
import ScheduledDiscovery from './pages/ScheduledDiscovery';
import Contacts from './pages/Contacts';

function Protected({ children }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <Loader label="Loading LeadHunter CRM…" />;
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

// UI guard only (the API enforces the same permission); sends the user home instead of a 403 page.
function RequirePerm({ perm, children }) {
  const { can } = useAuth();
  return can(perm) ? children : <Navigate to="/" replace />;
}

// Home depends on role: the company-wide dashboard for admins, the employee's own leads otherwise.
function Home() {
  const { can } = useAuth();
  return <Navigate to={can('dashboard.view') ? '/dashboard' : '/my-leads'} replace />;
}

const guard = (perm, el) => <RequirePerm perm={perm}>{el}</RequirePerm>;

export default function App() {
  const { isAuthenticated, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={loading ? <Loader /> : isAuthenticated ? <Navigate to="/" replace /> : <Login />}
      />
      <Route path="/set-password" element={<SetPassword />} />
      <Route
        element={
          <Protected>
            <AppLayout />
          </Protected>
        }
      >
        <Route path="/" element={<Home />} />
        <Route path="/dashboard" element={guard('dashboard.view', <Dashboard />)} />
        <Route path="/discovery" element={guard('discovery.use', <Discovery />)} />
        <Route path="/signals" element={guard('discovery.use', <Signals />)} />
        <Route path="/automation" element={guard('discovery.use', <Automation />)} />
        <Route path="/automation/runs/:id" element={guard('discovery.use', <AutomationRunDetail />)} />
        <Route path="/companies/:id" element={<CompanyProfile />} />
        <Route path="/leads" element={guard('leads.view', <Leads />)} />
        <Route path="/my-leads" element={guard('leads.view', <Leads mine key="mine" />)} />
        <Route path="/leads/automatic" element={guard('discovery.use', <AutomaticLeads />)} />
        <Route path="/leads/:id" element={<LeadProfile />} />
        <Route path="/pipeline" element={<Pipeline />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/notes" element={<Notes />} />
        <Route path="/explorium" element={guard('discovery.use', <ExploriumLeads />)} />
        <Route path="/imports" element={guard('discovery.use', <Imports />)} />
        <Route path="/imports/:id" element={guard('discovery.use', <ImportDetail />)} />
        <Route path="/team" element={guard('team.view', <TeamManagement />)} />
        <Route path="/assignment" element={guard('leads.assign', <LeadAssignment />)} />
        <Route path="/performance" element={guard('performance.view', <TeamPerformance />)} />
        <Route path="/activity" element={guard('audit.view', <ActivityLog preset="all" key="all" />)} />
        <Route path="/access-history" element={guard('audit.view', <ActivityLog preset="access" key="access" />)} />
        <Route path="/audit-trail" element={guard('settings.manage', <ActivityLog preset="security" key="security" />)} />
        <Route path="/lead-discovery" element={guard('discovery.run', <LeadDiscovery />)} />
        <Route path="/categories" element={guard('settings.manage', <BusinessCategories />)} />
        <Route path="/discovery-jobs" element={guard('discovery.use', <ScheduledDiscovery />)} />
        <Route path="/contacts" element={guard('leads.view', <Contacts />)} />
        <Route path="/locations" element={guard('locations.manage', <LocationManagement />)} />
        <Route path="/admin-settings" element={guard('settings.manage', <AdminSettings />)} />
      </Route>
      <Route path="*" element={<Navigate to={isAuthenticated ? '/' : '/login'} replace />} />
    </Routes>
  );
}
