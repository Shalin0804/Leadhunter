const config = require('../config/config');
const { getSettings, updateSettings } = require('../services/automationSettingsService');
const { runFullDiscovery, runForTarget } = require('../services/discoveryOrchestrator');
const { reschedule, isRunning, withRunLock } = require('../jobs/automationScheduler');
const { history } = require('../services/apiUsageService');
const { SearchRun, LeadSource, Lead, Company, sequelize } = require('../models');
const monitoring = require('../services/monitoringService');
const alerts = require('../services/alertService');
const { ok, parsePagination, paginated } = require('../utils/http');
const ApiError = require('../utils/ApiError');
const { listDiscoveryProviders, listEnrichmentProviders } = require('../providers');

exports.getSettings = async (req, res) =>
  ok(res, {
    settings: await getSettings(),
    discoveryProviders: listDiscoveryProviders(),
    enrichmentProviders: listEnrichmentProviders(),
  });

exports.updateSettings = async (req, res) => {
  const settings = await updateSettings(req.body || {});
  await reschedule();
  return ok(res, { settings });
};

// TARGET MODE / MANUAL MODE: run once, right now. Fire-and-forget — discovery
// can take a while, so the HTTP response doesn't wait for it to finish.
// Routed through withRunLock (not called directly) so this participates in
// the SAME concurrency lock as the cron scheduler and the external-cron
// endpoint below — otherwise `running` never gets set for this path and a
// second trigger (manual, scheduled, or external) can start concurrently.
exports.runNow = async (req, res) => {
  if (isRunning()) throw ApiError.conflict('A discovery run is already in progress');

  const { location, industry } = req.body || {};
  const settings = await getSettings();

  if (location && industry) {
    // TARGET MODE — a single ad-hoc location+industry pair, outside the saved config.
    withRunLock('manual', () =>
      runForTarget({
        location,
        industry,
        providerKey: settings.provider,
        discoveryProviders: settings.discoveryProviders?.length ? settings.discoveryProviders : [settings.provider],
        minLeadScore: settings.minLeadScore,
        dailyLimit: settings.dailyLeadLimit,
        triggeredBy: 'manual',
        triggeredByUserId: req.user.id,
        settings,
      })
    ).catch((e) => console.error('[automation] target run failed:', e.message));
  } else {
    // Without this, runFullDiscovery no-ops silently and the UI still says "run started".
    if (!settings.locations?.length || !settings.industries?.length) {
      throw ApiError.badRequest('Add at least one target location and one target industry in Automation Settings, save, then run again');
    }
    withRunLock('manual', () => runFullDiscovery({ triggeredBy: 'manual', triggeredByUserId: req.user.id })).catch((e) =>
      console.error('[automation] manual run failed:', e.message)
    );
  }

  return ok(res, { message: 'Discovery run started. Check Search History for progress.' }, 202);
};

// External-cron entry point — no user session, just a shared secret. Safe to
// call repeatedly/overlapping: withRunLock rejects a second run while one is
// in progress, same as the manual and in-process-scheduled triggers.
function checkTriggerSecret(req) {
  if (!config.automation.triggerSecret) {
    throw ApiError.badRequest('AUTOMATION_TRIGGER_SECRET is not configured on the server');
  }
  const provided = req.headers['x-automation-secret'] || req.query.secret;
  if (provided !== config.automation.triggerSecret) throw ApiError.unauthorized('Invalid automation trigger secret');
}

exports.runScheduled = async (req, res) => {
  checkTriggerSecret(req);
  if (isRunning()) return ok(res, { message: 'A run is already in progress — skipped.' });

  withRunLock('external', () => runFullDiscovery({ triggeredBy: 'external' })).catch((e) =>
    console.error('[automation] external run failed:', e.message)
  );
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

exports.ready = async (req, res) => {
  try {
    await sequelize.authenticate();
    return res.json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[health] readiness check failed:', err.message);
    return res.status(503).json({ status: 'unavailable', timestamp: new Date().toISOString() });
  }
};

// External-cron heartbeat: 200 when healthy/disabled/running, 503 when overdue so the
// cron service's own failure email fires too (a second channel if SMTP is broken).
exports.heartbeat = async (req, res) => {
  checkTriggerSecret(req);
  const status = await monitoring.checkAutomationHealth({ isRunning: isRunning() });
  return res.status(status.status === 'overdue' ? 503 : 200).json({ success: status.status !== 'overdue', data: status });
};

exports.monitorStatus = async (req, res) =>
  ok(res, { automation: await monitoring.automationStatus({ isRunning: isRunning() }), alerts: { configured: !alerts.configProblem(), problem: alerts.configProblem() } });

exports.testAlert = async (req, res) => {
  const problem = alerts.configProblem();
  if (problem) throw ApiError.badRequest(`Email alerts are not configured: ${problem}`);
  const sent = await alerts.send('test', { 'Requested by': req.user.email });
  if (!sent) throw ApiError.badRequest('Test email failed — check the server logs for the SMTP error');
  return ok(res, { message: `Test email sent to ${config.alerts.to}` });
};
