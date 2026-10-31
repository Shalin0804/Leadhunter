const { Op } = require('sequelize');
const { AgentTask, AgentActivity, Lead, Company } = require('../models');
const agent = require('../services/agentService');
const audit = require('../services/auditService');
const ApiError = require('../utils/ApiError');
const { likeOp } = require('../utils/dialect');
const { ok, parsePagination, paginated } = require('../utils/http');

const int = (v) => (v == null || v === '' ? null : Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : NaN);
const idParam = (req) => {
  const id = int(req.params.id);
  if (!id) throw ApiError.badRequest('Invalid id');
  return id;
};

/* ---------------- admin (JWT, agent.manage) ---------------- */

exports.overview = async (req, res) => ok(res, await agent.overview());

exports.control = async (req, res) => {
  const { action, enabled_modes: enabledModes } = req.body || {};
  const next = await agent.setControl(action, req.user, { enabledModes });
  await audit.record(req, { action: `agent.${action}`, resourceType: 'agent', metadata: { state: next.state, enabled_modes: next.enabled_modes?.join(',') } });
  ok(res, next);
};

// The raw token is returned exactly once; only its hash is stored.
exports.issueToken = async (req, res) => {
  const token = await agent.issueToken(req.user);
  await audit.record(req, { action: 'agent.token_issued', resourceType: 'agent' });
  ok(res, { token, note: 'Shown once. Put it in server/.env as LEADHUNTER_AGENT_TOKEN on the computer running Claude Code. Issuing a new token revokes this one.' }, 201);
};

exports.revokeToken = async (req, res) => {
  await agent.revokeToken();
  await audit.record(req, { action: 'agent.token_revoked', resourceType: 'agent' });
  ok(res, { revoked: true });
};

const TASK_INCLUDE = [
  { model: Lead, as: 'lead', attributes: ['id', 'status'] },
  { model: Company, as: 'company', attributes: ['id', 'company_name', 'website'] },
];

exports.listTasks = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 25 });
  const where = {};
  if (req.query.status) where.status = String(req.query.status).toUpperCase().split(',').filter((s) => AgentTask.STATUSES.includes(s));
  if (req.query.mode && agent.MODES.includes(req.query.mode)) where.mode = req.query.mode;
  if (int(req.query.lead_id)) where.lead_id = int(req.query.lead_id);
  if (int(req.query.company_id)) where.company_id = int(req.query.company_id);
  const { rows, count } = await AgentTask.findAndCountAll({ where, include: TASK_INCLUDE, order: [['id', 'DESC']], limit, offset });
  ok(res, paginated(rows, count, page, limit));
};

exports.getTask = async (req, res) => {
  const task = await AgentTask.findByPk(idParam(req), { include: TASK_INCLUDE });
  if (!task) throw ApiError.notFound('Task not found');
  const activity = await AgentActivity.findAll({ where: { task_id: task.id }, order: [['id', 'ASC']], limit: 200 });
  ok(res, { task, activity });
};

exports.createTask = async (req, res) => {
  const b = req.body || {};
  const leadId = int(b.lead_id);
  const companyId = int(b.company_id);
  if (Number.isNaN(leadId) || Number.isNaN(companyId)) throw ApiError.badRequest('lead_id / company_id must be positive integers');
  const task = await agent.createTask({ type: b.type, priority: b.priority ?? 5, leadId, companyId, title: b.title, input: b.input ?? null, maxAttempts: b.max_attempts ?? 3 }, req.user);
  await audit.record(req, { action: 'agent.task_created', resourceType: 'agent_task', resourceId: task.id, leadId: task.lead_id, companyId: task.company_id, metadata: { type: task.type } });
  ok(res, task, 201);
};

exports.taskAction = async (req, res) => {
  const task = await agent.transitionTask(idParam(req), req.params.action, req.user);
  await audit.record(req, { action: `agent.task_${req.params.action}`, resourceType: 'agent_task', resourceId: task.id, leadId: task.lead_id, companyId: task.company_id });
  ok(res, task);
};

exports.listActivity = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query, { defaultLimit: 50, maxLimit: 200 });
  const q = req.query;
  const where = {};
  if (q.type) where.type = String(q.type).split(',');
  if (q.status) where.status = String(q.status).split(',');
  for (const f of ['lead_id', 'company_id', 'task_id']) if (int(q[f])) where[f] = int(q[f]);
  const range = {};
  if (q.date_from && !Number.isNaN(Date.parse(q.date_from))) range[Op.gte] = new Date(q.date_from);
  if (q.date_to && !Number.isNaN(Date.parse(q.date_to))) range[Op.lte] = new Date(q.date_to);
  if (Object.getOwnPropertySymbols(range).length) where.created_at = range;
  if (q.search) where.action = { [likeOp]: `%${String(q.search).slice(0, 100)}%` };
  const { rows, count } = await AgentActivity.findAndCountAll({
    where,
    include: [
      { model: Company, as: 'company', attributes: ['id', 'company_name'] },
      { model: AgentTask, as: 'task', attributes: ['id', 'title', 'type'] },
    ],
    order: [['id', 'DESC']],
    limit,
    offset,
  });
  ok(res, paginated(rows, count, page, limit));
};

/* ---------------- bridge (agent token only — called by the MCP server) ---------------- */

const session = (req) => {
  if (!req.agent.sessionId) throw ApiError.badRequest('X-Agent-Session header is required');
  return req.agent.sessionId;
};

exports.heartbeat = async (req, res) => {
  const currentTaskId = int(req.body?.current_task_id);
  await agent.heartbeat({ sessionId: session(req), client: req.body?.client, currentTaskId: Number.isNaN(currentTaskId) ? null : currentTaskId });
  ok(res, { control: await agent.getControl(), connection: await agent.getConnection() });
};

exports.disconnect = async (req, res) => {
  await agent.disconnect({ sessionId: session(req), reason: req.body?.reason });
  ok(res, { disconnected: true });
};

exports.bridgeStatus = async (req, res) => {
  const o = await agent.overview();
  ok(res, { control: o.control, connection: o.connection, available: o.available, tasks: o.tasks });
};

exports.claim = async (req, res) => ok(res, await agent.claimNext(session(req)));

exports.complete = async (req, res) => ok(res, await agent.completeTask(idParam(req), session(req), req.body?.result ?? null));

exports.fail = async (req, res) => {
  if (!req.body?.error) throw ApiError.badRequest('error is required');
  ok(res, await agent.failTask(idParam(req), session(req), req.body.error, { retryable: req.body.retryable !== false }));
};
