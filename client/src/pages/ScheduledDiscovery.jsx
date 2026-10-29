import { useState } from 'react';
import { FiClock, FiPlay, FiTrash2, FiAlertTriangle, FiPlus } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { discoveryJobApi, leadDiscoveryApi, locationApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Modal } from '../components/ui';
import { fmtIST } from '../utils/rbac';
import { titleCase } from '../utils/format';

const FREQ = { every_6h: 'Every 6 hours', every_12h: 'Every 12 hours', daily: 'Daily', weekly: 'Weekly' };

function LocationPicker({ value, onChange }) {
  const [q, setQ] = useState('');
  const { data } = useApi(() => (q.length >= 2 ? locationApi.list({ search: q, limit: 20, sort: 'population', dir: 'desc' }) : null), [q]);
  return (
    <div className="field">
      <label>Location (approved records only)</label>
      <input className="input" placeholder="Type 2+ letters, e.g. Ahmed" value={value ? value.name : q} onChange={(e) => { onChange(null); setQ(e.target.value); }} />
      {!value && data?.items?.length > 0 && (
        <div className="picker-list">
          {data.items.map((l) => (
            <button type="button" key={l.id} className="picker-item" onClick={() => onChange(l)}>
              {l.name} <span className="cell-sub">{l.location_type} · {l.country_code}{l.latitude != null ? '' : ' · no coordinates'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function NewJob({ onClose, onSaved, initialLocation }) {
  const toast = useToast();
  const { data: opts } = useApi(() => leadDiscoveryApi.options(), []);
  const [loc, setLoc] = useState(initialLocation || null);
  const [f, setF] = useState({ business_category_id: '', frequency: 'daily', max_results: 25, radius_km: '' });
  const save = async (e) => {
    e.preventDefault();
    try {
      await discoveryJobApi.create({ ...f, location_id: loc?.id, radius_km: f.radius_km || null });
      toast.success('Scheduled — the first run happens on the next scheduler tick');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <Modal open onClose={onClose} title="Schedule discovery">
      <form onSubmit={save}>
        <LocationPicker value={loc} onChange={setLoc} />
        <div className="field">
          <label>Business category</label>
          <select className="select" required value={f.business_category_id} onChange={(e) => setF({ ...f, business_category_id: e.target.value })}>
            <option value="">Select…</option>
            {(opts?.categories || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Frequency</label>
            <select className="select" value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value })}>
              {Object.entries(FREQ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field"><label>Max results per run (1-50)</label><input className="input" type="number" min={1} max={50} value={f.max_results} onChange={(e) => setF({ ...f, max_results: e.target.value })} /></div>
        </div>
        <div className="field">
          <label>Radius in km (optional; needs coordinates)</label>
          <input className="input" type="number" min={1} max={100} value={f.radius_km} onChange={(e) => setF({ ...f, radius_km: e.target.value })} />
        </div>
        <button className="btn btn-primary btn-block" disabled={!loc}>Create job</button>
      </form>
    </Modal>
  );
}

export default function ScheduledDiscovery() {
  const toast = useToast();
  const [creating, setCreating] = useState(null);
  const { data, loading, error, reload } = useApi(() => discoveryJobApi.list(), []);
  const { data: legacy } = useApi(() => discoveryJobApi.legacy(), []);

  const act = async (fn, msg) => {
    try {
      await fn();
      toast.success(msg);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Scheduled Discovery</h1>
          <p>Recurring business discovery on approved locations. Jobs are stored in the database and run whenever the scheduler wakes.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating({})}><FiPlus /> Schedule discovery</button>
      </div>

      <div className="tracking-note mb-3">
        <FiClock style={{ verticalAlign: '-2px' }} /> Due jobs are checked every 15 minutes while the API is awake, and on every call to the external cron endpoint
        (<code>/api/automation/run-scheduled</code>). On a free host that sleeps, jobs run late rather than on the exact minute — keep the external cron configured.
        Runs never overlap, and repeat runs don't create duplicate leads.
      </div>

      {legacy?.locations?.length > 0 && (
        <Card title="Free-text automation locations" className="mb-3">
          <p className="text-sm text-muted mb-3">These come from Automation Settings and keep running unchanged. Convert the ones that match a location record into structured jobs.</p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Configured text</th><th>Match</th><th></th></tr></thead>
              <tbody>
                {legacy.locations.map((l) => (
                  <tr key={l.text}>
                    <td>{l.text}</td>
                    <td className="text-sm">
                      {l.status === 'resolved' ? <span className="badge green">{l.match.label}</span> : l.status === 'ambiguous' ? (
                        <span className="badge warm" title={l.candidates.map((c) => c.label).join('\n')}><FiAlertTriangle /> {l.candidates.length} possible matches — pick one when scheduling</span>
                      ) : (
                        <span className="badge not_qualified"><FiAlertTriangle /> No location record — import its country first</span>
                      )}
                    </td>
                    <td>{l.status === 'resolved' && <button className="btn btn-sm" onClick={() => setCreating({ location: { id: l.match.id, name: l.match.label } })}>Convert to job</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card bodyClass="">
        {loading && !data ? <Loader /> : error ? <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div> : !data.jobs.length ? (
          <EmptyState icon={<FiClock />} title="No scheduled discovery yet" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Location</th><th>Category</th><th>Frequency</th><th>Max</th><th>Radius</th><th>Last run</th><th>Next run</th><th>Enabled</th><th></th></tr></thead>
              <tbody>
                {data.jobs.map((j) => (
                  <tr key={j.id}>
                    <td>
                      <div className="cell-strong">{j.location_label}</div>
                      {!j.location_usable && <div className="text-danger text-sm"><FiAlertTriangle /> {j.location_warning}</div>}
                    </td>
                    <td>{j.category?.name}{j.category && !j.category.is_enabled && <span className="badge not_qualified"> disabled</span>}</td>
                    <td>
                      <select className="select" value={j.frequency} onChange={(e) => act(() => discoveryJobApi.update(j.id, { frequency: e.target.value }), 'Frequency updated')}>
                        {Object.entries(FREQ).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    </td>
                    <td>{j.max_results}</td>
                    <td className="text-sm">{j.radius_km ? `${Number(j.radius_km)} km` : '—'}</td>
                    <td className="text-sm">
                      {j.running_since ? <span className="badge blue">running…</span> : j.last_run_at ? (
                        <>
                          <span className={`badge ${j.last_status === 'completed' ? 'green' : 'not_qualified'}`}>{titleCase(j.last_status || '')}</span> {fmtIST(j.last_run_at)}
                          {j.last_run && <div className="cell-sub">{j.last_run.businesses_discovered} found · {j.last_run.new_companies} new · {j.last_run.duplicates_skipped} duplicates</div>}
                          {j.last_error && <div className="text-danger text-sm">{j.last_error}</div>}
                        </>
                      ) : 'Never'}
                    </td>
                    <td className="text-sm">{j.is_enabled ? fmtIST(j.next_run_at) : '—'}</td>
                    <td><input type="checkbox" checked={j.is_enabled} onChange={(e) => act(() => discoveryJobApi.update(j.id, { is_enabled: e.target.checked }), e.target.checked ? 'Enabled' : 'Paused')} /></td>
                    <td>
                      <div className="flex gap-2">
                        <button className="btn btn-sm" disabled={data.running} title="Run now" onClick={() => act(() => discoveryJobApi.run(j.id), 'Job started')}><FiPlay /></button>
                        <button className="btn btn-sm" title="Delete (runs and leads are kept)" onClick={() => act(() => discoveryJobApi.remove(j.id), 'Job deleted')}><FiTrash2 /></button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {creating && <NewJob initialLocation={creating.location} onClose={() => setCreating(null)} onSaved={reload} />}
    </div>
  );
}
