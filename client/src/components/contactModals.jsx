import { useState } from 'react';
import { Modal } from './ui';
import { leadApi, outreachApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { CONTACT_STATUS_LABELS, CONTACT_METHOD_LABELS } from '../utils/format';

const METHODS = Object.keys(CONTACT_METHOD_LABELS);
const NEXT_STATUSES = Object.keys(CONTACT_STATUS_LABELS).filter((s) => s !== 'NOT_CONTACTED');

/** [ CONTACT ] button modal — always sets contact_status = CONTACTED. */
export function ContactLeadModal({ open, onClose, leadId, onDone }) {
  const toast = useToast();
  const [method, setMethod] = useState('EMAIL');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await leadApi.contact(leadId, { method, note: note || undefined });
      toast.success('Marked as contacted');
      onDone?.();
      onClose();
      setNote('');
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
      title="Mark as contacted"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : 'Mark contacted'}</button>
        </>
      }
    >
      <div className="field">
        <label>Contact method</label>
        <select className="select" value={method} onChange={(e) => setMethod(e.target.value)}>
          {METHODS.map((m) => <option key={m} value={m}>{CONTACT_METHOD_LABELS[m]}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Note (optional)</label>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Sent website proposal." />
      </div>
    </Modal>
  );
}

/** General contact-status change: REPLIED, INTERESTED, MEETING_BOOKED, WON, LOST, DO_NOT_CONTACT, ... */
export function ContactStatusModal({ open, onClose, leadId, currentStatus, onDone }) {
  const toast = useToast();
  const [status, setStatus] = useState(currentStatus || 'REPLIED');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await leadApi.updateContactStatus(leadId, { contact_status: status, note: note || undefined });
      toast.success(`Updated to ${CONTACT_STATUS_LABELS[status]}`);
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
      title="Update contact status"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>Save</button>
        </>
      }
    >
      <div className="field">
        <label>New status</label>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          {NEXT_STATUSES.map((s) => <option key={s} value={s}>{CONTACT_STATUS_LABELS[s]}</option>)}
        </select>
      </div>
      <div className="field">
        <label>Note (optional)</label>
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What happened?" />
      </div>
    </Modal>
  );
}

/** [ RE-CONTACT ] — manual only. */
export function RecontactModal({ open, onClose, leadId, onDone }) {
  const toast = useToast();
  const [status, setStatus] = useState('FOLLOW_UP');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await leadApi.recontact(leadId, { contact_status: status });
      toast.success('Lead moved back into play');
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
      title="Re-contact this lead"
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={busy}>Confirm</button>
        </>
      }
    >
      <p className="text-sm text-muted mb-3">This never happens automatically — only when you choose it here.</p>
      <div className="field">
        <label>Move to</label>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="FOLLOW_UP">Follow-up</option>
          <option value="NOT_CONTACTED">Not contacted (ready to contact)</option>
        </select>
      </div>
    </Modal>
  );
}

const CHANNEL_LABELS = { EMAIL: 'Email', WHATSAPP: 'WhatsApp', LINKEDIN: 'LinkedIn', PHONE_TALKING_POINTS: 'Phone talking points', FOLLOW_UP: 'Follow-up message' };

/** [ GENERATE OUTREACH ] — template-based, built from real observed facts only. */
export function OutreachModal({ open, onClose, companyId, leadId }) {
  const toast = useToast();
  const [channel, setChannel] = useState('EMAIL');
  const [contactName, setContactName] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);

  const run = async () => {
    setBusy(true);
    try {
      const res = await outreachApi.generate({ company_id: companyId, lead_id: leadId, channel, contact_name: contactName || undefined });
      setDraft(res.outreach);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => { setDraft(null); onClose(); }}
      title="Generate outreach"
      size="lg"
      footer={
        <>
          <button className="btn" onClick={onClose}>Close</button>
          <button className="btn btn-primary" onClick={run} disabled={busy}>{busy ? 'Generating…' : 'Generate'}</button>
        </>
      }
    >
      <div className="form-row">
        <div className="field">
          <label>Channel</label>
          <select className="select" value={channel} onChange={(e) => setChannel(e.target.value)}>
            {Object.entries(CHANNEL_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="field">
          <label>Contact name (optional)</label>
          <input className="input" value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="e.g. Priya" />
        </div>
      </div>

      {draft && (
        <div className="card card-pad" style={{ background: 'var(--surface-2)' }}>
          {draft.subject && <div className="mb-2"><strong>Subject:</strong> {draft.subject}</div>}
          <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{draft.body}</div>
          {draft.evidence?.length > 0 && (
            <div className="mt-3 text-sm text-muted">
              <strong>Based on:</strong> {draft.evidence.join(' · ')}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
