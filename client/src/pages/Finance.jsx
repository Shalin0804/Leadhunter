import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ResponsiveContainer, AreaChart, Area, BarChart, Bar, ComposedChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import {
  FiUsers, FiBriefcase, FiDollarSign, FiCheckCircle, FiDownload, FiClock, FiActivity, FiFlag, FiPlus, FiSearch, FiArchive, FiRotateCcw, FiEdit2, FiArrowLeft, FiUpload, FiFileText, FiCreditCard, FiPieChart,
} from 'react-icons/fi';
import { Loader, ErrorBox, EmptyState } from '../components/ui';
import { useApi, useDebounced } from '../hooks/useApi';
import { financeApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import {
  inr, inrShort, fdate, code, presetRange, DateRange, ConfirmDialog, ClientForm, ProjectForm, PaymentForm, InvoiceForm, DocumentForm,
  ProjectsTable, PaymentsTable, InvoicesTable, DocumentsTable, PROJECT_STATUS, PAYMENT_TYPE, PAYMENT_METHOD, INVOICE_STATUS,
} from '../components/finance';

/* ---------------- shell + shared bits ---------------- */

const Shell = ({ title, subtitle, actions, children }) => (
  <div className="fin-theme fin-page">
    <div className="page">
      <div className="page-header">
        <div>
          <div className="fin-crumb">Client &amp; Finance</div>
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>{actions}</div>}
      </div>
      {children}
    </div>
  </div>
);

