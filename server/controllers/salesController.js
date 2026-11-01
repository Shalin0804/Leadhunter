const sales = require('../services/salesService');
const audit = require('../services/auditService');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');

// Mounted under /agent (agent.manage, Main Admin). The two bridge handlers are agent-token only.

const num = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw ApiError.badRequest('Invalid id');
  return n;
};
const session = (req) => {
  if (!req.agent.sessionId) throw ApiError.badRequest('X-Agent-Session header is required');
  return req.agent.sessionId;
};

exports.savePlaybook = async (req, res) => ok(res, await sales.savePlaybook(req.body, req.user, session(req)), 201);
exports.playbookContext = async (req, res) => ok(res, await sales.playbookContext(req.user, num(req.params.leadId)));

exports.overview = async (req, res) => ok(res, await sales.dashboard());
exports.lead = async (req, res) => ok(res, await sales.leadSales(num(req.params.leadId)));

exports.queue = async (req, res) => {
  const task = await sales.queue(req.user, num(req.params.leadId), req.body?.focus);
  await audit.record(req, { action: 'sales.task_queued', resourceType: 'agent_task', resourceId: task.id, leadId: task.lead_id, companyId: task.company_id, metadata: { focus: req.body.focus } });
  ok(res, task, 201);
};

exports.editPlaybook = async (req, res) => ok(res, await sales.editPlaybook(num(req.params.id), req.body?.sections, req.user, req));
exports.scheduleFollowUps = async (req, res) => ok(res, await sales.scheduleFollowUps(num(req.params.id), req.user, req), 201);
exports.markSent = async (req, res) => ok(res, await sales.markSent(num(req.params.id), req.user, req));
