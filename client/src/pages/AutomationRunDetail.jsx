import { useParams, useNavigate, Link } from 'react-router-dom';
import { FiArrowLeft } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { automationApi } from '../services/endpoints';
import { Card, Loader, ErrorBox, EmptyState, ScoreBadge } from '../components/ui';
import { fmtDateTime } from '../utils/format';

export default function AutomationRunDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => automationApi.getRun(id), [id]);

  if (loading) return <Loader />;
  if (error) return <div className="page"><ErrorBox message={error} onRetry={reload} /></div>;

  const run = data.run;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <button className="btn btn-ghost btn-sm mb-3" onClick={() => navigate('/automation')}><FiArrowLeft /> Automation</button>
          <h1>Search Run #{run.id}</h1>
          <p>{(run.locations || []).join(', ')} · {(run.industries || []).join(', ')} · {run.provider} · {fmtDateTime(run.started_at)}</p>
        </div>
        <span className={`badge ${run.status === 'completed' ? 'green' : run.status === 'failed' ? 'hot' : 'blue'}`}>{run.status}</span>
      </div>

      <div className="grid stat-grid mb-3">
        {[
          ['Discovered', run.businesses_discovered],
          ['Duplicates skipped', run.duplicates_skipped],
          ['Already contacted', run.already_contacted_skipped],
          ['Qualified leads', run.qualified_leads],
          ['Hot leads', run.hot_leads],
          ['Failed requests', run.failed_requests],
          ['API calls used', run.api_calls_used],
        ].map(([k, v]) => (
          <div key={k} className="card stat-card">
            <span className="stat-label">{k}</span>
            <div className="stat-value">{v}</div>
          </div>
        ))}
      </div>

      {run.error_message && <div className="error-box mb-3">{run.error_message}</div>}

      <Card title={`Businesses touched (${run.leadSources?.length || 0})`} bodyClass="">
        {run.leadSources?.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Company</th><th>Score</th><th>Temperature</th><th>External ID</th><th></th></tr></thead>
              <tbody>
                {run.leadSources.map((s) => (
                  <tr key={s.id}>
                    <td className="cell-strong">{s.company?.company_name || '—'}</td>
                    <td>{s.company ? <ScoreBadge value={s.company.lead_score} /> : '—'}</td>
                    <td className="text-sm">{s.company?.lead_temperature || '—'}</td>
                    <td className="cell-sub">{s.external_id || '—'}</td>
                    <td>{s.company && <Link className="btn btn-sm" to={`/companies/${s.company.id}`}>View</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No businesses recorded" message="This run may still be in progress or found nothing." />
        )}
      </Card>
    </div>
  );
}