const Stat = ({ icon, label, value, sub, tone = 'blue', i = 0 }) => (
  <motion.div className={`card fin-stat ${tone}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.25 }}>
    <div className="fin-stat-label"><span className="fin-stat-icon">{icon}</span>{label}</div>
    <div className="fin-stat-value">{value}</div>
    {sub && <div className="fin-stat-sub">{sub}</div>}
  </motion.div>
);

const ChartCard = ({ title, sub, children, wide, full }) => (
  <div className={`card fin-chart ${wide ? 'wide' : ''} ${full ? 'full' : ''}`}>
    <div className="card-header"><div><h3>{title}</h3>{sub && <div className="cell-sub">{sub}</div>}</div></div>
    <div className="chart-box">{children}</div>
  </div>
);

/** Open/close state for a modal that may carry a record: [item, open(item?), close]. */
function useDialog(reload) {
  const [state, setState] = useState(null);
  return [state, (item = {}) => setState({ item }), (changed) => { setState(null); if (changed) reload(); }];
}

// Dark-theme chart styling.
const AX = { fontSize: 11, fill: '#7d8bab' };
const GRID = 'rgba(148,163,184,0.10)';
const TIP = { contentStyle: { background: '#0c1530', border: '1px solid rgba(96,165,250,0.25)', borderRadius: 10, fontSize: 12, color: '#e6edf8' }, labelStyle: { color: '#9fb0d0' }, cursor: { fill: 'rgba(96,165,250,0.06)' } };
const money = (v) => inr(v);
const monthLabel = (m) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit' });

/* ---------------- dashboard ---------------- */

export function FinanceDashboard() {
  const [range, setRange] = useState(presetRange('12m'));
  const { data, loading, error, reload } = useApi(() => financeApi.dashboard(range), [range.from, range.to]);
  const c = data?.cards;
  const monthly = (data?.monthly || []).map((m) => ({ ...m, label: monthLabel(m.month) }));
  const empty = data && !c.total_clients && !c.total_projects;

  return (
    <Shell title="Finance Dashboard" subtitle="Every figure is calculated from the payments and projects you've recorded." actions={<DateRange value={range} onChange={setRange} />}>
      {error && <ErrorBox message={error} onRetry={reload} />}
      {loading && !data && <Loader label="Loading financials…" />}
      {empty && (
        <div className="card mb-3"><EmptyState icon={<FiUsers />} title="No clients yet" message="Add your first client and project, then record payments as they arrive." action={<Link className="btn btn-primary" to="/finance/clients">Add a client</Link>} /></div>
      )}
      {data && !empty && (
        <>
          <div className="grid fin-stat-grid">
            <Stat i={0} icon={<FiUsers />} label="Total Clients" value={c.total_clients} sub="Active (not archived)" />
            <Stat i={1} icon={<FiBriefcase />} label="Total Projects" value={c.total_projects} sub={`${c.active_projects} active · ${c.completed_projects} completed`} />
            <Stat i={2} icon={<FiDollarSign />} label="Total Project Value" value={inrShort(c.total_project_value)} sub={inr(c.total_project_value)} tone="indigo" />
            <Stat i={3} icon={<FiCheckCircle />} label="Payments Received" value={inrShort(c.total_received)} sub={`${inrShort(c.received_in_range)} in this period`} tone="cyan" />
            <Stat i={4} icon={<FiCreditCard />} label="Deposits Received" value={inrShort(c.total_deposits)} sub={`${inrShort(c.deposits_in_range)} in this period`} tone="teal" />
            <Stat i={5} icon={<FiClock />} label="Pending Payments" value={inrShort(c.pending_payments)} sub="Balance on open projects" tone="amber" />
            <Stat i={6} icon={<FiActivity />} label="Active Projects" value={c.active_projects} sub="Confirmed + in progress" />
            <Stat i={7} icon={<FiFlag />} label="Completed Projects" value={c.completed_projects} tone="green" />
          </div>

          <div className="grid fin-chart-grid mt-4">
            <ChartCard title="Monthly Revenue" sub="Valid payments received per month" wide>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={monthly} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                  <defs>
                    <linearGradient id="finRev" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#3b82f6" stopOpacity={0.55} /><stop offset="100%" stopColor="#3b82f6" stopOpacity={0} /></linearGradient>
                  </defs>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="label" tick={AX} axisLine={false} tickLine={false} />
                  <YAxis tick={AX} axisLine={false} tickLine={false} tickFormatter={inrShort} width={70} />
                  <Tooltip {...TIP} formatter={money} />
                  <Area type="monotone" dataKey="received" name="Received" stroke="#60a5fa" strokeWidth={2.2} fill="url(#finRev)" />
                </AreaChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Received vs Pending" sub="Across all non-cancelled projects">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={data.received_vs_pending} dataKey="value" nameKey="name" innerRadius={62} outerRadius={92} paddingAngle={3} stroke="none">
                    <Cell fill="#22d3ee" />
                    <Cell fill="#334a7a" />
                  </Pie>
                  <Tooltip {...TIP} formatter={money} />
                  <Legend wrapperStyle={{ fontSize: 12, color: '#9fb0d0' }} />
                </PieChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Monthly Deposits" sub="Advance deposits received">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthly} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
                  <defs><linearGradient id="finDep" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#22d3ee" /><stop offset="100%" stopColor="#2563eb" /></linearGradient></defs>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="label" tick={AX} axisLine={false} tickLine={false} />
                  <YAxis tick={AX} axisLine={false} tickLine={false} tickFormatter={inrShort} width={70} />
                  <Tooltip {...TIP} formatter={money} />
                  <Bar dataKey="deposits" name="Deposits" fill="url(#finDep)" radius={[6, 6, 0, 0]} maxBarSize={34} />
                </BarChart>
              </ResponsiveContainer>
            </ChartCard>

            <ChartCard title="Project-wise Revenue" sub="Top 10 projects: received and still pending" wide>
              {data.project_revenue.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={data.project_revenue} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke={GRID} horizontal={false} />
                    <XAxis type="number" tick={AX} axisLine={false} tickLine={false} tickFormatter={inrShort} />
                    <YAxis type="category" dataKey="project" tick={AX} axisLine={false} tickLine={false} width={130} />
                    <Tooltip {...TIP} formatter={money} />
                    <Legend wrapperStyle={{ fontSize: 12, color: '#9fb0d0' }} />
                    <Bar dataKey="received" name="Received" stackId="a" fill="#3b82f6" maxBarSize={20} />
                    <Bar dataKey="pending" name="Pending" stackId="a" fill="#334a7a" radius={[0, 6, 6, 0]} maxBarSize={20} />
                  </BarChart>
                </ResponsiveContainer>
              ) : <EmptyState title="No project revenue yet" />}
            </ChartCard>

            <ChartCard title="Payment Collection Trend" sub="Cumulative collected and payments per month" full>
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={monthly} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  <XAxis dataKey="label" tick={AX} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="amt" tick={AX} axisLine={false} tickLine={false} tickFormatter={inrShort} width={70} />
                  <YAxis yAxisId="n" orientation="right" tick={AX} axisLine={false} tickLine={false} allowDecimals={false} width={28} />
                  <Tooltip {...TIP} formatter={(v, n) => (n === 'Payments' ? v : money(v))} />
                  <Legend wrapperStyle={{ fontSize: 12, color: '#9fb0d0' }} />
                  <Bar yAxisId="n" dataKey="payments" name="Payments" fill="rgba(96,165,250,0.28)" radius={[4, 4, 0, 0]} maxBarSize={22} />
                  <Line yAxisId="amt" type="monotone" dataKey="cumulative" name="Cumulative collected" stroke="#22d3ee" strokeWidth={2.2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            </ChartCard>
          </div>
        </>
      )}
    </Shell>
  );
}

/* ---------------- clients ---------------- */

export function FinanceClients() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState('');
  const q = useDebounced(search);
  const { data, loading, error, reload } = useApi(() => financeApi.clients({ search: q, archived }), [q, archived]);
  const [form, openForm, closeForm] = useDialog(reload);
  const [confirm, setConfirm] = useState(null);

  return (
    <Shell title="Clients" subtitle="Paying clients and their balances." actions={<button className="btn btn-primary" onClick={() => openForm()}><FiPlus /> Add client</button>}>
      <div className="card">
        <div className="card-header fin-toolbar">
          <div className="fin-search"><FiSearch /><input className="input" placeholder="Search name, company, contact…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <div className="fin-seg">
            <button className={archived === '' ? 'active' : ''} onClick={() => setArchived('')}>Active</button>
            <button className={archived === 'true' ? 'active' : ''} onClick={() => setArchived('true')}>Archived</button>
          </div>
        </div>
        {error && <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div>}
        {loading && !data ? <Loader /> : data && (data.items.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>ID</th><th>Client</th><th>Contact</th><th className="num">Projects</th><th className="num">Total value</th><th className="num">Received</th><th className="num">Balance</th><th>Added</th><th /></tr></thead>
              <tbody>
                {data.items.map((cl) => (
                  <tr key={cl.id}>
                    <td className="cell-sub nowrap">{code('CL', cl.id)}</td>
                    <td><Link className="cell-strong" to={`/finance/clients/${cl.id}`}>{cl.name}</Link>{cl.company_name && <div className="cell-sub">{cl.company_name}</div>}</td>
                    <td><div>{cl.contact_person || '—'}</div><div className="cell-sub">{[cl.email, cl.phone].filter(Boolean).join(' · ')}</div></td>
                    <td className="num">{cl.projects_count}</td>
                    <td className="num">{inr(cl.total_value)}</td>
                    <td className="num text-success">{inr(cl.total_received)}</td>
                    <td className="num">{inr(cl.remaining_balance)}</td>
                    <td className="cell-sub nowrap">{fdate(cl.created_at)}</td>
                    <td>
                      <span className="row-actions">
                        <button className="icon-btn" title="Edit" onClick={() => openForm(cl)}><FiEdit2 /></button>
                        <button className="icon-btn" title={cl.archived_at ? 'Restore' : 'Archive'} onClick={() => setConfirm(cl)}>{cl.archived_at ? <FiRotateCcw /> : <FiArchive />}</button>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyState icon={<FiUsers />} title={archived ? 'No archived clients' : search ? 'No matching clients' : 'No clients yet'} action={!archived && !search && <button className="btn btn-primary" onClick={() => openForm()}><FiPlus /> Add client</button>} />)}
      </div>
      <ClientForm open={!!form} client={form?.item?.id ? form.item : null} onClose={closeForm} />
      <ConfirmDialog
        open={!!confirm}
        title={confirm?.archived_at ? 'Restore client' : 'Archive client'}
        message={confirm?.archived_at ? `Restore ${confirm?.name} to the active list?` : `Archive ${confirm?.name}? Their projects, payments and invoices are kept and still count in reports.`}
        confirmLabel={confirm?.archived_at ? 'Restore' : 'Archive'}
        danger={!confirm?.archived_at}
        onConfirm={async () => {
          await financeApi.archiveClient(confirm.id, !confirm.archived_at).catch((e) => { toast.error(e.message); throw e; });
          toast.success(confirm.archived_at ? 'Client restored' : 'Client archived');
          reload();
        }}
        onClose={() => setConfirm(null)}
      />
    </Shell>
  );
}

/* ---------------- client profile ---------------- */

const TABS = ['Overview', 'Projects', 'Payments', 'Invoices', 'Documents'];

export function FinanceClientProfile() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [tab, setTab] = useState('Overview');
  const { data, loading, error, reload } = useApi(() => financeApi.client(id), [id]);
  const [dialog, setDialog] = useState(null); // { kind, item }
  const [confirm, setConfirm] = useState(null);
  const open = (kind, item) => setDialog({ kind, item });
  const close = (changed) => { setDialog(null); if (changed) reload(); };
  const is = (k) => dialog?.kind === k;

  if (loading && !data) return <Shell title="Client"><Loader /></Shell>;
  if (error) return <Shell title="Client"><ErrorBox message={error} onRetry={reload} /></Shell>;
  const { client, summary, projects, payments, invoices, documents, timeline } = data;
  const actions = (
    <>
      <button className="btn" onClick={() => open('client', client)}><FiEdit2 /> Edit</button>
      <button className="btn" onClick={() => open('project')}><FiPlus /> Project</button>
      <button className="btn" onClick={() => open('invoice')}><FiFileText /> Invoice</button>
      <button className="btn btn-primary" onClick={() => open('payment')} disabled={!projects.length} title={projects.length ? '' : 'Add a project first'}><FiDollarSign /> Record payment</button>
    </>
  );

  return (
    <Shell title={client.name} subtitle={[code('CL', client.id), client.company_name, client.archived_at && 'Archived'].filter(Boolean).join(' · ')} actions={actions}>
      <button className="btn btn-ghost btn-sm mb-3" onClick={() => navigate('/finance/clients')}><FiArrowLeft /> All clients</button>
      <div className="grid fin-stat-grid">
        <Stat icon={<FiBriefcase />} label="Projects" value={summary.projects} />
        <Stat icon={<FiDollarSign />} label="Total value" value={inrShort(summary.total_value)} sub={inr(summary.total_value)} tone="indigo" />
        <Stat icon={<FiCheckCircle />} label="Received" value={inrShort(summary.total_received)} sub={inr(summary.total_received)} tone="cyan" />
        <Stat icon={<FiCreditCard />} label="Deposits" value={inrShort(summary.total_deposits)} tone="teal" />
        <Stat icon={<FiClock />} label="Balance due" value={inrShort(summary.remaining_balance)} sub={inr(summary.remaining_balance)} tone="amber" />
        <Stat icon={<FiFileText />} label="Invoiced" value={inrShort(summary.invoiced)} sub="Records only — not payments" />
      </div>

      <div className="tabs mt-4">
        {TABS.map((t) => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t}{{ Projects: projects.length, Payments: payments.length, Invoices: invoices.length, Documents: documents.length }[t] ? ` (${{ Projects: projects.length, Payments: payments.length, Invoices: invoices.length, Documents: documents.length }[t]})` : ''}
          </button>
        ))}
      </div>

      {tab === 'Overview' && (
        <div className="profile-grid">
          <div className="card">
            <div className="card-header"><h3>Transaction timeline</h3></div>
            <div className="card-pad">
              {timeline.length ? (
                <div className="timeline">
                  {timeline.map((t, i) => (
                    <div key={i} className={`timeline-item fin-t-${t.type}`}>
                      <div className="t-title">{t.title}{t.amount != null && <span className="fin-t-amount"> · {inr(t.amount)}</span>}</div>
                      {t.detail && <div className="t-body">{t.detail.split(' · ').filter(Boolean).map((x) => PAYMENT_TYPE[x] || PAYMENT_METHOD[x] || PROJECT_STATUS[x] || INVOICE_STATUS[x] || x).join(' · ')}</div>}
                      <div className="t-meta">{fdate(t.date)}</div>
                    </div>
                  ))}
                </div>
              ) : <EmptyState title="No activity yet" />}
            </div>
          </div>
          <div className="card">
            <div className="card-header"><h3>Client details</h3></div>
            <dl className="def-list card-pad">
              <dt>Client ID</dt><dd>{code('CL', client.id)}</dd>
              <dt>Company</dt><dd>{client.company_name || '—'}</dd>
              <dt>Contact person</dt><dd>{client.contact_person || '—'}</dd>
              <dt>Email</dt><dd>{client.email ? <a href={`mailto:${client.email}`}>{client.email}</a> : '—'}</dd>
              <dt>Phone</dt><dd>{client.phone || '—'}</dd>
              <dt>Address</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{client.address || '—'}</dd>
              <dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{client.notes || '—'}</dd>
              <dt>Created</dt><dd>{fdate(client.created_at)}</dd>
            </dl>
            <div className="card-pad" style={{ paddingTop: 0 }}>
              <button className="btn btn-sm" onClick={() => setConfirm({ kind: 'archive' })}>{client.archived_at ? <><FiRotateCcw /> Restore client</> : <><FiArchive /> Archive client</>}</button>
            </div>
          </div>
        </div>
      )}
      {tab === 'Projects' && <div className="card"><ProjectsTable items={projects} showClient={false} onEdit={(p) => open('project', p)} onDelete={(p) => setConfirm({ kind: 'project', item: p })} /></div>}
      {tab === 'Payments' && <div className="card"><PaymentsTable items={payments} showClient={false} onEdit={(p) => open('payment', p)} onVoid={(p) => setConfirm({ kind: 'void', item: p })} /></div>}
      {tab === 'Invoices' && <div className="card"><InvoicesTable items={invoices} showClient={false} onEdit={(i) => open('invoice', i)} onDelete={(i) => setConfirm({ kind: 'invoice', item: i })} /></div>}
      {tab === 'Documents' && (
        <div className="card">
          <div className="card-header"><h3>Documents</h3><button className="btn btn-sm btn-primary" onClick={() => open('document')}><FiUpload /> Upload</button></div>
          <DocumentsTable items={documents} onDelete={(d) => setConfirm({ kind: 'document', item: d })} />
        </div>
      )}

      <ClientForm open={is('client')} client={client} onClose={close} />
      <ProjectForm open={is('project')} project={is('project') ? dialog.item : null} clientId={client.id} onClose={close} />
      <PaymentForm open={is('payment')} payment={is('payment') ? dialog.item : null} clientId={client.id} onClose={close} />
      <InvoiceForm open={is('invoice')} invoice={is('invoice') ? dialog.item : null} clientId={client.id} onClose={close} />
      <DocumentForm open={is('document')} clientId={client.id} onClose={close} />
      <FinanceConfirm confirm={confirm} client={client} onClose={() => setConfirm(null)} onDone={reload} toast={toast} />
    </Shell>
  );
}

/** One confirmation dialog for every destructive action in the finance pages. */
function FinanceConfirm({ confirm, client, onClose, onDone, toast }) {
  const item = confirm?.item;
  const cfg = {
    archive: client && {
      title: client.archived_at ? 'Restore client' : 'Archive client',
      message: client.archived_at ? `Restore ${client.name}?` : `Archive ${client.name}? All their records are kept.`,
      label: client.archived_at ? 'Restore' : 'Archive',
      run: () => financeApi.archiveClient(client.id, !client.archived_at),
      ok: client.archived_at ? 'Client restored' : 'Client archived',
    },
    project: item && { title: 'Delete project', message: `Delete project "${item.name}"? This is only possible while it has no payments or invoices.`, label: 'Delete', run: () => financeApi.deleteProject(item.id), ok: 'Project deleted' },
    void: item && { title: 'Void payment', message: `Void ${code('PAY', item.id)} for ${inr(item.amount)}? It stays in the history but no longer counts toward totals.`, label: 'Void payment', reason: true, run: (why) => financeApi.voidPayment(item.id, why), ok: 'Payment voided' },
    invoice: item && { title: 'Delete draft invoice', message: `Delete draft invoice ${item.invoice_number}?`, label: 'Delete', run: () => financeApi.deleteInvoice(item.id), ok: 'Invoice deleted' },
    document: item && { title: 'Delete document', message: `Delete ${item.file_name}?`, label: 'Delete', run: () => financeApi.deleteDocument(item.id), ok: 'Document deleted' },
  }[confirm?.kind];
  return (
    <ConfirmDialog
      open={!!cfg}
      title={cfg?.title}
      message={cfg?.message}
      confirmLabel={cfg?.label}
      reason={!!cfg?.reason}
      onConfirm={async (why) => {
        try {
          await cfg.run(why);
        } catch (e) {
          toast.error(e.message);
          throw e;
        }
        toast.success(cfg.ok);
        onDone();
      }}
      onClose={onClose}
    />
  );
}

/* ---------------- projects ---------------- */

export function FinanceProjects() {
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const { data, loading, error, reload } = useApi(() => financeApi.projects({ status, search: q }), [status, q]);
  const [form, openForm, closeForm] = useDialog(reload);
  const [confirm, setConfirm] = useState(null);
  return (
    <Shell title="Projects" subtitle="Project value, received and remaining balance — calculated from recorded payments." actions={<button className="btn btn-primary" onClick={() => openForm()}><FiPlus /> Add project</button>}>
      <div className="card">
        <div className="card-header fin-toolbar">
          <div className="fin-search"><FiSearch /><input className="input" placeholder="Search projects…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <select className="select fin-select" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            {Object.entries(PROJECT_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        {error && <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div>}
        {loading && !data ? <Loader /> : data && <ProjectsTable items={data.items} onEdit={(p) => openForm(p)} onDelete={(p) => setConfirm({ kind: 'project', item: p })} />}
      </div>
      <ProjectForm open={!!form} project={form?.item?.id ? form.item : null} onClose={closeForm} />
      <FinanceConfirm confirm={confirm} onClose={() => setConfirm(null)} onDone={reload} toast={toast} />
    </Shell>
  );
}

/* ---------------- payments ---------------- */

export function FinancePayments() {
  const toast = useToast();
  const [range, setRange] = useState(presetRange('12m'));
  const [f, setF] = useState({ type: '', method: '', include_void: '' });
  const { data, loading, error, reload } = useApi(() => financeApi.payments({ ...range, ...f }), [range.from, range.to, f.type, f.method, f.include_void]);
  const [form, openForm, closeForm] = useDialog(reload);
  const [confirm, setConfirm] = useState(null);
  const valid = (data?.items || []).filter((p) => !p.voided_at);
  const total = valid.reduce((s, p) => s + Number(p.amount), 0);
  const deposits = valid.filter((p) => p.payment_type === 'ADVANCE_DEPOSIT').reduce((s, p) => s + Number(p.amount), 0);
  return (
    <Shell title="Payments" subtitle="Every payment here was entered by hand. Nothing is collected or recorded automatically." actions={<button className="btn btn-primary" onClick={() => openForm()}><FiPlus /> Record payment</button>}>
      <div className="card">
        <div className="card-header fin-toolbar">
          <DateRange value={range} onChange={setRange} />
          <select className="select fin-select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">All types</option>{Object.entries(PAYMENT_TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select className="select fin-select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}><option value="">All methods</option>{Object.entries(PAYMENT_METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <label className="export-check"><input type="checkbox" checked={f.include_void === 'true'} onChange={(e) => setF({ ...f, include_void: e.target.checked ? 'true' : '' })} /> Show voided</label>
        </div>
        {data && <div className="fin-mini-stats card-pad" style={{ paddingBottom: 0 }}><div><span>Payments</span><strong>{valid.length}</strong></div><div><span>Received</span><strong>{inr(total)}</strong></div><div><span>Deposits</span><strong className="text-cyan">{inr(deposits)}</strong></div></div>}
        {error && <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div>}
        {loading && !data ? <Loader /> : data && <PaymentsTable items={data.items} onEdit={(p) => openForm(p)} onVoid={(p) => setConfirm({ kind: 'void', item: p })} />}
      </div>
      <PaymentForm open={!!form} payment={form?.item?.id ? form.item : null} onClose={closeForm} />
      <FinanceConfirm confirm={confirm} onClose={() => setConfirm(null)} onDone={reload} toast={toast} />
    </Shell>
  );
}

/* ---------------- invoices ---------------- */

export function FinanceInvoices() {
  const toast = useToast();
  const [range, setRange] = useState(presetRange('12m'));
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const q = useDebounced(search);
  const { data, loading, error, reload } = useApi(() => financeApi.invoices({ ...range, status, search: q }), [range.from, range.to, status, q]);
  const [form, openForm, closeForm] = useDialog(reload);
  const [confirm, setConfirm] = useState(null);
  return (
    <Shell title="Invoices" subtitle="Invoice records and PDFs. Invoice status never records a payment." actions={<button className="btn btn-primary" onClick={() => openForm()}><FiPlus /> New invoice</button>}>
      <div className="card">
        <div className="card-header fin-toolbar">
          <div className="fin-search"><FiSearch /><input className="input" placeholder="Invoice number…" value={search} onChange={(e) => setSearch(e.target.value)} /></div>
          <select className="select fin-select" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{Object.entries(INVOICE_STATUS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <DateRange value={range} onChange={setRange} />
        </div>
        {error && <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div>}
        {loading && !data ? <Loader /> : data && <InvoicesTable items={data.items} onEdit={(i) => openForm(i)} onDelete={(i) => setConfirm({ kind: 'invoice', item: i })} />}
      </div>
      <InvoiceForm open={!!form} invoice={form?.item?.id ? form.item : null} onClose={closeForm} />
      <FinanceConfirm confirm={confirm} onClose={() => setConfirm(null)} onDone={reload} toast={toast} />
    </Shell>
  );
}

/* ---------------- reports ---------------- */

const REPORTS = { monthly: 'Monthly Revenue', yearly: 'Yearly Revenue', clients: 'Client-wise Payments', projects: 'Project-wise Revenue', pending: 'Pending Payments', deposits: 'Deposit Collection', invoices: 'Invoice Status' };

export function FinanceReports() {
  const toast = useToast();
  const [type, setType] = useState('monthly');
  const [range, setRange] = useState(presetRange('12m'));
  const [busy, setBusy] = useState('');
  const { data, loading, error, reload } = useApi(() => financeApi.report(type, range), [type, range.from, range.to]);
  const exp = async (format) => {
    setBusy(format);
    try {
      await financeApi.exportReport(type, range, format);
      toast.success(`${REPORTS[type]} exported`);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy('');
    }
  };
  const totals = data?.columns.filter((c) => c.money).map((c) => [c.key, data.rows.reduce((s, r) => s + Number(r[c.key] || 0), 0)]);
  return (
    <Shell
      title="Financial Reports"
      subtitle="Built from recorded payments, projects and invoices. Export to Excel or CSV."
      actions={<>
        <button className="btn" disabled={!!busy || !data?.rows.length} onClick={() => exp('csv')}><FiDownload /> {busy === 'csv' ? 'Exporting…' : 'CSV'}</button>
        <button className="btn btn-primary" disabled={!!busy || !data?.rows.length} onClick={() => exp('xlsx')}><FiDownload /> {busy === 'xlsx' ? 'Exporting…' : 'Excel'}</button>
      </>}
    >
      <div className="fin-seg fin-report-tabs mb-3">
        {Object.entries(REPORTS).map(([k, v]) => <button key={k} className={type === k ? 'active' : ''} onClick={() => setType(k)}>{v}</button>)}
      </div>
      <div className="card">
        <div className="card-header fin-toolbar">
          <h3><FiPieChart style={{ verticalAlign: -2, marginRight: 6 }} />{REPORTS[type]}</h3>
          <DateRange value={range} onChange={setRange} />
        </div>
        {type === 'pending' && <div className="tracking-note" style={{ margin: '12px 16px 0' }}>Pending balances are as of today, for all open projects.</div>}
        {error && <div className="card-pad"><ErrorBox message={error} onRetry={reload} /></div>}
        {loading && !data ? <Loader /> : data && (data.rows.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr>{data.columns.map((c) => <th key={c.key} className={c.money ? 'num' : ''}>{c.header}</th>)}</tr></thead>
              <tbody>
                {data.rows.map((r, i) => (
                  <tr key={i}>{data.columns.map((c) => <td key={c.key} className={c.money ? 'num' : ''}>{c.money ? inr(r[c.key]) : r[c.key] ?? '—'}</td>)}</tr>
                ))}
              </tbody>
              {!!totals.length && (
                <tfoot><tr>{data.columns.map((c, i) => <td key={c.key} className={c.money ? 'num cell-strong' : 'cell-strong'}>{c.money ? inr(totals.find(([k]) => k === c.key)[1]) : i === 0 ? 'Total' : ''}</td>)}</tr></tfoot>
              )}
            </table>
          </div>
        ) : <EmptyState title="Nothing in this period" message="Try a wider date range." />)}
      </div>
    </Shell>
  );
}
