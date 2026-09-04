import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { FiPlay, FiZap, FiClock, FiInfo, FiPlus, FiX, FiTarget } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { automationApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Pagination } from '../components/ui';
import { OPPORTUNITY_LABELS } from '../utils/format';
import { fmtDateTime, fmtRelative } from '../utils/format';

const SCHEDULES = [
  { value: 'daily_9am', label: 'Every day at 9:00 AM' },
  { value: 'every_6h', label: 'Every 6 hours' },
  { value: 'every_12h', label: 'Every 12 hours' },
  { value: 'weekly', label: 'Every week (Monday 9 AM)' },
  { value: 'custom', label: 'Custom cron expression' },
];

function TagInput({ values, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div>
      <div className="chip-row mb-2">
        {values.map((v) => (
          <span key={v} className="chip active" style={{ cursor: 'default', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {v}
            <FiX style={{ cursor: 'pointer' }} onClick={() => onChange(values.filter((x) => x !== v))} />
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          className="input"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
        />
        <button type="button" className="btn btn-sm" onClick={add}>
          <FiPlus /> Add
        </button>
      </div>
    </div>
  );
}

export default function Automation() {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [running, setRunning] = useState(false);
  const [targetLocation, setTargetLocation] = useState('');
  const [targetIndustry, setTargetIndustry] = useState('');

  const { data, loading, error, reload } = useApi(() => automationApi.getSettings(), []);
  const runsQuery = useApi(() => automationApi.listRuns({ page, limit: 10 }), [page]);
  const usageQuery = useApi(() => automationApi.apiUsage(), []);

  const [form, setForm] = useState(null);
  useEffect(() => {
    if (data?.settings) setForm(data.settings);
  }, [data]);

  useEffect(() => {
    const t = setInterval(() => {
      automationApi.status().then((s) => setRunning(s.running)).catch(() => {});
    }, 5000);
    return () => clearInterval(t);
  }, []);

  if (loading || !form) return <Loader label="Loading automation settings…" />;
  if (error) return <div className="page"><ErrorBox message={error} onRetry={reload} /></div>;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleOpportunity = (o) => {
    set('opportunities', form.opportunities.includes(o) ? form.opportunities.filter((x) => x !== o) : [...form.opportunities, o]);
  };

  const save = async () => {
    try {
      await automationApi.updateSettings(form);
      toast.success('Automation settings saved');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  const runNow = async () => {
    try {
      await automationApi.runNow();
      toast.success('Discovery run started — check Search History below shortly');
      setTimeout(() => runsQuery.reload(), 3000);
    } catch (e) {
      toast.error(e.message);
    }
  };

  const runTarget = async () => {
    if (!targetLocation || !targetIndustry) {
      toast.error('Enter both a location and an industry for target mode');
      return;
    }
    try {
      await automationApi.runNow({ location: targetLocation, industry: targetIndustry });
      toast.success(`Target run started: ${targetLocation} + ${targetIndustry}`);
      setTimeout(() => runsQuery.reload(), 3000);
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Automatic Lead Generation</h1>
          <p>Configure once — the backend keeps discovering, qualifying and scoring new prospects.</p>
        </div>
        <div className="flex gap-2">
          {running && <span className="badge blue"><FiZap /> Run in progress…</span>}
          <button className="btn btn-primary" onClick={runNow} disabled={running}>
            <FiPlay /> Run Search Now
          </button>
        </div>
      </div>

      <div className="card card-pad mb-3" style={{ display: 'flex', gap: 10, background: 'var(--surface-2)' }}>
        <FiInfo style={{ marginTop: 2, color: 'var(--primary)' }} />
        <div className="text-sm text-muted">
          Discovery uses OpenStreetMap (free, no API key) by default. Outreach is never sent automatically — contacting
          stays under your control. Reliable daily scheduling on a free hosting tier needs an external cron ping; see{' '}
          <code>DEPLOY.md</code> for the one-time setup.
        </div>
      </div>

      <div className="profile-grid mb-3">
        <Card title="Automation Settings">
          <label className="flex items-center gap-2 mb-3">
            <input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            <strong>Enable Automatic Lead Generation</strong>
          </label>

          <div className="form-row">
            <div className="field">
              <label>Search frequency</label>
              <select className="select" value={form.schedule} onChange={(e) => set('schedule', e.target.value)}>
                {SCHEDULES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Daily lead limit</label>
              <input className="input" type="number" min="1" value={form.dailyLeadLimit} onChange={(e) => set('dailyLeadLimit', Number(e.target.value))} />
            </div>
          </div>

          {form.schedule === 'custom' && (
            <div className="field">
              <label>Custom cron expression</label>
              <input className="input" value={form.customCron || ''} onChange={(e) => set('customCron', e.target.value)} placeholder="0 9 * * *" />
            </div>
          )}

          <div className="field">
            <label>Target locations</label>
            <TagInput values={form.locations} onChange={(v) => set('locations', v)} placeholder="e.g. Ahmedabad, India" />
          </div>
          <div className="field">
            <label>Target industries</label>
            <TagInput values={form.industries} onChange={(v) => set('industries', v)} placeholder="e.g. Hotels" />
          </div>

          <div className="field">
            <label>Discovery sources</label>
            <div className="chip-row">
              {(data.discoveryProviders || []).map((p) => (
                <button
                  key={p.key}
                  type="button"
                  className={`chip ${form.discoveryProviders?.includes(p.key) ? 'active' : ''}`}
                  disabled={!p.configured}
                  title={p.configured ? '' : `${p.label} is not configured (missing API key) — set it in Render env vars to enable`}
                  onClick={() =>
                    set(
                      'discoveryProviders',
                      form.discoveryProviders?.includes(p.key)
                        ? form.discoveryProviders.filter((x) => x !== p.key)
                        : [...(form.discoveryProviders || []), p.key]
                    )
                  }
                >
                  {p.label}
                  {!p.configured && ' (not configured)'}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Target opportunities</label>
            <div className="chip-row">
              {Object.entries(OPPORTUNITY_LABELS).map(([k, v]) => (
                <button key={k} type="button" className={`chip ${form.opportunities.includes(k) ? 'active' : ''}`} onClick={() => toggleOpportunity(k)}>
                  {v}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <label>Minimum lead score to save</label>
            <input className="input" type="number" min="0" max="100" value={form.minLeadScore} onChange={(e) => set('minLeadScore', Number(e.target.value))} />
          </div>

          <div className="form-row">
            <div className="field">
              <label>Enrichment score threshold</label>
              <input className="input" type="number" min="0" max="100" value={form.enrichmentThreshold} onChange={(e) => set('enrichmentThreshold', Number(e.target.value))} />
              <div className="help-text">A near-threshold score with a website, a strong industry/location fit, or a high buying signal can still qualify — see README.</div>
            </div>
            <div className="field">
              <label>Enrichment refresh (days)</label>
              <input className="input" type="number" min="1" value={form.enrichmentRefreshDays} onChange={(e) => set('enrichmentRefreshDays', Number(e.target.value))} />
            </div>
            <div className="field">
              <label>Max enrichments per run</label>
              <input className="input" type="number" min="1" value={form.maxEnrichmentsPerRun} onChange={(e) => set('maxEnrichmentsPerRun', Number(e.target.value))} />
            </div>
          </div>

          <div className="grid" style={{ gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
            {[
              ['autoAnalyzeWebsites', 'Automatically analyze websites'],
              ['autoEnrichContacts', 'Automatically enrich contacts'],
              ['autoDetectBuyingSignals', 'Automatically detect buying signals'],
              ['autoSaveQualifiedLeads', 'Automatically save qualified leads'],
            ].map(([k, label]) => (
              <label key={k} className="flex items-center gap-2 text-sm" style={{ padding: '6px 0' }}>
                <input type="checkbox" checked={form[k]} onChange={(e) => set(k, e.target.checked)} /> {label}
              </label>
            ))}
          </div>

          <button className="btn btn-primary mt-4" onClick={save}>Save settings</button>
        </Card>

        <div className="grid" style={{ gap: 16 }}>
          <Card title="Target Mode — run one search now">
            <div className="field">
              <label>Location</label>
              <input className="input" value={targetLocation} onChange={(e) => setTargetLocation(e.target.value)} placeholder="e.g. Dubai" />
            </div>
            <div className="field">
              <label>Industry</label>
              <input className="input" value={targetIndustry} onChange={(e) => setTargetIndustry(e.target.value)} placeholder="e.g. Restaurants" />
            </div>
            <button className="btn btn-block" onClick={runTarget} disabled={running}>
              <FiTarget /> Run this target
            </button>
          </Card>

          <Card title="API usage (last 30 days)">
            {usageQuery.data?.usage?.length ? (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Date</th><th>Provider</th><th>Requests</th><th>Leads created</th></tr></thead>
                  <tbody>
                    {usageQuery.data.usage.map((u) => (
                      <tr key={u.id}>
                        <td className="text-sm">{u.usage_date}</td>
                        <td><span className="badge gray">{u.provider}</span></td>
                        <td>{u.request_count}</td>
                        <td>{u.leads_created_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-muted text-sm">No API usage recorded yet.</p>
            )}
          </Card>
        </div>
      </div>

      <Card title="Search History" bodyClass="">
        {runsQuery.loading ? (
          <Loader />
        ) : !runsQuery.data?.items?.length ? (
          <EmptyState icon={<FiClock />} title="No searches yet" message="Run a search to start building history." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>ID</th><th>When</th><th>Location</th><th>Industry</th><th>Provider</th><th>Status</th>
                    <th>Discovered</th><th>Duplicates</th><th>Already contacted</th><th>Qualified</th><th>Hot</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  {runsQuery.data.items.map((r) => (
                    <tr key={r.id}>
                      <td>#{r.id}</td>
                      <td className="nowrap text-sm" title={fmtDateTime(r.started_at)}>{fmtRelative(r.started_at)}</td>
                      <td>{(r.locations || []).join(', ')}</td>
                      <td>{(r.industries || []).join(', ')}</td>
                      <td><span className="badge gray">{r.provider}</span></td>
                      <td>
                        <span className={`badge ${r.status === 'completed' ? 'green' : r.status === 'failed' ? 'hot' : 'blue'}`}>
                          {r.status}
                        </span>
                      </td>
                      <td>{r.businesses_discovered}</td>
                      <td>{r.duplicates_skipped}</td>
                      <td>{r.already_contacted_skipped}</td>
                      <td>{r.qualified_leads}</td>
                      <td>{r.hot_leads}</td>
                      <td><Link className="btn btn-sm" to={`/automation/runs/${r.id}`}>View</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={runsQuery.data.pagination} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
