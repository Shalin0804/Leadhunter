import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { FiDownload, FiShield, FiChevronUp, FiChevronDown } from 'react-icons/fi';
import { useApi, useDebounced } from '../hooks/useApi';
import { auditApi } from '../services/endpoints';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Pagination, Modal } from '../components/ui';
import { actionLabel, actionTone, fmtIST, istDate, leadCode, ROLE_LABELS } from '../utils/rbac';
import { STATUS_LABELS } from '../utils/format';

/** One audit-log view, three presets (see server/controllers/auditController.js presetWhere). */
const PRESETS = {
  all: { title: 'Activity Log', sub: 'Every recorded employee action — sign-ins, lead work, contact access and admin changes.' },
  access: { title: 'Lead Access History', sub: 'Who opened which lead, viewed which phone number or email, and when.' },
  security: { title: 'Audit Trail', sub: 'Security-relevant events: authentication, employee and role changes, assignments, exports and deletions.' },
};

const RANGES = [
  ['Today', 0],
  ['7 days', 6],
  ['30 days', 29],
  ['90 days', 89],
];

function Detail({ log, onClose }) {
  return (
    <Modal open onClose={onClose} title={actionLabel(log.action)}>
      <dl className="def-list">
        <dt>When</dt>
        <dd>{fmtIST(log.created_at)} <span className="cell-sub">({new Date(log.created_at).toISOString()} UTC)</span></dd>
        <dt>Employee</dt>
        <dd>{log.actor?.name || log.actor_name || 'Anonymous'} {log.actor_role && <span className="cell-sub">· {ROLE_LABELS[log.actor_role] || log.actor_role}</span>}</dd>
        <dt>Action</dt>
        <dd><code>{log.action}</code> · <span className={`badge ${log.result === 'success' ? 'green' : 'not_qualified'}`}>{log.result}</span></dd>
        {log.company && (<><dt>Company</dt><dd>{log.company.company_name}</dd></>)}
        {log.lead_id && (<><dt>Lead</dt><dd><Link to={`/leads/${log.lead_id}`}>{leadCode(log.lead_id)}</Link>{log.lead && <span className="cell-sub"> · now {STATUS_LABELS[log.lead.status] || log.lead.status}</span>}</dd></>)}
        {log.contact_id && (<><dt>Contact record</dt><dd>#{log.contact_id}</dd></>)}
        {log.accessed_fields && (<><dt>Fields accessed</dt><dd>{log.accessed_fields.join(', ')}</dd></>)}
        {log.resource_type && (<><dt>Resource</dt><dd>{log.resource_type} {log.resource_id && `#${log.resource_id}`}</dd></>)}
        {log.metadata && (<><dt>Details</dt><dd><pre className="detail-json">{JSON.stringify(log.metadata, null, 2)}</pre></dd></>)}
        <dt>Request</dt>
        <dd className="cell-sub">{log.request_id || '—'}{log.ip && ` · ${log.ip}`}</dd>
        {log.user_agent && (<><dt>Client</dt><dd className="cell-sub">{log.user_agent}</dd></>)}
      </dl>
      <p className="text-sm text-muted mt-3">Audit records are append-only. Contact values themselves are never stored — only which fields were accessed.</p>
    </Modal>
  );
}

export default function ActivityLog({ preset = 'all' }) {
  const { can } = useAuth();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  const get = (k) => params.get(k) || '';
  const set = (k, v) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPage(1);
  };
  const setRange = (days) => {
    const next = new URLSearchParams(params);
    if (days === null) {
      next.delete('from');
      next.delete('to');
    } else {
      next.set('from', istDate(days));
      next.set('to', istDate(0));
    }
    setParams(next, { replace: true });
    setPage(1);
  };

  const search = useDebounced(get('search'), 350);
  const query = useMemo(
    () => ({
      preset: preset === 'all' ? undefined : preset,
      page,
      limit: 25,
      search,
      actor_user_id: get('actor_user_id'),
      action: get('action'),
      lead_id: get('lead_id').replace(/^LEAD-/i, ''),
      contact_id: get('contact_id'),
      lead_status: get('lead_status'),
      result: get('result'),
      from: get('from'),
      to: get('to'),
      sort: get('sort') || 'created_at',
      dir: get('dir') || 'desc',
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [preset, page, search, params.toString()]
  );
  const { data, loading, error, reload } = useApi(() => auditApi.logs(query), [JSON.stringify(query)]);
  const { data: meta } = useApi(() => auditApi.meta(), []);
  const info = PRESETS[preset];

  const sortBy = (col) => {
    const next = new URLSearchParams(params);
    const dir = get('sort') === col && get('dir') !== 'asc' ? 'asc' : 'desc';
    next.set('sort', col);
    next.set('dir', dir);
    setParams(next, { replace: true });
  };
  const SortIcon = ({ col }) => ((get('sort') || 'created_at') === col ? (get('dir') === 'asc' ? <FiChevronUp /> : <FiChevronDown />) : null);
  const tz = meta?.display_timezone;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{info.title}</h1>
          <p>{info.sub}</p>
        </div>
        {can('audit.export') && (
          <button className="btn" onClick={() => auditApi.exportCsv({ ...query, page: undefined, limit: undefined }).catch((e) => toast.error(e.message))}>
            <FiDownload /> Export CSV
          </button>
        )}
      </div>

      <div className="tracking-note mb-3">
        <FiShield style={{ verticalAlign: '-2px' }} />{' '}
        {meta?.tracking_started_at
          ? `Reliable tracking began ${fmtIST(meta.tracking_started_at, tz)}. Nothing before that is shown or implied.`
          : 'No activity has been recorded yet — tracking starts with the first action after this release.'}{' '}
        Times shown in {tz || 'Asia/Kolkata'}.
      </div>

      <Card className="mb-3">
        <div className="chip-row mb-3">
          {RANGES.map(([label, days]) => (
            <button key={label} className={`chip ${get('from') === istDate(days) && get('to') === istDate(0) ? 'active' : ''}`} onClick={() => setRange(days)}>
              {label}
            </button>
          ))}
          <button className={`chip ${!get('from') && !get('to') ? 'active' : ''}`} onClick={() => setRange(null)}>
            All time
          </button>
        </div>
        <div className="filters">
          <div className="field">
            <label>Search</label>
            <input className="input" placeholder="Company, employee or action" value={get('search')} onChange={(e) => set('search', e.target.value)} />
          </div>
          {(meta?.users?.length || 0) > 1 && (
            <div className="field">
              <label>Employee</label>
              <select className="select" value={get('actor_user_id')} onChange={(e) => set('actor_user_id', e.target.value)}>
                <option value="">Everyone</option>
                {meta.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </div>
          )}
          <div className="field">
            <label>Action</label>
            <select className="select" value={get('action')} onChange={(e) => set('action', e.target.value)}>
              <option value="">Any action</option>
              {(meta?.actions || []).map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Lead ID</label>
            <input className="input" placeholder="LEAD-102" value={get('lead_id')} onChange={(e) => set('lead_id', e.target.value)} style={{ width: 120 }} />
          </div>
          <div className="field">
            <label>Contact ID</label>
            <input className="input" value={get('contact_id')} onChange={(e) => set('contact_id', e.target.value)} style={{ width: 100 }} />
          </div>
          <div className="field">
            <label>Lead status (now)</label>
            <select className="select" value={get('lead_status')} onChange={(e) => set('lead_status', e.target.value)}>
              <option value="">Any</option>
              {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>From</label>
            <input className="input" type="date" value={get('from')} onChange={(e) => set('from', e.target.value)} />
          </div>
          <div className="field">
            <label>To</label>
            <input className="input" type="date" value={get('to')} onChange={(e) => set('to', e.target.value)} />
          </div>
          {preset === 'security' && (
            <div className="field">
              <label>Result</label>
              <select className="select" value={get('result')} onChange={(e) => set('result', e.target.value)}>
                <option value="">Any</option>
                <option value="success">Success</option>
                <option value="failure">Failure</option>
              </select>
            </div>
          )}
        </div>
      </Card>

      <Card bodyClass="">
        {loading && !data ? (
          <Loader />
        ) : error ? (
          <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div>
        ) : !data?.items?.length ? (
          <EmptyState icon={<FiShield />} title="No activity found" message="Try a wider date range or fewer filters." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="sortable" onClick={() => sortBy('actor')}>Employee <SortIcon col="actor" /></th>
                    <th className="sortable" onClick={() => sortBy('action')}>Action <SortIcon col="action" /></th>
                    <th>Company</th>
                    <th>Lead ID</th>
                    <th>Fields</th>
                    <th className="sortable" onClick={() => sortBy('created_at')}>Date &amp; time <SortIcon col="created_at" /></th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((r) => (
                    <tr key={r.id} onClick={() => setDetail(r)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div className="cell-strong">{r.actor?.name || r.actor_name || 'Anonymous'}</div>
                        {r.actor_role && <div className="cell-sub">{ROLE_LABELS[r.actor_role] || r.actor_role}</div>}
                      </td>
                      <td>
                        <span className={`badge ${actionTone(r.action)}`}>{actionLabel(r.action)}</span>
                        {r.result !== 'success' && <span className="badge not_qualified" style={{ marginLeft: 4 }}>{r.result}</span>}
                      </td>
                      <td className="text-sm">{r.company?.company_name || '—'}</td>
                      <td className="text-sm">
                        {r.lead_id ? <Link to={`/leads/${r.lead_id}`} onClick={(e) => e.stopPropagation()}>{leadCode(r.lead_id)}</Link> : '—'}
                      </td>
                      <td className="text-sm">{r.accessed_fields?.join(', ') || '—'}</td>
                      <td className="text-sm" style={{ whiteSpace: 'nowrap' }}>{fmtIST(r.created_at, tz)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={data.pagination} onChange={setPage} />
          </>
        )}
      </Card>
      {detail && <Detail log={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}
