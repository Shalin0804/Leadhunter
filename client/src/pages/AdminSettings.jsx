import { Link } from 'react-router-dom';
import { FiCheck, FiMinus } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { auditApi } from '../services/endpoints';
import { Card, Loader, ErrorBox } from '../components/ui';
import { fmtIST } from '../utils/rbac';

export default function AdminSettings() {
  const { data, loading, error, reload } = useApi(() => auditApi.settings(), []);
  if (loading) return <Loader />;
  if (error) return <div className="page"><ErrorBox message={error} onRetry={reload} /></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Admin Settings</h1>
          <p>Access control and audit configuration. Values marked “env” are set on the server, not here.</p>
        </div>
        <div className="flex gap-2">
          <Link className="btn" to="/email">Email settings</Link>
          <Link className="btn" to="/automation">Automation settings</Link>
        </div>
      </div>

      <div className="grid chart-grid mb-3">
        <Card title="Audit & tracking">
          <dl className="def-list">
            <dt>Tracking started</dt>
            <dd>{data.tracking_started_at ? fmtIST(data.tracking_started_at, data.display_timezone) : 'No events yet'}</dd>
            <dt>Display timezone</dt>
            <dd>{data.display_timezone} <span className="cell-sub">env DISPLAY_TIMEZONE</span></dd>
            <dt>Log retention</dt>
            <dd>{data.audit_retention_days ? `${data.audit_retention_days} days` : 'Kept indefinitely'} <span className="cell-sub">env AUDIT_RETENTION_DAYS</span></dd>
            <dt>Contact reveal limit</dt>
            <dd>{data.contact_reveal_limit_per_hour} per employee per hour <span className="cell-sub">env CONTACT_REVEAL_LIMIT_PER_HOUR</span></dd>
          </dl>
        </Card>
        <Card title="Provisioning">
          <p className="text-sm">There is no public sign-up. Employees join only through an invite from Team Management and get exactly the role chosen there.</p>
          <p className="text-sm">To create or recover a Main Admin from the server, run:</p>
          <pre className="detail-json">npm --prefix server run create-admin -- --email you@company.com --name "Your Name"</pre>
        </Card>
      </div>

      <Card title="Role permissions" bodyClass="">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Permission</th>
                {data.roles.map((r) => <th key={r.key}>{r.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.permissions).map(([perm, description]) => (
                <tr key={perm}>
                  <td>
                    <div className="cell-strong">{description}</div>
                    <div className="cell-sub"><code>{perm}</code></div>
                  </td>
                  {data.roles.map((r) => (
                    <td key={r.key}>
                      {r.permissions.includes(perm) ? <FiCheck className="text-success" aria-label="allowed" /> : <FiMinus className="text-muted" aria-label="not allowed" />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="card-pad text-sm text-muted">
          Enforced on the server for every API request. Lead visibility: Main Admin — all leads; Manager — own and team’s; BDE and Viewer — only leads assigned to them. Defined in <code>server/config/permissions.js</code>.
        </p>
      </Card>
    </div>
  );
}
