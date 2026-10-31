import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  FiCommand, FiPlay, FiPause, FiSquare, FiPlus, FiRefreshCw, FiX, FiRotateCcw, FiWifi, FiWifiOff,
  FiKey, FiCopy, FiActivity, FiCheckCircle, FiAlertTriangle, FiClock, FiList, FiTarget, FiBriefcase, FiMail, FiInbox,
} from 'react-icons/fi';
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
  useEffect(() => {
    const t = setInterval(() => {
      if (document.hidden) return;
      fnRef.current().then((d) => { q.setData(d); setPollError(null); }, (e) => setPollError(e.message || 'Refresh failed'));
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
  const toggle = async (m) => {
    const next = control.enabled_modes.includes(m) ? control.enabled_modes.filter((x) => x !== m) : [...control.enabled_modes, m];
    try {
      await agentApi.control('modes', { enabled_modes: next });
      onChanged();
    } catch (e) {
      toast.error(e.message);
    }
  };
  return (
    <Card title="Enabled modes">
      <p className="text-sm text-muted mb-3">The agent only picks up tasks whose mode is enabled. Tasks in a disabled mode stay queued.</p>
      <div className="chip-row">
        {Object.entries(MODE_LABELS).map(([k, v]) => (
          <button key={k} type="button" className={`chip ${control.enabled_modes.includes(k) ? 'active' : ''}`} aria-pressed={control.enabled_modes.includes(k)} onClick={() => toggle(k)}>{v}</button>
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
        <Stat label="Pending approvals" icon={<FiInbox />} value={fmtNumber(tasks.AWAITING_APPROVAL)} />
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
    try {
      await agentApi.revokeToken();
      toast.success('Token revoked');
      onChanged();
    } catch (e) {
      toast.error(e.message);
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
            {overview.token && <button className="btn btn-danger" onClick={revoke}>Revoke</button>}
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
      <label>{kind === 'lead' ? 'Lead' : 'Company'}</label>
      <input className="input" placeholder="Type 2+ letters of the company name" value={q} onChange={(e) => setQ(e.target.value)} />
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
          <label>Task</label>
          <select className="select" value={type} onChange={(e) => { setType(e.target.value); setRecord(null); }}>
            {Object.entries(TASK_TYPES).map(([k, v]) => <option key={k} value={k}>{v.label} ({MODE_LABELS[v.mode]})</option>)}
          </select>
          {modeOff && <div className="text-warning text-sm mt-2"><FiAlertTriangle /> {MODE_LABELS[def.mode]} mode is disabled. The task will wait until you enable it.</div>}
        </div>
        {def.needs && <RecordPicker kind={def.needs} value={record} onChange={setRecord} />}
        {type === 'strategy_review' && (
          <div className="field"><label>What should the agent look at?</label><textarea className="input" rows={3} maxLength={2000} value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Which industries in our leads respond best to booking-system offers?" /></div>
        )}
        {type === 'competitor_research' && (
          <div className="grid-2">
            <div className="field"><label>Competitor name</label><input className="input" maxLength={120} value={competitor.name} onChange={(e) => setCompetitor({ ...competitor, name: e.target.value })} /></div>
            <div className="field"><label>Website (optional)</label><input className="input" type="url" maxLength={300} value={competitor.website} onChange={(e) => setCompetitor({ ...competitor, website: e.target.value })} placeholder="https://" /></div>
          </div>
        )}
        <div className="grid-2">
          <div className="field">
            <label>Priority</label>
            <select className="select" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((p) => <option key={p} value={p}>{p}{p === 1 ? ' (highest)' : p === 10 ? ' (lowest)' : ''}</option>)}
            </select>
          </div>
          <div className="field"><label>Title (optional)</label><input className="input" maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
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
          <div className="field"><label>Search</label><input className="input" placeholder="Action text" value={f.search} onChange={set('search')} /></div>
          <div className="field">
            <label>Type</label>
            <select className="select" value={f.type} onChange={set('type')}>
              <option value="">All types</option>
              {Object.entries(ACTIVITY_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Status</label>
            <select className="select" value={f.status} onChange={set('status')}>
              <option value="">All</option>
              <option value="success">Success</option>
              <option value="failure">Failure</option>
              <option value="denied">Denied</option>
            </select>
          </div>
          <div className="field"><label>From</label><input className="input" type="date" value={f.date_from} onChange={set('date_from')} /></div>
          <div className="field"><label>To</label><input className="input" type="date" value={f.date_to} onChange={set('date_to')} /></div>
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

/* ---------------- page ---------------- */

const TABS = [
  ['overview', 'Overview'],
  ['connection', 'Connection'],
  ['tasks', 'Task Manager'],
  ['activity', 'Activity Log'],
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

      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`tab ${tab === k ? 'active' : ''}`} onClick={() => setParams({ tab: k }, { replace: true })}>{label}</button>
        ))}
      </div>

      {tab === 'overview' && <Overview overview={overview} onChanged={reload} openTask={setTaskId} />}
      {tab === 'connection' && <Connection overview={overview} onChanged={reload} />}
      {tab === 'tasks' && <Tasks overview={overview} onChanged={reload} openTask={setTaskId} />}
      {tab === 'activity' && <Activity openTask={setTaskId} />}

      {taskId && <TaskDetail id={taskId} onClose={() => setTaskId(null)} onChanged={reload} />}
    </div>
  );
}
