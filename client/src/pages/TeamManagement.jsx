import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FiUserPlus, FiKey, FiActivity, FiCopy, FiEdit2, FiUsers } from 'react-icons/fi';
import { useApi, useDebounced } from '../hooks/useApi';
import { userApi } from '../services/endpoints';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Modal } from '../components/ui';
import { ROLE_LABELS, ROLE_TONE, STATUS_TONE, fmtIST } from '../utils/rbac';
import { fmtRelative } from '../utils/format';

const ROLES = Object.keys(ROLE_LABELS);

function LinkBox({ link, emailed }) {
  const toast = useToast();
  return (
    <div className="link-box">
      <p className="text-sm">
        {emailed ? 'An email with this link was sent. ' : 'Email is not configured — share this link with the employee yourself. '}
        It works once and expires. It will not be shown again.
      </p>
      <div className="flex gap-2">
        <input className="input" readOnly value={link} onFocus={(e) => e.target.select()} />
        <button className="btn" type="button" onClick={() => navigator.clipboard.writeText(link).then(() => toast.success('Link copied'))}>
          <FiCopy /> Copy
        </button>
      </div>
    </div>
  );
}

function InviteModal({ open, onClose, managers, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', role: 'agent', manager_id: '' });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const close = () => {
    setResult(null);
    setForm({ name: '', email: '', role: 'agent', manager_id: '' });
    onClose();
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await userApi.invite({ ...form, manager_id: form.manager_id || null });
      setResult(r);
      toast.success(`${r.user.name} invited`);
      onDone();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={close} title="Invite employee">
      {result ? (
        <LinkBox link={result.set_password_link} emailed={result.emailed} />
      ) : (
        <form onSubmit={submit} id="invite-form">
          <div className="field">
            <label>Full name</label>
            <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} required minLength={2} />
          </div>
          <div className="field">
            <label>Work email</label>
            <input className="input" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} required />
          </div>
          <div className="grid-2">
            <div className="field">
              <label>Role</label>
              <select className="select" value={form.role} onChange={(e) => set('role', e.target.value)}>
                {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Manager (team)</label>
              <select className="select" value={form.manager_id} onChange={(e) => set('manager_id', e.target.value)}>
                <option value="">— None —</option>
                {managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </div>
          </div>
          <p className="text-sm text-muted">The employee gets only the permissions of this role. No password is set by you — they choose it from the invite link.</p>
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Inviting…' : 'Send invite'}</button>
        </form>
      )}
    </Modal>
  );
}

