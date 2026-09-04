const { sequelize, Company, Lead, LeadStatusHistory, Activity, Note } = require('../models');
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

/**
 * Move a lead to a new contact_status (the permanent "have we reached out and
 * how far did it go" record). Keeps the Kanban `status` field in sync via
 * CONTACT_TO_PIPELINE, and — critically — never gets called automatically by
 * the discovery pipeline once a lead has left NOT_CONTACTED.
 */
async function setContactStatus(leadId, toContactStatus, { userId, note, method } = {}) {
  if (!Lead.CONTACT_STATUSES.includes(toContactStatus)) {
    throw ApiError.badRequest(`Invalid contact_status: ${toContactStatus}`);
  }

  return sequelize.transaction(async (transaction) => {
    const lead = await Lead.findByPk(leadId, { transaction });
    if (!lead) throw ApiError.notFound('Lead not found');

    const fromContact = lead.contact_status;
    const fromPipeline = lead.status;
    const toPipeline = Lead.CONTACT_TO_PIPELINE[toContactStatus] || fromPipeline;

    lead.contact_status = toContactStatus;
    lead.status = toPipeline;
    if (method && Lead.CONTACT_METHODS.includes(method)) lead.contact_method = method;
    if (toContactStatus !== 'NOT_CONTACTED') {
      lead.ever_contacted = true;
      lead.last_contacted_at = new Date();
    }
    if (['LOST', 'NOT_INTERESTED'].includes(toContactStatus) && note) lead.lost_reason = note;
    await lead.save({ transaction });

    if (fromPipeline !== toPipeline) {
      await LeadStatusHistory.create(
        { lead_id: lead.id, from_status: fromPipeline, to_status: toPipeline, changed_by_user_id: userId || null, note: note || null },
        { transaction }
      );
    }

    const activityType = toContactStatus === 'REPLIED' ? 'reply_received' : toContactStatus === 'MEETING_BOOKED' ? 'meeting' : 'status_change';
    await Activity.create(
      {
        lead_id: lead.id,
        company_id: lead.company_id,
        user_id: userId || null,
        type: activityType,
        title: `Contact status: ${fromContact} → ${toContactStatus}`,
        body: note || null,
      },
      { transaction }
    );

    if (note) {
      await Note.create({ lead_id: lead.id, company_id: lead.company_id, user_id: userId || null, body: note }, { transaction });
    }

    return lead;
  });
}

/** The [CONTACT] button — always sets CONTACTED regardless of prior state. */
async function markContacted(leadId, { userId, method, note } = {}) {
  return sequelize.transaction(async (transaction) => {
    const lead = await Lead.findByPk(leadId, { transaction });
    if (!lead) throw ApiError.notFound('Lead not found');

    const fromContact = lead.contact_status;
    lead.contact_status = 'CONTACTED';
    lead.status = Lead.CONTACT_TO_PIPELINE.CONTACTED;
    lead.contacted_at = new Date();
    lead.last_contacted_at = new Date();
    lead.ever_contacted = true;
    if (method && Lead.CONTACT_METHODS.includes(method)) lead.contact_method = method;
    await lead.save({ transaction });

    if (fromContact !== 'CONTACTED') {
      await LeadStatusHistory.create(
        { lead_id: lead.id, from_status: fromContact, to_status: 'CONTACTED', changed_by_user_id: userId || null, note },
        { transaction }
      );
    }

    await Activity.create(
      {
        lead_id: lead.id,
        company_id: lead.company_id,
        user_id: userId || null,
        type: 'contacted',
        title: `Contacted via ${method || 'unspecified method'}`,
        body: note || null,
        occurred_at: new Date(),
      },
      { transaction }
    );

    if (note) {
      await Note.create({ lead_id: lead.id, company_id: lead.company_id, user_id: userId || null, body: note }, { transaction });
    }

    return lead;
  });
}

/** Lead qualification state — orthogonal to contact_status (section 16). */
async function setLeadStatus(leadId, toLeadStatus, { userId, note } = {}) {
  if (!Lead.LEAD_QUALIFICATION_STATUSES.includes(toLeadStatus)) {
    throw ApiError.badRequest(`Invalid lead_status: ${toLeadStatus}`);
  }
  return sequelize.transaction(async (transaction) => {
    const lead = await Lead.findByPk(leadId, { transaction });
    if (!lead) throw ApiError.notFound('Lead not found');
    const from = lead.lead_status;
    lead.lead_status = toLeadStatus;
    await lead.save({ transaction });

    await Activity.create(
      {
        lead_id: lead.id,
        company_id: lead.company_id,
        user_id: userId || null,
        type: 'status_change',
        title: `Lead status: ${from} → ${toLeadStatus}`,
        body: note || null,
      },
      { transaction }
    );
    return lead;
  });
}

/**
 * Manually bring an already-engaged lead back into play. Never called
 * automatically by the discovery pipeline — only a human clicks [RE-CONTACT].
 */
async function recontact(leadId, { userId, toContactStatus = 'FOLLOW_UP', note } = {}) {
  return setContactStatus(leadId, toContactStatus, { userId, note: note || 'Re-contact initiated' });
}

module.exports = { convertCompanyToLead, changeLeadStatus, setContactStatus, markContacted, setLeadStatus, recontact };
