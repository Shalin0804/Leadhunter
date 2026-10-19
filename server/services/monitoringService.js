const crypto = require('crypto');
const { Op } = require('sequelize');
const config = require('../config/config');
const { Setting, SearchRun } = require('../models');
const alerts = require('./alertService');
const { getSettings, KEY: AUTOMATION_SETTINGS_KEY } = require('./automationSettingsService');
const { version } = require('../package.json');

/**
 * Backend lifecycle + automation health. Job history itself is the existing
 * search_runs table (one row per location x industry, with start/finish/status/
 * errors/counts) — this module only reads it and decides when to alert.
 */

const BOOT_KEY = 'lifecycle:last_boot';
const CLEAN_SHUTDOWN_KEY = 'lifecycle:last_clean_shutdown';
// On a zero-downtime deploy the new instance boots BEFORE the old one gets SIGTERM.
// Wait this long before judging whether the previous instance shut down cleanly.
const STARTUP_CHECK_DELAY_MS = 90000;

const bootId = crypto.randomUUID();
const appVersion = () => [version, process.env.RENDER_GIT_COMMIT?.slice(0, 7)].filter(Boolean).join(' @ ');

// ---- run outcomes ------------------------------------------------------------

/**
 * A run is a failure if it says so, OR if it "completed" with zero businesses
 * because every discovery provider errored — that case used to pass silently.
 */
function isFailedRun(run) {
  if (run.status === 'failed') return true;
  const discoveryErrors = (run.errors || []).filter((e) => String(e.step || '').startsWith('discovery:'));
  return run.businesses_discovered === 0 && discoveryErrors.length > 0 && !(run.providers_used || []).length;
}

const firstError = (run) => run.error_message || (run.errors || [])[0]?.message || 'unknown error';

/**
 * Called (fire-and-forget) with whatever withRunLock's task resolved to:
 * { runs } from runFullDiscovery, a single SearchRun from target mode,
 * { error } when the task threw, or { skipped } when another run held the lock.
 */
async function recordRunOutcome(triggeredBy, result) {
  if (!result || result.skipped) return;
  const facts = { Trigger: triggeredBy };

  if (result.error) return alerts.raise('automation_failure', { ...facts, Error: String(result.error).slice(0, 300) });

  const runs = result.runs || (result.status ? [result] : []);
  if (!runs.length) {
    return alerts.raise('automation_failure', { ...facts, Error: result.message || 'Run produced no search runs' });
  }

  const failed = runs.filter(isFailedRun);
  if (failed.length) {
    return alerts.raise('automation_failure', {
      ...facts,
      'Failed targets': `${failed.length} of ${runs.length}`,
      'First error': firstError(failed[0]).slice(0, 300),
      'Search run IDs': failed.map((r) => r.id).join(', '),
    });
  }

  return alerts.resolve(['automation_failure', 'automation_overdue'], 'automation_recovered', {
    ...facts,
    'Businesses discovered': runs.reduce((n, r) => n + (r.businesses_discovered || 0), 0),
    'Qualified leads': runs.reduce((n, r) => n + (r.qualified_leads || 0), 0),
  });
}

// ---- overdue detection -------------------------------------------------------

/**
 * Automation status from persisted run history. Statuses:
 *   disabled  — automation switched off in settings (never alerts)
 *   running   — a run holds the lock right now
 *   ok        — last success within the threshold
 *   overdue   — enabled, but no success within the threshold
 */
async function automationStatus({ isRunning = false } = {}) {
  const settings = await getSettings();
  const [lastStarted, lastSuccess, lastFailure, settingsRow] = await Promise.all([
    SearchRun.findOne({ order: [['started_at', 'DESC']] }),
    SearchRun.findOne({ where: { status: 'completed', finished_at: { [Op.ne]: null } }, order: [['finished_at', 'DESC']] }),
    SearchRun.findOne({ where: { status: 'failed' }, order: [['finished_at', 'DESC']] }),
    Setting.findOne({ where: { key: AUTOMATION_SETTINGS_KEY } }),
  ]);

  const thresholdMinutes = config.automation.staleThresholdMinutes;
  // Never succeeded yet? Measure from when automation was last configured instead,
  // so turning it on doesn't instantly alert.
  const since = lastSuccess?.finished_at || settingsRow?.updatedAt || null;
  const minutesSinceSuccess = since ? Math.round((Date.now() - new Date(since).getTime()) / 60000) : null;

  let status = 'ok';
  if (!settings.enabled) status = 'disabled';
  else if (isRunning) status = 'running';
  else if (minutesSinceSuccess === null || minutesSinceSuccess > thresholdMinutes) status = 'overdue';

  return {
    status,
    enabled: !!settings.enabled,
    schedule: settings.schedule,
    threshold_minutes: thresholdMinutes,
    minutes_since_last_success: minutesSinceSuccess,
    last_started_at: lastStarted?.started_at || null,
    last_success_at: lastSuccess?.finished_at || null,
    last_failure_at: lastFailure?.finished_at || null,
    last_failure_error: lastFailure ? firstError(lastFailure).slice(0, 200) : null,
    last_run_status: lastStarted?.status || null,
    last_success_businesses_discovered: lastSuccess?.businesses_discovered ?? null,
  };
}

/** Heartbeat check, driven by an EXTERNAL cron — an asleep process can't check itself. */
async function checkAutomationHealth(opts) {
  const s = await automationStatus(opts);
  if (s.status === 'overdue') {
    await alerts.raise('automation_overdue', {
      'Last successful run': s.last_success_at ? new Date(s.last_success_at).toISOString() : 'never',
      'Minutes since last success': s.minutes_since_last_success ?? 'n/a',
      'Threshold (minutes)': s.threshold_minutes,
      'Last run status': s.last_run_status || 'none',
      'Last failure': s.last_failure_error || 'none recorded',
    });
  }
  return s;
}

// ---- startup / shutdown ------------------------------------------------------

async function reportStartup() {
  const previous = (await Setting.findOne({ where: { key: BOOT_KEY } }))?.value || null;
  const bootedAt = new Date().toISOString();
  await Setting.upsert({ key: BOOT_KEY, value: { id: bootId, at: bootedAt }, description: 'Last backend boot' });

  setTimeout(async () => {
    try {
      const clean = (await Setting.findOne({ where: { key: CLEAN_SHUTDOWN_KEY } }))?.value || null;
      const unexpected = !!previous && clean?.boot_id !== previous.id;
      await alerts.raise(unexpected ? 'backend_unexpected_restart' : 'backend_startup', {
        Environment: config.nodeEnv,
        Version: appVersion(),
        'Started at': bootedAt,
        'Previous instance started': previous?.at,
      });
    } catch (err) {
      console.error('[monitoring] startup report failed:', err.message);
    }
  }, STARTUP_CHECK_DELAY_MS);
}

/** Render sends SIGTERM on deploys, sleep and manual restarts — record it so the next boot knows. */
function installShutdownHook() {
  const onSignal = async (signal) => {
    const force = setTimeout(() => process.exit(0), 5000);
    try {
      await Setting.upsert({ key: CLEAN_SHUTDOWN_KEY, value: { boot_id: bootId, at: new Date().toISOString(), signal }, description: 'Last clean shutdown' });
    } catch (err) {
      console.error('[monitoring] could not record clean shutdown:', err.message);
    }
    clearTimeout(force);
    process.exit(0);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}

module.exports = { recordRunOutcome, automationStatus, checkAutomationHealth, reportStartup, installShutdownHook, isFailedRun, bootId };
