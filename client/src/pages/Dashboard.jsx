import { Link, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  FiBriefcase,
  FiZap,
  FiCheckCircle,
  FiThermometer,
  FiPhoneCall,
  FiClock,
  FiCalendar,
  FiFileText,
  FiAward,
} from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { dashboardApi } from '../services/endpoints';
import { Card, Loader, ErrorBox, ScoreBadge, TemperatureBadge, EmptyState } from '../components/ui';
import { BarChartBox, LineChartBox, DonutChartBox } from '../components/charts';
import { fmtDate, fmtNumber } from '../utils/format';

const CARD_META = [
  { key: 'totalCompanies', label: 'Total Companies', icon: <FiBriefcase /> },
  { key: 'newCompanies', label: 'New Companies (30d)', icon: <FiZap /> },
  { key: 'qualifiedLeads', label: 'Qualified Leads', icon: <FiCheckCircle /> },
  { key: 'hotLeads', label: 'Hot Leads', icon: <FiThermometer /> },
  { key: 'contactedLeads', label: 'Contacted', icon: <FiPhoneCall /> },
  { key: 'followUpsDue', label: 'Follow-ups Due', icon: <FiClock /> },
  { key: 'meetings', label: 'Meetings', icon: <FiCalendar /> },
  { key: 'proposals', label: 'Proposals', icon: <FiFileText /> },
  { key: 'wonLeads', label: 'Won', icon: <FiAward /> },
];

export default function Dashboard() {
  const navigate = useNavigate();
  const { data, loading, error, reload } = useApi(() => dashboardApi.stats(), []);
  const { data: opps } = useApi(() => dashboardApi.opportunities(8), []);

  if (loading) return <Loader label="Building dashboard…" />;
  if (error)
    return (
      <div className="page">
        <ErrorBox message={error} onRetry={reload} />
      </div>
    );

  const { cards, charts } = data;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p>New-company intelligence and pipeline overview.</p>
        </div>
        <Link className="btn btn-primary" to="/discovery">
          Explore companies
        </Link>
      </div>

      <div className="grid stat-grid mb-3">
        {CARD_META.map((m, i) => (
          <motion.div
            key={m.key}
            className="card stat-card"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.03 }}
          >
            <div className="flex justify-between items-center">
              <span className="stat-label">{m.label}</span>
              <span className="stat-icon">{m.icon}</span>
            </div>
            <div className="stat-value">{fmtNumber(cards[m.key] ?? 0)}</div>
          </motion.div>
        ))}
      </div>

      <div className="grid chart-grid mb-3">
        <Card title="New companies by day">
          <div className="chart-box">
            {charts.newByDay?.length ? (
              <LineChartBox data={charts.newByDay} xKey="day" yKey="count" name="Companies" />
            ) : (
              <EmptyState title="No registration data" message="Import companies with incorporation dates." />
            )}
          </div>
        </Card>
        <Card title="New companies by industry">
          <div className="chart-box">
            <BarChartBox data={(charts.byIndustry || []).map((d) => ({ ...d, industry: d.industry || 'Unknown' }))} xKey="industry" yKey="count" name="Companies" horizontal />
          </div>
        </Card>
        <Card title="Companies by state">
          <div className="chart-box">
            <BarChartBox data={(charts.byState || []).map((d) => ({ ...d, state: d.state || 'Unknown' }))} xKey="state" yKey="count" name="Companies" horizontal color="#0ea5e9" />
          </div>
        </Card>
        <Card title="Lead score distribution">
          <div className="chart-box">
            <BarChartBox data={charts.scoreBuckets || []} xKey="bucket" yKey="count" name="Companies" color="#6366f1" />
          </div>
        </Card>
        <Card title="CRM pipeline">
          <div className="chart-box">
            <BarChartBox data={charts.pipeline || []} xKey="status" yKey="count" name="Leads" color="#14b8a6" />
          </div>
        </Card>
        <Card title="Lead conversion rate">
          <div className="chart-box" style={{ display: 'grid', placeItems: 'center' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 48, fontWeight: 700, letterSpacing: '-0.03em' }}>{charts.conversionRate}%</div>
              <p className="text-muted text-sm">Won leads ÷ total leads</p>
              <div style={{ width: 220, marginTop: 12 }}>
                <DonutChartBox
                  data={[
                    { name: 'Won', value: charts.pipeline?.find((p) => p.status === 'WON')?.count || 0 },
                    { name: 'Lost', value: charts.pipeline?.find((p) => p.status === 'LOST')?.count || 0 },
                    {
                      name: 'In progress',
                      value:
                        (charts.pipeline || [])
                          .filter((p) => !['WON', 'LOST'].includes(p.status))
                          .reduce((s, p) => s + p.count, 0) || 0,
                    },
                  ]}
                  nameKey="name"
                  valueKey="value"
                />
              </div>
            </div>
          </div>
        </Card>
      </div>

      <Card
        title="Best Opportunities"
        actions={
          <Link className="btn btn-sm" to="/discovery?sort=lead_score&dir=desc">
            View all
          </Link>
        }
        bodyClass=""
      >
        {opps?.items?.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Company</th>
                  <th>Registered</th>
                  <th>Industry</th>
                  <th>Location</th>
                  <th>Website</th>
                  <th>Score</th>
                  <th>Temp</th>
                  <th>Recommended service</th>
                  <th>CRM status</th>
                </tr>
              </thead>
              <tbody>
                {opps.items.map((o) => (
                  <tr key={o.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/companies/${o.id}`)}>
                    <td className="cell-strong">{o.company_name}</td>
                    <td className="nowrap">{fmtDate(o.date_of_incorporation)}</td>
                    <td>{o.industry || '—'}</td>
                    <td>{o.location || '—'}</td>
                    <td>
                      <span className={`badge ${o.website_status === 'No website' ? 'warm' : 'gray'}`}>
                        {o.website_status}
                      </span>
                    </td>
                    <td>
                      <ScoreBadge value={o.lead_score} />
                    </td>
                    <td>
                      <TemperatureBadge value={o.lead_temperature} />
                    </td>
                    <td className="text-sm">{o.recommended_service || '—'}</td>
                    <td>
                      <span className="badge gray">{o.crm_status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No opportunities yet" message="Import or add companies to start scoring opportunities." />
        )}
      </Card>
    </div>
  );
}
