const { Company, HermesResearchRun, HermesResearchEvidence } = require('../models');
const { ok } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const hermesClient = require('../services/hermes/hermesClient');
const hermesResearchWorker = require('../jobs/hermesResearchWorker');
const config = require('../config/config');

// Fire-and-forget, like automationController.runNow — a Hermes run is a live
// multi-source web research task and can take up to HERMES_TIMEOUT_MS
// (default 3 minutes), far too long to hold an HTTP request open for.
exports.research = async (req, res) => {
  const company = await Company.findByPk(req.params.companyId);
  if (!company) throw ApiError.notFound('Company not found');

  hermesResearchWorker
    .enqueue(company.id, { triggeredBy: 'manual', triggeredByUserId: req.user.id, depth: req.body?.depth || 'standard' })
    .catch((e) => console.error(`[hermes] research enqueue failed for company ${company.id}:`, e.message));

  return ok(res, { message: 'Hermes research started. Poll GET /api/hermes/research/:companyId for progress.' }, 202);
};

exports.getResearch = async (req, res) => {
  const run = await HermesResearchRun.findOne({
    where: { company_id: req.params.companyId },
    order: [['created_at', 'DESC']],
  });
  return ok(res, { run });
};

exports.getEvidence = async (req, res) => {
  const run = await HermesResearchRun.findOne({
    where: { company_id: req.params.companyId },
    order: [['created_at', 'DESC']],
  });
  if (!run) return ok(res, { run: null, evidence: [] });

  const evidence = await HermesResearchEvidence.findAll({
    where: { research_run_id: run.id },
    order: [['id', 'ASC']],
  });
  return ok(res, { run, evidence });
};

exports.status = async (req, res) =>
  ok(res, {
    configured: hermesClient.isConfigured(),
    testMode: config.hermes.testMode,
    queue: hermesResearchWorker.status(),
  });
