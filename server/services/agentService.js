/**
 * Claude Code agent: control state, connection heartbeat, agent token, the
 * persistent task queue and the activity feed.
 *
 * There is no in-memory state here — everything lives in the database, so a
 * server restart (or Render sleeping) loses nothing: pending tasks stay pending
 * and a task whose session died is returned to the queue when its lease expires.
 *
 * State lives in three separate `settings` rows so writers never overwrite each other:
 *   agent.control   — running/paused/stopped + enabled modes (admin actions only)
 *   agent.heartbeat — last heartbeat from the MCP server (agent only)
 *   agent.token     — sha256 of the active agent token + the admin it acts as
 */
const crypto = require('crypto');
const { Op } = require('sequelize');
const { sequelize, Setting, User, Company, AgentTask, AgentActivity } = require('../models');
const { can } = require('../config/permissions');
const { scrub } = require('./auditService');
const access = require('./accessService');
const ApiError = require('../utils/ApiError');

const KEYS = { control: 'agent.control', heartbeat: 'agent.heartbeat', token: 'agent.token' };
const TOKEN_PREFIX = 'lh_agent_';
const STALE_SECONDS = () => parseInt(process.env.AGENT_HEARTBEAT_STALE_SECONDS || '120', 10);
const LEASE_MINUTES = () => parseInt(process.env.AGENT_TASK_TIMEOUT_MINUTES || '30', 10);

const MODES = AgentTask.MODES;
// type -> { mode, needs }. `needs` is the record the task must point at.
const TASK_TYPES = {
  research_company: { mode: 'research', needs: 'company', label: 'Research' },
  analyse_lead: { mode: 'lead_analyst', needs: 'lead', label: 'Analyse lead' },
  generate_outreach: { mode: 'sales', needs: 'lead', label: 'Draft outreach for' },
  strategy_review: { mode: 'strategy', needs: null, label: 'Strategy review' },
  competitor_research: { mode: 'competitor', needs: null, label: 'Competitor research' },
  daily_report: { mode: 'reporting', needs: null, label: 'Daily report' },
  weekly_report: { mode: 'reporting', needs: null, label: 'Weekly report' },
};

/* ---------------- settings rows ---------------- */

async function getRow(key, fallback) {
  const row = await Setting.findOne({ where: { key } });
  return { ...fallback, ...(row?.value || {}) };
}
const putRow = (key, value, description) => Setting.upsert({ key, value, description });

const getControl = () => getRow(KEYS.control, { state: 'stopped', enabled_modes: MODES, changed_at: null, changed_by_user_id: null });

/* ---------------- activity ---------------- */

/** Append to the activity feed. Never throws: a feed write must not break the agent's work. */
async function logActivity(a) {
  try {
    await AgentActivity.create({
      type: a.type,
      tool: a.tool ? String(a.tool).slice(0, 60) : null,
      action: String(a.action || a.type).slice(0, 255),
      status: a.status || 'success',
      duration_ms: a.durationMs ?? null,
      error: a.error ? String(a.error).slice(0, 1000) : null,
      task_id: a.taskId ?? null,
      lead_id: a.leadId ?? null,
      company_id: a.companyId ?? null,
      session_id: a.sessionId ? String(a.sessionId).slice(0, 64) : null,
      metadata: scrub(a.metadata),
    });
  } catch (err) {
    console.error('[agent] activity log write failed:', err.message);
  }
}

/* ---------------- token ---------------- */

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const isAgentToken = (t) => typeof t === 'string' && t.startsWith(TOKEN_PREFIX);

async function issueToken(user) {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  await putRow(KEYS.token, { hash: hashToken(token), user_id: user.id, issued_at: new Date().toISOString(), last4: token.slice(-4) }, 'Claude Code agent token (hash only)');
  return token;
}

