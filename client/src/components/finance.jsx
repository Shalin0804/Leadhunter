import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FiEdit2, FiEye, FiDownload, FiSlash, FiTrash2, FiPaperclip, FiAlertTriangle } from 'react-icons/fi';
import { Modal, EmptyState } from './ui';
import { financeApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';

/* ---------------- formatting + labels ---------------- */

const INR = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
const INR0 = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 });
export const inr = (v) => (v === null || v === undefined || v === '' ? '—' : INR.format(Number(v)));
export const inrShort = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e7) return `₹${(n / 1e7).toFixed(2)} Cr`;
  if (Math.abs(n) >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return INR0.format(n);
};
export const fdate = (d) => (d ? new Date(String(d).length === 10 ? `${d}T00:00:00` : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const code = (prefix, id) => `${prefix}-${String(id).padStart(4, '0')}`;
export const todayIso = () => new Date().toLocaleDateString('en-CA');

export const PROJECT_STATUS = { INQUIRY: 'Inquiry', CONFIRMED: 'Confirmed', IN_PROGRESS: 'In Progress', ON_HOLD: 'On Hold', COMPLETED: 'Completed', CANCELLED: 'Cancelled' };
export const PAYMENT_TYPE = { ADVANCE_DEPOSIT: 'Advance Deposit', MILESTONE: 'Milestone Payment', PARTIAL: 'Partial Payment', FINAL: 'Final Payment', OTHER: 'Other' };
export const PAYMENT_METHOD = { CASH: 'Cash', BANK_TRANSFER: 'Bank Transfer', UPI: 'UPI', CHEQUE: 'Cheque', OTHER: 'Other' };
export const INVOICE_STATUS = { DRAFT: 'Draft', SENT: 'Sent', PARTIALLY_PAID: 'Partially Paid', PAID: 'Paid', OVERDUE: 'Overdue', CANCELLED: 'Cancelled' };
const PROJECT_TONE = { INQUIRY: 'gray', CONFIRMED: 'blue', IN_PROGRESS: 'cyan', ON_HOLD: 'amber', COMPLETED: 'green', CANCELLED: 'hot' };
const INVOICE_TONE = { DRAFT: 'gray', SENT: 'blue', PARTIALLY_PAID: 'amber', PAID: 'green', OVERDUE: 'hot', CANCELLED: 'gray' };

export const ProjectStatus = ({ value }) => <span className={`badge ${PROJECT_TONE[value] || 'gray'}`}>{PROJECT_STATUS[value] || value}</span>;
export const InvoiceStatus = ({ invoice }) => (
  <span className="flex items-center gap-2">
    <span className={`badge ${INVOICE_TONE[invoice.status] || 'gray'}`}>{INVOICE_STATUS[invoice.status]}</span>
    {invoice.is_overdue && <span className="badge hot">Past due</span>}
  </span>
);
export const Progress = ({ value }) => (
  <div className="fin-progress" title={`${value}% paid`}>
    <span style={{ width: `${Math.min(100, value)}%` }} />
    <em>{value}%</em>
  </div>
);

const options = (map) => Object.entries(map).map(([k, v]) => <option key={k} value={k}>{v}</option>);
const errText = (e) => (e.details?.length && Array.isArray(e.details) ? `${e.message}: ${e.details.map((d) => `${d.field} ${d.message}`).join(', ')}` : e.message);

/* ---------------- dialogs ---------------- */

/** Confirmation for destructive actions; with `reason` it also collects a required reason. */
export function ConfirmDialog({ open, title, message, confirmLabel = 'Confirm', danger = true, reason = false, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState('');
  useEffect(() => setWhy(''), [open]);
  const go = async () => {
    setBusy(true);
    try {
      await onConfirm(why);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={title} className="fin-theme"
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} disabled={busy || (reason && !why.trim())} onClick={go}>{busy ? 'Working…' : confirmLabel}</button>
      </>}>
      <p className="flex gap-2" style={{ margin: 0 }}><FiAlertTriangle className="text-warning" style={{ flexShrink: 0, marginTop: 3 }} /> {message}</p>
      {reason && (
        <div className="field mt-4">
          <label>Reason (kept in the audit trail)</label>
          <input className="input" autoFocus value={why} maxLength={300} onChange={(e) => setWhy(e.target.value)} />
        </div>
      )}
    </Modal>
  );
}

/** Generic form modal: renders children, submits, toasts, reports server validation errors. */
function FormModal({ open, title, onClose, onSubmit, submitLabel = 'Save', children, size }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setError(''), [open]);
  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      const msg = await onSubmit();
      if (msg !== false) {
        toast.success(msg || 'Saved');
        onClose(true);
      }
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={() => onClose(false)} title={title} size={size} className="fin-theme"
      footer={<>
        <button className="btn" type="button" onClick={() => onClose(false)}>Cancel</button>
        <button className="btn btn-primary" type="submit" form="fin-form" disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
      </>}>
      <form id="fin-form" onSubmit={submit}>
        {error && <div className="error-box mb-3">{error}</div>}
        {children}
      </form>
    </Modal>
  );
}

