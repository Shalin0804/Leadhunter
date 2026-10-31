import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  FiCommand, FiPlay, FiPause, FiSquare, FiPlus, FiRefreshCw, FiX, FiRotateCcw, FiWifi, FiWifiOff,
  FiKey, FiCopy, FiActivity, FiCheckCircle, FiAlertTriangle, FiClock, FiList, FiTarget, FiBriefcase, FiMail, FiInbox, FiFileText,
} from 'react-icons/fi';
import { MultiLineChartBox } from '../components/charts';
import { useApi, useDebounced } from '../hooks/useApi';
import { agentApi, leadApi, companyApi } from '../services/endpoints';
import { useToast } from '../context/ToastContext';
import { Card, Loader, ErrorBox, EmptyState, Modal, Pagination } from '../components/ui';
import { fmtIST } from '../utils/rbac';
import { fmtRelative, fmtNumber } from '../utils/format';

const POLL_MS = 15000;

const MODE_LABELS = { research: 'Research', lead_analyst: 'Lead Analyst', sales: 'Sales', strategy: 'Strategy', competitor: 'Competitor Intelligence', reporting: 'Reporting' };
const TASK_TYPES = {
  research_company: { label: 'Research a company', mode: 'research', needs: 'company' },
  analyse_lead: { label: 'Analyse a lead', mode: 'lead_analyst', needs: 'lead' },
  generate_outreach: { label: 'Draft outreach for a lead', mode: 'sales', needs: 'lead' },
  strategy_review: { label: 'Strategy review', mode: 'strategy', needs: null },
  competitor_research: { label: 'Research a competitor', mode: 'competitor', needs: null },
  daily_report: { label: 'Daily report', mode: 'reporting', needs: null },
  weekly_report: { label: 'Weekly report', mode: 'reporting', needs: null },
};
const STATUSES = ['PENDING', 'RUNNING', 'PAUSED', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'];
const STATUS_TONE = { PENDING: 'gray', RUNNING: 'blue', PAUSED: 'warm', AWAITING_APPROVAL: 'high', COMPLETED: 'green', FAILED: 'hot', CANCELLED: 'not_qualified' };
const STATE_TONE = { running: 'green', paused: 'warm', stopped: 'gray' };
const ACTIVITY_LABELS = {
  tool_call: 'Tool call', task_created: 'Task queued', task_claimed: 'Task started', task_completed: 'Task completed', task_failed: 'Task failed',
  task_timeout: 'Task timed out', task_pause: 'Task paused', task_resume: 'Task resumed', task_cancel: 'Task cancelled', task_retry: 'Task retried',
  connected: 'Connected', reconnected: 'Reconnected', disconnected: 'Disconnected', control: 'Control',
  report_saved: 'Report saved', draft_created: 'Draft created', draft_edited: 'Draft edited', draft_approved: 'Draft approved', draft_rejected: 'Draft rejected',
  proposal_created: 'Proposal', proposal_approved: 'Proposal approved', proposal_rejected: 'Proposal rejected',
};
const ACTIVITY_STATUS_TONE = { success: 'green', failure: 'hot', denied: 'warm' };
// Which admin actions each task status allows (mirrors the server's transitions).
const TASK_ACTIONS = {
  PENDING: ['pause', 'cancel'],
  PAUSED: ['resume', 'cancel'],
  RUNNING: ['cancel'],
  AWAITING_APPROVAL: ['cancel'],
  FAILED: ['retry'],
  CANCELLED: ['retry'],
};
const DONE_LABELS = { pause: 'paused', resume: 'resumed', cancel: 'cancelled', retry: 're-queued' };
const ACTION_ICONS = { pause: <FiPause />, resume: <FiPlay />, cancel: <FiX />, retry: <FiRotateCcw /> };

const titleCase = (s = '') => s.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
const fmtDuration = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60000)} min`);
const json = (v) => JSON.stringify(v, null, 2);

/**
 * useApi + a silent refresh every POLL_MS while the tab is visible (no spinner flicker).
 * A failed refresh is surfaced as `error` so stale data is never shown as current.
 */
function usePolled(fn, deps) {
  const q = useApi(fn, deps);
  const [pollError, setPollError] = useState(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const errRef = useRef(q.error);
  errRef.current = q.error;
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      fnRef.current().then(
        (d) => {
          setPollError(null);
          // The first load failed but the API is back: reload properly so useApi clears its error.
          if (errRef.current) q.reload();
          else q.setData(d);
        },
        (e) => setPollError(e.message || 'Refresh failed')
      );
    }, POLL_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { ...q, error: q.error || pollError };
}

function ConnectionBadge({ connection }) {
  return connection?.connected ? (
    <span className="badge green"><FiWifi /> Connected</span>
  ) : (
    <span className="badge hot"><FiWifiOff /> Disconnected</span>
  );
}

const Stat = ({ label, icon, value, sub }) => (
  <div className="card stat-card">
    <div className="flex justify-between items-center">
      <span className="stat-label">{label}</span>
      {icon && <span className="stat-icon">{icon}</span>}
    </div>
    <div className="stat-value">{value}</div>
    {sub && <div className="stat-sub">{sub}</div>}
  </div>
);

/* ---------------- header controls ---------------- */

function Controls({ overview, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { state } = overview.control;
  const connected = overview.connection.connected;
  const run = async (action, msg) => {
    setBusy(true);
    try {
      await agentApi.control(action);
      toast.success(msg);
      onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const needConn = connected ? undefined : 'Connect Claude Code first: see the Connection tab';
  return (
    <div className="flex gap-2 items-center">
      {state === 'stopped' && (
        <button className="btn btn-primary" disabled={busy || !connected} title={needConn} onClick={() => run('start', 'Agent started')}><FiPlay /> Start</button>
      )}
      {state === 'paused' && (
        <button className="btn btn-primary" disabled={busy || !connected} title={needConn} onClick={() => run('resume', 'Agent resumed')}><FiPlay /> Resume</button>
      )}
      {state === 'running' && <button className="btn" disabled={busy} onClick={() => run('pause', 'Agent paused. Pending tasks are kept')}><FiPause /> Pause</button>}
      {state !== 'stopped' && <button className="btn btn-danger" disabled={busy} onClick={() => run('stop', 'Agent stopped. It will not take new tasks')}><FiSquare /> Stop</button>}
    </div>
  );
}

/* ---------------- overview ---------------- */

function ModesCard({ control, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const toggle = async (m) => {
    const next = control.enabled_modes.includes(m) ? control.enabled_modes.filter((x) => x !== m) : [...control.enabled_modes, m];
    setBusy(true); // one change at a time, so a quick second click can't overwrite the first
    try {
      await agentApi.control('modes', { enabled_modes: next });
      await onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Enabled modes">
      <p className="text-sm text-muted mb-3">The agent only picks up tasks whose mode is enabled. Tasks in a disabled mode stay queued.</p>
      <div className="chip-row">
        {Object.entries(MODE_LABELS).map(([k, v]) => (
          <button key={k} type="button" disabled={busy} className={`chip ${control.enabled_modes.includes(k) ? 'active' : ''}`} aria-pressed={control.enabled_modes.includes(k)} onClick={() => toggle(k)}>{v}</button>
        ))}
      </div>
    </Card>
  );
}

function Overview({ overview, onChanged, openTask }) {
  const { connection, control, tasks, completed_by_type: done } = overview;
  const recent = usePolled(() => agentApi.activity({ limit: 8 }), []);
  return (
    <>
      <div className="grid stat-grid mb-3">
        <Stat label="Connection" icon={connection.connected ? <FiWifi /> : <FiWifiOff />} value={connection.connected ? 'Connected' : 'Disconnected'} sub={connection.last_heartbeat_at ? `Last heartbeat ${fmtRelative(connection.last_heartbeat_at)}` : 'Never connected'} />
        <Stat label="Availability" icon={<FiCommand />} value={overview.available ? 'Available' : 'Unavailable'} sub={`Agent is ${control.state}${!connection.connected ? ' · no session' : ''}`} />
        <Stat label="Current task" icon={<FiClock />} value={overview.current_task ? `#${overview.current_task.id}` : '—'} sub={overview.current_task?.title || 'Nothing running'} />
        <Stat label="Last activity" icon={<FiActivity />} value={overview.last_activity ? fmtRelative(overview.last_activity.created_at) : '—'} sub={overview.last_activity?.action} />
        <Stat label="Pending" icon={<FiList />} value={fmtNumber(tasks.PENDING + tasks.PAUSED)} sub={tasks.PAUSED ? `${tasks.PAUSED} paused` : undefined} />
        <Stat label="Running" icon={<FiPlay />} value={fmtNumber(tasks.RUNNING)} />
        <Stat label="Completed" icon={<FiCheckCircle />} value={fmtNumber(tasks.COMPLETED)} />
        <Stat label="Failed" icon={<FiAlertTriangle />} value={fmtNumber(tasks.FAILED)} sub={tasks.CANCELLED ? `${tasks.CANCELLED} cancelled` : undefined} />
        <Stat label="Leads analysed" icon={<FiTarget />} value={fmtNumber(done.analyse_lead)} sub="Completed analysis tasks" />
        <Stat label="Companies researched" icon={<FiBriefcase />} value={fmtNumber(done.research_company)} sub="Completed research tasks" />
        <Stat label="Outreach drafts" icon={<FiMail />} value={fmtNumber(done.generate_outreach)} sub="Completed draft tasks" />
        <Stat label="Pending approvals" icon={<FiInbox />} value={fmtNumber(overview.pending_approvals.total)} sub={`${overview.pending_approvals.drafts} drafts · ${overview.pending_approvals.proposals} lead changes`} />
      </div>

      <div className="grid chart-grid mb-3">
        <ModesCard control={control} onChanged={onChanged} />
        <Card title="When the agent works">
          <p className="text-sm">The agent runs inside <strong>Claude Code on your computer</strong>, using your Claude subscription. It only works while that Claude Code session is open and online.</p>
          <p className="text-sm text-muted mt-2">When the computer is off or Claude Code is closed, this page shows Disconnected and tasks wait in the queue. Work resumes when the session reconnects. Nothing is ever sent to prospects automatically.</p>
        </Card>
      </div>

      <Card title="Recent activity" bodyClass="">
        {recent.loading && !recent.data ? <Loader /> : recent.error ? <div className="card-pad"><ErrorBox message={recent.error} onRetry={recent.reload} /></div> : (
          <ActivityTable items={recent.data.items} openTask={openTask} compact />
        )}
      </Card>
    </>
  );
}

