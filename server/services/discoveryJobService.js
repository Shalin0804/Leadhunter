/**
 * Scheduled location x category discovery (models/DiscoveryJob.js).
 *
 * Execution model — honest about free hosting: jobs are rows with a next_run_at, not
 * timers. They run whenever the scheduler ticks: the in-process 15-minute check while
 * the API is awake, and the secret-protected /api/automation/run-scheduled endpoint an
 * external cron calls (which also wakes a sleeping Render instance). Everything runs
 * inside the global single-flight run lock, so discovery runs never overlap.
 *
 * Safety: a job is claimed atomically (running_since) before it runs; a claim older
 * than STALE_MS means the process died mid-run, so the job is marked interrupted and
 * re-queued. Failures back off exponentially (capped at the job's own interval).
 * Re-running a target never duplicates leads — the discovery engine dedups companies
 * and skips businesses that already have a lead.
 */
const { Op } = require('sequelize');
const { DiscoveryJob, BusinessCategory } = require('../models');

const STALE_MS = 2 * 3600 * 1000;
const PER_TICK = Math.max(1, parseInt(process.env.DISCOVERY_JOBS_PER_TICK || '3', 10));
const BASE_BACKOFF_MS = 15 * 60 * 1000;

const nextRun = (job, from = Date.now()) => new Date(from + DiscoveryJob.INTERVAL_MS[job.frequency]);

async function requeueInterrupted(now = new Date()) {
  const [n] = await DiscoveryJob.update(
    { running_since: null, last_status: 'interrupted', last_error: 'The server stopped while this job was running — re-queued', next_run_at: now },
    { where: { running_since: { [Op.lt]: new Date(now.getTime() - STALE_MS) } } }
  );
  return n;
}

async function dueJobs(now = new Date(), limit = PER_TICK) {
  return DiscoveryJob.findAll({
    where: { is_enabled: true, running_since: null, [Op.or]: [{ next_run_at: null }, { next_run_at: { [Op.lte]: now } }] },
    order: [['next_run_at', 'ASC'], ['id', 'ASC']],
    limit,
  });
}

/** Run one job. Must be called inside withRunLock. Never throws. */
async function runJob(job, { triggeredBy = 'scheduled', triggeredByUserId = null } = {}) {
  // Atomic claim: only one caller can move running_since from null.
  const [claimed] = await DiscoveryJob.update({ running_since: new Date() }, { where: { id: job.id, running_since: null } });
  if (!claimed) return { job_id: job.id, status: 'skipped', reason: 'already running' };

  // Lazy: the controller module requires the scheduler, which requires this service.
  const { buildTarget } = require('../controllers/leadDiscoveryController');
  const { runForTarget } = require('./discoveryOrchestrator');
  const { getSettings } = require('./automationSettingsService');
  const started = Date.now();
  try {
    const category = await BusinessCategory.findByPk(job.business_category_id);
    if (!category || !category.is_enabled) throw new Error('Business category is missing or disabled');
    const { label, target } = await buildTarget(job.location_id, { radiusKm: job.radius_km, maxResults: job.max_results }); // re-validates the location is still approved
    const settings = await getSettings();
    const run = await runForTarget({
      location: label,
      industry: category.keyword,
      providerKey: settings.provider,
      discoveryProviders: settings.discoveryProviders?.length ? settings.discoveryProviders : [settings.provider],
      minLeadScore: settings.minLeadScore,
      dailyLimit: settings.dailyLeadLimit,
      triggeredBy,
      triggeredByUserId,
      settings,
      target: { ...target, categoryId: category.id, jobId: job.id },
    });
    const failed = run.status === 'failed';
    await job.update({
      running_since: null,
      last_run_at: new Date(started),
      last_status: run.status,
      last_error: failed ? String(run.error_message || 'Run failed').slice(0, 500) : null,
      last_search_run_id: run.id,
      consecutive_failures: failed ? job.consecutive_failures + 1 : 0,
      next_run_at: failed ? new Date(Date.now() + Math.min(DiscoveryJob.INTERVAL_MS[job.frequency], BASE_BACKOFF_MS * 2 ** job.consecutive_failures)) : nextRun(job, started),
    });
    return { job_id: job.id, status: run.status, search_run_id: run.id };
  } catch (err) {
    const fails = job.consecutive_failures + 1;
    await job.update({
      running_since: null,
      last_run_at: new Date(started),
      last_status: 'failed',
      last_error: String(err.message).slice(0, 500),
      consecutive_failures: fails,
      next_run_at: new Date(Date.now() + Math.min(DiscoveryJob.INTERVAL_MS[job.frequency], BASE_BACKOFF_MS * 2 ** (fails - 1))),
    });
    return { job_id: job.id, status: 'failed', error: err.message };
  }
}

/** Run up to PER_TICK due jobs, one after another. Call inside withRunLock. */
async function runDueJobs(opts = {}) {
  const interrupted = await requeueInterrupted();
  const results = [];
  for (const job of await dueJobs()) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await runJob(job, opts));
  }
  return { interrupted, results };
}

/** Cheap check so the 15-minute tick doesn't take the run lock for nothing. */
async function hasDueJobs() {
  const stale = await DiscoveryJob.count({ where: { running_since: { [Op.lt]: new Date(Date.now() - STALE_MS) } } });
  return stale > 0 || (await dueJobs(new Date(), 1)).length > 0;
}

module.exports = { runDueJobs, runJob, hasDueJobs, nextRun, requeueInterrupted, STALE_MS };
