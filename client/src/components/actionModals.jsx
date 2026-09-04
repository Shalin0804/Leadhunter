import { useState } from 'react';
import { Modal } from './ui';
import { useApi } from '../hooks/useApi';
import { userApi, leadApi, noteApi, taskApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';

function UserSelect({ value, onChange, allowEmpty = true }) {
  const { data } = useApi(() => userApi.list(), []);
  return (
    <select className="select" value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
      {allowEmpty && <option value="">Unassigned</option>}
      {(data?.users || []).map((u) => (
        <option key={u.id} value={u.id}>
          {u.name} ({u.role})
        </option>
      ))}
    </select>
  );
}

export function ConvertToLeadModal({ open, onClose, company, onDone }) {
  const toast = useToast();
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const res = await leadApi.createFromCompany({
        company_id: company.id,
        assigned_user_id: assignee || undefined,
        priority,
        estimated_value: value ? Number(value) : undefined,
      });
      toast.success(res.created ? 'Company converted to lead' : 'Lead already existed — opened it');
      onDone?.(res.lead);
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
      title={`Convert to lead — ${company?.company_name || ''}`}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            {busy ? 'Converting…' : 'Create lead'}
          </button>
        </>
      }
    >
      <div className="field">
        <label>Assign to</label>
        <UserSelect value={assignee} onChange={setAssignee} />
      </div>
      <div className="form-row">
        <div className="field">
          <label>Priority</label>
          <select className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option>LOW</option>
            <option>MEDIUM</option>
            <option>HIGH</option>
          </select>
        </div>
        <div className="field">
          <label>Estimated value (₹)</label>
          <input className="input" type="number" value={value} onChange={(e) => setValue(e.target.value)} placeholder="e.g. 75000" />
        </div>
      </div>
    </Modal>
  );
}

export function AddNoteModal({ open, onClose, leadId, companyId, onDone }) {
  const toast = useToast();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      await noteApi.create({ body: body.trim(), lead_id: leadId, company_id: companyId });
      toast.success('Note added');
      setBody('');
      onDone?.();
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
      title="Add note"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy || !body.trim()}>
            Save note
          </button>
        </>
      }
    >
      <div className="field">
        <label>Note</label>
        <textarea className="input" rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="What did you learn about this company?" />
      </div>
    </Modal>
  );
}

export function AddFollowUpModal({ open, onClose, leadId, companyId, onDone }) {
  const toast = useToast();
  const [title, setTitle] = useState('Follow up');
  const [dueDate, setDueDate] = useState('');
  const [priority, setPriority] = useState('MEDIUM');
  const [assignee, setAssignee] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await taskApi.create({
        title,
        due_date: dueDate || undefined,
        priority,
        assigned_user_id: assignee || undefined,
        lead_id: leadId,
        company_id: companyId,
        is_follow_up: true,
      });
      toast.success('Follow-up created');
      onDone?.();
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
      title="Add follow-up"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            Create follow-up
          </button>
        </>
      }
    >
      <div className="field">
        <label>Title</label>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="form-row">
        <div className="field">
          <label>Due date</label>
          <input className="input" type="datetime-local" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
        <div className="field">
          <label>Priority</label>
          <select className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
            <option>LOW</option>
            <option>MEDIUM</option>
            <option>HIGH</option>
          </select>
        </div>
      </div>
      <div className="field">
        <label>Assign to</label>
        <UserSelect value={assignee} onChange={setAssignee} />
      </div>
    </Modal>
  );
}

export function AssignModal({ open, onClose, lead, onDone }) {
  const toast = useToast();
  const [assignee, setAssignee] = useState(lead?.assigned_user_id || '');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const updated = await leadApi.update(lead.id, { assigned_user_id: assignee || '' });
      toast.success('Lead reassigned');
      onDone?.(updated.lead);
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
      title="Assign lead"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <div className="field">
        <label>Assign to</label>
        <UserSelect value={assignee} onChange={setAssignee} />
      </div>
    </Modal>
  );
}

export { UserSelect };
