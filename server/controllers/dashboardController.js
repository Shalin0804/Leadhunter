const { Op, fn, col, literal } = require('sequelize');
const { Company, Lead, Task, Activity, User, Signal } = require('../models');
const { ok } = require('../utils/http');

const LeadModel = Lead;
const COUNT_DESC = [fn('COUNT', col('id')), 'DESC'];

// Postgres returns COUNT()/SUM() as strings; MySQL as numbers. Normalize.
const numify = (rows, ...fields) =>
  rows.map((r) => {
    const out = { ...r };
    for (const f of fields) if (out[f] !== undefined && out[f] !== null) out[f] = Number(out[f]);
    return out;
  });

// Portable "bucket the lead score" expression (raw column name is identical on both dialects).
const SCORE_BUCKET =
  "CASE WHEN lead_score >= 90 THEN '90-100' WHEN lead_score >= 75 THEN '75-89' " +
  "WHEN lead_score >= 50 THEN '50-74' WHEN lead_score >= 30 THEN '30-49' ELSE '0-29' END";

const daysAgoISO = (n) => new Date(Date.now() - n * 86400000);

exports.stats = async (req, res) => {
  const recentDate = daysAgoISO(30).toISOString().slice(0, 10);

  const [
    totalCompanies,
    newCompanies,
    qualifiedLeads,
    hotLeads,
    contactedLeads,
    followUpsDue,
    meetings,
    proposals,
    wonLeads,
    lostLeads,
    totalLeads,
    activeSignals,
    signalsThisWeek,
  ] = await Promise.all([
    Company.count(),
    Company.count({ where: { date_of_incorporation: { [Op.gte]: recentDate } } }),
    Lead.count({ where: { status: { [Op.in]: ['QUALIFIED', 'CONTACTED', 'REPLIED', 'MEETING', 'PROPOSAL', 'NEGOTIATION', 'WON'] } } }),
    Lead.count({ where: { lead_temperature: 'HOT' } }),
    Lead.count({ where: { status: 'CONTACTED' } }),
    Task.count({ where: { is_follow_up: true, status: { [Op.notIn]: ['COMPLETED', 'CANCELLED'] }, due_date: { [Op.lte]: new Date() } } }),
    Lead.count({ where: { status: 'MEETING' } }),
    Lead.count({ where: { status: 'PROPOSAL' } }),
    Lead.count({ where: { status: 'WON' } }),
    Lead.count({ where: { status: 'LOST' } }),
    Lead.count(),
    Signal.count({ where: { status: { [Op.in]: ['NEW', 'REVIEWED'] } } }),
    Signal.count({ where: { captured_at: { [Op.gte]: daysAgoISO(7) } } }),
  ]);

  // charts — run in parallel
  const [newByDay, byIndustry, byState, scoreBucketsRaw, pipeline] = await Promise.all([
    Company.findAll({
      where: { date_of_incorporation: { [Op.gte]: daysAgoISO(60).toISOString().slice(0, 10) } },
      attributes: [['date_of_incorporation', 'day'], [fn('COUNT', col('id')), 'count']],
      group: ['date_of_incorporation'],
      order: [['date_of_incorporation', 'ASC']],
      raw: true,
    }),
    Company.findAll({
      attributes: ['industry', [fn('COUNT', col('id')), 'count']],
      group: ['industry'],
      order: [COUNT_DESC],
      limit: 10,
      raw: true,
    }),
    Company.findAll({
      attributes: ['state', [fn('COUNT', col('id')), 'count']],
      group: ['state'],
      order: [COUNT_DESC],
      limit: 10,
      raw: true,
    }),
    Company.findAll({
      attributes: [[literal(SCORE_BUCKET), 'bucket'], [fn('COUNT', col('id')), 'count']],
      group: [literal(SCORE_BUCKET)],
      raw: true,
    }),
    Lead.findAll({
      attributes: ['status', [fn('COUNT', col('id')), 'count'], [fn('COALESCE', fn('SUM', col('estimated_value')), 0), 'value']],
      group: ['status'],
      raw: true,
    }),
  ]);

  const scoreBuckets = ['0-29', '30-49', '50-74', '75-89', '90-100'].map((b) => ({
    bucket: b,
    count: Number(scoreBucketsRaw.find((r) => r.bucket === b)?.count || 0),
  }));

  const conversionRate = totalLeads ? Math.round((wonLeads / totalLeads) * 1000) / 10 : 0;

  return ok(res, {
    cards: {
      totalCompanies,
      newCompanies,
      qualifiedLeads,
      hotLeads,
      contactedLeads,
      followUpsDue,
      meetings,
      proposals,
      wonLeads,
      lostLeads,
      activeSignals,
      signalsThisWeek,
    },
    charts: {
      newByDay: numify(newByDay, 'count'),
      byIndustry: numify(byIndustry, 'count'),
      byState: numify(byState, 'count'),
      scoreBuckets,
      pipeline: LeadModel.STATUSES.map((s) => {
        const row = pipeline.find((p) => p.status === s);
        return { status: s, count: row ? Number(row.count) : 0, value: row ? Number(row.value) : 0 };
      }),
      conversionRate,
    },
  });
};

exports.opportunities = async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
  const companies = await Company.findAll({
    order: [['lead_score', 'DESC'], ['date_of_incorporation', 'DESC']],
    limit,
    include: [
      { model: Lead, as: 'leads', attributes: ['id', 'status'] },
      { model: Signal, as: 'signals', attributes: ['id', 'service', 'source', 'status'], separate: true },
    ],
  });

  const items = companies.map((c) => {
    const activeSignal = (c.signals || []).find((s) => ['NEW', 'REVIEWED'].includes(s.status));
    return {
      id: c.id,
      company_name: c.company_name,
      date_of_incorporation: c.date_of_incorporation,
      industry: c.industry,
      location: [c.city, c.state].filter(Boolean).join(', '),
      website: c.website,
      website_status: c.has_website ? 'Has website' : 'No website',
      lead_score: c.lead_score,
      lead_temperature: c.lead_temperature,
      recommended_service: c.recommended_service,
      crm_status: c.leads?.[0]?.status || 'Not a lead',
      lead_id: c.leads?.[0]?.id || null,
      has_signal: !!activeSignal,
      signal_service: activeSignal?.service || null,
      signal_source: activeSignal?.source || null,
    };
  });

  return ok(res, { items });
};

exports.activityFeed = async (req, res) => {
  const activities = await Activity.findAll({
    include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    order: [['occurred_at', 'DESC']],
    limit: 20,
  });
  return ok(res, { activities });
};