const Field = ({ label, children, hint }) => (
  <div className="field">
    <label>{label}</label>
    {children}
    {hint && <div className="help-text">{hint}</div>}
  </div>
);

/** Controlled-form helper: [values, bind(name), set]. */
function useForm(initial, open) {
  const [v, setV] = useState(initial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setV(initial), [open]);
  const bind = (k) => ({ value: v[k] ?? '', onChange: (e) => setV((s) => ({ ...s, [k]: e.target.value })) });
  return [v, bind, setV];
}

/** Active clients + their projects, for the selects in the payment/invoice/project forms. */
function useLookups(open) {
  const [data, setData] = useState({ clients: [], projects: [] });
  useEffect(() => {
    if (!open) return;
    Promise.all([financeApi.clients(), financeApi.projects()])
      .then(([c, p]) => setData({ clients: c.items, projects: p.items }))
      .catch(() => {});
  }, [open]);
  return data;
}

const FileInput = ({ accept, onChange, label, hint }) => (
  <Field label={label} hint={hint}>
    <input className="input" type="file" accept={accept} onChange={(e) => onChange(e.target.files?.[0] || null)} />
  </Field>
);

/* ---------------- forms ---------------- */

export function ClientForm({ open, client, onClose }) {
  const [v, bind] = useForm(client || { name: '', company_name: '', contact_person: '', email: '', phone: '', address: '', notes: '' }, open);
  const submit = async () => {
    const body = { name: v.name, company_name: v.company_name, contact_person: v.contact_person, email: v.email, phone: v.phone, address: v.address, notes: v.notes };
    if (client) await financeApi.updateClient(client.id, body);
    else await financeApi.createClient(body);
    return client ? 'Client updated' : 'Client added';
  };
  return (
    <FormModal open={open} title={client ? 'Edit client' : 'Add client'} onClose={onClose} onSubmit={submit}>
      <div className="form-row">
        <Field label="Client name *"><input className="input" required maxLength={160} {...bind('name')} /></Field>
        <Field label="Company name"><input className="input" maxLength={200} {...bind('company_name')} /></Field>
      </div>
      <div className="form-row">
        <Field label="Contact person"><input className="input" maxLength={160} {...bind('contact_person')} /></Field>
        <Field label="Phone"><input className="input" type="tel" maxLength={40} {...bind('phone')} /></Field>
      </div>
      <Field label="Email"><input className="input" type="email" maxLength={190} {...bind('email')} /></Field>
      <Field label="Address"><textarea className="input" rows={2} {...bind('address')} /></Field>
      <Field label="Notes"><textarea className="input" rows={3} {...bind('notes')} /></Field>
    </FormModal>
  );
}

