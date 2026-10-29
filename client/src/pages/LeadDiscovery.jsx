import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiCompass, FiPlay, FiAlertTriangle, FiCheckCircle, FiGlobe } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { locationApi, leadDiscoveryApi } from '../services/endpoints';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, ScoreBadge, TemperatureBadge } from '../components/ui';
import ContactValue from '../components/ContactValue';
import { fmtIST } from '../utils/rbac';
import { titleCase } from '../utils/format';

const LEVELS = [
  ['country', 'Country'],
  ['state', 'State / region'],
  ['city', 'City / town'],
  ['area', 'Area'],
];

function LevelSelect({ type, label, parentId, value, onChange, required }) {
  const { data, loading } = useApi(
    () => (type === 'country' || parentId ? locationApi.list({ type, ...(parentId ? { parent_id: parentId } : {}), limit: 500, sort: type === 'city' ? 'population' : 'name', dir: type === 'city' ? 'desc' : 'asc' }) : null),
    [type, parentId]
  );
  const items = data?.items || [];
  const disabled = type !== 'country' && !parentId;
  return (
    <div className="field" style={{ minWidth: 190 }}>
      <label>{label}</label>
      <select className="select" value={value || ''} disabled={disabled || loading} onChange={(e) => onChange(e.target.value ? items.find((i) => String(i.id) === e.target.value) : null)}>
        <option value="">{required ? 'Select…' : disabled ? '—' : items.length ? 'All' : 'None available'}</option>
        {items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
      </select>
    </div>
  );
}

// Evidence-backed opportunity hints from what discovery actually observed.
function Opportunities({ company }) {
  const site = company.websites?.[0];
  const out = [];
  if (!company.has_website) out.push(['warm', 'No website found', 'Discovery found no website — verify before pitching a new site']);
  if (site && site.is_https === false) out.push(['warm', 'No HTTPS', 'Site served without HTTPS']);
  if (['broken', 'inaccessible', 'down', 'parked'].includes(site?.status)) out.push(['hot', `Website ${site.status}`, 'Observed by the automated homepage check']);
  if (['poor', 'outdated'].includes(site?.health)) out.push(['high', `Website ${site.health}`, 'From the automated website audit']);
  if (site?.opportunity_score >= 50) out.push(['hot', 'Modernization opportunity', `Website audit opportunity score ${site.opportunity_score}/100`]);
  for (const s of (company.detectedSignals || []).slice(0, 2)) out.push([s.signal_strength === 'HIGH' ? 'hot' : 'gray', titleCase(s.signal_type), s.signal_description]);
  if (!out.length) return <span className="cell-sub">No signals observed</span>;
  return out.map(([tone, label, title]) => <span key={label} className={`badge ${tone}`} title={title} style={{ marginRight: 4, marginBottom: 2 }}>{label}</span>);
}

function RunResults({ run }) {
  const [filters, setFilters] = useState({ website: '', contact: '' });
  const { data, loading, error } = useApi(() => leadDiscoveryApi.runLeads(run.id, filters), [run.id, filters.website, filters.contact, run.status]);
  return (
    <Card title={`Results — ${run.locations?.[0]} · ${titleCase(run.industries?.[0] || '')}`} className="mt-3" bodyClass="">
      <div className="card-pad filters">
        <div className="field">
          <label>Website</label>
          <select className="select" value={filters.website} onChange={(e) => setFilters({ ...filters, website: e.target.value })}>
            <option value="">Any</option><option value="yes">Has website</option><option value="no">No website found</option>
          </select>
        </div>
        <div className="field">
          <label>Contact information</label>
          <select className="select" value={filters.contact} onChange={(e) => setFilters({ ...filters, contact: e.target.value })}>
            <option value="">Any</option><option value="phone">Has phone</option><option value="email">Has email</option>
          </select>
        </div>
      </div>
      {loading && !data ? <Loader /> : error ? <div className="card-pad"><ErrorBox message={error} /></div> : !data.leads.length ? (
        <EmptyState title="No leads from this run match" message="Duplicates of businesses already in the CRM are not added twice." />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Business</th><th>Score</th><th>Opportunity signals</th><th>Phone</th><th>Email</th><th>Recommended service</th></tr></thead>
            <tbody>
              {data.leads.map((l) => {
                const phone = l.company.contacts?.find((c) => c.type === 'phone');
                const email = l.company.contacts?.find((c) => c.type === 'email');
                return (
                  <tr key={l.id}>
                    <td>
                      <Link to={`/leads/${l.id}`} className="cell-strong">{l.company.company_name}</Link>
                      <div className="cell-sub">{[l.company.industry, l.company.city].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td><ScoreBadge value={l.lead_score} /> <TemperatureBadge value={l.lead_temperature} /></td>
                    <td><Opportunities company={l.company} /></td>
                    <td className="text-sm"><ContactValue contact={phone} leadId={l.id} fallback="Not found" /></td>
                    <td className="text-sm"><ContactValue contact={email} leadId={l.id} fallback="Not found" /></td>
                    <td className="text-sm">{l.recommended_service || '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function LeadDiscovery() {
  const { can } = useAuth();
  const toast = useToast();
  const [sel, setSel] = useState({});
  const [cats, setCats] = useState([]);
  const [busy, setBusy] = useState(false);
  const [opt, setOpt] = useState({ radius_km: '', max_results: 25, min_score: '', website: '', contact: '' });
  const [openRun, setOpenRun] = useState(null);
  const { data: opts, error: optsError } = useApi(() => leadDiscoveryApi.options(), []);
  const { data: runsData, reload: reloadRuns } = useApi(() => leadDiscoveryApi.runs({ limit: 15 }), []);
  const runs = runsData?.runs || [];
  const anyRunning = runsData?.running || runs.some((r) => r.status === 'running');

  useEffect(() => {
    if (!anyRunning) return undefined;
    const t = setInterval(reloadRuns, 4000);
    return () => clearInterval(t);
  }, [anyRunning, reloadRuns]);

  const pick = (level, loc) => {
    const idx = LEVELS.findIndex(([l]) => l === level);
    const next = {};
    LEVELS.slice(0, idx).forEach(([l]) => (next[l] = sel[l]));
    next[level] = loc;
    setSel(next);
  };
  const target = [...LEVELS].reverse().map(([l]) => sel[l]).find(Boolean);
  const configured = (opts?.providers || []).filter((p) => p.status === 'CONFIGURED');

  const start = async () => {
    setBusy(true);
    try {
      const r = await leadDiscoveryApi.run({ location_id: target.id, category_ids: cats, ...opt, radius_km: opt.radius_km || undefined, min_score: opt.min_score || undefined });
      toast.success(`Discovery started for ${r.location}`);
      reloadRuns();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Lead Discovery</h1>
          <p>Find real businesses in an approved location, then score, de-duplicate and save them as leads.</p>
        </div>
        {can('locations.manage') && <Link className="btn" to="/locations"><FiGlobe /> Manage locations</Link>}
      </div>

      {optsError && <ErrorBox message={optsError} />}

      <Card title="1. Where" className="mb-3">
        <div className="filters">
          {LEVELS.map(([level, label], i) => (
            <LevelSelect key={level} type={level} label={label} required={level === 'country'} parentId={i === 0 ? null : sel[LEVELS[i - 1][0]]?.id} value={sel[level]?.id} onChange={(loc) => pick(level, loc)} />
          ))}
        </div>
        <p className="text-sm text-muted mt-3">
          Only locations approved by the Main Admin are listed.
          {target && <> Searching: <strong>{[...LEVELS].map(([l]) => sel[l]?.name).filter(Boolean).reverse().join(', ')}</strong>.</>}
        </p>
      </Card>

      <Card title="2. What kind of business" className="mb-3">
        <div className="chip-row">
          {(opts?.categories || []).map((c) => (
            <button key={c.id} className={`chip ${cats.includes(c.id) ? 'active' : ''}`} title={c.description || ''} onClick={() => setCats((s) => (s.includes(c.id) ? s.filter((x) => x !== c.id) : s.length >= 5 ? s : [...s, c.id]))}>
              {c.name}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted mt-3">Up to 5 per run. Each category is searched separately on every configured provider.</p>
      </Card>

      <Card title="3. Filters" className="mb-3">
        <div className="filters">
          <div className="field">
            <label>Radius (km)</label>
            <input className="input" type="number" min={1} max={opts?.max_radius_km || 100} placeholder={target?.latitude != null ? 'Whole area' : 'Needs coordinates'} disabled={target && target.latitude == null} value={opt.radius_km} onChange={(e) => setOpt({ ...opt, radius_km: e.target.value })} style={{ width: 130 }} />
          </div>
          <div className="field"><label>Max leads per category</label><input className="input" type="number" min={1} max={50} value={opt.max_results} onChange={(e) => setOpt({ ...opt, max_results: e.target.value })} style={{ width: 130 }} /></div>
          <div className="field"><label>Minimum lead score</label><input className="input" type="number" min={0} max={100} placeholder="Default" value={opt.min_score} onChange={(e) => setOpt({ ...opt, min_score: e.target.value })} style={{ width: 130 }} /></div>
          <div className="field">
            <label>Website status</label>
            <select className="select" value={opt.website} onChange={(e) => setOpt({ ...opt, website: e.target.value })}>
              <option value="">Any</option><option value="yes">Website found</option><option value="no">No website found</option>
            </select>
          </div>
          <div className="field">
            <label>Contact details</label>
            <select className="select" value={opt.contact} onChange={(e) => setOpt({ ...opt, contact: e.target.value })}>
              <option value="">Any</option><option value="phone">Phone available</option><option value="email">Email available</option>
            </select>
          </div>
        </div>
        <p className="text-sm text-muted mt-3">
          Radius: OpenStreetMap and Yelp filter natively (Yelp max 40 km); Serper results are filtered by their coordinates afterwards; providers without coordinates can't honour a radius — each run reports exactly what was enforced.
          Website/contact filters apply to the results view.
        </p>
      </Card>

      <Card title="4. Run" className="mb-3">
        <div className="flex items-center gap-3" style={{ flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={!target || !cats.length || busy || anyRunning || !configured.length} onClick={start}>
            <FiPlay /> {anyRunning ? 'A run is in progress…' : 'Discover business leads'}
          </button>
          <span className="text-sm">
            Providers:{' '}
            {(opts?.providers || []).map((p) => (
              <span key={p.key} className={`badge ${p.status === 'CONFIGURED' ? 'green' : 'not_qualified'}`} style={{ marginRight: 4 }} title={p.status === 'CONFIGURED' ? 'Will be queried' : 'Missing credentials — skipped'}>
                {p.label}: {p.status === 'CONFIGURED' ? 'ready' : 'not configured'}
              </span>
            ))}
          </span>
        </div>
        {opts && !configured.length && (
          <p className="error-box mt-3"><FiAlertTriangle /> No discovery provider is configured, so nothing can be searched. The Main Admin can enable one in Automation settings (OpenStreetMap needs no key).</p>
        )}
        <p className="text-sm text-muted mt-3">Results depend on what each provider lists for that place — no provider covers every business, and missing phone/email stays empty rather than guessed.</p>
      </Card>

      <Card title="Recent discovery runs" bodyClass="">
        {!runs.length ? <EmptyState icon={<FiCompass />} title="No runs yet" /> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Started</th><th>Location · category</th><th>By</th><th>Status</th><th>Found</th><th>New companies</th><th>Duplicates</th><th>Qualified</th><th>Emails</th><th>Errors</th><th></th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="text-sm">{fmtIST(r.started_at)}</td>
                    <td className="text-sm">
                      {r.locations?.join(', ')}
                      <div className="cell-sub">
                        {r.category?.name || r.industries?.join(', ')}
                        {r.radius_km ? ` · ${Number(r.radius_km)} km` : ''}
                        {r.location_id ? '' : ' · free-text target'}
                      </div>
                      {r.search_params?.radius && (
                        <div className="cell-sub">
                          {Object.entries(r.search_params.radius).map(([p, x]) => `${p}: ${x.enforced ? 'radius enforced' : x.mode === 'none' ? 'radius not enforceable' : 'radius partly enforced'}${x.excluded_outside_radius ? `, ${x.excluded_outside_radius} outside dropped` : ''}`).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td className="text-sm">{r.triggered_by_name || r.triggered_by}</td>
                    <td>
                      <span className={`badge ${r.status === 'completed' ? 'green' : r.status === 'running' ? 'blue' : 'not_qualified'}`}>
                        {r.status === 'running' ? 'running…' : r.status}
                      </span>
                    </td>
                    <td>{r.businesses_discovered}</td>
                    <td>{r.new_companies}</td>
                    <td>{r.duplicates_skipped}</td>
                    <td>{r.qualified_leads}</td>
                    <td>{r.emails_found}</td>
                    <td title={(r.errors || []).map((e) => e.message).join('\n')}>{r.errors?.length ? <span className="text-danger">{r.errors.length} ⚠</span> : <FiCheckCircle className="text-success" />}</td>
                    <td><button className="btn btn-sm" onClick={() => setOpenRun(r)}>Results</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {openRun && <RunResults run={runs.find((r) => r.id === openRun.id) || openRun} />}
    </div>
  );
}
