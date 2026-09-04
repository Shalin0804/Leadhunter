const { Lead, Company, User } = require('../models');
const { ok } = require('../utils/http');
const { changeLeadStatus } = require('../services/leadService');

const STAGES = Lead.STATUSES;

exports.board = async (req, res) => {
  const where = {};
  if (req.query.assigned_user_id) where.assigned_user_id = req.query.assigned_user_id;

  const leads = await Lead.findAll({
    where,
    include: [
      { model: Company, as: 'company', attributes: ['id', 'company_name', 'industry', 'state', 'city'] },
      { model: User, as: 'assignedUser', attributes: ['id', 'name'] },
    ],
    order: [['updated_at', 'DESC']],
  });

  const columns = STAGES.map((stage) => ({
    stage,
    leads: leads.filter((l) => l.status === stage),
    count: leads.filter((l) => l.status === stage).length,
    value: leads
      .filter((l) => l.status === stage)
      .reduce((sum, l) => sum + (Number(l.estimated_value) || 0), 0),
  }));

  return ok(res, { stages: STAGES, columns });
};

// convenience alias to PATCH /leads/:id/status used by drag-drop
exports.move = async (req, res) => {
  const lead = await changeLeadStatus(req.params.id, req.body.status, { userId: req.user.id, note: req.body.note });
  return ok(res, { lead });
};
