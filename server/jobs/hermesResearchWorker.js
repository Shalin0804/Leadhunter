/**
 * Bounded-concurrency executor for Hermes research runs. Every entry point
 * (the manual "Research with Hermes" button today; future bulk/automation
 * triggers) goes through `enqueue()` so the number of simultaneous live
 * Hermes Agent runs never exceeds HERMES_MAX_CONCURRENT — same failure-
 * isolation spirit as automationScheduler's single-flight withRunLock, just
 * N-wide instead of 1-wide, since many single-lead research clicks (or a
 * future bulk call) can legitimately overlap.
 */
const config = require('../config/config');
const { researchCompany } = require('../services/hermes/hermesResearchService');

let active = 0;
const pending = []; // FIFO of { run, resolve, reject }

function pump() {
  if (active >= config.hermes.maxConcurrent || pending.length === 0) return;
  const job = pending.shift();
  active += 1;
  job
    .run()
    .then(job.resolve, job.reject)
    .finally(() => {
      active -= 1;
      pump();
    });
}

/** Queue a company research job; resolves/rejects like calling it directly, just rate-limited. */
function enqueue(companyId, opts) {
  return new Promise((resolve, reject) => {
    pending.push({ run: () => researchCompany(companyId, opts), resolve, reject });
    pump();
  });
}

function status() {
  return { active, queued: pending.length, maxConcurrent: config.hermes.maxConcurrent };
}

module.exports = { enqueue, status };
