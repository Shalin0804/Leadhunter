import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { Loader } from './components/ui';
import AppLayout from './layouts/AppLayout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Discovery from './pages/Discovery';
import CompanyProfile from './pages/CompanyProfile';
import Leads from './pages/Leads';
import LeadProfile from './pages/LeadProfile';
import Pipeline from './pages/Pipeline';
import Tasks from './pages/Tasks';
import Notes from './pages/Notes';
import Imports from './pages/Imports';
import ImportDetail from './pages/ImportDetail';
import Signals from './pages/Signals';
import Automation from './pages/Automation';
import AutomationRunDetail from './pages/AutomationRunDetail';

function Protected({ children }) {
  const { isAuthenticated, loading } = useAuth();
  if (loading) return <Loader label="Loading LeadHunter CRM…" />;
  return isAuthenticated ? children : <Navigate to="/login" replace />;
}

export default function App() {
  const { isAuthenticated, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={loading ? <Loader /> : isAuthenticated ? <Navigate to="/dashboard" replace /> : <Login />}
      />
      <Route
        element={
          <Protected>
            <AppLayout />
          </Protected>
        }
      >
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/discovery" element={<Discovery />} />
        <Route path="/signals" element={<Signals />} />
        <Route path="/automation" element={<Automation />} />
        <Route path="/automation/runs/:id" element={<AutomationRunDetail />} />
        <Route path="/companies/:id" element={<CompanyProfile />} />
        <Route path="/leads" element={<Leads />} />
        <Route path="/leads/:id" element={<LeadProfile />} />
        <Route path="/pipeline" element={<Pipeline />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/notes" element={<Notes />} />
        <Route path="/imports" element={<Imports />} />
        <Route path="/imports/:id" element={<ImportDetail />} />
      </Route>
      <Route path="*" element={<Navigate to={isAuthenticated ? '/dashboard' : '/login'} replace />} />
    </Routes>
  );
}
