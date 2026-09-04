const { Op } = require('sequelize');
const { Task, Lead, Company, User, Activity } = require('../models');
const { ok, parsePagination, paginated } = require('../utils/http');
const ApiError = require('../utils/ApiError');

const include = [
  { model: Lead, as: 'lead', attributes: ['id', 'status'], include: [{ model: Company, as: 'company', attributes: ['id', 'company_name'] }] },
  { model: Company, as: 'company', attributes: ['id', 'company_name'] },
  { model: User, as: 'assignedUser', attributes: ['id', 'name'] },
];

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
    where,
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

  const full = await Task.findByPk(task.id, { include });
  return ok(res, { task: full }, 201);
};

exports.update = async (req, res) => {
  const task = await Task.findByPk(req.params.id);
  if (!task) throw ApiError.notFound('Task not found');

  const fields = ['title', 'description', 'due_date', 'priority', 'status', 'assigned_user_id', 'is_follow_up'];
  for (const f of fields) if (req.body[f] !== undefined) task[f] = req.body[f] === '' ? null : req.body[f];

  if (req.body.status === 'COMPLETED' && !task.completed_at) task.completed_at = new Date();
  if (req.body.status && req.body.status !== 'COMPLETED') task.completed_at = null;
  await task.save();

  const full = await Task.findByPk(task.id, { include });
  return ok(res, { task: full });
};

exports.remove = async (req, res) => {
  const task = await Task.findByPk(req.params.id);
  if (!task) throw ApiError.notFound('Task not found');
  await task.destroy();
  return ok(res, { message: 'Task deleted' });
};