/** Revoking also ends the current session's Connected status at once (its requests now get 401). */
async function revokeToken() {
  await Setting.destroy({ where: { key: KEYS.token } });
  const hb = await getRow(KEYS.heartbeat, {});
  if (hb.session_id && !hb.disconnected_at) await putRow(KEYS.heartbeat, { ...hb, disconnected_at: new Date().toISOString(), disconnect_reason: 'agent token revoked', current_task_id: null }, 'Claude Code agent heartbeat');
}

/** The admin an agent token acts as, or null. The admin must still be active and allowed to run the agent. */
async function userForToken(token) {
  const row = await Setting.findOne({ where: { key: KEYS.token } });
  const stored = row?.value?.hash;
  if (!stored) return null;
  const a = Buffer.from(hashToken(token), 'hex');
  const b = Buffer.from(stored, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const user = await User.findByPk(row.value.user_id);
  if (!user || !user.is_active || !can(user, 'agent.manage')) return null;
  // A password change (e.g. after a compromise) kills the agent token too. Logout doesn't —
  // it revokes the admin's browser sessions, not the agent's.
  if (user.password_changed_at && user.password_changed_at > new Date(row.value.issued_at)) return null;
  return user;
}

/**
 * What an agent token may call (path relative to /api). Everything else is refused
 * even though the token acts as an admin — no user management, deletes, exports or reveals.
 */
const AGENT_ROUTES = [
  ['GET', /^\/leads(\?|$)/],
  ['GET', /^\/leads\/\d+(\?|$)/],
  ['GET', /^\/companies(\?|$)/],
  ['GET', /^\/companies\/\d+(\?|$)/],
  ['GET', /^\/contacts(\?|$)/],
  ['GET', /^\/notes(\?|$)/],
  ['GET', /^\/tasks(\?|$)/],
  ['GET', /^\/automation\/(runs|status|monitor)(\/\d+)?(\?|$)/],
  ['GET', /^\/discovery\/stats(\?|$)/],
  ['GET', /^\/dashboard\/(stats|lead-generation|opportunities|daily-summary|automation-status)(\?|$)/],
  ['POST', /^\/notes$/],
  ['POST', /^\/tasks$/],
  ['POST', /^\/agent\/bridge\/(heartbeat|disconnect|tasks\/claim|tasks\/\d+\/(complete|fail))$/],
  ['GET', /^\/agent\/bridge\/status$/],
];
// Dot segments, encoded separators and backslashes are refused outright, so the regexes
// above only ever see the literal path Express will route.
const UNSAFE_PATH = /\/\.|%2e|%2f|%5c|\\/i;
const agentRouteAllowed = (method, path) => !UNSAFE_PATH.test(path) && AGENT_ROUTES.some(([m, re]) => m === method && re.test(path));

/* ---------------- heartbeat / connection ---------------- */

/**
 * Record a heartbeat from the MCP server. Logs `connected` when a new session
 * appears and `reconnected` after a gap, so disconnections show up in the feed
 * even though nothing runs server-side while the agent is away.
 */
async function heartbeat({ sessionId, client, currentTaskId }) {
  if (!sessionId) throw ApiError.badRequest('session_id is required');
  const prev = await getRow(KEYS.heartbeat, {});
  const now = new Date();
  const gapSec = prev.last_heartbeat_at ? (now - new Date(prev.last_heartbeat_at)) / 1000 : null;
  const newSession = prev.session_id !== sessionId;
  await putRow(
    KEYS.heartbeat,
    {
      session_id: sessionId,
      client: client ? String(client).slice(0, 120) : prev.client || null,
      connected_at: newSession || prev.disconnected_at || gapSec > STALE_SECONDS() ? now.toISOString() : prev.connected_at,
      last_heartbeat_at: now.toISOString(),
      current_task_id: currentTaskId ?? null,
      disconnected_at: null,
      disconnect_reason: null,
    },
    'Claude Code agent heartbeat'
  );
  if (newSession) {
    await logActivity({ type: 'connected', action: `Claude Code session connected${client ? ` (${client})` : ''}`, sessionId, metadata: { previous_session: prev.session_id || null } });
  } else if (prev.disconnected_at || gapSec > STALE_SECONDS()) {
    await logActivity({ type: 'reconnected', action: `Claude Code session reconnected after ${Math.round(gapSec / 60)} min without a heartbeat`, sessionId });
  }
}

/** The MCP server is shutting down (Claude Code closed). Shows Disconnected immediately instead of after the stale window. */
async function disconnect({ sessionId, reason }) {
  const prev = await getRow(KEYS.heartbeat, {});
  if (prev.session_id !== sessionId) return;
  await putRow(KEYS.heartbeat, { ...prev, disconnected_at: new Date().toISOString(), disconnect_reason: String(reason || 'session closed').slice(0, 200), current_task_id: null }, 'Claude Code agent heartbeat');
  await logActivity({ type: 'disconnected', action: `Claude Code session disconnected (${reason || 'session closed'})`, sessionId });
}

/** Connected = a heartbeat within the stale window and no explicit disconnect. Nothing else counts. */
function connectionFrom(hb) {
  const last = hb.last_heartbeat_at ? new Date(hb.last_heartbeat_at) : null;
  const ageSec = last ? Math.round((Date.now() - last) / 1000) : null;
  const connected = !!last && !hb.disconnected_at && ageSec <= STALE_SECONDS();
  let reason = null;
  if (!last) reason = 'No Claude Code session has ever connected.';
  else if (hb.disconnected_at) reason = `Session closed: ${hb.disconnect_reason || 'unknown'}.`;
  else if (!connected) reason = `No heartbeat for ${Math.round(ageSec / 60)} min — Claude Code is closed, the computer is off or offline.`;
  return {
    connected,
    session_id: hb.session_id || null,
    client: hb.client || null,
    connected_at: connected ? hb.connected_at : null,
    last_heartbeat_at: hb.last_heartbeat_at || null,
    heartbeat_age_seconds: ageSec,
    stale_after_seconds: STALE_SECONDS(),
    current_task_id: connected ? hb.current_task_id ?? null : null,
    reason,
  };
}

const getConnection = async () => connectionFrom(await getRow(KEYS.heartbeat, {}));

/* ---------------- control ---------------- */

/**
 * start/resume require a live Claude Code connection (a real heartbeat). stop/pause
 * only stop *new* claims; a task already running finishes (or times out) normally.
 */
async function setControl(action, user, { enabledModes } = {}) {
  const control = await getControl();
  const conn = await getConnection();
  const next = { ...control };
  if (action === 'start' || action === 'resume') {
    if (!conn.connected) throw ApiError.conflict(`Cannot ${action}: no Claude Code session is connected. ${conn.reason}`);
    if (action === 'resume' && control.state !== 'paused') throw ApiError.conflict('The agent is not paused');
    next.state = 'running';
  } else if (action === 'pause') {
    if (control.state !== 'running') throw ApiError.conflict('Only a running agent can be paused');
    next.state = 'paused';
  } else if (action === 'stop') {
    next.state = 'stopped';
  } else if (action === 'modes') {
    if (!Array.isArray(enabledModes) || !enabledModes.every((m) => MODES.includes(m))) throw ApiError.badRequest(`enabled_modes must be a subset of: ${MODES.join(', ')}`);
    next.enabled_modes = [...new Set(enabledModes)];
  } else {
    throw ApiError.badRequest('Unknown action');
  }
  next.changed_at = new Date().toISOString();
  next.changed_by_user_id = user.id;
  await putRow(KEYS.control, next, 'Claude Code agent control state');
  await logActivity({ type: 'control', action: action === 'modes' ? `Enabled modes set to: ${next.enabled_modes.join(', ') || 'none'}` : `Agent ${action} by ${user.name}`, metadata: { state: next.state } });
  return next;
}

/* ---------------- task queue ---------------- */

const clean = (t) => (t ? t.get({ plain: true }) : null);
const activeKey = (type, leadId, companyId, input) =>
  leadId || companyId ? `${type}:${leadId ? `lead:${leadId}` : `company:${companyId}`}` : `${type}:${crypto.createHash('sha1').update(JSON.stringify(input || {})).digest('hex')}`;

async function createTask({ type, priority = 5, leadId = null, companyId = null, title, input = null, maxAttempts = 3 }, user) {
  const def = TASK_TYPES[type];
  if (!def) throw ApiError.badRequest(`type must be one of: ${Object.keys(TASK_TYPES).join(', ')}`);
  if (def.needs === 'lead' && !leadId) throw ApiError.badRequest(`${type} needs a lead_id`);
  if (def.needs === 'company' && !companyId) throw ApiError.badRequest(`${type} needs a company_id`);
  const p = Number(priority);
  if (!Number.isInteger(p) || p < 1 || p > 10) throw ApiError.badRequest('priority must be an integer 1 (highest) to 10');
  const m = Number(maxAttempts);
  if (!Number.isInteger(m) || m < 1 || m > 10) throw ApiError.badRequest('max_attempts must be 1 to 10');
  if (input != null && (typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 20000)) throw ApiError.badRequest('input must be a JSON object under 20 KB');

  // Only real records: resolves through the same scope checks the rest of the API uses.
  if (leadId) {
    const lead = await access.loadAccessibleLead(user, leadId);
    companyId = companyId || lead.company_id;
  } else if (companyId) {
    await access.assertCompanyAccess(user, companyId);
  }
  // Default title names the record, e.g. "Research Sunrise Dental Clinic".
  let subject = input?.competitor || '';
  if (companyId) subject = (await Company.findByPk(companyId, { attributes: ['company_name'] }))?.company_name || `company #${companyId}`;
  const defaultTitle = [def.label, subject].filter(Boolean).join(' ');

  try {
    const task = await AgentTask.create({
      mode: def.mode,
      type,
      priority: p,
      lead_id: leadId,
      company_id: companyId,
      title: String(title || defaultTitle).slice(0, 200),
      input,
      max_attempts: m,
      created_by_user_id: user.id,
      dedupe_key: activeKey(type, leadId, companyId, input),
    });
    await logActivity({ type: 'task_created', action: `Task #${task.id} queued: ${task.title}`, taskId: task.id, leadId, companyId, metadata: { type, priority: p } });
    return clean(task);
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') throw ApiError.conflict('The same task is already queued or running');
    throw err;
  }
}

/** Running tasks whose lease ran out (session died or the work hung) go back to the queue, or fail when out of attempts. */
async function reapExpired() {
  const expired = await AgentTask.findAll({ where: { status: 'RUNNING', lease_expires_at: { [Op.lt]: new Date() } } });
  for (const t of expired) {
    const giveUp = t.attempts >= t.max_attempts;
    // eslint-disable-next-line no-await-in-loop
    const [n] = await AgentTask.update(
      giveUp
        ? { status: 'FAILED', error: 'Timed out (lease expired) — no attempts left', completed_at: new Date(), claimed_by_session: null, lease_expires_at: null, dedupe_key: null }
        : { status: 'PENDING', error: 'Previous attempt timed out', available_at: new Date(), claimed_by_session: null, lease_expires_at: null },
      { where: { id: t.id, status: 'RUNNING', lease_expires_at: { [Op.lt]: new Date() } } }
    );
    // eslint-disable-next-line no-await-in-loop
    if (n) await logActivity({ type: 'task_timeout', status: 'failure', action: `Task #${t.id} timed out — ${giveUp ? 'failed' : 'returned to queue'}`, taskId: t.id, leadId: t.lead_id, companyId: t.company_id, sessionId: t.claimed_by_session });
  }
  return expired.length;
}

/**
 * Hand the next eligible task to a session. The conditional UPDATE is the lock:
 * whichever session flips PENDING -> RUNNING first gets it; the other retries the next one.
 */
async function claimNext(sessionId) {
  if (!sessionId) throw ApiError.badRequest('session_id is required');
  const control = await getControl();
  if (control.state !== 'running') return { task: null, reason: `Agent is ${control.state} — an admin must start it from the AI Agent dashboard.` };
  await reapExpired();
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const next = await AgentTask.findOne({
      where: { status: 'PENDING', available_at: { [Op.lte]: new Date() }, mode: { [Op.in]: control.enabled_modes.length ? control.enabled_modes : ['__none__'] } },
      order: [['priority', 'ASC'], ['id', 'ASC']],
    });
    if (!next) return { task: null, reason: 'No pending tasks for the enabled modes.' };
    const now = new Date();
    // eslint-disable-next-line no-await-in-loop
    const [n] = await AgentTask.update(
      { status: 'RUNNING', claimed_by_session: sessionId, started_at: now, lease_expires_at: new Date(now.getTime() + LEASE_MINUTES() * 60000), attempts: sequelize.literal('attempts + 1') },
      { where: { id: next.id, status: 'PENDING' } }
    );
    if (n === 1) {
      // eslint-disable-next-line no-await-in-loop
      const task = await AgentTask.findByPk(next.id);
      // eslint-disable-next-line no-await-in-loop
      await logActivity({ type: 'task_claimed', action: `Task #${task.id} started (attempt ${task.attempts}/${task.max_attempts}): ${task.title}`, taskId: task.id, leadId: task.lead_id, companyId: task.company_id, sessionId });
      return { task: clean(task) };
    }
  }
  return { task: null, reason: 'Queue busy — try again.' };
}

