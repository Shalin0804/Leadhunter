import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiUserCheck, FiInbox } from 'react-icons/fi';
import { useApi, useDebounced } from '../hooks/useApi';
import { leadApi, userApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Pagination, Modal, ScoreBadge, TemperatureBadge, StatusBadge } from '../components/ui';
import { ROLE_LABELS, leadCode } from '../utils/rbac';

function AssignDialog({ open, leadIds, users, onClose, onDone }) {
  const toast = useToast();
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await leadApi.assign({ lead_ids: leadIds, user_id: userId || null, reason: reason || undefined });
      toast.success(`${r.updated} of ${r.total} lead(s) ${userId ? 'assigned' : 'unassigned'}`);
      onDone();
      onClose();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Assign ${leadIds.length} lead${leadIds.length === 1 ? '' : 's'}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Assign'}</button>
        </>
      }
    >
      <div className="field">
        <label>New owner</label>
        <select className="select" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">— Unassign —</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name} · {ROLE_LABELS[u.role]}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Reason (optional, kept in assignment history)</label>
        <input className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Territory: Pune" />
      </div>
      <p className="text-sm text-muted">The previous owner, new owner, who assigned it and when are all recorded.</p>
    </Modal>
  );
}

export default function LeadAssignment() {
  const [filters, setFilters] = useState({ search: '', owner: 'unassigned' });
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState([]);
  const [open, setOpen] = useState(false);
  const search = useDebounced(filters.search, 350);
  const { data: usersData } = useApi(() => userApi.list(), []);
  const users = usersData?.users || [];

  const query = useMemo(() => ({ page, limit: 25, search, assigned_user_id: filters.owner, sort: 'lead_score', dir: 'desc' }), [page, search, filters.owner]);
  const { data, loading, error, reload } = useApi(() => leadApi.list(query), [JSON.stringify(query)]);
  const items = data?.items || [];
  const allOnPage = items.length > 0 && items.every((l) => selected.includes(l.id));
  const toggle = (id) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const toggleAll = () => setSelected((s) => (allOnPage ? s.filter((id) => !items.some((l) => l.id === id)) : [...new Set([...s, ...items.map((l) => l.id)])]));
  const setFilter = (k, v) => {
    setFilters((f) => ({ ...f, [k]: v }));
    setPage(1);
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Lead Assignment</h1>
          <p>Give each lead one owner. Employees only see the leads assigned to them (managers: their team’s).</p>
        </div>
        <button className="btn btn-primary" disabled={!selected.length} onClick={() => setOpen(true)}>
          <FiUserCheck /> Assign selected ({selected.length})
        </button>
      </div>

      <Card className="mb-3">
        <div className="filters">
          <div className="field">
            <label>Search</label>
            <input className="input" placeholder="Company, CIN or website" value={filters.search} onChange={(e) => setFilter('search', e.target.value)} />
          </div>
          <div className="field">
            <label>Current owner</label>
            <select className="select" value={filters.owner} onChange={(e) => setFilter('owner', e.target.value)}>
              <option value="">Anyone</option>
              <option value="unassigned">Unassigned</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
          </div>
          {selected.length > 0 && (
            <button className="btn btn-ghost" onClick={() => setSelected([])}>Clear selection</button>
          )}
        </div>
      </Card>

      <Card bodyClass="">
        {loading && !data ? (
          <Loader />
        ) : error ? (
          <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div>
        ) : !items.length ? (
          <EmptyState icon={<FiInbox />} title={filters.owner === 'unassigned' ? 'Every lead has an owner' : 'No leads match'} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th><input type="checkbox" checked={allOnPage} onChange={toggleAll} aria-label="Select page" /></th>
                    <th>Lead</th>
                    <th>Company</th>
                    <th>Score</th>
                    <th>Temperature</th>
                    <th>Stage</th>
                    <th>Current owner</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((l) => (
                    <tr key={l.id}>
                      <td><input type="checkbox" checked={selected.includes(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${leadCode(l.id)}`} /></td>
                      <td className="text-sm"><Link to={`/leads/${l.id}`}>{leadCode(l.id)}</Link></td>
                      <td>
                        <div className="cell-strong">{l.company?.company_name}</div>
                        <div className="cell-sub">{[l.company?.industry, l.company?.city].filter(Boolean).join(' · ') || '—'}</div>
                      </td>
                      <td><ScoreBadge value={l.lead_score} /></td>
                      <td><TemperatureBadge value={l.lead_temperature} /></td>
                      <td><StatusBadge value={l.status} /></td>
                      <td className="text-sm">{l.assignedUser?.name || <span className="badge warm">Unassigned</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={data.pagination} onChange={setPage} />
          </>
        )}
      </Card>

      <AssignDialog
        open={open}
        leadIds={selected}
        users={users}
        onClose={() => setOpen(false)}
        onDone={() => {
          setSelected([]);
          reload();
        }}
      />
    </div>
  );
}