export function ProjectForm({ open, project, clientId, onClose }) {
  const { clients } = useLookups(open && !clientId && !project);
  const [v, bind] = useForm(
    project || { client_id: clientId || '', name: '', description: '', start_date: '', expected_delivery_date: '', actual_completion_date: '', project_value: '', status: 'INQUIRY', notes: '' },
    open
  );
  const submit = async () => {
    const body = { name: v.name, description: v.description, start_date: v.start_date || null, expected_delivery_date: v.expected_delivery_date || null, actual_completion_date: v.actual_completion_date || null, project_value: v.project_value, status: v.status, notes: v.notes };
    if (project) await financeApi.updateProject(project.id, body);
    else await financeApi.createProject({ ...body, client_id: v.client_id });
    return project ? 'Project updated' : 'Project added';
  };
  return (
    <FormModal open={open} title={project ? 'Edit project' : 'Add project'} onClose={onClose} onSubmit={submit} size="lg">
      {!project && !clientId && (
        <Field label="Client *">
          <select className="select" required {...bind('client_id')}>
            <option value="">Select a client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company_name ? ` — ${c.company_name}` : ''}</option>)}
          </select>
        </Field>
      )}
      <div className="form-row">
        <Field label="Project name *"><input className="input" required maxLength={200} {...bind('name')} /></Field>
        <Field label="Project status"><select className="select" {...bind('status')}>{options(PROJECT_STATUS)}</select></Field>
      </div>
      <Field label="Description"><textarea className="input" rows={2} {...bind('description')} /></Field>
      <div className="form-row">
        <Field label="Project value (₹) *" hint={project ? `Received so far: ${inr(project.total_received)} — the value can't go below this.` : undefined}>
          <input className="input" required inputMode="decimal" pattern="^\d+(\.\d{1,2})?$" title="Amount with up to 2 decimals" {...bind('project_value')} />
        </Field>
        <Field label="Start date"><input className="input" type="date" {...bind('start_date')} /></Field>
      </div>
      <div className="form-row">
        <Field label="Expected delivery"><input className="input" type="date" {...bind('expected_delivery_date')} /></Field>
        <Field label="Actual completion"><input className="input" type="date" {...bind('actual_completion_date')} /></Field>
      </div>
      <Field label="Notes"><textarea className="input" rows={2} {...bind('notes')} /></Field>
    </FormModal>
  );
}

/**
 * Record (or edit) a payment the admin actually received. The server re-checks everything;
 * a likely duplicate comes back as 409 + needs_confirmation, which we show and let the
 * admin explicitly confirm.
 */
