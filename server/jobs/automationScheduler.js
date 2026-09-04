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

async function fire(triggeredBy = 'scheduled') {
  if (running) {
    console.log('[automation] a run is already in progress — skipping this trigger');
    return { skipped: true };
  }
  running = true;
  try {
    console.log(`[automation] starting ${triggeredBy} discovery run`);
    const result = await runFullDiscovery({ triggeredBy });
    console.log(`[automation] run complete: ${result.runs?.length || 0} target(s) processed`);
    return result;
  } catch (err) {
    console.error('[automation] run failed:', err.message);
    return { error: err.message };
  } finally {
    running = false;
  }
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

module.exports = { reschedule, fire, isRunning: () => running, nextRunEstimate };