async function ownedRunning(id, sessionId) {
  const task = await AgentTask.findByPk(id);
  if (!task) throw ApiError.notFound('Task not found');
  if (task.status !== 'RUNNING' || task.claimed_by_session !== sessionId) {
    throw ApiError.conflict(`Task #${id} is ${task.status}${task.status === 'RUNNING' ? ' under another session' : ''} — this session no longer owns it`);
  }
  return task;
}

async function completeTask(id, sessionId, result) {
  if (result != null && JSON.stringify(result).length > 200000) throw ApiError.badRequest('result is too large (max 200 KB)');
  const task = await ownedRunning(id, sessionId);
  const now = new Date();
  const [n] = await AgentTask.update(
    { status: 'COMPLETED', result: result ?? null, error: null, completed_at: now, duration_ms: now - task.started_at, claimed_by_session: null, lease_expires_at: null, dedupe_key: null },
    { where: { id, status: 'RUNNING', claimed_by_session: sessionId } }
  );
  if (!n) throw ApiError.conflict(`Task #${id} changed while finishing — not completed`);
  await logActivity({ type: 'task_completed', action: `Task #${id} completed: ${task.title}`, durationMs: now - task.started_at, taskId: id, leadId: task.lead_id, companyId: task.company_id, sessionId });
  return clean(await AgentTask.findByPk(id));
}

