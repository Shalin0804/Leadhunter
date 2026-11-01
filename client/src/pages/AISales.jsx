import { Link } from 'react-router-dom';
import { FiCpu, FiStar, FiClock, FiMessageSquare, FiCheckSquare, FiSend, FiTarget } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { agentApi } from '../services/endpoints';
import { Card, Loader, ErrorBox, EmptyState } from '../components/ui';
import { fmtDateTime } from '../utils/format';

const QUALITY_TONE = { high: 'green', medium: 'warm', low: 'gray', unknown: 'gray' };

const Stat = ({ label, value, icon, sub, to }) => {
  const body = (
    <div className="card stat-card">
      <div className="flex justify-between items-center">
        <span className="stat-label">{label}</span>
        <span className="stat-icon">{icon}</span>
      </div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
  return to ? <Link to={to} style={{ color: 'inherit' }}>{body}</Link> : body;
};

export default function AISales() {
  const { data, loading, error, reload } = useApi(() => agentApi.salesOverview(), []);
  if (loading && !data) return <Loader />;
  if (error) return <div className="page"><ErrorBox message={error} onRetry={reload} /></div>;
  const { totals: t, quality, sales_tasks: tasks, last_30_days: m, history } = data;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>AI Sales</h1>
          <p>Claude's sales intelligence across your leads: analysis, playbooks, outreach waiting for approval, and what to do next. Claude drafts; you approve and send.</p>
        </div>
        <Link className="btn" to="/ai-agent">AI Agent control center</Link>
      </div>

      <div className="grid stat-grid mb-3">
        <Stat label="Leads analysed" value={t.leads_analysed} icon={<FiCpu />} sub={`${t.leads_with_playbook} with a sales playbook`} />
        <Stat label="High-potential leads" value={t.high_potential} icon={<FiStar />} sub="Latest playbook rates them high" />
        <Stat label="Follow-ups due" value={t.follow_ups_due} icon={<FiClock />} sub="Open follow-up tasks due now" to="/tasks" />
        <Stat label="Leads with pitches" value={t.leads_with_pitches} icon={<FiMessageSquare />} sub="Claude outreach drafts exist" />
        <Stat label="Awaiting approval" value={t.leads_awaiting_approval} icon={<FiCheckSquare />} sub="Leads with drafts to review" to="/ai-agent" />
        <Stat label="Pending sales actions" value={t.pending_sales_actions} icon={<FiSend />} sub="Approved drafts not yet sent" />
      </div>

      <div className="grid chart-grid mb-3">
        <Card title="Last 30 days">
          <dl className="def-list">
            <dt>Drafts written by Claude</dt><dd>{m.drafts_created}</dd>
            <dt>Approved / rejected</dt><dd>{m.drafts_approved} / {m.drafts_rejected}</dd>
            <dt>Drafts sent</dt><dd>{m.drafts_sent}</dd>
            <dt>Emails sent (Titan)</dt><dd>{m.emails_sent}</dd>
            <dt>Email replies received</dt><dd>{m.replies_received}</dd>
          </dl>
          <p className="cell-sub mt-2">"Sent" counts drafts a person sent or marked as sent. Email counts come from the Email module.</p>
        </Card>
        <Card title="Lead quality & sales tasks">
          <div className="chip-row mb-3">
            {['high', 'medium', 'low', 'unknown'].map((q) => <span key={q} className={`badge ${QUALITY_TONE[q]}`}>{q}: {quality[q] || 0}</span>)}
          </div>
          <div className="chip-row">
            {Object.entries(tasks).length ? Object.entries(tasks).map(([s, n]) => <span key={s} className="badge gray">{s.toLowerCase()}: {n}</span>) : <span className="text-muted text-sm">No sales tasks yet.</span>}
          </div>
        </Card>
      </div>

      <Card title="AI analysis history" bodyClass="">
        {history.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Lead</th><th>Version</th><th>Quality</th><th>Next step</th><th>Confidence</th><th>Created</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td><Link className="cell-strong" to={`/leads/${h.lead_id}`}>{h.company?.company_name || `Lead #${h.lead_id}`}</Link></td>
                    <td className="text-sm">v{h.version}{h.edited_at ? ' (edited)' : ''}</td>
                    <td><span className={`badge ${QUALITY_TONE[h.lead_quality]}`}>{h.lead_quality}</span></td>
                    <td className="text-sm">{h.next_step || '—'}</td>
                    <td className="text-sm">{h.confidence}%</td>
                    <td className="nowrap text-sm">{fmtDateTime(h.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={<FiTarget />} title="No sales playbooks yet" message="Open a lead and click Generate sales strategy, or turn on automatic sales strategies under AI Agent → Settings." />
        )}
      </Card>
    </div>
  );
}
