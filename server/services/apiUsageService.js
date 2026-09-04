const { Op } = require('sequelize');
const { ApiUsage } = require('../models');

const todayISO = () => new Date().toISOString().slice(0, 10);

/** Current usage row for a provider today (creates one at zero if missing). */
async function getTodayUsage(provider) {
  const [row] = await ApiUsage.findOrCreate({
    where: { provider, usage_date: todayISO() },
    defaults: { request_count: 0, leads_created_count: 0 },
  });
  return row;
}

/** Increment today's counters for a provider, optionally bumping arbitrary metadata counters. */
async function recordUsage(provider, { requests = 1, leadsCreated = 0, metadataDelta } = {}) {
  const row = await getTodayUsage(provider);
  row.request_count += requests;
  row.leads_created_count += leadsCreated;
  if (metadataDelta) {
    const meta = { ...(row.metadata || {}) };
    for (const [k, v] of Object.entries(metadataDelta)) meta[k] = (meta[k] || 0) + v;
    row.metadata = meta;
    row.changed('metadata', true); // JSON column mutation needs an explicit flag for Sequelize to persist it
  }
  await row.save();
  return row;
}

/** Has this provider already hit today's cap? */
async function hasReachedDailyLimit(provider, dailyLimit) {
  if (!dailyLimit) return false;
  const row = await getTodayUsage(provider);
  return row.leads_created_count >= dailyLimit;
}

async function remainingToday(provider, dailyLimit) {
  if (!dailyLimit) return Infinity;
  const row = await getTodayUsage(provider);
  return Math.max(0, dailyLimit - row.leads_created_count);
}

async function history(days = 14) {
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  return ApiUsage.findAll({ where: { usage_date: { [Op.gte]: since } }, order: [['usage_date', 'DESC']] });
}

module.exports = { getTodayUsage, recordUsage, hasReachedDailyLimit, remainingToday, history, todayISO };
