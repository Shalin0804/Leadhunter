/**
 * In-process scheduler for automatic lead generation. Uses node-cron so a
 * job fires on its own timer as long as this Node process is alive.
 *
 * IMPORTANT — Render's free tier (and similar) sleeps the process after ~15
 * minutes idle, so this alone will NOT reliably fire a daily 9am job on a
 * free instance. The companion route POST /api/automation/run-scheduled
 * (secured by AUTOMATION_TRIGGER_SECRET) exists for exactly that case: point
 * an external cron service (cron-job.org, a GitHub Actions scheduled
 * workflow, Render's own Cron Job add-on) at it and it works regardless of
 * whether this in-process timer happened to be awake.
 */
const cron = require('node-cron');
const { getSettings } = require('../services/automationSettingsService');
const { runFullDiscovery } = require('../services/discoveryOrchestrator');

const CRON_EXPRESSIONS = {
  daily_9am: '0 9 * * *',
  every_6h: '0 */6 * * *',
  every_12h: '0 */12 * * *',
  weekly: '0 9 * * 1',
};

let currentTask = null;
let running = false;

function cronExpressionFor(settings) {
  if (settings.schedule === 'custom' && settings.customCron) return settings.customCron;
  return CRON_EXPRESSIONS[settings.schedule] || CRON_EXPRESSIONS.daily_9am;
}

/**
 * The single concurrency gate for every way a discovery run can start
 * (in-process cron, manual "Run Now", and the external-cron-secured
 * /api/automation/run-scheduled endpoint) — all three MUST go through this,
 * not call runFullDiscovery/runForTarget directly, or `running` never gets
 * set and a second overlapping trigger runs concurrently uncontested.
 *
 * The isRunning() check-and-set below is synchronous (no `await` between
 * them), so it's race-free even against two requests arriving back-to-back —
 * Node only yields the event loop at an `await`/I-O point, and there isn't
 * one until after `running` is already true.
 */
async function withRunLock(triggeredBy, task) {
  if (running) {
    console.log(`[automation] a run is already in progress — ${triggeredBy} trigger skipped`);
    return { skipped: true, message: 'A run is already in progress — skipped.' };
  }
  running = true;
  try {
    console.log(`[automation] starting ${triggeredBy} discovery run`);
    const result = await task();
    console.log(`[automation] ${triggeredBy} run complete`);
    return result;
  } catch (err) {
    console.error(`[automation] ${triggeredBy} run failed:`, err.message);
    return { error: err.message };
  } finally {
    running = false;
  }
}

async function fire(triggeredBy = 'scheduled') {
  return withRunLock(triggeredBy, () => runFullDiscovery({ triggeredBy }));
}

/**
 * Best-effort "next run" estimate for the dashboard — computed directly from
 * the fixed schedule presets. Returns null for a disabled scheduler or a
 * custom cron expression (not worth hand-rolling a cron parser for a display
 * hint; the run still fires correctly either way).
 */
function nextRunEstimate(settings) {
  if (!settings.enabled) return null;
  const now = new Date();
  if (settings.schedule === 'daily_9am') {
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }
  if (settings.schedule === 'every_6h' || settings.schedule === 'every_12h') {
    const stepH = settings.schedule === 'every_6h' ? 6 : 12;
    const next = new Date(now);
    next.setMinutes(0, 0, 0);
    next.setHours(Math.ceil((next.getHours() + 1) / stepH) * stepH);
    return next;
  }
  if (settings.schedule === 'weekly') {
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    let diff = (1 - next.getDay() + 7) % 7; // next Monday
    if (diff === 0 && next <= now) diff = 7;
    next.setDate(next.getDate() + diff);
    return next;
  }
  return null; // custom cron — not estimated
}

/** (Re)build the cron job from current settings. Safe to call any time settings change. */
async function reschedule() {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }

  const settings = await getSettings();
  if (!settings.enabled) {
    console.log('[automation] scheduler disabled (Automation Settings -> Enable Automatic Lead Generation)');
    return;
  }

  const expr = cronExpressionFor(settings);
  if (!cron.validate(expr)) {
    console.error(`[automation] invalid cron expression "${expr}" — scheduler not started`);
    return;
  }

  currentTask = cron.schedule(expr, () => fire('scheduled'));
  console.log(`[automation] scheduler active: "${expr}" (${settings.schedule})`);
}

module.exports = { reschedule, fire, withRunLock, isRunning: () => running, nextRunEstimate };
