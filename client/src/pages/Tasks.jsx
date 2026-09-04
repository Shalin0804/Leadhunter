import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { FiPlus, FiCheck } from 'react-icons/fi';
import { useApi } from '../hooks/useApi';
import { taskApi, userApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Modal } from '../components/ui';
import { UserSelect } from '../components/actionModals';
import { fmtDateTime, titleCase } from '../utils/format';

const TABS = [
  { key: 'overdue', label: 'Overdue', params: { overdue: 'true' } },
  { key: 'upcoming', label: 'Upcoming (7d)', params: { upcoming: 'true' } },
  { key: 'todo', label: 'To do', params: { status: 'TODO' } },
  { key: 'all', label: 'All', params: {} },
];

function TaskModal({ open, onClose, onDone }) {
  const toast = useToast();
  const [form, setForm] = useState({ title: '', description: '', due_date: '', priority: 'MEDIUM', assigned_user_id: '', is_follow_up: false });
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    if (!form.title.trim()) return;
    setBusy(true);
    try {
      await taskApi.create({ ...form, assigned_user_id: form.assigned_user_id || undefined, due_date: form.due_date || undefined });
      toast.success('Task created');
      onDone?.();
      onClose();
      setForm({ title: '', description: '', due_date: '', priority: 'MEDIUM', assigned_user_id: '', is_follow_up: false });
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
      title="New task"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !form.title.trim()}>
            Create
          </button>
        </>
      }
    >
      <div className="field">
        <label>Title</label>
        <input className="input" value={form.title} onChange={(e) => set('title', e.target.value)} />
      </div>
      <div className="field">
        <label>Description</label>
        <textarea className="input" rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} />
      </div>
      <div className="form-row">
        <div className="field">
          <label>Due date</label>
          <input className="input" type="datetime-local" value={form.due_date} onChange={(e) => set('due_date', e.target.value)} />
        </div>
        <div className="field">
          <label>Priority</label>
          <select className="select" value={form.priority} onChange={(e) => set('priority', e.target.value)}>
            <option>LOW</option>
            <option>MEDIUM</option>
            <option>HIGH</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>Assign to</label>
        <UserSelect value={form.assigned_user_id} onChange={(v) => set('assigned_user_id', v)} />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={form.is_follow_up} onChange={(e) => set('is_follow_up', e.target.checked)} /> This is a follow-up
      </label>
    </Modal>
  );
}

export default function Tasks() {
  const toast = useToast();
  const [tab, setTab] = useState('overdue');
  const [showModal, setShowModal] = useState(false);
  const { data: users } = useApi(() => userApi.list(), []);
  const [assignee, setAssignee] = useState('');

  const params = useMemo(() => {
    const t = TABS.find((x) => x.key === tab);
    return { ...t.params, assigned_user_id: assignee || undefined, limit: 100 };
  }, [tab, assignee]);

  const { data, loading, error, reload } = useApi(() => taskApi.list(params), [JSON.stringify(params)]);

  const complete = async (id) => {
    try {
      await taskApi.update(id, { status: 'COMPLETED' });
      toast.success('Task completed');
      reload();
    } catch (e) {
      toast.error(e.message);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Tasks &amp; Follow-ups</h1>
          <p>Stay on top of overdue and upcoming work.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setShowModal(true)}>
          <FiPlus /> New task
        </button>
      </div>

      <div className="flex gap-2 mb-3" style={{ flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t.key} className={`chip ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
        <select className="select" style={{ maxWidth: 200, marginLeft: 'auto' }} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">All assignees</option>
          {(users?.users || []).map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </div>

      <Card bodyClass="">
        {loading ? (
          <Loader />
        ) : error ? (
          <div className="card-pad">
            <ErrorBox message={error} onRetry={reload} />
          </div>
        ) : !data?.items?.length ? (
          <EmptyState title="Nothing here" message="No tasks match this view." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Lead / Company</th>
                  <th>Due</th>
                  <th>Priority</th>
                  <th>Assigned</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((t) => {
                  const overdue = t.due_date && new Date(t.due_date) < new Date() && !['COMPLETED', 'CANCELLED'].includes(t.status);
                  return (
                    <tr key={t.id}>
                      <td>
                        <div className="cell-strong">{t.title}</div>
                        {t.is_follow_up && <span className="badge blue">Follow-up</span>}
                      </td>
                      <td className="text-sm">
                        {t.lead ? (
                          <Link to={`/leads/${t.lead.id}`}>{t.lead.company?.company_name || `Lead #${t.lead.id}`}</Link>
                        ) : t.company ? (
                          <Link to={`/companies/${t.company.id}`}>{t.company.company_name}</Link>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className={`nowrap text-sm ${overdue ? '' : ''}`} style={overdue ? { color: 'var(--danger)', fontWeight: 600 } : {}}>
                        {fmtDateTime(t.due_date)}
                      </td>
                      <td className="text-sm">{t.priority}</td>
                      <td className="text-sm">{t.assignedUser?.name || '—'}</td>
                      <td>
                        <span className={`badge ${t.status === 'COMPLETED' ? 'green' : t.status === 'CANCELLED' ? 'gray' : overdue ? 'hot' : 'blue'}`}>
                          {titleCase(t.status)}
                        </span>
                      </td>
                      <td>
                        {!['COMPLETED', 'CANCELLED'].includes(t.status) && (
                          <button className="icon-btn" title="Mark complete" onClick={() => complete(t.id)}>
                            <FiCheck />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <TaskModal open={showModal} onClose={() => setShowModal(false)} onDone={reload} />
    </div>
  );
}
