import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FiTarget, FiGlobe, FiPhone, FiMail, FiCheckCircle, FiUsers, FiThumbsUp, FiAward, FiCopy, FiAlertTriangle } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { dashboardApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Modal } from './ui';
import { BarChartBox } from './charts';
import { fmtNumber } from '../utils/format';
import { fmtIST } from '../utils/rbac';

const RANGES = [['7 days', 7], ['30 days', 30], ['90 days', 90]];
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

function Duplicates({ onClose, onChanged }) {
  const toast = useToast();
  const { data, loading, reload } = useApi(() => dashboardApi.duplicates(), []);
  const decide = async (id, status) => {
    try {
      await dashboardApi.reviewDuplicate(id, status);
      toast.success(status === 'confirmed' ? 'Marked as duplicate — merge the records manually if needed' : 'Marked as different businesses');
      reload();
      onChanged();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const side = (c) => (
    <div>
      <Link to={`/companies/${c.id}`} className="cell-strong">{c.company_name}</Link>
      <div className="cell-sub">{[c.city, c.state].filter(Boolean).join(', ') || 'No city'} · {c.website || 'no website'} · {c.source}</div>
    </div>
  );
  return (
    <Modal open onClose={onClose} title="Possible duplicates to review" size="lg">
      <p className="text-sm text-muted mb-3">These were kept as separate records because identity was uncertain (same name elsewhere, same address only, or conflicting phone/website). Nothing is merged automatically.</p>
      {loading ? <Loader /> : !data.items.length ? <EmptyState title="Nothing to review" /> : (
        <table className="data">
          <tbody>
            {data.items.map((d) => (
              <tr key={d.id}>
                <td>{d.company && side(d.company)}</td>
                <td>{d.candidate && side(d.candidate)}<div className="cell-sub">Reason: {d.reason.replace(/_/g, ' ')}</div></td>
                <td>
                  <div className="flex gap-2">
                    <button className="btn btn-sm" onClick={() => decide(d.id, 'not_duplicate')}>Different</button>
                    <button className="btn btn-sm" onClick={() => decide(d.id, 'confirmed')}>Same business</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  );
}

export default function LeadGenPanel() {
  const [days, setDays] = useState(30);
  const [dupOpen, setDupOpen] = useState(false);
  const from = new Date(Date.now() - days * 86400000).toISOString();
  const { data, loading, error, reload } = useApi(() => dashboardApi.leadGeneration({ from }), [days]);

  if (loading && !data) return <Loader />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  const t = data.totals;
  const d = data.discovery;
  const def = data.definitions;
  const cards = [
    ['Unique businesses', t.unique_businesses, <FiTarget />, `${fmtNumber(t.leads)} are leads`, 'unique_businesses', true],
    [`New leads (${days}d)`, t.new_leads, <FiTarget />, `${fmtNumber(t.qualified)} qualified overall`, 'new_leads'],
    ['High priority', t.high_priority, <FiAward />, 'Scored HOT (80+)', 'high_priority'],
    ['No website found', t.no_website, <FiGlobe />, `${fmtNumber(t.with_website)} have a website`, null],
    ['Public phone', t.with_phone, <FiPhone />, `${fmtNumber(t.verified_phone)} verified`, null],
    ['Public email', t.with_email, <FiMail />, `${fmtNumber(t.verified_email)} verified`, 'verified_email'],
    ['Assigned', t.assigned, <FiUsers />, `${pct(t.assigned, t.leads)} of leads`, null],
    ['Contacted', t.contacted, <FiCheckCircle />, `${fmtNumber(t.not_contacted)} not yet`, 'contacted'],
    ['Positive responses', t.positive_responses, <FiThumbsUp />, `${pct(t.positive_responses, t.contacted)} of contacted`, 'positive_responses'],
    ['Converted (won)', t.converted, <FiAward />, `${pct(t.converted, t.contacted)} of contacted`, 'converted'],
  ];

  return (
    <div className="mb-3">
      <div className="flex justify-between items-center mb-2" style={{ flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ fontSize: 17 }}>Lead generation</h2>
        <div className="chip-row">
          {RANGES.map(([label, n]) => <button key={n} className={`chip ${days === n ? 'active' : ''}`} onClick={() => setDays(n)}>{label}</button>)}
        </div>
      </div>
      <div className="grid stat-grid mb-3">
        {cards.map(([label, value, icon, sub, key, accent]) => (
          <div key={label} className={`card stat-card ${accent ? 'accent' : ''}`} title={key ? def[key] : undefined}>
            <div className="flex justify-between items-center"><span className="stat-label">{label}</span><span className="stat-icon">{icon}</span></div>
            <div className="stat-value">{fmtNumber(value)}</div>
            <div className="stat-sub">{sub}</div>
          </div>
        ))}
      </div>

      {t.open_duplicate_reviews > 0 && (
        <div className="tracking-note mb-3 flex items-center justify-between gap-2">
          <span><FiCopy style={{ verticalAlign: '-2px' }} /> {t.open_duplicate_reviews} possible duplicate(s) were kept separate and need a decision.</span>
          <button className="btn btn-sm" onClick={() => setDupOpen(true)}>Review</button>
        </div>
      )}

      <div className="grid chart-grid mb-3">
        <Card title="Leads by industry">
          {data.breakdowns.industry.length ? <div className="chart-box"><BarChartBox data={data.breakdowns.industry} xKey="name" yKey="count" name="Leads" horizontal /></div> : <EmptyState title="No leads yet" />}
        </Card>
        <Card title="Leads by city">
          {data.breakdowns.city.length ? <div className="chart-box"><BarChartBox data={data.breakdowns.city} xKey="name" yKey="count" name="Leads" horizontal color="#0ea5e9" /></div> : <EmptyState title="No leads yet" />}
        </Card>
        <Card title="Leads by owner">
          {data.breakdowns.employee.length ? <div className="chart-box"><BarChartBox data={data.breakdowns.employee} xKey="name" yKey="count" name="Leads" horizontal color="#6366f1" /></div> : <EmptyState title="No leads yet" />}
        </Card>
      </div>

      <Card title={`Discovery (${days} days)`} bodyClass="">
        <div className="card-pad text-sm">
          {fmtNumber(d.runs)} runs · {fmtNumber(d.businesses_discovered)} businesses found · {fmtNumber(d.new_companies)} new · {fmtNumber(d.duplicates_skipped)} duplicates skipped · {fmtNumber(d.qualified_leads)} qualified
          {d.failed_runs > 0 && <span className="text-danger"> · {d.failed_runs} failed</span>}
          <span className="cell-sub"> · by source: {data.breakdowns.source.map((s) => `${s.name} ${s.count}`).join(', ') || '—'}</span>
        </div>
        {d.providers.length > 0 && (
          <div className="card-pad" style={{ paddingTop: 0 }}>
            {d.providers.map((p) => (
              <span key={p.provider} className={`badge ${p.error_rate > 30 ? 'not_qualified' : p.error_rate ? 'warm' : 'green'}`} style={{ marginRight: 6 }}>
                {p.provider}: {p.runs} runs, {p.error_rate}% with errors
              </span>
            ))}
          </div>
        )}
        {d.recent.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Started</th><th>Target</th><th>Status</th><th>Found</th><th>New</th><th>Errors</th></tr></thead>
              <tbody>
                {d.recent.map((r) => (
                  <tr key={r.id}>
                    <td className="text-sm">{fmtIST(r.started_at)}</td>
                    <td className="text-sm">{r.location} · {r.industry}</td>
                    <td><span className={`badge ${r.status === 'completed' ? 'green' : r.status === 'running' ? 'blue' : 'not_qualified'}`}>{r.status}</span></td>
                    <td>{r.discovered}</td>
                    <td>{r.new_companies}</td>
                    <td>{r.errors ? <span className="text-danger"><FiAlertTriangle /> {r.errors}</span> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {dupOpen && <Duplicates onClose={() => setDupOpen(false)} onChanged={reload} />}
    </div>
  );
}