/** Retryable failures go back to the queue with exponential backoff (1, 2, 4… min) until max_attempts. */
async function failTask(id, sessionId, error, { retryable = true } = {}) {
  const task = await ownedRunning(id, sessionId);
  const now = new Date();
  const retry = retryable && task.attempts < task.max_attempts;
  const msg = String(error || 'Unknown error').slice(0, 1000);
  const [n] = await AgentTask.update(
    retry
      ? { status: 'PENDING', error: msg, available_at: new Date(now.getTime() + 2 ** (task.attempts - 1) * 60000), claimed_by_session: null, lease_expires_at: null }
      : { status: 'FAILED', error: msg, completed_at: now, duration_ms: now - task.started_at, claimed_by_session: null, lease_expires_at: null, dedupe_key: null },
    { where: { id, status: 'RUNNING', claimed_by_session: sessionId } }
  );
  if (!n) throw ApiError.conflict(`Task #${id} changed while failing — not updated`);
  await logActivity({ type: 'task_failed', status: 'failure', action: `Task #${id} failed${retry ? ' — will retry' : ''}: ${task.title}`, error: msg, durationMs: now - task.started_at, taskId: id, leadId: task.lead_id, companyId: task.company_id, sessionId });
  return clean(await AgentTask.findByPk(id));
}

