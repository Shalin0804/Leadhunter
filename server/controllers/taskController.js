const { Op } = require('sequelize');
const { Task, Lead, Company, User, Activity } = require('../models');
const { ok, parsePagination, paginated } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const access = require('../services/accessService');
const audit = require('../services/auditService');

const include = [
  { model: Lead, as: 'lead', attributes: ['id', 'status'], include: [{ model: Company, as: 'company', attributes: ['id', 'company_name'] }] },
  { model: Company, as: 'company', attributes: ['id', 'company_name'] },
  { model: User, as: 'assignedUser', attributes: ['id', 'name'] },
];

// Tasks a user may see: assigned to someone in their scope, or attached to a lead they can see.
async function taskScope(user) {
  const ids = await access.visibleUserIds(user);
  if (!ids) return {};
  return { [Op.or]: [{ assigned_user_id: { [Op.in]: ids } }, { lead_id: { [Op.in]: await access.accessibleLeadIds(user) } }] };
}

async function loadTask(user, id) {
  const task = await Task.findOne({ where: { [Op.and]: [{ id }, await taskScope(user)] } });
  if (!task) throw ApiError.notFound('Task not found');
  return task;
}

async function assertAssignee(user, assigneeId) {
  if (!assigneeId || Number(assigneeId) === user.id) return;
  const ids = await access.visibleUserIds(user);
  if (ids && !ids.includes(Number(assigneeId))) throw ApiError.forbidden('You can only assign tasks within your team');
}

exports.list = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const where = {};
  if (req.query.status) where.status = req.query.status;
  if (req.query.assigned_user_id) where.assigned_user_id = req.query.assigned_user_id;
  if (req.query.lead_id) where.lead_id = req.query.lead_id;
  if (req.query.priority) where.priority = req.query.priority;
  if (req.query.overdue === 'true') {
    where.due_date = { [Op.lt]: new Date() };
    where.status = { [Op.notIn]: ['COMPLETED', 'CANCELLED'] };
  }
  if (req.query.upcoming === 'true') {
    where.due_date = { [Op.between]: [new Date(), new Date(Date.now() + 7 * 86400000)] };
    where.status = { [Op.notIn]: ['COMPLETED', 'CANCELLED'] };
  }

  const { rows, count } = await Task.findAndCountAll({
    where: { [Op.and]: [where, await taskScope(req.user)] },
    include,
    order: [['due_date', 'ASC'], ['id', 'DESC']],
    limit,
    offset,
  });
  return ok(res, paginated(rows, count, page, limit));
};

exports.create = async (req, res) => {
  const b = req.body;
  if (!b.title) throw ApiError.badRequest('title is required');
  if (b.lead_id) await access.loadAccessibleLead(req.user, b.lead_id);
  if (b.company_id) await access.assertCompanyAccess(req.user, b.company_id);
  await assertAssignee(req.user, b.assigned_user_id);

  const task = await Task.create({
    lead_id: b.lead_id || null,
    company_id: b.company_id || null,
    assigned_user_id: b.assigned_user_id || req.user.id,
    created_by_user_id: req.user.id,
    title: b.title,
    description: b.description,
    due_date: b.due_date || null,
    priority: b.priority || 'MEDIUM',
    status: b.status || 'TODO',
    is_follow_up: !!b.is_follow_up,
  });

  if (task.lead_id) {
    await Activity.create({
      lead_id: task.lead_id,
      user_id: req.user.id,
      type: task.is_follow_up ? 'follow_up' : 'note',
      title: `${task.is_follow_up ? 'Follow-up' : 'Task'} created: ${task.title}`,
      body: task.due_date ? `Due ${new Date(task.due_date).toISOString()}` : null,
    });
    // keep lead.next_follow_up_at in sync with the earliest open follow-up
    if (task.is_follow_up && task.due_date) {
      const lead = await Lead.findByPk(task.lead_id);
      if (lead && (!lead.next_follow_up_at || new Date(task.due_date) < new Date(lead.next_follow_up_at))) {
        lead.next_follow_up_at = task.due_date;
        await lead.save();
      }
    }
  }

  await audit.record(req, {
    action: task.is_follow_up ? 'lead.follow_up_added' : 'task.created',
    resourceType: 'task',
    resourceId: task.id,
    leadId: task.lead_id,
    companyId: task.company_id,
    metadata: { assigned_user_id: task.assigned_user_id, due_date: task.due_date ? new Date(task.due_date).toISOString() : null },
  });

  const full = await Task.findByPk(task.id, { include });
  return ok(res, { task: full }, 201);
};

exports.update = async (req, res) => {
  const task = await loadTask(req.user, req.params.id);
  if (req.body.assigned_user_id !== undefined) await assertAssignee(req.user, req.body.assigned_user_id);
  const before = task.status;

  const fields = ['title', 'description', 'due_date', 'priority', 'status', 'assigned_user_id', 'is_follow_up'];
  for (const f of fields) if (req.body[f] !== undefined) task[f] = req.body[f] === '' ? null : req.body[f];

  if (req.body.status === 'COMPLETED' && !task.completed_at) task.completed_at = new Date();
  if (req.body.status && req.body.status !== 'COMPLETED') task.completed_at = null;
  await task.save();

  await audit.record(req, {
    action: before !== 'COMPLETED' && task.status === 'COMPLETED' ? 'task.completed' : 'task.updated',
    resourceType: 'task',
    resourceId: task.id,
    leadId: task.lead_id,
    companyId: task.company_id,
    metadata: { from: before, to: task.status },
  });

  const full = await Task.findByPk(task.id, { include });
  return ok(res, { task: full });
};

exports.remove = async (req, res) => {
  const task = await loadTask(req.user, req.params.id);
  await task.destroy();
  await audit.record(req, { action: 'task.deleted', resourceType: 'task', resourceId: task.id, leadId: task.lead_id, companyId: task.company_id });
  return ok(res, { message: 'Task deleted' });
};
