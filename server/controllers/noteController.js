const { Op } = require('sequelize');
const { Note, Lead, Company, User, Activity } = require('../models');
const { ok, parsePagination, paginated } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const access = require('../services/accessService');
const audit = require('../services/auditService');

const include = [
  { model: User, as: 'user', attributes: ['id', 'name'] },
  { model: Company, as: 'company', attributes: ['id', 'company_name'] },
  { model: Lead, as: 'lead', attributes: ['id'] },
];

// Notes a user may see: on a lead they can see, or written by someone in their scope.
async function noteScope(user) {
  const ids = await access.visibleUserIds(user);
  if (!ids) return {};
  return { [Op.or]: [{ lead_id: { [Op.in]: await access.accessibleLeadIds(user) } }, { user_id: { [Op.in]: ids } }] };
}

exports.list = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const where = {};
  if (req.query.lead_id) where.lead_id = req.query.lead_id;
  if (req.query.company_id) where.company_id = req.query.company_id;

  const { rows, count } = await Note.findAndCountAll({
    where: { [Op.and]: [where, await noteScope(req.user)] },
    include,
    order: [['created_at', 'DESC']],
    limit,
    offset,
  });
  return ok(res, paginated(rows, count, page, limit));
};

exports.create = async (req, res) => {
  const { body, lead_id, company_id } = req.body;
  if (!body || !body.trim()) throw ApiError.badRequest('Note body is required');
  if (!lead_id && !company_id) throw ApiError.badRequest('A note must be attached to a lead or company');

  let resolvedCompanyId = company_id || null;
  if (lead_id) {
    const lead = await access.loadAccessibleLead(req.user, lead_id);
    resolvedCompanyId = resolvedCompanyId || lead.company_id;
  } else {
    await access.assertCompanyAccess(req.user, company_id);
  }

  const note = await Note.create({
    lead_id: lead_id || null,
    company_id: resolvedCompanyId,
    user_id: req.user.id,
    body: body.trim(),
  });

  await Activity.create({
    lead_id: lead_id || null,
    company_id: resolvedCompanyId,
    user_id: req.user.id,
    type: 'note',
    title: 'Note added',
    body: body.trim().slice(0, 240),
  });

  // Note text itself is not copied into the audit trail (it may contain contact details).
  await audit.record(req, {
    action: 'lead.note_added',
    resourceType: 'note',
    resourceId: note.id,
    leadId: note.lead_id,
    companyId: note.company_id,
    metadata: { length: note.body.length },
  });

  const full = await Note.findByPk(note.id, { include });
  return ok(res, { note: full }, 201);
};

exports.remove = async (req, res) => {
  const note = await Note.findOne({ where: { [Op.and]: [{ id: req.params.id }, await noteScope(req.user)] } });
  if (!note) throw ApiError.notFound('Note not found');
  if (note.user_id && note.user_id !== req.user.id && req.user.role !== 'admin') {
    throw ApiError.forbidden('You can only delete your own notes');
  }
  await note.destroy();
  await audit.record(req, { action: 'lead.note_deleted', resourceType: 'note', resourceId: note.id, leadId: note.lead_id, companyId: note.company_id });
  return ok(res, { message: 'Note deleted' });
};