function EditModal({ user, onClose, managers, onDone, selfId }) {
  const toast = useToast();
  const [form, setForm] = useState(() => ({ name: user.name, role: user.role, manager_id: user.manager_id || '', is_active: user.is_active }));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reset, setReset] = useState(null);
  const self = user.id === selfId;
  const sensitive = form.role !== user.role || form.is_active !== user.is_active;

  const save = async () => {
    if (sensitive && !confirming) return setConfirming(true);
    setBusy(true);
    try {
      await userApi.update(user.id, { ...form, manager_id: form.manager_id || null });
      toast.success('Employee updated');
      onDone();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const resetPassword = async () => {
    try {
      setReset(await userApi.resetPassword(user.id));
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Edit ${user.name}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn ${confirming ? 'btn-danger' : 'btn-primary'}`} onClick={save} disabled={busy}>
            {confirming ? 'Confirm change' : 'Save'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Full name</label>
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Role</label>
          <select className="select" value={form.role} disabled={self} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Manager (team)</label>
          <select className="select" value={form.manager_id} onChange={(e) => setForm({ ...form, manager_id: e.target.value })}>
            <option value="">— None —</option>
            {managers.filter((m) => m.id !== user.id).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
      </div>
      <label className="flex items-center gap-2 mb-3">
        <input type="checkbox" checked={form.is_active} disabled={self} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} />
        Account active {self && <span className="text-muted text-sm">(you can't change your own role or status)</span>}
      </label>
      {confirming && (
        <div className="error-box mb-3">
          {form.is_active !== user.is_active && (form.is_active ? 'Re-activate this account? ' : 'Deactivate this account? Their sessions stop working immediately. ')}
          {form.role !== user.role && `Change role from ${ROLE_LABELS[user.role]} to ${ROLE_LABELS[form.role]}?`}
        </div>
      )}
      <div className="divider" />
      {reset ? (
        <LinkBox link={reset.set_password_link} emailed={reset.emailed} />
      ) : (
        <button className="btn btn-sm" type="button" onClick={resetPassword} disabled={!user.is_active}>
          <FiKey /> Generate password-reset link
        </button>
      )}
    </Modal>
  );
}

export default function TeamManagement() {
  const { user: me, can } = useAuth();
  const [filters, setFilters] = useState({ search: '', role: '', status: '' });
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const search = useDebounced(filters.search, 300);
  const { data, loading, error, reload } = useApi(
    () => userApi.list({ include_inactive: 'true', search, role: filters.role, status: filters.status }),
    [search, filters.role, filters.status]
  );
  const { data: all } = useApi(() => userApi.list({ include_inactive: 'true' }), [data]);
  const managers = (all?.users || []).filter((u) => ['manager', 'admin'].includes(u.role) && u.is_active);
  const nameOf = (id) => all?.users?.find((u) => u.id === id)?.name;
  const users = data?.users || [];
  const counts = (all?.users || []).reduce((c, u) => ({ ...c, [u.status]: (c[u.status] || 0) + 1 }), {});
  const manage = can('users.manage');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Team Management</h1>
          <p>Employees, roles and account access. Every change here is recorded in the Audit Trail.</p>
        </div>
        {manage && (
          <button className="btn btn-primary" onClick={() => setInviteOpen(true)}>
            <FiUserPlus /> Invite employee
          </button>
        )}
      </div>

      <div className="grid stat-grid mb-3">
        {[
          ['Total employees', all?.users?.length ?? 0, ''],
          ['Active', counts.active || 0, 'text-success'],
          ['Invited (pending)', counts.invited || 0, 'text-warning'],
          ['Inactive', counts.inactive || 0, 'text-danger'],
        ].map(([label, value, tone]) => (
          <div key={label} className="card stat-card">
            <span className="stat-label">{label}</span>
            <div className={`stat-value ${tone}`}>{value}</div>
          </div>
        ))}
      </div>

      <Card className="mb-3">
        <div className="filters">
          <div className="field">
            <label>Search</label>
            <input className="input" placeholder="Name or email" value={filters.search} onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
          </div>
          <div className="field">
            <label>Role</label>
            <select className="select" value={filters.role} onChange={(e) => setFilters({ ...filters, role: e.target.value })}>
              <option value="">All roles</option>
              {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select className="select" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="invited">Invited</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
      </Card>

      <Card bodyClass="">
        {loading ? (
          <Loader />
        ) : error ? (
          <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div>
        ) : !users.length ? (
          <EmptyState icon={<FiUsers />} title="No employees match" />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Role</th>
                  <th>Status</th>
                  <th>Team</th>
                  <th>Leads</th>
                  <th>Last login</th>
                  <th>Last activity</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>
                      <div className="cell-strong">{u.name} {u.id === me.id && <span className="badge gray">You</span>}</div>
                      <div className="cell-sub">{u.email} · #{u.id}</div>
                    </td>
                    <td><span className={`badge ${ROLE_TONE[u.role]}`}>{ROLE_LABELS[u.role]}</span></td>
                    <td><span className={`badge ${STATUS_TONE[u.status]}`}>{u.status}</span></td>
                    <td className="text-sm">{nameOf(u.manager_id) || '—'}</td>
                    <td className="text-sm">{u.assigned_leads ?? '—'}</td>
                    <td className="text-sm" title={fmtIST(u.last_login_at)}>{u.last_login_at ? fmtRelative(u.last_login_at) : 'Never'}</td>
                    <td className="text-sm" title={fmtIST(u.last_activity_at)}>{u.last_activity_at ? fmtRelative(u.last_activity_at) : '—'}</td>
                    <td className="text-sm">{fmtIST(u.created_at).split(',')[0]}</td>
                    <td>
                      <div className="flex gap-2">
                        <Link className="btn btn-sm" to={`/activity?actor_user_id=${u.id}`} title="Activity history"><FiActivity /></Link>
                        {manage && <button className="btn btn-sm" onClick={() => setEditing(u)} title="Edit"><FiEdit2 /></button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} managers={managers} onDone={reload} />
      {editing && <EditModal user={editing} selfId={me.id} managers={managers} onClose={() => setEditing(null)} onDone={reload} />}
    </div>
  );
}
