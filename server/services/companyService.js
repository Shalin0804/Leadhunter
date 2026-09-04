const { Company, CompanyContact, CompanyWebsite, CompanySocial, LeadScore, Lead, Signal, DetectedSignal } = require('../models');
const { scoreCompany } = require('./leadScoring');

const PRESENCE_INCLUDE = [
  { model: CompanyContact, as: 'contacts' },
  { model: CompanyWebsite, as: 'websites' },
  { model: CompanySocial, as: 'socials' },
];

// Everything the scoring engine needs (presence + active buying signals + detected signals).
const SCORING_INCLUDE = [...PRESENCE_INCLUDE, { model: Signal, as: 'signals' }, { model: DetectedSignal, as: 'detectedSignals' }];

async function loadCompanyWithPresence(id, options = {}) {
  return Company.findByPk(id, { include: PRESENCE_INCLUDE, ...options });
}

/** Recalculate denormalized flags from related rows. Mutates + saves the company. */
async function syncPresenceFlags(company, { transaction } = {}) {
  const contacts = company.contacts || (await company.getContacts({ transaction }));
  const websites = company.websites || (await company.getWebsites({ transaction }));

  company.has_email = contacts.some((c) => c.type === 'email');
  company.has_phone = contacts.some((c) => c.type === 'phone');
  company.has_website = websites.length > 0 || !!company.website;
  if (!company.website && websites[0]) company.website = websites[0].url;

  await company.save({ transaction });
  return company;
}

/**
 * Score a company, persist the cached fields on companies + append a lead_scores row.
 * Also propagates the score to an existing lead if one exists.
 */
async function rescoreCompany(companyId, { transaction, leadId } = {}) {
  const company = await Company.findByPk(companyId, { include: SCORING_INCLUDE, transaction });
  if (!company) return null;

  const result = scoreCompany(company);

  company.lead_score = result.score;
  company.lead_temperature = result.temperature;
  company.recommended_service = result.recommendedService;
  company.contactability_score = result.contactabilityScore;
  await company.save({ transaction });

  await LeadScore.create(
    {
      company_id: company.id,
      lead_id: leadId || null,
      score: result.score,
      temperature: result.temperature,
      opportunity_level: result.opportunityLevel,
      recommended_service: result.recommendedService,
      breakdown: result.breakdown,
      reasons: result.reasons,
      missing_assets: result.missingAssets,
      model_version: result.modelVersion,
    },
    { transaction }
  );

  const lead = leadId
    ? await Lead.findByPk(leadId, { transaction })
    : await Lead.findOne({ where: { company_id: company.id }, transaction });
  if (lead) {
    lead.lead_score = result.score;
    lead.lead_temperature = result.temperature;
    lead.recommended_service = result.recommendedService;
    await lead.save({ transaction });
  }

  return { company, result };
}

module.exports = { loadCompanyWithPresence, syncPresenceFlags, rescoreCompany, PRESENCE_INCLUDE, SCORING_INCLUDE };
