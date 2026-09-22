import { useState, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { FiDownload, FiExternalLink, FiZap } from 'react-icons/fi';
import { useApi, useDebounced } from '../hooks/useApi';
import { leadApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Pagination, ScoreBadge, SourceBadge } from '../components/ui';
import { fmtDate, fmtDateTime, STATUS_LABELS } from '../utils/format';

const STATUSES = Object.keys(STATUS_LABELS);

const PROVIDER_LABELS = {
  osm: 'OpenStreetMap',
  google_places: 'Google Places',
  yelp: 'Yelp',
  apollo: 'Apollo',
};

const providerLabel = (key) => PROVIDER_LABELS[key] || (key ? key.replace(/_/g, ' ') : null);

// The Automatic Leads section is defined entirely by Lead.source = 'automation'
// (see server/services/discoveryOrchestrator.js) — never by date, score, or any
// other heuristic. This page just renders whatever the API returns for that filter.
export default function AutomaticLeads() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const toast = useToast();

  const get = (k) => params.get(k) || '';
  const setParam = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPage(1);
  };

  const searchInput = get('search');
  const debounced = useDebounced(searchInput, 400);

  const query = useMemo(
    () => ({
      page,
      limit: 15,
      source: 'automation',
      search: debounced,
      status: get('status'),
      industry: get('industry'),
      city: get('city'),
      state: get('state'),
      min_score: get('min_score'),
      created_from: get('created_from'),
      created_to: get('created_to'),
      sort: get('sort') || 'created_at',
      dir: get('dir') || 'desc',
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [page, debounced, params.toString()]
  );

  const { data, loading, error, reload } = useApi(() => leadApi.list(query), [JSON.stringify(query)]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Automatic Leads</h1>
          <p>Every lead the automation pipeline discovered, deduplicated, scored and saved on its own — no manual entry.</p>
        </div>
        <div className="flex gap-2">
          <Link className="btn" to="/automation">
            <FiZap /> Automation settings
          </Link>
          <button className="btn" onClick={() => leadApi.exportCsv(query).catch((e) => toast.error(e.message))}>
            <FiDownload /> Export CSV
          </button>
        </div>
      </div>

      <Card className="mb-3">
        <div className="filters">
          <div className="field">
            <label>Search</label>
            <input className="input" value={searchInput} onChange={(e) => setParam('search', e.target.value)} placeholder="Company, CIN or website" />
          </div>
          <div className="field">
            <label>Pipeline stage</label>
            <select className="select" value={get('status')} onChange={(e) => setParam('status', e.target.value)}>
              <option value="">Any</option>
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Industry</label>
            <input className="input" value={get('industry')} onChange={(e) => setParam('industry', e.target.value)} />
          </div>
          <div className="field">
            <label>City</label>
            <input className="input" value={get('city')} onChange={(e) => setParam('city', e.target.value)} />
          </div>
          <div className="field">
            <label>Min score</label>
            <input className="input" type="number" value={get('min_score')} onChange={(e) => setParam('min_score', e.target.value)} />
          </div>
          <div className="field">
            <label>Discovered from</label>
            <input className="input" type="date" value={get('created_from')} onChange={(e) => setParam('created_from', e.target.value)} />
          </div>
          <div className="field">
            <label>Discovered to</label>
            <input className="input" type="date" value={get('created_to')} onChange={(e) => setParam('created_to', e.target.value)} />
          </div>
        </div>
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
            title="No automatic leads yet"
            message="Nothing has been discovered and saved by the automation pipeline yet. Configure and run it from Automation settings."
            action={<Link className="btn btn-primary" to="/automation">Go to automation settings</Link>}
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Contact</th>
                    <th>Email</th>
                    <th>Phone</th>
                    <th>Website</th>
                    <th>City</th>
                    <th>Industry</th>
                    <th>Lead score</th>
                    <th>Source</th>
                    <th>Discovery source</th>
                    <th>Status</th>
                    <th>Discovered</th>
                    <th>Last updated</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((l) => {
                    const email = l.company?.contacts?.find((c) => c.type === 'email');
                    const phone = l.company?.contacts?.find((c) => c.type === 'phone');
                    const discovery = l.company?.sources?.[0];
                    return (
                      <tr key={l.id}>
                        <td>
                          <Link to={`/leads/${l.id}`} className="cell-strong">
                            {l.company?.company_name}
                          </Link>
                        </td>
                        <td className="text-sm">{email?.contact_name || 'Not available'}</td>
                        <td className="text-sm">{email?.value || 'Not available'}</td>
                        <td className="text-sm">{phone?.value || 'Not available'}</td>
                        <td className="text-sm">
                          {l.company?.website ? (
                            <a href={l.company.website} target="_blank" rel="noreferrer">
                              {l.company.website.replace(/^https?:\/\/(www\.)?/i, '')}
                            </a>
                          ) : (
                            'Not available'
                          )}
                        </td>
                        <td className="text-sm">{l.company?.city || 'Not available'}</td>
                        <td className="text-sm">{l.company?.industry || 'Not available'}</td>
                        <td>{l.lead_score != null ? <ScoreBadge value={l.lead_score} /> : 'Not scored'}</td>
                        <td><SourceBadge value={l.source} /></td>
                        <td className="text-sm">
                          {discovery ? (
                            discovery.search_run_id ? (
                              <Link to={`/automation/runs/${discovery.search_run_id}`}>{providerLabel(discovery.provider)}</Link>
                            ) : (
                              providerLabel(discovery.provider)
                            )
                          ) : (
                            'Not available'
                          )}
                        </td>
                        <td><span className="badge gray">{STATUS_LABELS[l.status] || l.status}</span></td>
                        <td className="nowrap text-sm">{fmtDate(l.created_at)}</td>
                        <td className="nowrap text-sm">{fmtDateTime(l.updated_at)}</td>
                        <td>
                          <Link className="icon-btn" to={`/leads/${l.id}`} title="View">
                            <FiExternalLink />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination pagination={data.pagination} onChange={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
