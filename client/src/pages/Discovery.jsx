import { useState, useMemo } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import {
  FiEye,
  FiUserPlus,
  FiFileText,
  FiClock,
  FiDownload,
  FiFilter,
  FiX,
} from 'react-icons/fi';
import { useApi, useDebounced } from '../hooks/useApi';
import { companyApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Pagination, ScoreBadge, TemperatureBadge, DemoBadge } from '../components/ui';
import { ConvertToLeadModal, AddNoteModal, AddFollowUpModal } from '../components/actionModals';
import { fmtDate } from '../utils/format';

const DATE_PRESETS = [
  { key: '', label: 'All time' },
  { key: 'today', label: 'Today' },
  { key: 'last_7_days', label: 'Last 7 days' },
  { key: 'last_30_days', label: 'Last 30 days' },
  { key: 'last_90_days', label: 'Last 90 days' },
];

const TEMPS = ['HOT', 'HIGH', 'WARM', 'LOW', 'NOT_QUALIFIED'];

export default function Discovery() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(true);
  const [modal, setModal] = useState(null); // { type, company }

  const get = (k) => params.get(k) || '';
  const setParam = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPage(1);
  };

  const searchInput = get('search');
  const debouncedSearch = useDebounced(searchInput, 400);

  const query = useMemo(
    () => ({
      page,
      limit: 15,
      search: debouncedSearch,
      state: get('state'),
      city: get('city'),
      industry: get('industry'),
      company_status: get('company_status'),
      company_type: get('company_type'),
      has_website: get('has_website'),
      has_email: get('has_email'),
      has_phone: get('has_phone'),
      lead_temperature: get('lead_temperature'),
      min_score: get('min_score'),
      max_score: get('max_score'),
      date_preset: get('date_preset'),
      date_from: get('date_from'),
      date_to: get('date_to'),
      sort: get('sort') || 'lead_score',
      dir: get('dir') || 'desc',
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, debouncedSearch, params.toString()]
  );

  const { data, loading, error, reload } = useApi(() => companyApi.discovery(query), [JSON.stringify(query)]);

  const activeFilterCount = ['state', 'city', 'industry', 'company_status', 'has_website', 'has_email', 'has_phone', 'lead_temperature', 'min_score', 'date_preset', 'date_from'].filter((k) => get(k)).length;

  const clearFilters = () => {
    const keep = new URLSearchParams();
    if (searchInput) keep.set('search', searchInput);
    setParams(keep, { replace: true });
    setPage(1);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Company Discovery</h1>
          <p>Find recently registered businesses and qualify them as leads.</p>
        </div>
        <div className="flex gap-2">
          <button className="btn" onClick={() => setShowFilters((v) => !v)}>
            <FiFilter /> Filters {activeFilterCount > 0 && <span className="badge blue">{activeFilterCount}</span>}
          </button>
          <button
            className="btn"
            onClick={() => companyApi.exportCsv(query).catch((e) => toast.error(e.message))}
          >
            <FiDownload /> Export CSV
          </button>
        </div>
      </div>

      <Card className="mb-3">
        <div className="field" style={{ marginBottom: 12 }}>
          <input
            className="input"
            placeholder="Search by company name, CIN, city, state or industry…"
            value={searchInput}
            onChange={(e) => setParam('search', e.target.value)}
          />
        </div>

        <div className="chip-row mb-3">
          {DATE_PRESETS.map((p) => (
            <button
              key={p.key}
              className={`chip ${get('date_preset') === p.key ? 'active' : ''}`}
              onClick={() => setParam('date_preset', p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>

        {showFilters && (
          <div className="filters">
            <div className="field">
              <label>Registered from</label>
              <input className="input" type="date" value={get('date_from')} onChange={(e) => setParam('date_from', e.target.value)} />
            </div>
            <div className="field">
              <label>Registered to</label>
              <input className="input" type="date" value={get('date_to')} onChange={(e) => setParam('date_to', e.target.value)} />
            </div>
            <div className="field">
              <label>State</label>
              <input className="input" value={get('state')} onChange={(e) => setParam('state', e.target.value)} placeholder="e.g. Maharashtra" />
            </div>
            <div className="field">
              <label>City</label>
              <input className="input" value={get('city')} onChange={(e) => setParam('city', e.target.value)} placeholder="e.g. Pune" />
            </div>
            <div className="field">
              <label>Industry</label>
              <input className="input" value={get('industry')} onChange={(e) => setParam('industry', e.target.value)} placeholder="e.g. Healthcare" />
            </div>
            <div className="field">
              <label>Company status</label>
              <input className="input" value={get('company_status')} onChange={(e) => setParam('company_status', e.target.value)} placeholder="e.g. Active" />
            </div>
            <div className="field">
              <label>Has website</label>
              <select className="select" value={get('has_website')} onChange={(e) => setParam('has_website', e.target.value)}>
                <option value="">Any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
            <div className="field">
              <label>Has email</label>
              <select className="select" value={get('has_email')} onChange={(e) => setParam('has_email', e.target.value)}>
                <option value="">Any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
            <div className="field">
              <label>Has phone</label>
              <select className="select" value={get('has_phone')} onChange={(e) => setParam('has_phone', e.target.value)}>
                <option value="">Any</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
            <div className="field">
              <label>Temperature</label>
              <select className="select" value={get('lead_temperature')} onChange={(e) => setParam('lead_temperature', e.target.value)}>
                <option value="">Any</option>
                {TEMPS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Min score</label>
              <input className="input" type="number" min="0" max="100" value={get('min_score')} onChange={(e) => setParam('min_score', e.target.value)} />
            </div>
            <div className="field">
              <label>Max score</label>
              <input className="input" type="number" min="0" max="100" value={get('max_score')} onChange={(e) => setParam('max_score', e.target.value)} />
            </div>
            {activeFilterCount > 0 && (
              <button className="btn btn-ghost" onClick={clearFilters}>
                <FiX /> Clear
              </button>
            )}
          </div>
        )}
      </Card>

      <Card bodyClass="">
        {loading ? (
          <Loader />
        ) : error ? (
          <div className="card-pad">
            <ErrorBox message={error} onRetry={reload} />
          </div>
        ) : !data?.items?.length ? (
          <EmptyState
            title="No companies match these filters"
            message="Try widening the date range or clearing filters, or import a CSV of new companies."
            action={
              <Link className="btn btn-primary" to="/imports">
                Import companies
              </Link>
            }
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>CIN</th>
                    <th>Registered</th>
                    <th>Industry</th>
                    <th>State</th>
                    <th>City</th>
                    <th>Website</th>
                    <th>Score</th>
                    <th>Temp</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((c) => (
                    <tr key={c.id}>
                      <td>
                        <Link to={`/companies/${c.id}`} className="cell-strong">
                          {c.company_name}
                        </Link>{' '}
                        {c.is_demo && <DemoBadge />}
                      </td>
                      <td className="cell-sub nowrap">{c.cin || '—'}</td>
                      <td className="nowrap">{fmtDate(c.date_of_incorporation)}</td>
                      <td>{c.industry || '—'}</td>
                      <td>{c.state || '—'}</td>
                      <td>{c.city || '—'}</td>
                      <td>
                        {c.has_website ? (
                          <span className="badge green">Yes</span>
                        ) : (
                          <span className="badge warm">No</span>
                        )}
                      </td>
                      <td>
                        <ScoreBadge value={c.lead_score} />
                      </td>
                      <td>
                        <TemperatureBadge value={c.lead_temperature} />
                      </td>
                      <td className="text-sm">{c.company_status || '—'}</td>
                      <td>
                        <div className="row-actions">
                          <button className="icon-btn" title="View" onClick={() => navigate(`/companies/${c.id}`)}>
                            <FiEye />
                          </button>
                          <button className="icon-btn" title="Convert to lead" onClick={() => setModal({ type: 'convert', company: c })}>
                            <FiUserPlus />
                          </button>
                          <button className="icon-btn" title="Add note" onClick={() => setModal({ type: 'note', company: c })}>
                            <FiFileText />
                          </button>
                          <button className="icon-btn" title="Add follow-up" onClick={() => setModal({ type: 'follow', company: c })}>
                            <FiClock />
                          </button>
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

      <ConvertToLeadModal
        open={modal?.type === 'convert'}
        onClose={() => setModal(null)}
        company={modal?.company}
        onDone={(lead) => navigate(`/leads/${lead.id}`)}
      />
      <AddNoteModal
        open={modal?.type === 'note'}
        onClose={() => setModal(null)}
        companyId={modal?.company?.id}
        onDone={reload}
      />
      <AddFollowUpModal
        open={modal?.type === 'follow'}
        onClose={() => setModal(null)}
        companyId={modal?.company?.id}
        onDone={reload}
      />
    </div>
  );
}
