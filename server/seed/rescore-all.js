/**
 * One-off: rescore every existing company with the Prospecting Engine 2.0
 * scoring rules (new contactability rubric, new temperature bands, new
 * website-opportunity weights) and backfill detected signals for every
 * company using data already on file — no new network calls, no fabricated
 * data. Safe to re-run; every value is recomputed from what's already stored.
 *
 *   node seed/rescore-all.js
 */
require('dotenv').config();
const { sequelize, Company } = require('../models');
const { rescoreCompany } = require('../services/companyService');
const { detectAndSaveSignals } = require('../services/signalDetectionService');

async function run() {
  await sequelize.authenticate();
  const companies = await Company.findAll({ attributes: ['id'] });
  console.log(`[rescore-all] ${companies.length} companies to process`);

  let changed = 0;
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
  }

  console.log(`[rescore-all] done. ${changed}/${companies.length} companies changed score/temperature.`);
  console.log('[rescore-all] temperature distribution:', tempCounts);
  await sequelize.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('[rescore-all] failed:', err.message);
  process.exit(1);
});