/* ---------------- connection ---------------- */

function Connection({ overview, onChanged }) {
  const toast = useToast();
  const [issued, setIssued] = useState(null);
  const [busy, setBusy] = useState(false);
  const c = overview.connection;
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:5000/api';

  const issue = async () => {
    if (overview.token && !window.confirm('Issue a new token? The current one stops working immediately.')) return;
    setBusy(true);
    try {
      setIssued((await agentApi.issueToken()).token);
      onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const revoke = async () => {
    if (!window.confirm('Revoke the agent token? Claude Code loses access immediately.')) return;
    setBusy(true);
    try {
      await agentApi.revokeToken();
      toast.success('Token revoked');
      onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Copied');
    } catch {
      toast.error('Copy failed. Select the text and copy it manually');
    }
  };
  const envLines = `LEADHUNTER_API_URL=${apiUrl}\nLEADHUNTER_AGENT_TOKEN=${issued || '<your agent token>'}`;

  return (
    <>
      <div className="grid chart-grid mb-3">
        <Card title="Claude Code connection" actions={<ConnectionBadge connection={c} />}>
          <dl className="def-list">
            <dt>Status</dt>
            <dd>{c.connected ? 'Connected: heartbeats are arriving' : 'Disconnected'}</dd>
            {!c.connected && c.reason && (<><dt>Reason</dt><dd className="text-danger">{c.reason}</dd></>)}
            <dt>Last heartbeat</dt>
            <dd>{c.last_heartbeat_at ? <>{fmtIST(c.last_heartbeat_at)} <span className="cell-sub">({fmtRelative(c.last_heartbeat_at)})</span></> : 'Never'}</dd>
            <dt>Connected since</dt>
            <dd>{c.connected_at ? fmtIST(c.connected_at) : '—'}</dd>
            <dt>Session</dt>
            <dd className="text-sm">{c.session_id || '—'}</dd>
            <dt>Client</dt>
            <dd className="text-sm">{c.client || '—'}</dd>
            <dt>MCP server health</dt>
            <dd>{c.connected ? <span className="badge green">Healthy</span> : <span className="badge not_qualified">No signal</span>} <span className="cell-sub">Disconnected after {Math.round(c.stale_after_seconds / 60)} min without a heartbeat</span></dd>
          </dl>
          <p className="text-sm text-muted mt-2">Heartbeats come from the LeadHunter MCP server, which runs only inside an open Claude Code session. The status is never inferred from configuration files.</p>
        </Card>

        <Card title="Agent token" actions={<FiKey />}>
          {overview.token ? (
            <dl className="def-list">
              <dt>Issued</dt>
              <dd>{fmtIST(overview.token.issued_at)}</dd>
              <dt>Ends with</dt>
              <dd><code>…{overview.token.last4}</code></dd>
            </dl>
          ) : <p className="text-sm">No token issued. Claude Code can't connect until you issue one.</p>}
          <p className="text-sm text-muted mt-2">The token acts as you, without contact reveal, deletes, exports, or user and settings management. Only its hash is stored.</p>
          <div className="flex gap-2 mt-4">
            <button className="btn btn-primary" disabled={busy} onClick={issue}><FiKey /> {overview.token ? 'Issue new token' : 'Issue token'}</button>
            {overview.token && <button className="btn btn-danger" disabled={busy} onClick={revoke}>Revoke</button>}
          </div>
        </Card>
      </div>

      <Card title="Connect Claude Code on your computer">
        <ol className="reason-list text-sm">
          <li>Issue a token above, then add these two lines to <code>server/.env</code> in your LeadHunter project folder:
            <pre className="detail-json mt-2">{envLines}</pre>
            <button className="btn btn-sm" onClick={() => copy(envLines)}><FiCopy /> Copy</button>
          </li>
          <li className="mt-2">Open a terminal in the project folder and run <code>claude</code>. Approve the <code>leadhunter</code> MCP server when Claude Code asks.</li>
          <li className="mt-2">Within a minute, this page shows <strong>Connected</strong>. Then press <strong>Start</strong> at the top.</li>
          <li className="mt-2">In Claude Code, run <code>/loop 5m /leadhunter-agent</code> to keep working the queue, or ask it once to "work the LeadHunter queue".</li>
        </ol>
        <p className="text-sm text-muted mt-2">If the connection drops (computer asleep, Claude Code closed, network lost), just reopen Claude Code in the project folder. Pending tasks are kept, and a task left half-done returns to the queue after its time limit.</p>
      </Card>

      {issued && (
        <Modal open onClose={() => setIssued(null)} title="Agent token" footer={<button className="btn btn-primary" onClick={() => setIssued(null)}>I've saved it</button>}>
          <p className="text-sm mb-3"><FiAlertTriangle style={{ verticalAlign: '-2px' }} /> This is shown <strong>once</strong>. Store it only in <code>server/.env</code> on the computer that runs Claude Code. Never commit it.</p>
          <pre className="detail-json">{issued}</pre>
          <button className="btn btn-sm mt-2" onClick={() => copy(issued)}><FiCopy /> Copy token</button>
        </Modal>
      )}
    </>
  );
}

/* ---------------- tasks ---------------- */

function RecordPicker({ kind, value, onChange }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data, loading } = useApi(
    () => (dq.length >= 2 ? (kind === 'lead' ? leadApi.list({ search: dq, limit: 10 }) : companyApi.list({ search: dq, limit: 10 })) : Promise.resolve(null)),
    [dq, kind]
  );
  const name = (r) => (kind === 'lead' ? r.company?.company_name : r.company_name);
  if (value) {
    return (
      <div className="field">
        <label>{kind === 'lead' ? 'Lead' : 'Company'}</label>
        <div className="flex items-center gap-2"><span className="chip active">{value.label}</span><button type="button" className="btn btn-sm" onClick={() => onChange(null)}>Change</button></div>
      </div>
    );
  }
  return (
    <div className="field">
      <label htmlFor="rec-search">{kind === 'lead' ? 'Lead' : 'Company'}</label>
      <input id="rec-search" className="input" placeholder="Type 2+ letters of the company name" value={q} onChange={(e) => setQ(e.target.value)} />
      {loading && dq.length >= 2 && <div className="cell-sub mt-2">Searching…</div>}
      {data?.items?.length > 0 && (
        <div className="picker-list">
          {data.items.map((r) => (
            <button type="button" key={r.id} className="picker-item" onClick={() => onChange({ id: r.id, label: name(r) || `#${r.id}` })}>
              {name(r) || `#${r.id}`} <span className="cell-sub">{kind === 'lead' ? `LEAD-${r.id}` : r.city || r.industry || ''}</span>
            </button>
          ))}
        </div>
      )}
      {data?.items?.length === 0 && <div className="cell-sub mt-2">No matches.</div>}
    </div>
  );
}

function NewTask({ control, onClose, onSaved }) {
  const toast = useToast();
  const [type, setType] = useState('research_company');
  const [record, setRecord] = useState(null);
  const [priority, setPriority] = useState(5);
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [competitor, setCompetitor] = useState({ name: '', website: '' });
  const [busy, setBusy] = useState(false);
  const def = TASK_TYPES[type];
  const modeOff = !control.enabled_modes.includes(def.mode);

  const input = () => {
    if (type === 'strategy_review') return { topic };
    if (type === 'competitor_research') return { competitor: competitor.name, website: competitor.website || undefined };
    return null;
  };
  const valid = (def.needs ? !!record : true) && (type !== 'strategy_review' || topic.trim().length >= 3) && (type !== 'competitor_research' || competitor.name.trim().length >= 2);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await agentApi.createTask({
        type,
        priority: Number(priority),
        title: title.trim() || undefined,
        lead_id: def.needs === 'lead' ? record.id : undefined,
        company_id: def.needs === 'company' ? record.id : undefined,
        input: input(),
      });
      toast.success('Task queued');
      onSaved();
      onClose();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="New agent task">
      <form onSubmit={save}>
        <div className="field">
          <label htmlFor="nt-type">Task</label>
          <select id="nt-type" className="select" value={type} onChange={(e) => { setType(e.target.value); setRecord(null); }}>
            {Object.entries(TASK_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label} ({MODE_LABELS[v.mode]})</option>)}
          </select>
          {modeOff && <div className="text-warning text-sm mt-2"><FiAlertTriangle /> {MODE_LABELS[def.mode]} mode is disabled. The task will wait until you enable it.</div>}
        </div>
        {def.needs && <RecordPicker kind={def.needs} value={record} onChange={setRecord} />}
        {type === 'strategy_review' && (
          <div className="field"><label htmlFor="nt-topic">What should the agent look at?</label><textarea id="nt-topic" className="input" rows={3} maxLength={2000} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Which industries in our leads respond best to booking-system offers?" /></div>
        )}
        {type === 'competitor_research' && (
          <div className="grid-2">
            <div className="field"><label htmlFor="nt-comp">Competitor name</label><input id="nt-comp" className="input" maxLength={120} value={competitor.name} onChange={(e) => setCompetitor({ ...competitor, name: e.target.value })} /></div>
            <div className="field"><label htmlFor="nt-site">Website (optional)</label><input id="nt-site" className="input" type="url" maxLength={300} value={competitor.website} onChange={(e) => setCompetitor({ ...competitor, website: e.target.value })} placeholder="https://" /></div>
          </div>
        )}
        <div className="grid-2">
          <div className="field">
            <label htmlFor="nt-prio">Priority</label>
            <select id="nt-prio" className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((p) => <option key={p} value={p}>{p}{p === 1 ? ' (highest)' : p === 10 ? ' (lowest)' : ''}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="nt-title">Title (optional)</label><input id="nt-title" className="input" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
        </div>
        <button className="btn btn-primary btn-block" disabled={!valid || busy}>Queue task</button>
      </form>
    </Modal>
  );
}

function TaskDetail({ id, onClose, onChanged }) {
  const { data, loading, error, reload } = useApi(() => agentApi.task(id), [id]);
  const t = data?.task;
  return (
    <Modal open size="lg" onClose={onClose} title={`Task #${id}`} footer={t && <TaskActions task={t} onDone={() => { reload(); onChanged(); }} />}>
      {loading && !data ? <Loader /> : error ? <ErrorBox message={error} onRetry={reload} /> : (
        <>
          <dl className="def-list">
            <dt>Title</dt><dd className="cell-strong">{t.title}</dd>
            <dt>Status</dt><dd><span className={`badge ${STATUS_TONE[t.status]}`}>{titleCase(t.status)}</span></dd>
            <dt>Type · mode</dt><dd>{TASK_TYPES[t.type]?.label || t.type} · {MODE_LABELS[t.mode]}</dd>
            <dt>Record</dt><dd>{t.lead_id ? <Link to={`/leads/${t.lead_id}`}>LEAD-{t.lead_id}</Link> : null}{t.lead_id && t.company ? ' · ' : ''}{t.company ? <Link to={`/companies/${t.company.id}`}>{t.company.company_name}</Link> : !t.lead_id && '—'}</dd>
            <dt>Priority</dt><dd>{t.priority}</dd>
            <dt>Attempts</dt><dd>{t.attempts} / {t.max_attempts}</dd>
            <dt>Queued</dt><dd>{fmtIST(t.created_at)}</dd>
            <dt>Started</dt><dd>{t.started_at ? fmtIST(t.started_at) : '—'}</dd>
            <dt>Finished</dt><dd>{t.completed_at ? `${fmtIST(t.completed_at)} (${fmtDuration(t.duration_ms)})` : '—'}</dd>
            {t.status === 'PENDING' && new Date(t.available_at) > new Date() && (<><dt>Next attempt</dt><dd>{fmtIST(t.available_at)}</dd></>)}
            {t.status === 'RUNNING' && (<><dt>Time limit</dt><dd>{fmtIST(t.lease_expires_at)}</dd></>)}
          </dl>
          {t.error && <div className="error-box mt-2">{t.error}</div>}
          {t.input && (<><h4 className="section-title mt-4">Input</h4><pre className="detail-json">{json(t.input)}</pre></>)}
          {t.result && (<><h4 className="section-title mt-4">Result</h4><pre className="detail-json">{json(t.result)}</pre></>)}
          <h4 className="section-title mt-4">Execution log</h4>
          {data.activity.length ? (
            <div className="timeline">
              {data.activity.map((a) => (
                <div key={a.id} className="timeline-item">
                  <div className="text-sm"><span className={`badge ${ACTIVITY_STATUS_TONE[a.status] || 'gray'}`}>{ACTIVITY_LABELS[a.type] || a.type}</span> {a.action}</div>
                  <div className="cell-sub">{fmtIST(a.created_at)}{a.duration_ms != null ? ` · ${fmtDuration(a.duration_ms)}` : ''}</div>
                  {a.error && <div className="text-danger text-sm">{a.error}</div>}
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-muted">No log entries.</p>}
        </>
      )}
    </Modal>
  );
}

function TaskActions({ task, onDone }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (action) => {
    if (action === 'cancel' && task.status === 'RUNNING' && !window.confirm('Cancel a running task? Claude Code may be working on it right now; its result will be rejected.')) return;
    setBusy(true);
    try {
      await agentApi.taskAction(task.id, action);
      toast.success(`Task ${DONE_LABELS[action]}`);
      onDone();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex gap-2">
      {(TASK_ACTIONS[task.status] || []).map((a) => (
        <button key={a} className={`btn btn-sm ${a === 'cancel' ? 'btn-danger' : ''}`} disabled={busy} onClick={() => act(a)} title={titleCase(a)}>{ACTION_ICONS[a]} {titleCase(a)}</button>
      ))}
    </div>
  );
}

function Tasks({ overview, onChanged, openTask }) {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const q = usePolled(() => agentApi.tasks({ status, page, limit: 25 }), [status, page]);
  const refresh = () => {
    q.reload();
    onChanged();
  };
  const counts = overview.tasks;
  return (
    <>
      <div className="flex justify-between items-center gap-3 mb-3" style={{ flexWrap: 'wrap' }}>
        <div className="chip-row">
          <button type="button" className={`chip ${!status ? 'active' : ''}`} onClick={() => { setStatus(''); setPage(1); }}>All</button>
          {STATUSES.map((s) => (
            <button type="button" key={s} className={`chip ${status === s ? 'active' : ''}`} onClick={() => { setStatus(s); setPage(1); }}>{titleCase(s)} · {counts[s]}</button>
          ))}
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}><FiPlus /> New task</button>
      </div>
      <Card bodyClass="">
        {q.loading && !q.data ? <Loader /> : q.error ? <div className="card-pad"><ErrorBox message={q.error} onRetry={q.reload} /></div> : !q.data.items.length ? (
          <EmptyState icon={<FiList />} title={status ? `No ${titleCase(status).toLowerCase()} tasks` : 'No agent tasks yet'} message="Queue research, lead analysis, outreach drafts, strategy or report tasks for Claude Code." action={<button className="btn btn-primary" onClick={() => setCreating(true)}><FiPlus /> New task</button>} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>#</th><th>Task</th><th>Record</th><th>Priority</th><th>Status</th><th>Attempts</th><th>Updated</th><th></th></tr></thead>
                <tbody>
                  {q.data.items.map((t) => (
                    <tr key={t.id}>
                      <td className="text-sm">{t.id}</td>
                      <td>
                        <button className="link-btn cell-strong" onClick={() => openTask(t.id)}>{t.title}</button>
                        <div className="cell-sub">{MODE_LABELS[t.mode]}{t.error && t.status !== 'COMPLETED' ? ` · ${t.error}` : ''}</div>
                      </td>
                      <td className="text-sm">{t.company ? <Link to={`/companies/${t.company.id}`}>{t.company.company_name}</Link> : t.lead_id ? <Link to={`/leads/${t.lead_id}`}>LEAD-{t.lead_id}</Link> : '—'}</td>
                      <td>{t.priority}</td>
                      <td><span className={`badge ${STATUS_TONE[t.status]}`}>{titleCase(t.status)}</span></td>
                      <td className="text-sm">{t.attempts}/{t.max_attempts}</td>
                      <td className="text-sm nowrap">{fmtRelative(t.updated_at)}</td>
                      <td><TaskActions task={t} onDone={refresh} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={q.data.pagination} onChange={setPage} />
          </>
        )}
      </Card>
      {creating && <NewTask control={overview.control} onClose={() => setCreating(false)} onSaved={refresh} />}
    </>
  );
}

/* ---------------- activity ---------------- */

function ActivityTable({ items, openTask, compact, onFilter }) {
  if (!items.length) return <EmptyState icon={<FiActivity />} title="No activity yet" message="Everything the agent does appears here: every tool call, task step and connection change." />;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>Time</th><th>Type</th><th>Action</th>{!compact && <th>Record</th>}<th>Status</th><th>Duration</th></tr></thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td className="text-sm nowrap">{fmtIST(a.created_at)}</td>
              <td className="text-sm">{ACTIVITY_LABELS[a.type] || a.type}{a.tool && <div className="cell-sub">{a.tool}</div>}</td>
              <td className="text-sm">
                {a.task_id ? <button className="link-btn" onClick={() => openTask(a.task_id)}>{a.action}</button> : a.action}
                {a.error && <div className="text-danger text-sm">{a.error}</div>}
              </td>
              {!compact && (
                <td className="text-sm">
                  {a.company && <button className="link-btn" title="Show only this company" onClick={() => onFilter?.({ company_id: a.company.id, label: a.company.company_name })}>{a.company.company_name}</button>}
                  {a.lead_id && !a.company && <button className="link-btn" title="Show only this lead" onClick={() => onFilter?.({ lead_id: a.lead_id, label: `LEAD-${a.lead_id}` })}>LEAD-{a.lead_id}</button>}
                  {!a.company && !a.lead_id && '—'}
                </td>
              )}
              <td><span className={`badge ${ACTIVITY_STATUS_TONE[a.status] || 'gray'}`}>{titleCase(a.status)}</span></td>
              <td className="text-sm nowrap">{fmtDuration(a.duration_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Activity({ openTask }) {
  const [f, setF] = useState({ type: '', status: '', date_from: '', date_to: '', search: '' });
  const [record, setRecord] = useState(null); // { company_id | lead_id, label }
  const [page, setPage] = useState(1);
  const search = useDebounced(f.search);
  const params = {
    type: f.type,
    status: f.status,
    search,
    // Dates are whole days in the viewer's local time.
    date_from: f.date_from ? new Date(`${f.date_from}T00:00:00`).toISOString() : '',
    date_to: f.date_to ? new Date(`${f.date_to}T23:59:59.999`).toISOString() : '',
    company_id: record?.company_id,
    lead_id: record?.lead_id,
    page,
    limit: 50,
  };
  const q = usePolled(() => agentApi.activity(params), [JSON.stringify(params)]);
  const set = (k) => (e) => { setF({ ...f, [k]: e.target.value }); setPage(1); };

  return (
    <>
      <Card className="mb-3">
        <div className="filters">
          <div className="field"><label htmlFor="ac-search">Search</label><input id="ac-search" className="input" placeholder="Action text" value={f.search} onChange={set('search')} /></div>
          <div className="field">
            <label htmlFor="ac-type">Type</label>
            <select id="ac-type" className="select" value={f.type} onChange={set('type')}>
              <option value="">All types</option>
              {Object.entries(ACTIVITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="ac-status">Status</label>
            <select id="ac-status" className="select" value={f.status} onChange={set('status')}>
              <option value="">All</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
              <option value="denied">Denied</option>
            </select>
          </div>
          <div className="field"><label htmlFor="ac-from">From</label><input id="ac-from" className="input" type="date" value={f.date_from} onChange={set('date_from')} /></div>
          <div className="field"><label htmlFor="ac-to">To</label><input id="ac-to" className="input" type="date" value={f.date_to} onChange={set('date_to')} /></div>
          {record && (
            <div className="field"><label>Record</label><button type="button" className="chip active" onClick={() => { setRecord(null); setPage(1); }}>{record.label} <FiX style={{ verticalAlign: '-2px' }} /></button></div>
          )}
        </div>
        <p className="cell-sub mt-2">Tip: click a company or lead in the table to show only its activity.</p>
      </Card>
      <Card bodyClass="">
        {q.loading && !q.data ? <Loader /> : q.error ? <div className="card-pad"><ErrorBox message={q.error} onRetry={q.reload} /></div> : (
          <>
            <ActivityTable items={q.data.items} openTask={openTask} onFilter={(r) => { setRecord(r); setPage(1); }} />
            {q.data.items.length > 0 && <Pagination pagination={q.data.pagination} onChange={setPage} />}
          </>
        )}
      </Card>
    </>
  );
}

/* ---------------- research reports ---------------- */

const REPORT_KINDS = {
  company_research: 'Company research',
  lead_qualification: 'Lead qualification',
  strategy: 'Strategy',
  competitor: 'Competitor intelligence',
  daily: 'Daily report',
  weekly: 'Weekly report',
  prospecting: 'Prospecting report',
};
// Sections every company research report should have, in display order.
const REPORT_SECTIONS = [
  ['company_overview', 'Company overview'],
  ['potential_software_requirements', 'Potential software requirements'],
  ['website_observations', 'Website observations'],
  ['business_opportunities', 'Business opportunities'],
  ['recommended_next_action', 'Recommended next action'],
];
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const confidenceTone = (c) => (c >= 70 ? 'green' : c >= 40 ? 'warm' : 'hot');

function SectionValue({ value }) {
  if (value == null || value === '') return <p className="text-sm text-muted">Not reported.</p>;
  if (Array.isArray(value)) {
    if (!value.length) return <p className="text-sm text-muted">None found.</p>;
    return <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>{value.map((v, i) => <li key={i}>{typeof v === 'string' ? v : json(v)}</li>)}</ul>;
  }
  if (typeof value === 'object') return <pre className="detail-json">{json(value)}</pre>;
  return <p className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{String(value)}</p>;
}

function ReportDetail({ id, onClose }) {
  const { data: r, loading, error, reload } = useApi(() => agentApi.report(id), [id]);
  const c = r?.content || {};
  const contacts = Array.isArray(c.public_business_contacts) ? c.public_business_contacts : [];
  const known = new Set([...REPORT_SECTIONS.map(([k]) => k), 'public_business_contacts', 'lead_qualification', 'business_category']);
  const extra = Object.entries(c).filter(([k]) => !known.has(k));
  return (
    <Modal open size="lg" onClose={onClose} title={r ? r.title : `Report #${id}`}>
      {loading && !r ? <Loader /> : error ? <ErrorBox message={error} onRetry={reload} /> : (
        <>
          <dl className="def-list">
            <dt>Type</dt><dd>{REPORT_KINDS[r.kind]}</dd>
            {r.company && (<><dt>Company</dt><dd><Link to={`/companies/${r.company.id}`}>{r.company.company_name}</Link>{r.company.is_demo && <span className="badge demo"> DEMO</span>}</dd></>)}
            {r.company && (<><dt>Website</dt><dd>{safeUrl(r.company.website) ? <a href={r.company.website} target="_blank" rel="noopener noreferrer">{r.company.website}</a> : r.company.website || 'None on file'}</dd></>)}
            {(c.business_category || r.company) && (<><dt>Business category</dt><dd>{c.business_category || r.company?.company_category || r.company?.industry || '—'}</dd></>)}
            {r.lead_id && (<><dt>Lead</dt><dd><Link to={`/leads/${r.lead_id}`}>LEAD-{r.lead_id}</Link></dd></>)}
            <dt>Research date</dt><dd>{fmtIST(r.created_at)}</dd>
            <dt>Confidence</dt><dd><span className={`badge ${confidenceTone(r.confidence)}`}>{r.confidence}/100</span></dd>
            {r.ai_score != null && (<><dt>Claude's lead score</dt><dd><span className="badge blue">{r.ai_score}/100</span> <span className="cell-sub">Separate from LeadHunter's rule-based score</span></dd></>)}
            {r.task && (<><dt>Task</dt><dd>#{r.task.id} {r.task.title}</dd></>)}
          </dl>

          {r.summary && (<><h4 className="section-title mt-4">Summary</h4><p className="text-sm" style={{ whiteSpace: 'pre-wrap' }}>{r.summary}</p></>)}

          {['company_research', 'lead_qualification'].includes(r.kind) && REPORT_SECTIONS.map(([k, label]) => (
            <div key={k}><h4 className="section-title mt-4">{label}</h4><SectionValue value={c[k]} /></div>
          ))}

          {r.kind === 'company_research' && (
            <>
              <h4 className="section-title mt-4">Publicly available business contacts</h4>
              {contacts.length ? (
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th>Name / role</th><th>Channel</th><th>Value</th><th>Source</th></tr></thead>
                    <tbody>
                      {contacts.map((p, i) => (
                        <tr key={i}>
                          <td className="text-sm">{[p.name, p.role].filter(Boolean).join(' · ') || '—'}</td>
                          <td className="text-sm">{p.channel}</td>
                          <td className="text-sm">{p.value}</td>
                          <td className="text-sm">{safeUrl(p.source_url) ? <a href={p.source_url} target="_blank" rel="noopener noreferrer">source</a> : <span className="text-danger">no source</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-sm text-muted">None found.</p>}
            </>
          )}

          {c.lead_qualification && (
            <>
              <h4 className="section-title mt-4">Lead qualification</h4>
              <p className="text-sm cell-strong">{c.lead_qualification.verdict}</p>
              <SectionValue value={c.lead_qualification.reasons} />
            </>
          )}

          {extra.map(([k, v]) => (<div key={k}><h4 className="section-title mt-4">{titleCase(k)}</h4><SectionValue value={v} /></div>))}

          <h4 className="section-title mt-4">Source URLs</h4>
          {r.source_urls?.length ? (
            <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>
              {r.source_urls.map((u) => <li key={u}>{safeUrl(u) ? <a href={u} target="_blank" rel="noopener noreferrer">{u}</a> : u}</li>)}
            </ul>
          ) : <p className="text-sm text-warning"><FiAlertTriangle /> No sources cited. Treat this report as unverified.</p>}
        </>
      )}
    </Modal>
  );
}

function Reports() {
  const [kind, setKind] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(null);
  const dsearch = useDebounced(search);
  const q = usePolled(() => agentApi.reports({ kind, search: dsearch, page, limit: 25 }), [kind, dsearch, page]);
  return (
    <>
      <Card className="mb-3">
        <div className="filters">
          <div className="field"><label htmlFor="rp-search">Search titles</label><input id="rp-search" className="input" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="e.g. Sunrise" /></div>
          <div className="field">
            <label htmlFor="rp-kind">Type</label>
            <select id="rp-kind" className="select" value={kind} onChange={(e) => { setKind(e.target.value); setPage(1); }}>
              <option value="">All reports</option>
              {Object.entries(REPORT_KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
      </Card>
      <Card bodyClass="">
        {q.loading && !q.data ? <Loader /> : q.error ? <div className="card-pad"><ErrorBox message={q.error} onRetry={q.reload} /></div> : !q.data.items.length ? (
          <EmptyState icon={<FiFileText />} title="No reports yet" message="Reports appear here when Claude Code completes research, qualification, strategy, competitor or reporting tasks." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Report</th><th>Type</th><th>Company</th><th>Confidence</th><th>AI score</th><th>Date</th></tr></thead>
                <tbody>
                  {q.data.items.map((r) => (
                    <tr key={r.id}>
                      <td><button className="link-btn cell-strong" onClick={() => setOpen(r.id)}>{r.title}</button>{r.summary && <div className="cell-sub">{r.summary.slice(0, 120)}{r.summary.length > 120 ? '…' : ''}</div>}</td>
                      <td className="text-sm">{REPORT_KINDS[r.kind]}</td>
                      <td className="text-sm">{r.company ? <Link to={`/companies/${r.company.id}`}>{r.company.company_name}</Link> : '—'}</td>
                      <td><span className={`badge ${confidenceTone(r.confidence)}`}>{r.confidence}</span></td>
                      <td className="text-sm">{r.ai_score ?? '—'}</td>
                      <td className="text-sm nowrap">{fmtIST(r.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination pagination={q.data.pagination} onChange={setPage} />
          </>
        )}
      </Card>
      {open && <ReportDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/* ---------------- approvals ---------------- */

const CHANNEL_LABELS = { EMAIL: 'Cold email', FOLLOW_UP: 'Follow-up email', LINKEDIN: 'LinkedIn message', PROPOSAL: 'Business proposal' };
const DRAFT_TONE = { PENDING_APPROVAL: 'warm', APPROVED: 'green', REJECTED: 'not_qualified', DRAFT: 'gray' };

function DraftCard({ draft, onChanged }) {
  const toast = useToast();
  const [subject, setSubject] = useState(draft.subject || '');
  const [body, setBody] = useState(draft.body);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const editable = draft.status !== 'APPROVED';
  const dirty = subject !== (draft.subject || '') || body !== draft.body;
  const run = async (fn, msg) => {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${subject ? `Subject: ${subject}\n\n` : ''}${body}`);
      toast.success('Copied. Send it yourself from your own email or LinkedIn');
    } catch {
      toast.error('Copy failed. Select the text manually');
    }
  };
  return (
    <Card
      className="mb-3"
      title={<>{CHANNEL_LABELS[draft.channel] || draft.channel} · {draft.company ? <Link to={`/companies/${draft.company.id}`}>{draft.company.company_name}</Link> : `LEAD-${draft.lead_id}`}</>}
      actions={<span className={`badge ${DRAFT_TONE[draft.status]}`}>{titleCase(draft.status)}</span>}
    >
      {draft.channel !== 'LINKEDIN' && (
        <div className="field"><label htmlFor={`subj-${draft.id}`}>Subject</label><input id={`subj-${draft.id}`} className="input" maxLength={255} disabled={!editable} value={subject} onChange={(e) => setSubject(e.target.value)} /></div>
      )}
      <div className="field">
        <label htmlFor={`body-${draft.id}`}>Message</label>
        <textarea id={`body-${draft.id}`} className="input" rows={Math.min(16, Math.max(5, body.split('\n').length + 1))} maxLength={20000} disabled={!editable} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      {draft.evidence?.length > 0 && (
        <div className="mb-3">
          <div className="section-title">Facts it relies on</div>
          <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>{draft.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </div>
      )}
      {draft.reviewed_at && <p className="cell-sub mb-3">{titleCase(draft.status)} by {draft.reviewedBy?.name || 'admin'} on {fmtIST(draft.reviewed_at)}{draft.review_note ? `: "${draft.review_note}"` : ''}</p>}
      <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
        {editable && dirty && <button className="btn" disabled={busy || !body.trim()} onClick={() => run(() => agentApi.editDraft(draft.id, { subject: subject || null, body }), 'Draft saved')}>Save edits</button>}
        {draft.status !== 'APPROVED' && <input className="input" style={{ maxWidth: 260 }} placeholder="Note (optional)" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Review note" />}
        {draft.status !== 'APPROVED' && <button className="btn btn-primary" disabled={busy || dirty} title={dirty ? 'Save your edits first' : undefined} onClick={() => run(() => agentApi.decideDraft(draft.id, 'approve', note), 'Approved. Nothing was sent')}><FiCheckCircle /> Approve</button>}
        {draft.status !== 'REJECTED' && <button className="btn btn-danger" disabled={busy} onClick={() => run(() => agentApi.decideDraft(draft.id, 'reject', note), 'Rejected')}><FiX /> Reject</button>}
        {draft.status === 'APPROVED' && <button className="btn" onClick={copy}><FiCopy /> Copy to send</button>}
      </div>
    </Card>
  );
}

function ProposalRow({ task, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const i = task.input || {};
  const decide = async (decision) => {
    setBusy(true);
    try {
      await agentApi.decideProposal(task.id, decision);
      toast.success(decision === 'approve' ? 'Applied to the lead' : 'Rejected. The lead is unchanged');
      onChanged();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr>
      <td>{task.lead_id ? <Link to={`/leads/${task.lead_id}`}>LEAD-{task.lead_id}</Link> : '—'}<div className="cell-sub">{task.company?.company_name}</div></td>
      <td className="text-sm">{i.field === 'status' ? 'Pipeline status' : 'Qualification'}: <strong>{titleCase(i.from || '—')}</strong> → <strong>{titleCase(i.value || '')}</strong></td>
      <td className="text-sm" style={{ maxWidth: 420 }}>{i.reason}</td>
      <td className="text-sm nowrap">{fmtRelative(task.created_at)}</td>
      <td>
        <div className="flex gap-2">
          <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => decide('approve')}>Approve</button>
          <button className="btn btn-sm btn-danger" disabled={busy} onClick={() => decide('reject')}>Reject</button>
        </div>
      </td>
    </tr>
  );
}

function Approvals({ onChanged }) {
  const [status, setStatus] = useState('PENDING_APPROVAL');
  const [page, setPage] = useState(1);
  const drafts = usePolled(() => agentApi.drafts({ status, page, limit: 10 }), [status, page]);
  const proposals = usePolled(() => agentApi.tasks({ status: 'AWAITING_APPROVAL', limit: 50 }), []);
  const refresh = () => {
    drafts.reload();
    proposals.reload();
    onChanged();
  };
  return (
    <>
      <div className="tracking-note mb-3">Approving marks a draft ready. <strong>Nothing is ever sent by LeadHunter or Claude</strong>: copy an approved draft and send it yourself. Approved lead changes are applied through the normal lead update, with history.</div>

      <Card title="Lead status proposals" bodyClass="" className="mb-3">
        {proposals.loading && !proposals.data ? <Loader /> : proposals.error ? <div className="card-pad"><ErrorBox message={proposals.error} onRetry={proposals.reload} /></div> : !proposals.data.items.length ? (
          <div className="card-pad text-sm text-muted">No proposals waiting.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Lead</th><th>Change</th><th>Claude's reason</th><th>Proposed</th><th></th></tr></thead>
              <tbody>{proposals.data.items.map((t) => <ProposalRow key={t.id} task={t} onChanged={refresh} />)}</tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="flex justify-between items-center gap-3 mb-3" style={{ flexWrap: 'wrap' }}>
        <h3 className="section-title" style={{ margin: 0 }}>Outreach drafts</h3>
        <div className="chip-row">
          {[['PENDING_APPROVAL', 'Pending'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['', 'All']].map(([k, v]) => (
            <button type="button" key={v} className={`chip ${status === k ? 'active' : ''}`} onClick={() => { setStatus(k); setPage(1); }}>{v}</button>
          ))}
        </div>
      </div>
      {drafts.loading && !drafts.data ? <Loader /> : drafts.error ? <ErrorBox message={drafts.error} onRetry={drafts.reload} /> : !drafts.data.items.length ? (
        <Card><EmptyState icon={<FiMail />} title={status === 'PENDING_APPROVAL' ? 'Nothing to approve' : 'No drafts'} message="Cold emails, follow-ups, LinkedIn messages and proposals written by Claude appear here for review." /></Card>
      ) : (
        <>
          {drafts.data.items.map((d) => <DraftCard key={`${d.id}-${d.updated_at}`} draft={d} onChanged={refresh} />)}
          <Pagination pagination={drafts.data.pagination} onChange={setPage} />
        </>
      )}
    </>
  );
}

/* ---------------- analytics ---------------- */

const PRESETS = [[7, '7 days'], [30, '30 days'], [90, '90 days']];
const isoDay = (d) => d.toLocaleDateString('en-CA');

function Analytics() {
  const [range, setRange] = useState({ from: isoDay(new Date(Date.now() - 29 * 86400000)), to: isoDay(new Date()) });
  const params = { from: new Date(`${range.from}T00:00:00`).toISOString(), to: new Date(`${range.to}T23:59:59.999`).toISOString() };
  const q = useApi(() => agentApi.analytics(params), [range.from, range.to]);
  const history = useApi(() => agentApi.tasks({ status: 'COMPLETED,FAILED', limit: 30 }), []);
  // Proposals are admin decisions, not work runs.
  const runs = (history.data?.items || []).filter((x) => x.type !== 'lead_change_proposal').slice(0, 15);
  const preset = (days) => setRange({ from: isoDay(new Date(Date.now() - (days - 1) * 86400000)), to: isoDay(new Date()) });
  const t = q.data?.totals;
  const pct = (v) => (v == null ? '—' : `${v}%`);
  return (
    <>
      <Card className="mb-3">
        <div className="filters">
          <div className="field"><label>Range</label><div className="chip-row">{PRESETS.map(([d, l]) => <button type="button" key={d} className="chip" onClick={() => preset(d)}>{l}</button>)}</div></div>
          <div className="field"><label htmlFor="an-from">From</label><input id="an-from" className="input" type="date" value={range.from} max={range.to} onChange={(e) => e.target.value && setRange({ ...range, from: e.target.value })} /></div>
          <div className="field"><label htmlFor="an-to">To</label><input id="an-to" className="input" type="date" value={range.to} min={range.from} onChange={(e) => e.target.value && setRange({ ...range, to: e.target.value })} /></div>
        </div>
      </Card>
      {q.loading && !q.data ? <Loader /> : q.error ? <ErrorBox message={q.error} onRetry={q.reload} /> : (
        <>
          <div className="grid stat-grid mb-3">
            <Stat label="Leads analysed" icon={<FiTarget />} value={fmtNumber(t.leads_analysed)} />
            <Stat label="Companies researched" icon={<FiBriefcase />} value={fmtNumber(t.companies_researched)} />
            <Stat label="Qualified leads" icon={<FiCheckCircle />} value={fmtNumber(t.qualified_leads)} sub={`Claude's score ≥ ${q.data.qualified_threshold}`} />
            <Stat label="Average AI score" value={t.average_ai_score ?? '—'} sub="Across lead qualification reports" />
            <Stat label="Research success rate" value={pct(t.research_success_rate)} sub="Completed ÷ (completed + failed)" />
            <Stat label="Failed tasks" icon={<FiAlertTriangle />} value={fmtNumber(t.failed_tasks)} sub={`${fmtNumber(t.completed_tasks)} completed`} />
            <Stat label="Outreach drafts" icon={<FiMail />} value={fmtNumber(t.outreach_drafts)} sub={Object.entries(t.outreach_by_status).map(([k, v]) => `${v} ${titleCase(k).toLowerCase()}`).join(' · ') || undefined} />
            <Stat label="Average task time" icon={<FiClock />} value={fmtDuration(t.average_duration_ms)} />
          </div>
          <div className="grid chart-grid mb-3">
            <Card title="Work per day">
              <div className="chart-box">
                <MultiLineChartBox data={q.data.series} xKey="date" series={[{ key: 'leads_analysed', name: 'Leads analysed' }, { key: 'companies_researched', name: 'Companies researched' }, { key: 'outreach_drafts', name: 'Outreach drafts' }]} />
              </div>
            </Card>
            <Card title="Task outcomes per day">
              <div className="chart-box">
                <MultiLineChartBox data={q.data.series} xKey="date" series={[{ key: 'completed', name: 'Completed', color: '#10b981' }, { key: 'failed', name: 'Failed', color: '#ef4444' }, { key: 'reports', name: 'Reports saved', color: '#6366f1' }]} />
              </div>
            </Card>
          </div>
        </>
      )}
      <Card title="Task execution history" bodyClass="">
        {history.loading && !history.data ? <Loader /> : history.error ? <div className="card-pad"><ErrorBox message={history.error} onRetry={history.reload} /></div> : !runs.length ? (
          <div className="card-pad text-sm text-muted">No finished tasks yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Task</th><th>Status</th><th>Attempts</th><th>Duration</th><th>Finished</th></tr></thead>
              <tbody>
                {runs.map((x) => (
                  <tr key={x.id}>
                    <td className="text-sm">{x.title}<div className="cell-sub">{MODE_LABELS[x.mode]}{x.error ? ` · ${x.error}` : ''}</div></td>
                    <td><span className={`badge ${STATUS_TONE[x.status]}`}>{titleCase(x.status)}</span></td>
                    <td className="text-sm">{x.attempts}/{x.max_attempts}</td>
                    <td className="text-sm">{fmtDuration(x.duration_ms)}</td>
                    <td className="text-sm nowrap">{x.completed_at ? fmtIST(x.completed_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

/* ---------------- settings ---------------- */

const toList = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

function Settings({ overview, onChanged }) {
  const toast = useToast();
  const { data, loading, error, reload } = useApi(() => agentApi.config(), []);
  const [f, setF] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (data) setF({ ...data, target_industries: data.target_industries.join(', '), target_locations: data.target_locations.join(', ') });
  }, [data]);
  if (loading && !data) return <Loader />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!f) return null;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      await agentApi.updateConfig({
        research_preferences: f.research_preferences,
        research_priorities: f.research_priorities,
        target_industries: toList(f.target_industries),
        target_locations: toList(f.target_locations),
        min_lead_score: Number(f.min_lead_score),
        daily_task_limit: Number(f.daily_task_limit),
        auto_research_per_day: Number(f.auto_research_per_day),
        schedules: f.schedules,
      });
      toast.success('Settings saved');
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };
  const sched = (k) => (e) => setF({ ...f, schedules: { ...f.schedules, [k]: e.target.checked } });
  return (
    <form onSubmit={save}>
      <div className="grid chart-grid mb-3">
        <Card title="Research">
          <div className="field"><label htmlFor="rp">Research preferences</label><textarea id="rp" className="input" rows={3} maxLength={2000} value={f.research_preferences} onChange={set('research_preferences')} placeholder="e.g. Prefer businesses with an online booking need; skip franchises." /></div>
          <div className="field"><label htmlFor="rpr">Research priorities</label><textarea id="rpr" className="input" rows={3} maxLength={2000} value={f.research_priorities} onChange={set('research_priorities')} placeholder="e.g. Clinics first, then hotels." /></div>
          <p className="cell-sub">Claude reads these with every task (via get_agent_status).</p>
        </Card>
        <Card title="Targeting">
          <div className="field"><label htmlFor="ti">Target industries (comma separated)</label><input id="ti" className="input" value={f.target_industries} onChange={set('target_industries')} placeholder="Healthcare, Hospitality" /></div>
          <div className="field"><label htmlFor="tl">Target locations: cities or states (comma separated)</label><input id="tl" className="input" value={f.target_locations} onChange={set('target_locations')} placeholder="Ahmedabad, Gujarat" /></div>
          <div className="grid-2">
            <div className="field"><label htmlFor="ms">Minimum lead score</label><input id="ms" className="input" type="number" min={0} max={100} required value={f.min_lead_score} onChange={set('min_lead_score')} /></div>
            <div className="field"><label htmlFor="dl">Daily task limit (per 24 h)</label><input id="dl" className="input" type="number" min={1} max={1000} required value={f.daily_task_limit} onChange={set('daily_task_limit')} /></div>
          </div>
        </Card>
        <Card title="Automation schedules">
          <p className="text-sm text-muted mb-3">Scheduled tasks are queued when Claude Code asks for work, so they only appear while a session is connected and the agent is running.</p>
          <label className="flex items-center gap-2 text-sm mb-3"><input type="checkbox" checked={f.schedules.daily_report} onChange={sched('daily_report')} /> Daily report (once per day)</label>
          <label className="flex items-center gap-2 text-sm mb-3"><input type="checkbox" checked={f.schedules.weekly_report} onChange={sched('weekly_report')} /> Weekly report (once per week, from Monday)</label>
          <label className="flex items-center gap-2 text-sm mb-3"><input type="checkbox" checked={f.schedules.auto_research_new_leads} onChange={sched('auto_research_new_leads')} /> Research new leads automatically (last 7 days, at or above the minimum score, matching the targets)</label>
          <div className="field"><label htmlFor="ar">Automatic research per 24 h</label><input id="ar" className="input" type="number" min={1} max={100} required value={f.auto_research_per_day} onChange={set('auto_research_per_day')} /></div>
        </Card>
        <Card title="Approval requirements">
          <ul className="text-sm" style={{ margin: 0, paddingLeft: 18 }}>
            <li>Outreach drafts (emails, follow-ups, LinkedIn messages, proposals): <strong>always need approval</strong>.</li>
            <li>Lead pipeline status and qualification changes: <strong>always need approval</strong>.</li>
            <li>Sending messages: <strong>never automatic</strong>. Approved drafts are sent by a person.</li>
            <li>Notes, follow-up reminders and research reports: saved directly and marked as AI-written.</li>
          </ul>
          <p className="cell-sub mt-2">These rules are fixed for safety and can't be relaxed from the dashboard.</p>
        </Card>
      </div>
      <ModesCard control={overview.control} onChanged={onChanged} />
      <div className="flex gap-2 mt-4"><button className="btn btn-primary" disabled={busy}>Save settings</button></div>
    </form>
  );
}

/* ---------------- page ---------------- */

const TABS = [
  ['overview', 'Overview'],
  ['connection', 'Connection'],
  ['tasks', 'Task Manager'],
  ['activity', 'Activity Log'],
  ['reports', 'Research Reports'],
  ['approvals', 'Approvals'],
  ['analytics', 'Analytics'],
  ['settings', 'Settings'],
];

export default function AIAgent() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'overview';
  const [taskId, setTaskId] = useState(null);
  const { data: overview, loading, error, reload } = usePolled(() => agentApi.overview(), []);

  if (loading && !overview) return <Loader label="Loading AI Agent…" />;
  if (error && !overview) return <div className="page"><ErrorBox message={error} onRetry={reload} /></div>;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>AI Agent</h1>
          <p>
            Claude Code, connected over MCP · <ConnectionBadge connection={overview.connection} />{' '}
            <span className={`badge ${STATE_TONE[overview.control.state]}`}>Agent {overview.control.state}</span>
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <button className="btn btn-ghost" onClick={reload} title="Refresh now" aria-label="Refresh"><FiRefreshCw /></button>
          <Controls overview={overview} onChanged={reload} />
        </div>
      </div>

      {error && <div className="mb-3"><ErrorBox message={`Couldn't refresh: ${error}`} onRetry={reload} /></div>}

      <div className="tabs" role="tablist" style={{ overflowX: 'auto' }}>
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab nowrap ${tab === k ? 'active' : ''}`} onClick={() => setParams({ tab: k }, { replace: true })}>
            {label}
            {k === 'approvals' && overview.pending_approvals.total > 0 && <span className="badge warm" style={{ marginLeft: 6 }}>{overview.pending_approvals.total}</span>}
          </button>
        ))}
      </div>

      {tab === 'overview' && <Overview overview={overview} onChanged={reload} openTask={setTaskId} />}
      {tab === 'connection' && <Connection overview={overview} onChanged={reload} />}
      {tab === 'tasks' && <Tasks overview={overview} onChanged={reload} openTask={setTaskId} />}
      {tab === 'activity' && <Activity openTask={setTaskId} />}
      {tab === 'reports' && <Reports />}
      {tab === 'approvals' && <Approvals onChanged={reload} />}
      {tab === 'analytics' && <Analytics />}
      {tab === 'settings' && <Settings overview={overview} onChanged={reload} />}

      {taskId && <TaskDetail id={taskId} onClose={() => setTaskId(null)} onChanged={reload} />}
    </div>
  );
}
