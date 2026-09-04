const config = require('../config/config');
const { getSettings, updateSettings } = require('../services/automationSettingsService');
const { runFullDiscovery, runForTarget } = require('../services/discoveryOrchestrator');
const { reschedule, isRunning } = require('../jobs/automationScheduler');
const { history } = require('../services/apiUsageService');
const { SearchRun, LeadSource, Lead, Company } = require('../models');
const { ok, parsePagination, paginated } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const { listDiscoveryProviders } = require('../providers');

exports.getSettings = async (req, res) => ok(res, { settings: await getSettings(), discoveryProviders: listDiscoveryProviders() });

exports.updateSettings = async (req, res) => {
  const settings = await updateSettings(req.body || {});
  await reschedule();
  return ok(res, { settings });
};

// TARGET MODE / MANUAL MODE: run once, right now. Fire-and-forget — discovery
// can take a while, so the HTTP response doesn't wait for it to finish.
exports.runNow = async (req, res) => {
  if (isRunning()) throw ApiError.conflict('A discovery run is already in progress');

  const { location, industry } = req.body || {};
  const settings = await getSettings();

  if (location && industry) {
    // TARGET MODE — a single ad-hoc location+industry pair, outside the saved config.
    runForTarget({
      location,
      industry,
      providerKey: settings.provider,
      minLeadScore: settings.minLeadScore,
      dailyLimit: settings.dailyLeadLimit,
      triggeredBy: 'manual',
      triggeredByUserId: req.user.id,
      settings,
    }).catch((e) => console.error('[automation] target run failed:', e.message));
  } else {
    runFullDiscovery({ triggeredBy: 'manual', triggeredByUserId: req.user.id }).catch((e) =>
      console.error('[automation] manual run failed:', e.message)
    );
  }

  return ok(res, { message: 'Discovery run started. Check Search History for progress.' }, 202);
};

// External-cron entry point — no user session, just a shared secret.
exports.runScheduled = async (req, res) => {
  if (!config.automation.triggerSecret) {
    throw ApiError.badRequest('AUTOMATION_TRIGGER_SECRET is not configured on the server');
  }
  const provided = req.headers['x-automation-secret'] || req.query.secret;
  if (provided !== config.automation.triggerSecret) throw ApiError.unauthorized('Invalid automation trigger secret');
  if (isRunning()) return ok(res, { message: 'A run is already in progress — skipped.' });

  runFullDiscovery({ triggeredBy: 'external' }).catch((e) => console.error('[automation] external run failed:', e.message));
  return ok(res, { message: 'Discovery run started.' }, 202);
};

exports.listRuns = async (req, res) => {
  const { page, limit, offset } = parsePagination(req.query);
  const { rows, count } = await SearchRun.findAndCountAll({
    order: [['started_at', 'DESC']],
    limit,
    offset,
  });
  return ok(res, paginated(rows, count, page, limit));
};

exports.getRun = async (req, res) => {
  const run = await SearchRun.findByPk(req.params.id, {
    include: [
      {
        model: LeadSource,
        as: 'leadSources',
        include: [{ model: Company, as: 'company', attributes: ['id', 'company_name', 'lead_score', 'lead_temperature'] }],
      },
    ],
  });
  if (!run) throw ApiError.notFound('Search run not found');
  return ok(res, { run });
};

exports.apiUsage = async (req, res) => ok(res, { usage: await history(30) });

exports.isRunning = async (req, res) => ok(res, { running: isRunning() });
