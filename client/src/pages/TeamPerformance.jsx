import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiUsers, FiEye, FiPhoneCall, FiClock, FiAward, FiInfo, FiTarget } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { auditApi, userApi } from '../services/endpoints';
import { Card, Loader, ErrorBox, EmptyState } from '../components/ui';
import { BarChartBox, MultiLineChartBox } from '../components/charts';
import { ROLE_LABELS, fmtIST, istDate } from '../utils/rbac';
import { fmtNumber, fmtRelative } from '../utils/format';

const PERIODS = {
  day: { label: 'Daily', days: 13, granularity: 'day' },
  week: { label: 'Weekly', days: 83, granularity: 'week' },
  month: { label: 'Monthly', days: 364, granularity: 'month' },
};

const COLUMNS = [
  ['leads_assigned', 'Assigned'],
  ['lead_views', 'Lead opens'],
  ['unique_leads_viewed', 'Unique leads'],
  ['contact_reveals', 'Contact views'],
  ['contacted', 'Contact attempts'],
  ['follow_ups', 'Follow-ups'],
  ['notes', 'Notes'],
  ['updates', 'Updates'],
  ['won', 'Won'],
];

const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—');

export default function TeamPerformance() {
  const [period, setPeriod] = useState('day');
  const [range, setRange] = useState({ from: istDate(PERIODS.day.days), to: istDate(0) });
  const [userId, setUserId] = useState('');
  const [sort, setSort] = useState('contacted');

  const choosePeriod = (p) => {
    setPeriod(p);
    setRange({ from: istDate(PERIODS[p].days), to: istDate(0) });
  };

  const query = { ...range, user_id: userId, granularity: PERIODS[period].granularity };
  const { data, loading, error, reload } = useApi(() => auditApi.performance(query), [JSON.stringify(query)]);
  const { data: usersData } = useApi(() => userApi.list({ include_inactive: 'true' }), []);

  const employees = useMemo(() => [...(data?.employees || [])].sort((a, b) => b[sort] - a[sort]), [data, sort]);
  const max = useMemo(() => Object.fromEntries(COLUMNS.map(([k]) => [k, Math.max(1, ...employees.map((e) => e[k]))])), [employees]);
  const t = data?.totals || {};
  const def = data?.definitions || {};

  const cards = [
    { key: 'unique_leads_viewed', label: 'Unique leads worked', icon: <FiTarget />, sub: `${fmtNumber(t.lead_views)} total opens`, accent: true },
    { key: 'contact_reveals', label: 'Contact details viewed', icon: <FiEye />, sub: 'Views are not calls' },
    { key: 'contacted', label: 'Contact attempts', icon: <FiPhoneCall />, sub: `${pct(t.contacted, t.unique_leads_viewed)} of leads worked` },
    { key: 'follow_ups', label: 'Follow-ups scheduled', icon: <FiClock />, sub: `${fmtNumber(t.notes)} notes added` },
    { key: 'won', label: 'Leads won', icon: <FiAward />, sub: `${pct(t.won, t.contacted)} of attempts` },
    { key: 'leads_assigned', label: 'Leads owned now', icon: <FiUsers />, sub: `${fmtNumber(t.assigned_in_period)} assigned in period` },
  ];

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Team Performance</h1>
          <p>Employee activity built only from recorded events — no estimates.</p>
        </div>
        <div className="chip-row">
          {Object.entries(PERIODS).map(([k, p]) => (
            <button key={k} className={`chip ${period === k ? 'active' : ''}`} onClick={() => choosePeriod(k)}>{p.label}</button>
          ))}
        </div>
      </div>

      <Card className="mb-3">
        <div className="filters">
          <div className="field">
            <label>From</label>
            <input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </div>
          <div className="field">
            <label>To</label>
            <input className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </div>
          <div className="field">
            <label>Employee</label>
            <select className="select" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Whole team</option>
              {(usersData?.users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
        </div>
        {data?.tracking_started_at && (
          <p className="tracking-note mt-3">
            <FiInfo style={{ verticalAlign: '-2px' }} /> Activity tracking began {fmtIST(data.tracking_started_at, data.display_timezone)}; earlier periods show no activity rather than estimates.
          </p>
        )}
      </Card>

      {loading && !data ? (
        <Loader />
      ) : error ? (
        <ErrorBox message={error} onRetry={reload} />
      ) : (
        <>
          <div className="grid stat-grid mb-3">
            {cards.map((c) => (
              <div key={c.key} className={`card stat-card ${c.accent ? 'accent' : ''}`} title={def[c.key]}>
                <div className="flex justify-between items-center">
                  <span className="stat-label">{c.label}</span>
                  <span className="stat-icon">{c.icon}</span>
                </div>
                <div className="stat-value">{fmtNumber(t[c.key] || 0)}</div>
                <div className="stat-sub">{c.sub}</div>
              </div>
            ))}
          </div>

          <div className="grid chart-grid mb-3">
            <Card title={`Team activity (${PERIODS[period].label.toLowerCase()})`}>
              {data.series.length ? (
                <div className="chart-box">
                  <MultiLineChartBox
                    data={data.series}
                    xKey="period"
                    series={[
                      { key: 'lead_views', name: 'Lead opens' },
                      { key: 'contact_reveals', name: 'Contact views' },
                      { key: 'contacted', name: 'Contact attempts' },
                      { key: 'follow_ups', name: 'Follow-ups' },
                    ]}
                  />
                </div>
              ) : (
                <EmptyState title="No activity in this range" />
              )}
            </Card>
            <Card title="Contact attempts by employee">
              {employees.some((e) => e.contacted) ? (
                <div className="chart-box">
                  <BarChartBox data={employees.filter((e) => e.contacted).slice(0, 10).map((e) => ({ name: e.user.name, value: e.contacted }))} xKey="name" yKey="value" name="Contact attempts" horizontal />
                </div>
              ) : (
                <EmptyState title="No contact attempts recorded" message="Attempts count only when an employee uses the Contact action on a lead." />
              )}
            </Card>
          </div>

          <Card title="Employee breakdown" bodyClass="">
            {!employees.length ? (
              <EmptyState icon={<FiUsers />} title="No employees in scope" />
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      {COLUMNS.map(([k, label]) => (
                        <th key={k} className="sortable" title={def[k]} onClick={() => setSort(k)}>
                          {label} {sort === k && '↓'}
                        </th>
                      ))}
                      <th>Last activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employees.map((e) => (
                      <tr key={e.user.id}>
                        <td>
                          <Link to={`/activity?actor_user_id=${e.user.id}`} className="cell-strong">{e.user.name}</Link>
                          <div className="cell-sub">{ROLE_LABELS[e.user.role]}{!e.user.is_active && ' · inactive'}</div>
                        </td>
                        {COLUMNS.map(([k]) => (
                          <td key={k} className="text-sm">
                            <div>{fmtNumber(e[k])}</div>
                            <div className="metric-bar"><span style={{ width: `${(e[k] / max[k]) * 100}%` }} /></div>
                          </td>
                        ))}
                        <td className="text-sm" title={fmtIST(e.last_activity_at)}>{e.last_activity_at ? fmtRelative(e.last_activity_at) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="How these numbers are counted" className="mt-3">
            <dl className="def-list">
              {COLUMNS.map(([k, label]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{label}</dt>
                  <dd>{def[k]}</dd>
                </div>
              ))}
            </dl>
          </Card>
        </>
      )}
    </div>
  );
}