// Admin transitions: allowed source statuses and the update to apply. Each is one conditional UPDATE.
const TRANSITIONS = {
  pause: { from: ['PENDING'], set: () => ({ status: 'PAUSED' }) },
  resume: { from: ['PAUSED'], set: () => ({ status: 'PENDING', available_at: new Date() }) },
  cancel: { from: ['PENDING', 'PAUSED', 'RUNNING', 'AWAITING_APPROVAL'], set: () => ({ status: 'CANCELLED', completed_at: new Date(), claimed_by_session: null, lease_expires_at: null, dedupe_key: null }) },
  retry: { from: ['FAILED', 'CANCELLED'], set: (t) => ({ status: 'PENDING', attempts: 0, error: null, available_at: new Date(), completed_at: null, dedupe_key: activeKey(t.type, t.lead_id, t.company_id, t.input) }) },
};

const PAST = { pause: 'paused', resume: 'resumed', cancel: 'cancelled', retry: 'retried' };

async function transitionTask(id, action, user) {
  const tr = TRANSITIONS[action];
  if (!tr) throw ApiError.badRequest('Unknown task action');
  const task = await AgentTask.findByPk(id);
  if (!task) throw ApiError.notFound('Task not found');
  if (!tr.from.includes(task.status)) throw ApiError.conflict(`Cannot ${action} a ${task.status} task`);
  try {
    const [n] = await AgentTask.update(tr.set(task), { where: { id, status: task.status } });
    if (!n) throw ApiError.conflict('The task changed meanwhile — reload and try again');
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') throw ApiError.conflict('The same task is already queued — cannot retry this one');
    throw err;
  }
  await logActivity({ type: `task_${action}`, action: `Task #${id} ${PAST[action]} by ${user.name}`, taskId: id, leadId: task.lead_id, companyId: task.company_id });
  return clean(await AgentTask.findByPk(id));
}