export function PaymentForm({ open, payment, clientId, projectId, onClose }) {
  const { clients, projects } = useLookups(open);
  const [receipt, setReceipt] = useState(null);
  const [dup, setDup] = useState(null);
  const [v, bind, setV] = useForm(
    payment
      ? { ...payment }
      : { client_id: clientId || '', project_id: projectId || '', payment_date: todayIso(), amount: '', payment_type: 'ADVANCE_DEPOSIT', payment_method: 'UPI', transaction_reference: '', notes: '' },
    open
  );
  useEffect(() => {
    setReceipt(null);
    setDup(null);
  }, [open]);
  const clientProjects = projects.filter((p) => String(p.client_id) === String(v.client_id) && (p.status !== 'CANCELLED' || String(p.id) === String(v.project_id)));
  const selected = projects.find((p) => String(p.id) === String(v.project_id));
  const remaining = selected ? Number(selected.remaining_balance) + (payment ? Number(payment.amount) : 0) : null;

  const submit = async () => {
    const body = { payment_date: v.payment_date, amount: v.amount, payment_type: v.payment_type, payment_method: v.payment_method, transaction_reference: v.transaction_reference, notes: v.notes };
    try {
      if (payment) await financeApi.updatePayment(payment.id, body, receipt);
      else await financeApi.createPayment({ ...body, client_id: v.client_id, project_id: v.project_id, confirm_duplicate: dup ? 'true' : undefined }, receipt);
    } catch (e) {
      if (e.details?.needs_confirmation && !dup) {
        setDup(e.message);
        return false;
      }
      throw e;
    }
    return payment ? 'Payment updated' : 'Payment recorded';
  };

  return (
    <FormModal open={open} title={payment ? `Edit payment ${code('PAY', payment.id)}` : 'Record a received payment'} onClose={onClose} onSubmit={submit} submitLabel={dup ? 'Yes, record it' : payment ? 'Save' : 'Record payment'} size="lg">
      {dup && <div className="alert warn mb-3"><FiAlertTriangle /> {dup}</div>}
      {!payment && (
        <div className="form-row">
          <Field label="Client *">
            <select className="select" required value={v.client_id} onChange={(e) => setV((s) => ({ ...s, client_id: e.target.value, project_id: '' }))}>
              <option value="">Select a client…</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.company_name ? ` — ${c.company_name}` : ''}</option>)}
            </select>
          </Field>
          <Field label="Project *">
            <select className="select" required disabled={!v.client_id} {...bind('project_id')}>
              <option value="">{v.client_id && !clientProjects.length ? 'No open projects for this client' : 'Select a project…'}</option>
              {clientProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>
      )}
      {selected && (
        <div className="fin-mini-stats mb-3">
          <div><span>Project value</span><strong>{inr(selected.project_value)}</strong></div>
          <div><span>Received</span><strong>{inr(selected.total_received)}</strong></div>
          <div><span>Remaining</span><strong className="text-cyan">{inr(remaining)}</strong></div>
        </div>
      )}
      <div className="form-row">
        <Field label="Payment date *"><input className="input" type="date" required max={todayIso()} {...bind('payment_date')} /></Field>
        <Field label="Amount received (₹) *">
          <input className="input" required inputMode="decimal" pattern="^\d+(\.\d{1,2})?$" title="Amount with up to 2 decimals" {...bind('amount')} />
        </Field>
      </div>
      <div className="form-row">
        <Field label="Payment type *"><select className="select" {...bind('payment_type')}>{options(PAYMENT_TYPE)}</select></Field>
        <Field label="Payment method *"><select className="select" {...bind('payment_method')}>{options(PAYMENT_METHOD)}</select></Field>
      </div>
      <Field label="Transaction reference" hint="UTR / UPI ref / cheque no. The same reference can't be recorded twice.">
        <input className="input" maxLength={120} {...bind('transaction_reference')} />
      </Field>
      <Field label="Notes"><textarea className="input" rows={2} {...bind('notes')} /></Field>
      <FileInput label={payment ? 'Add a receipt (optional)' : 'Receipt (optional)'} accept="application/pdf,image/png,image/jpeg,image/webp" onChange={setReceipt} hint="PDF, PNG, JPG or WEBP, up to 5 MB. Stored privately." />
    </FormModal>
  );
}

