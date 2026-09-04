/**
 * One-off: rescore every existing company with the Prospecting Engine 2.0
 * scoring rules (new contactability rubric, new temperature bands, new
 * website-opportunity weights), backfill detected signals, and refresh each
 * existing lead's qualification text (recommended_service/ai_problem/
 * ai_sales_angle) — using data already on file, no new network calls, no
 * fabricated data. Safe to re-run; every value is recomputed from what's
 * already stored. Never touches contact_status/lead_status — qualification
 * text only.
 *
 *   node seed/rescore-all.js
 */
require('dotenv').config();
const { sequelize, Company, CompanyWebsite, Lead } = require('../models');
const { rescoreCompany } = require('../services/companyService');
const { detectAndSaveSignals } = require('../services/signalDetectionService');
const { detectOpportunities } = require('../services/opportunityDetectionService');
const { qualify } = require('../services/aiQualificationService');

async function run() {
  await sequelize.authenticate();
  const companies = await Company.findAll({ attributes: ['id'] });
  console.log(`[rescore-all] ${companies.length} companies to process`);

  let changed = 0;
  let qualificationRefreshed = 0;
  const tempCounts = { HOT: 0, WARM: 0, MEDIUM: 0, LOW: 0 };

  for (const { id } of companies) {
    const before = await Company.findByPk(id, { attributes: ['lead_score', 'lead_temperature'] });
    // eslint-disable-next-line no-await-in-loop
    await detectAndSaveSignals(id);
    // eslint-disable-next-line no-await-in-loop
    const result = await rescoreCompany(id);
    if (!result) continue; // eslint-disable-line no-continue
    tempCounts[result.result.temperature] = (tempCounts[result.result.temperature] || 0) + 1;
    if (before.lead_score !== result.result.score || before.lead_temperature !== result.result.temperature) {
      changed += 1;
    }

    // Refresh this lead's qualification text with the same fixed
    // opportunity-detection logic used for freshly-discovered leads —
    // otherwise a lead created before an opportunityDetectionService fix
    // keeps stale/incorrect ai_problem/ai_sales_angle text forever.
    // eslint-disable-next-line no-await-in-loop
    const lead = await Lead.findOne({ where: { company_id: id } });
    if (lead) {
      // eslint-disable-next-line no-await-in-loop
      const websiteRow = await CompanyWebsite.findOne({ where: { company_id: id }, order: [['last_checked_at', 'DESC']] });
      const websiteAudit = websiteRow
        ? {
            status: websiteRow.status,
            health: websiteRow.health,
            httpStatus: websiteRow.http_status,
            technologies: websiteRow.detected_technologies,
            signals: websiteRow.audit_signals,
            featureFlags: websiteRow.feature_flags || {},
          }
        : null;
      const opportunities = detectOpportunities({ industry: result.company.industry, websiteAudit });
      // eslint-disable-next-line no-await-in-loop
      const freshCompany = await Company.findByPk(id);
      const qualification = qualify({ company: freshCompany, scoring: result.result, opportunities, websiteAudit });
      lead.recommended_service = result.result.recommendedService;
      lead.ai_problem = qualification.problem;
      lead.ai_evidence = qualification.evidence;
      lead.ai_sales_angle = qualification.salesAngle;
      // eslint-disable-next-line no-await-in-loop
      await lead.save();
      qualificationRefreshed += 1;
    }
  }

  console.log(`[rescore-all] done. ${changed}/${companies.length} companies changed score/temperature.`);
  console.log(`[rescore-all] ${qualificationRefreshed} leads had qualification text refreshed.`);
  console.log('[rescore-all] temperature distribution:', tempCounts);
  await sequelize.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('[rescore-all] failed:', err.message);
  process.exit(1);
});