async function overview() {
  await reapExpired();
  const count = [sequelize.fn('COUNT', sequelize.col('id')), 'n'];
  const [control, connection, counts, done, lastActivity] = await Promise.all([
    getControl(),
    getConnection(),
    AgentTask.findAll({ attributes: ['status', count], group: ['status'], raw: true }),
    AgentTask.findAll({ where: { status: 'COMPLETED' }, attributes: ['type', count], group: ['type'], raw: true }),
    AgentActivity.findOne({ order: [['id', 'DESC']] }),
  ]);
  const tasks = Object.fromEntries(AgentTask.STATUSES.map((s) => [s, 0]));
  for (const c of counts) tasks[c.status] = Number(c.n);
  const completedByType = Object.fromEntries(Object.keys(TASK_TYPES).map((t) => [t, 0]));
  for (const c of done) completedByType[c.type] = Number(c.n);
  // Only a connected session has a "current task"; a RUNNING row with no session is just waiting for its lease to expire.
  // The heartbeat's task id can lag one interval behind completion, so it must still be RUNNING.
  const current = connection.current_task_id ? await AgentTask.findOne({ where: { id: connection.current_task_id, status: 'RUNNING' }, attributes: ['id', 'title', 'type', 'status'] }) : null;
  const tokenRow = await Setting.findOne({ where: { key: KEYS.token } });
  return {
    control,
    connection,
    // "available" = an admin started it AND a session is actually connected right now.
    available: control.state === 'running' && connection.connected,
    tasks,
    completed_by_type: completedByType,
    current_task: clean(current),
    last_activity: clean(lastActivity),
    token: tokenRow ? { issued_at: tokenRow.value.issued_at, last4: tokenRow.value.last4, user_id: tokenRow.value.user_id } : null,
  };
}

module.exports = {
  KEYS,
  MODES,
  TASK_TYPES,
  isAgentToken,
  issueToken,
  revokeToken,
  userForToken,
  agentRouteAllowed,
  heartbeat,
  disconnect,
  getConnection,
  getControl,
  setControl,
  createTask,
  claimNext,
  completeTask,
  failTask,
  transitionTask,
  reapExpired,
  overview,
  logActivity,
};
