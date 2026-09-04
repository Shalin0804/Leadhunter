const { sequelize, Company, Lead, LeadStatusHistory, Activity } = require('../models');
const { scoreCompany } = require('./leadScoring');
const { SCORING_INCLUDE } = require('./companyService');
const ApiError = require('../utils/ApiError');

/** Convert a company into a lead (or return the existing one). */
async function convertCompanyToLead(companyId, { userId, assignedUserId, priority, estimatedValue } = {}) {
  return sequelize.transaction(async (transaction) => {
    const company = await Company.findByPk(companyId, { include: SCORING_INCLUDE, transaction });
    if (!company) throw ApiError.notFound('Company not found');

    const existing = await Lead.findOne({ where: { company_id: companyId }, transaction });
    if (existing) return { lead: existing, created: false };

    const analysis = scoreCompany(company);

    const lead = await Lead.create(
      {
        company_id: company.id,
        assigned_user_id: assignedUserId || userId || null,
        created_by_user_id: userId || null,
        status: 'NEW',
        priority: priority || 'MEDIUM',
        lead_score: analysis.score,
        lead_temperature: analysis.temperature,
        recommended_service: analysis.recommendedService,
        estimated_value: estimatedValue || null,
      },
      { transaction }
    );

    await LeadStatusHistory.create(
      { lead_id: lead.id, from_status: null, to_status: 'NEW', changed_by_user_id: userId || null, note: 'Converted from company discovery' },
      { transaction }
    );

    await Activity.create(
      {
        lead_id: lead.id,
        company_id: company.id,
        user_id: userId || null,
        type: 'system',
        title: 'Company converted to lead',
        body: `Initial score ${analysis.score} (${analysis.temperature})`,
      },
      { transaction }
    );

    return { lead, created: true };
  });
}

async function changeLeadStatus(leadId, toStatus, { userId, note } = {}) {
  if (!Lead.STATUSES.includes(toStatus)) throw ApiError.badRequest(`Invalid status: ${toStatus}`);

  return sequelize.transaction(async (transaction) => {
    const lead = await Lead.findByPk(leadId, { transaction });
    if (!lead) throw ApiError.notFound('Lead not found');

    const from = lead.status;
    if (from === toStatus) return lead;

    lead.status = toStatus;
    if (toStatus === 'CONTACTED' || toStatus === 'REPLIED') lead.last_contacted_at = new Date();
    if (toStatus === 'LOST' && note) lead.lost_reason = note;
    await lead.save({ transaction });

    await LeadStatusHistory.create(
      { lead_id: lead.id, from_status: from, to_status: toStatus, changed_by_user_id: userId || null, note: note || null },
      { transaction }
    );

    await Activity.create(
      {
        lead_id: lead.id,
        company_id: lead.company_id,
        user_id: userId || null,
        type: 'status_change',
        title: `Status: ${from} → ${toStatus}`,
        body: note || null,
      },
      { transaction }
    );

    return lead;
  });
}

module.exports = { convertCompanyToLead, changeLeadStatus };