export function InvoiceForm({ open, invoice, clientId, onClose }) {
  const { clients, projects } = useLookups(open);
  const [pdf, setPdf] = useState(null);
  const [v, bind, setV] = useForm(
    invoice
      ? { ...invoice, project_id: invoice.project_id || '' }
      : { invoice_number: '', client_id: clientId || '', project_id: '', invoice_date: todayIso(), due_date: '', amount: '', tax_amount: '', status: 'DRAFT', notes: '' },
    open
  );
  useEffect(() => setPdf(null), [open]);
  const total = (Number(v.amount) || 0) + (Number(v.tax_amount) || 0);
  const submit = async () => {
    const body = { invoice_number: v.invoice_number, client_id: v.client_id, project_id: v.project_id || '', invoice_date: v.invoice_date, due_date: v.due_date || '', amount: v.amount, tax_amount: v.tax_amount || '0', status: v.status, notes: v.notes };
    if (invoice) await financeApi.updateInvoice(invoice.id, body, pdf);
    else await financeApi.createInvoice(body, pdf);
    return invoice ? 'Invoice updated' : 'Invoice saved';
  };
  return (
    <FormModal open={open} title={invoice ? `Edit invoice ${invoice.invoice_number}` : 'New invoice record'} onClose={onClose} onSubmit={submit} size="lg">
      <div className="tracking-note mb-3">Invoices are records only. Marking one Paid does not record a payment — add the payment under Payments when the money arrives.</div>
      <div className="form-row">
        <Field label="Invoice number *"><input className="input" required maxLength={60} {...bind('invoice_number')} /></Field>
        <Field label="Status"><select className="select" {...bind('status')}>{options(INVOICE_STATUS)}</select></Field>
      </div>
      <div className="form-row">
        <Field label="Client *">
          <select className="select" required value={v.client_id} onChange={(e) => setV((s) => ({ ...s, client_id: e.target.value, project_id: '' }))}>
            <option value="">Select a client…</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Project">
          <select className="select" {...bind('project_id')}>
            <option value="">— None —</option>
            {projects.filter((p) => String(p.client_id) === String(v.client_id)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Invoice date *"><input className="input" type="date" required {...bind('invoice_date')} /></Field>
        <Field label="Due date"><input className="input" type="date" {...bind('due_date')} /></Field>
      </div>
      <div className="form-row">
        <Field label="Invoice amount (₹) *"><input className="input" required inputMode="decimal" pattern="^\d+(\.\d{1,2})?$" {...bind('amount')} /></Field>
        <Field label="GST / Tax (₹)" hint={`Total: ${inr(total)}`}><input className="input" inputMode="decimal" pattern="^\d+(\.\d{1,2})?$" {...bind('tax_amount')} /></Field>
      </div>
      <Field label="Notes"><textarea className="input" rows={2} {...bind('notes')} /></Field>
      <FileInput label={invoice ? 'Attach a new PDF (optional)' : 'Invoice PDF (optional)'} accept="application/pdf" onChange={setPdf} hint="PDF up to 5 MB. Stored privately." />
    </FormModal>
  );
}

export function DocumentForm({ open, clientId, onClose }) {
  const [file, setFile] = useState(null);
  const [v, bind] = useForm({ project_id: '', notes: '' }, open);
  const { projects } = useLookups(open);
  const submit = async () => {
    if (!file) throw new Error('Choose a file to upload');
    await financeApi.uploadDocument({ client_id: clientId, project_id: v.project_id, notes: v.notes }, file);
    return 'Document uploaded';
  };
  return (
    <FormModal open={open} title="Upload document" onClose={onClose} onSubmit={submit} submitLabel="Upload">
      <FileInput label="File *" accept="application/pdf,image/png,image/jpeg,image/webp" onChange={setFile} hint="PDF, PNG, JPG or WEBP, up to 5 MB." />
      <Field label="Project">
        <select className="select" {...bind('project_id')}>
          <option value="">— None —</option>
          {projects.filter((p) => String(p.client_id) === String(clientId)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Field label="Notes"><input className="input" maxLength={300} {...bind('notes')} /></Field>
    </FormModal>
  );
}

/* ---------------- tables (shared by list pages and the client profile) ---------------- */

/** Preview / download buttons for attached files. */
export function DocLinks({ docs = [] }) {
  const toast = useToast();
  if (!docs.length) return <span className="text-faint">—</span>;
  const run = (fn) => fn().catch((e) => toast.error(e.message));
  return (
    <span className="row-actions">
      {docs.map((d) => (
        <span key={d.id} className="row-actions">
          <button className="icon-btn" title={`Preview ${d.file_name}`} onClick={() => run(() => financeApi.previewDocument(d))}><FiEye /></button>
          <button className="icon-btn" title={`Download ${d.file_name}`} onClick={() => run(() => financeApi.downloadDocument(d))}><FiDownload /></button>
        </span>
      ))}
    </span>
  );
}

export function ProjectsTable({ items, onEdit, onDelete, showClient = true }) {
  if (!items.length) return <EmptyState title="No projects yet" message="Add a project to start tracking its value and payments." />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>ID</th><th>Project</th>{showClient && <th>Client</th>}<th>Status</th><th className="num">Value</th><th className="num">Received</th><th className="num">Balance</th><th>Paid</th><th>Delivery</th><th /></tr></thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <td className="cell-sub nowrap">{code('PRJ', p.id)}</td>
              <td><div className="cell-strong">{p.name}</div>{p.start_date && <div className="cell-sub">Started {fdate(p.start_date)}</div>}</td>
              {showClient && <td>{p.client ? <Link to={`/finance/clients/${p.client.id}`}>{p.client.name}</Link> : '—'}</td>}
              <td><ProjectStatus value={p.status} /></td>
              <td className="num">{inr(p.project_value)}</td>
              <td className="num text-success">{inr(p.total_received)}</td>
              <td className="num">{inr(p.remaining_balance)}</td>
              <td style={{ minWidth: 110 }}><Progress value={p.completion_percent} /></td>
              <td className="cell-sub nowrap">{p.actual_completion_date ? `Done ${fdate(p.actual_completion_date)}` : fdate(p.expected_delivery_date)}</td>
              <td>
                <span className="row-actions">
                  <button className="icon-btn" title="Edit" onClick={() => onEdit(p)}><FiEdit2 /></button>
                  {onDelete && !p.payments_count && <button className="icon-btn" title="Delete" onClick={() => onDelete(p)}><FiTrash2 /></button>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PaymentsTable({ items, onEdit, onVoid, showClient = true }) {
  if (!items.length) return <EmptyState title="No payments recorded" message="Payments appear here once you record money you've received." />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>ID</th><th>Date</th>{showClient && <th>Client</th>}<th>Project</th><th>Type</th><th>Method</th><th>Reference</th><th className="num">Amount</th><th>Receipt</th><th /></tr></thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id} className={p.voided_at ? 'fin-voided' : ''}>
              <td className="cell-sub nowrap">{code('PAY', p.id)}</td>
              <td className="nowrap">{fdate(p.payment_date)}</td>
              {showClient && <td>{p.client ? <Link to={`/finance/clients/${p.client.id}`}>{p.client.name}</Link> : '—'}</td>}
              <td>{p.project?.name || '—'}</td>
              <td><span className={`badge ${p.payment_type === 'ADVANCE_DEPOSIT' ? 'cyan' : 'blue'}`}>{PAYMENT_TYPE[p.payment_type]}</span></td>
              <td>{PAYMENT_METHOD[p.payment_method]}</td>
              <td className="cell-sub">{p.transaction_reference || '—'}</td>
              <td className="num cell-strong">
                {inr(p.amount)}
                {p.voided_at && <div className="cell-sub" title={p.void_reason}>Voided — {p.void_reason}</div>}
              </td>
              <td><DocLinks docs={p.documents} /></td>
              <td>
                {!p.voided_at && (
                  <span className="row-actions">
                    <button className="icon-btn" title="Edit" onClick={() => onEdit(p)}><FiEdit2 /></button>
                    <button className="icon-btn" title="Void payment" onClick={() => onVoid(p)}><FiSlash /></button>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InvoicesTable({ items, onEdit, onDelete, showClient = true }) {
  if (!items.length) return <EmptyState title="No invoices" message="Create an invoice record or upload an existing PDF." />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Invoice #</th><th>Date</th><th>Due</th>{showClient && <th>Client</th>}<th>Project</th><th className="num">Amount</th><th className="num">Tax</th><th className="num">Total</th><th>Status</th><th>PDF</th><th /></tr></thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.id}>
              <td className="cell-strong nowrap">{i.invoice_number}</td>
              <td className="nowrap">{fdate(i.invoice_date)}</td>
              <td className="nowrap">{fdate(i.due_date)}</td>
              {showClient && <td>{i.client ? <Link to={`/finance/clients/${i.client.id}`}>{i.client.name}</Link> : '—'}</td>}
              <td>{i.project?.name || '—'}</td>
              <td className="num">{inr(i.amount)}</td>
              <td className="num cell-sub">{inr(i.tax_amount)}</td>
              <td className="num cell-strong">{inr(i.total_amount)}</td>
              <td><InvoiceStatus invoice={i} /></td>
              <td><DocLinks docs={i.documents} /></td>
              <td>
                <span className="row-actions">
                  <button className="icon-btn" title="Edit" onClick={() => onEdit(i)}><FiEdit2 /></button>
                  {i.status === 'DRAFT' && <button className="icon-btn" title="Delete draft" onClick={() => onDelete(i)}><FiTrash2 /></button>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocumentsTable({ items, onDelete }) {
  if (!items.length) return <EmptyState icon={<FiPaperclip />} title="No documents" message="Receipts, invoice PDFs and uploaded files appear here." />;
  const KIND = { RECEIPT: 'Receipt', INVOICE: 'Invoice PDF', DOCUMENT: 'Document' };
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>File</th><th>Type</th><th>Size</th><th>Uploaded</th><th>Notes</th><th /></tr></thead>
        <tbody>
          {items.map((d) => (
            <tr key={d.id}>
              <td className="cell-strong">{d.file_name}</td>
              <td><span className="badge blue">{KIND[d.kind]}</span></td>
              <td className="cell-sub">{(d.size_bytes / 1024).toFixed(0)} KB</td>
              <td className="cell-sub nowrap">{fdate(d.created_at)}</td>
              <td className="cell-sub">{d.notes || '—'}</td>
              <td>
                <span className="row-actions">
                  <DocLinks docs={[d]} />
                  {d.kind === 'DOCUMENT' && <button className="icon-btn" title="Delete" onClick={() => onDelete(d)}><FiTrash2 /></button>}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- date range filter ---------------- */

const iso = (d) => d.toLocaleDateString('en-CA');
export function presetRange(key) {
  const now = new Date();
  const start = (y, m) => iso(new Date(y, m, 1));
  if (key === 'month') return { from: start(now.getFullYear(), now.getMonth()), to: iso(now) };
  if (key === '3m') return { from: start(now.getFullYear(), now.getMonth() - 2), to: iso(now) };
  if (key === 'fy') {
    const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1; // Indian FY: April–March
    return { from: `${y}-04-01`, to: iso(now) };
  }
  if (key === 'year') return { from: `${now.getFullYear()}-01-01`, to: iso(now) };
  return { from: start(now.getFullYear(), now.getMonth() - 11), to: iso(now) };
}
const PRESETS = { month: 'This month', '3m': '3 months', '12m': '12 months', fy: 'This FY', year: 'This year' };

export function DateRange({ value, onChange }) {
  const [preset, setPreset] = useState('12m');
  return (
    <div className="fin-range">
      <div className="fin-seg">
        {Object.entries(PRESETS).map(([k, label]) => (
          <button key={k} type="button" className={preset === k ? 'active' : ''} onClick={() => { setPreset(k); onChange(presetRange(k)); }}>{label}</button>
        ))}
      </div>
      <input className="input" type="date" aria-label="From" value={value.from} max={value.to} onChange={(e) => { setPreset(''); onChange({ ...value, from: e.target.value }); }} />
      <span className="text-faint">to</span>
      <input className="input" type="date" aria-label="To" value={value.to} min={value.from} onChange={(e) => { setPreset(''); onChange({ ...value, to: e.target.value }); }} />
    </div>
  );
}
