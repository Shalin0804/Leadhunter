import { useState, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { FiDownload, FiExternalLink, FiPhoneCall, FiRotateCcw } from 'react-icons/fi';
import { useApi, useDebounced } from '../hooks/useApi';
import { leadApi, userApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Pagination, ScoreBadge, TemperatureBadge, StatusBadge } from '../components/ui';
import { ContactLeadModal, RecontactModal } from '../components/contactModals';
import { fmtDate, fmtDateTime, fmtMoney, STATUS_LABELS, CONTACT_STATUS_LABELS } from '../utils/format';

const STATUSES = Object.keys(STATUS_LABELS);
const CONTACT_STATUSES = Object.keys(CONTACT_STATUS_LABELS);
const TEMPS = ['HOT', 'HIGH', 'WARM', 'LOW', 'NOT_QUALIFIED'];

const CONTACT_TONE = {
  NOT_CONTACTED: 'gray',
  CONTACTED: 'blue',
  FOLLOW_UP: 'blue',
  REPLIED: 'blue',
  INTERESTED: 'warm',
  MEETING_BOOKED: 'warm',
  PROPOSAL_SENT: 'high',
  NEGOTIATION: 'high',
  WON: 'green',
  LOST: 'not_qualified',
  NOT_INTERESTED: 'not_qualified',
  DO_NOT_CONTACT: 'not_qualified',
};

export default function Leads() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const toast = useToast();
  const [modal, setModal] = useState(null); // { type, leadId }
  const { data: users } = useApi(() => userApi.list(), []);

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
      search: debounced,
      status: get('status'),
      contact_status: get('contact_status'),
      lead_temperature: get('lead_temperature'),
      assigned_user_id: get('assigned_user_id'),
      industry: get('industry'),
      state: get('state'),
      min_score: get('min_score'),
      created_from: get('created_from'),
      follow_up_due: get('follow_up_due'),
      new_only: get('new_only'),
      sort: get('sort') || 'lead_score',
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
          <h1>Leads</h1>
          <p>Qualified opportunities moving through your sales process.</p>
        </div>
        <button className="btn" onClick={() => leadApi.exportCsv(query).catch((e) => toast.error(e.message))}>
          <FiDownload /> Export CSV
        </button>
      </div>

      <div className="chip-row mb-3">
        <button className={`chip ${!get('new_only') ? 'active' : ''}`} onClick={() => setParam('new_only', '')}>
          All leads
        </button>
        <button className={`chip ${get('new_only') === 'true' ? 'active' : ''}`} onClick={() => setParam('new_only', 'true')}>
          New (not yet contacted)
        </button>
      </div>

      <Card className="mb-3">
        <div className="filters">
          <div className="field">
            <label>Search</label>
            <input className="input" value={searchInput} onChange={(e) => setParam('search', e.target.value)} placeholder="Company or CIN" />
          </div>
          <div className="field">
            <label>Pipeline stage</label>
            <select className="select" value={get('status')} onChange={(e) => setParam('status', e.target.value)}>
              <option value="">Any</option>
              {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Contact status</label>
            <select className="select" value={get('contact_status')} onChange={(e) => setParam('contact_status', e.target.value)}>
              <option value="">Any</option>
              {CONTACT_STATUSES.map((s) => <option key={s} value={s}>{CONTACT_STATUS_LABELS[s]}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Temperature</label>
            <select className="select" value={get('lead_temperature')} onChange={(e) => setParam('lead_temperature', e.target.value)}>
              <option value="">Any</option>
              {TEMPS.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Assigned to</label>
            <select className="select" value={get('assigned_user_id')} onChange={(e) => setParam('assigned_user_id', e.target.value)}>
              <option value="">Anyone</option>
              {(users?.users || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Industry</label>
            <input className="input" value={get('industry')} onChange={(e) => setParam('industry', e.target.value)} />
          </div>
          <div className="field">
            <label>State</label>
            <input className="input" value={get('state')} onChange={(e) => setParam('state', e.target.value)} />
          </div>
          <div className="field">
            <label>Min score</label>
            <input className="input" type="number" value={get('min_score')} onChange={(e) => setParam('min_score', e.target.value)} />
          </div>
          <div className="field">
            <label>Follow-up</label>
            <select className="select" value={get('follow_up_due')} onChange={(e) => setParam('follow_up_due', e.target.value)}>
              <option value="">Any</option>
              <option value="true">Due / overdue</option>
            </select>
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
          <EmptyState title="No leads found" message="Convert companies from Company Discovery to create leads, or let automation find some." action={<Link className="btn btn-primary" to="/discovery">Go to discovery</Link>} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Company</th>
                    <th>Score</th>
                    <th>Temp</th>
                    <th>Stage</th>
                    <th>Contact status</th>
                    <th>Assigned</th>
                    <th>Est. value</th>
                    <th>Next follow-up</th>
                    <th>Last contacted</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((l) => (
                    <tr key={l.id}>
                      <td>
                        <Link to={`/leads/${l.id}`} className="cell-strong">
                          {l.company?.company_name}
                        </Link>
                        <div className="cell-sub">{[l.company?.industry, l.company?.city].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td><ScoreBadge value={l.lead_score} /></td>
                      <td><TemperatureBadge value={l.lead_temperature} /></td>
                      <td><StatusBadge value={l.status} /></td>
                      <td><span className={`badge ${CONTACT_TONE[l.contact_status] || 'gray'}`}>{CONTACT_STATUS_LABELS[l.contact_status]}</span></td>
                      <td className="text-sm">{l.assignedUser?.name || '—'}</td>
                      <td className="nowrap">{fmtMoney(l.estimated_value)}</td>
                      <td className="nowrap text-sm">{fmtDateTime(l.next_follow_up_at)}</td>
                      <td className="nowrap text-sm">{fmtDateTime(l.last_contacted_at)}</td>
                      <td>
                        <div className="row-actions">
                          {l.contact_status === 'NOT_CONTACTED' ? (
                            <button className="icon-btn" title="Mark contacted" onClick={() => setModal({ type: 'contact', leadId: l.id })}>
                              <FiPhoneCall />
                            </button>
                          ) : (
                            <button className="icon-btn" title="Re-contact" onClick={() => setModal({ type: 'recontact', leadId: l.id })}>
                              <FiRotateCcw />
                            </button>
                          )}
                          <Link className="icon-btn" to={`/leads/${l.id}`} title="Open">
                            <FiExternalLink />
                          </Link>
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

      <ContactLeadModal open={modal?.type === 'contact'} onClose={() => setModal(null)} leadId={modal?.leadId} onDone={reload} />
      <RecontactModal open={modal?.type === 'recontact'} onClose={() => setModal(null)} leadId={modal?.leadId} onDone={reload} />
    </div>
  );
}
