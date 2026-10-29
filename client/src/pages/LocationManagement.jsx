import { useEffect, useMemo, useState } from 'react';
import { FiGlobe, FiPlus, FiEdit2, FiTrash2, FiRefreshCw, FiPause, FiPlay, FiChevronRight, FiMapPin } from 'react-icons/fi';
import { useApi, useDebounced } from '../hooks/useApi';
import { locationApi, auditApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Pagination, Modal } from '../components/ui';
import { fmtIST, actionLabel } from '../utils/rbac';
import { fmtNumber } from '../utils/format';

const CHILD_TYPE = { country: 'state', state: 'city', city: 'area' };
const JOB_TONE = { completed: 'green', running: 'blue', queued: 'gray', failed: 'not_qualified', cancelled: 'warm' };

function CountryImport({ onChanged }) {
  const toast = useToast();
  const { data: catalog, error: catalogError } = useApi(() => locationApi.catalog(), []);
  const { data, reload } = useApi(() => locationApi.jobs(), []);
  const [cc, setCc] = useState('');
  const [dataset, setDataset] = useState('cities1000');
  const [busy, setBusy] = useState(false);
  const active = data?.jobs?.some((j) => ['queued', 'running'].includes(j.status));

  // Poll while an import runs — the job itself runs on the server, not in this tab.
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => reload().then(() => onChanged?.()), 3000);
    return () => clearInterval(t);
  }, [active, reload, onChanged]);

  const act = async (fn, msg) => {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      reload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Discover locations by country" className="mb-3">
      <div className="filters mb-3">
        <div className="field" style={{ minWidth: 260 }}>
          <label>Country</label>
          <select className="select" value={cc} onChange={(e) => setCc(e.target.value)}>
            <option value="">Select country…</option>
            {(catalog?.countries || []).map((c) => <option key={c.code} value={c.code}>{c.name} ({c.code})</option>)}
          </select>
        </div>
        <div className="field">
          <label>Coverage</label>
          <select className="select" value={dataset} onChange={(e) => setDataset(e.target.value)}>
            <option value="cities15000">Large cities (15k+)</option>
            <option value="cities5000">Towns 5k+</option>
            <option value="cities1000">Towns 1k+ (default)</option>
            <option value="cities500">Towns 500+ (most, larger import)</option>
          </select>
        </div>
        <button className="btn btn-primary" disabled={!cc || busy} onClick={() => act(() => locationApi.importCountry(cc, dataset), 'Discovery started — it runs in the background')}>
          <FiGlobe /> Discover locations
        </button>
      </div>
      {catalogError && <ErrorBox message={catalogError} />}
      <p className="text-sm text-muted">
        Source: GeoNames (CC BY 4.0). Imports states and towns above the chosen population, plus neighbourhoods only where GeoNames records them.
        For villages, suburbs and neighbourhoods, open a city and use <strong>Add localities (OSM)</strong> — a bounded OpenStreetMap lookup (© OpenStreetMap contributors, ODbL).
        Re-running a country syncs changes without duplicating anything; a stopped import resumes from its checkpoint.
      </p>

      {data?.countries?.length > 0 && (
        <div className="table-wrap mt-3">
          <table className="data">
            <thead><tr><th>Country</th><th>States</th><th>Cities</th><th>Areas</th><th>Last sync</th></tr></thead>
            <tbody>
              {data.countries.map((c) => (
                <tr key={c.id}>
                  <td className="cell-strong">{c.name} {!c.is_active && <span className="badge not_qualified">inactive</span>}</td>
                  <td>{fmtNumber(c.counts.state || 0)}</td>
                  <td>{fmtNumber(c.counts.city || 0)}</td>
                  <td>{fmtNumber(c.counts.area || 0)}</td>
                  <td className="text-sm">{fmtIST(c.last_synced_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data?.jobs?.length > 0 && (
        <>
          <h4 className="mt-3 mb-2">Import jobs</h4>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>#</th><th>Country</th><th>Status</th><th>Stage</th><th>Found (S / C / A)</th><th>Imported</th><th>Updated</th><th>Already present</th><th>Failed</th><th>Started</th><th></th></tr></thead>
              <tbody>
                {data.jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="text-sm">{j.id}</td>
                    <td>{j.country_name || j.country_code}</td>
                    <td>
                      <span className={`badge ${JOB_TONE[j.status]}`}>{j.status}</span>
                      {j.attempts > 1 && <div className="cell-sub">attempt {j.attempts}</div>}
                    </td>
                    <td className="text-sm">{j.stage || '—'}</td>
                    <td className="text-sm">{j.states_found} / {fmtNumber(j.cities_found)} / {fmtNumber(j.areas_found)}</td>
                    <td>{fmtNumber(j.imported)}</td>
                    <td>{fmtNumber(j.updated)}</td>
                    <td>{fmtNumber(j.skipped_existing)}</td>
                    <td title={(j.errors || []).map((e) => e.message).join('\n')}>{j.failed_records}{j.errors?.length ? ' ⚠' : ''}</td>
                    <td className="text-sm">{fmtIST(j.started_at)}<div className="cell-sub">{j.startedBy?.name}</div></td>
                    <td>
                      {['queued', 'running'].includes(j.status) ? (
                        <button className="btn btn-sm" disabled={busy} onClick={() => act(() => locationApi.cancelJob(j.id), 'Cancelling at the next checkpoint')}><FiPause /> Cancel</button>
                      ) : ['failed', 'cancelled'].includes(j.status) ? (
                        <button className="btn btn-sm" disabled={busy} onClick={() => act(() => locationApi.resumeJob(j.id), 'Resuming from checkpoint')}><FiPlay /> Resume</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Card>
  );
}

function LocationForm({ initial, parent, onClose, onSaved }) {
  const toast = useToast();
  const editing = !!initial?.id;
  const [form, setForm] = useState(() => ({
    name: initial?.name || '',
    latitude: initial?.latitude ?? '',
    longitude: initial?.longitude ?? '',
    search_radius_km: initial?.search_radius_km ?? '',
    location_type: initial?.location_type || CHILD_TYPE[parent?.location_type] || 'country',
    country_code: initial?.country_code || parent?.country_code || '',
  }));
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const save = async (e) => {
    e.preventDefault();
    try {
      const body = { name: form.name, latitude: form.latitude, longitude: form.longitude, search_radius_km: form.search_radius_km };
      if (editing) await locationApi.update(initial.id, body);
      else await locationApi.create({ ...body, location_type: form.location_type, parent_id: parent?.id, country_code: form.country_code });
      toast.success(editing ? 'Location updated' : 'Location added');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.message);
    }
  };
  return (
    <Modal open onClose={onClose} title={editing ? `Edit ${initial.name}` : `Add ${form.location_type}${parent ? ` in ${parent.name}` : ''}`}>
      <form onSubmit={save}>
        <div className="field"><label>Name</label><input className="input" required value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
        {!editing && !parent && (
          <div className="field"><label>Country code (ISO, 2 letters)</label><input className="input" maxLength={2} required value={form.country_code} onChange={(e) => set('country_code', e.target.value.toUpperCase())} /></div>
        )}
        <div className="grid-2">
          <div className="field"><label>Latitude</label><input className="input" type="number" step="any" min={-90} max={90} value={form.latitude} onChange={(e) => set('latitude', e.target.value)} /></div>
          <div className="field"><label>Longitude</label><input className="input" type="number" step="any" min={-180} max={180} value={form.longitude} onChange={(e) => set('longitude', e.target.value)} /></div>
        </div>
        <div className="field">
          <label>Search radius (km) — only used by providers that support a radius</label>
          <input className="input" type="number" min={1} max={500} value={form.search_radius_km} onChange={(e) => set('search_radius_km', e.target.value)} />
        </div>
        <button className="btn btn-primary btn-block">{editing ? 'Save changes' : 'Add location'}</button>
      </form>
    </Modal>
  );
}

export default function LocationManagement() {
  const toast = useToast();
  const [path, setPath] = useState([]); // breadcrumb of opened locations
  const [filters, setFilters] = useState({ search: '', status: '', sort: 'name' });
  const [page, setPage] = useState(1);
  const [form, setForm] = useState(null); // { initial?, parent? }
  const [confirm, setConfirm] = useState(null); // { loc, kind }
  const [tab, setTab] = useState('browse');
  const search = useDebounced(filters.search, 350);
  const parent = path[path.length - 1];

  const query = useMemo(
    () => ({
      page,
      limit: 50,
      include_inactive: 'true',
      status: filters.status || undefined,
      sort: filters.sort,
      dir: filters.sort === 'population' || filters.sort === 'updated_at' ? 'desc' : 'asc',
      ...(search ? { search, ...(parent ? { country_code: parent.country_code } : {}) } : { parent_id: parent ? parent.id : 'root' }),
    }),
    [page, filters.status, filters.sort, search, parent]
  );
  const { data, loading, error, reload } = useApi(() => locationApi.list(query), [JSON.stringify(query)]);
  const { data: history } = useApi(() => (tab === 'history' ? auditApi.logs({ resource_type: 'location', limit: 50 }) : null), [tab]);

  const open = (loc) => {
    if (!CHILD_TYPE[loc.location_type]) return;
    setPath((p) => [...p, loc]);
    setFilters((f) => ({ ...f, search: '' }));
    setPage(1);
  };
  const toggle = async (loc, cascade) => {
    try {
      const r = await locationApi.update(loc.id, { is_active: !loc.is_active, cascade });
      toast.success(`${loc.name} ${loc.is_active ? 'deactivated' : 'activated'}${r.cascaded ? ` with ${r.cascaded} sub-locations` : ''}`);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const addLocalities = async (loc) => {
    toast.success(`Asking OpenStreetMap for localities around ${loc.name}…`);
    try {
      const r = await locationApi.discoverLocalities(loc.id, 10);
      toast.success(`${loc.name}: ${r.imported} added, ${r.matched_other_source} already known, ${r.already_imported} previously imported (of ${r.found} found)`);
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };
  const remove = async (loc) => {
    try {
      const r = await locationApi.remove(loc.id);
      toast.success(r.deleted ? 'Location deleted' : 'Location deactivated (imported or has sub-locations)');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Location Management</h1>
          <p>The places employees may target in Lead Discovery. Only active locations (with active parents) can be used.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setForm({ parent })}>
          <FiPlus /> Add {parent ? CHILD_TYPE[parent.location_type] || 'location' : 'country'}
        </button>
      </div>

      <CountryImport onChanged={reload} />

      <div className="tabs">
        {['browse', 'history'].map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t === 'browse' ? 'Locations' : 'Change history'}</button>
        ))}
      </div>

      {tab === 'history' ? (
        <Card bodyClass="">
          {!history ? <Loader /> : !history.items.length ? <EmptyState title="No location changes recorded yet" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Details</th></tr></thead>
                <tbody>
                  {history.items.map((h) => (
                    <tr key={h.id}>
                      <td className="text-sm">{fmtIST(h.created_at)}</td>
                      <td>{h.actor?.name || h.actor_name}</td>
                      <td><span className="badge blue">{actionLabel(h.action)}</span></td>
                      <td className="text-sm">{h.metadata ? Object.entries(h.metadata).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      ) : (
        <>
          <Card className="mb-3">
            <div className="flex items-center gap-2 mb-3" style={{ flexWrap: 'wrap' }}>
              <button className="btn btn-sm btn-ghost" onClick={() => { setPath([]); setPage(1); }}><FiGlobe /> All countries</button>
              {path.map((p, i) => (
                <span key={p.id} className="flex items-center gap-2">
                  <FiChevronRight className="text-muted" />
                  <button className="btn btn-sm btn-ghost" onClick={() => { setPath(path.slice(0, i + 1)); setPage(1); }}>{p.name}</button>
                </span>
              ))}
            </div>
            <div className="filters">
              <div className="field">
                <label>Search {parent ? `in ${path[0].name}` : 'all'}</label>
                <input className="input" value={filters.search} placeholder="Name" onChange={(e) => { setFilters({ ...filters, search: e.target.value }); setPage(1); }} />
              </div>
              <div className="field">
                <label>Status</label>
                <select className="select" value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1); }}>
                  <option value="">Active and inactive</option>
                  <option value="inactive">Inactive only</option>
                </select>
              </div>
              <div className="field">
                <label>Sort</label>
                <select className="select" value={filters.sort} onChange={(e) => setFilters({ ...filters, sort: e.target.value })}>
                  <option value="name">Name</option>
                  <option value="population">Population</option>
                  <option value="updated_at">Last updated</option>
                </select>
              </div>
            </div>
          </Card>

          <Card bodyClass="">
            {loading && !data ? <Loader /> : error ? <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div> : !data?.items?.length ? (
              <EmptyState icon={<FiMapPin />} title="No locations here yet" message={parent ? 'Nothing imported under this location.' : 'Pick a country above and click Discover locations.'} />
            ) : (
              <>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Location</th><th>Type</th><th>Parent</th><th>Coordinates</th><th>Population</th><th>Status</th><th>Source</th><th>Created by</th><th>Created</th><th>Updated</th><th>Actions</th></tr></thead>
                    <tbody>
                      {data.items.map((l) => (
                        <tr key={l.id}>
                          <td>
                            {CHILD_TYPE[l.location_type] ? <button className="link-btn cell-strong" onClick={() => open(l)}>{l.name}</button> : <span className="cell-strong">{l.name}</span>}
                            <div className="cell-sub">{l.country_code}</div>
                          </td>
                          <td><span className="badge gray">{l.location_type}</span></td>
                          <td className="text-sm">{l.parent?.name || '—'}</td>
                          <td className="text-sm">{l.latitude != null ? `${Number(l.latitude).toFixed(3)}, ${Number(l.longitude).toFixed(3)}` : '—'}{l.search_radius_km ? <div className="cell-sub">{l.search_radius_km} km radius</div> : null}</td>
                          <td className="text-sm">{l.population ? fmtNumber(l.population) : '—'}</td>
                          <td><span className={`badge ${l.is_active ? 'green' : 'not_qualified'}`}>{l.is_active ? 'Active' : 'Inactive'}</span></td>
                          <td className="text-sm">{l.source}</td>
                          <td className="text-sm">{l.createdBy?.name || (l.source === 'geonames' ? 'Import' : '—')}</td>
                          <td className="text-sm">{fmtIST(l.created_at).split(',')[0]}</td>
                          <td className="text-sm">{fmtIST(l.updated_at).split(',')[0]}</td>
                          <td>
                            <div className="flex gap-2">
                              <button className="btn btn-sm" title="Edit" onClick={() => setForm({ initial: l })}><FiEdit2 /></button>
                              {['city', 'area'].includes(l.location_type) && l.latitude != null && (
                                <button className="btn btn-sm" title="Add villages / suburbs / neighbourhoods within 10 km from OpenStreetMap" onClick={() => addLocalities(l)}>+ OSM</button>
                              )}
                              <button className="btn btn-sm" title={l.is_active ? 'Deactivate' : 'Activate'} onClick={() => setConfirm({ loc: l, kind: 'toggle' })}><FiRefreshCw /></button>
                              <button className="btn btn-sm" title="Delete" onClick={() => setConfirm({ loc: l, kind: 'delete' })}><FiTrash2 /></button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination pagination={data.pagination} onChange={setPage} />
              </>
            )}
          </Card>
        </>
      )}

      {form && <LocationForm initial={form.initial} parent={form.parent} onClose={() => setForm(null)} onSaved={reload} />}
      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(null)}
          title={confirm.kind === 'delete' ? `Delete ${confirm.loc.name}?` : `${confirm.loc.is_active ? 'Deactivate' : 'Activate'} ${confirm.loc.name}?`}
          footer={
            <>
              <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
              {confirm.kind === 'toggle' && CHILD_TYPE[confirm.loc.location_type] && (
                <button className="btn" onClick={() => { toggle(confirm.loc, true); setConfirm(null); }}>Include sub-locations</button>
              )}
              <button className="btn btn-danger" onClick={() => { (confirm.kind === 'delete' ? remove : toggle)(confirm.loc, false); setConfirm(null); }}>
                {confirm.kind === 'delete' ? 'Delete' : 'Confirm'}
              </button>
            </>
          }
        >
          <p className="text-sm">
            {confirm.kind === 'delete'
              ? 'Manually added locations without sub-locations are deleted. Imported locations, or ones with sub-locations, are deactivated instead so the hierarchy stays intact. Existing leads are not affected either way.'
              : confirm.loc.is_active
                ? 'Employees will no longer be able to run discovery on this location (or anything under it). Existing leads are not affected.'
                : 'Employees with discovery permission will be able to target this location.'}
          </p>
        </Modal>
      )}
    </div>
  );
}
