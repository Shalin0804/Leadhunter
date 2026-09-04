const { Op, fn, col, literal } = require('sequelize');
const { Company, Lead, Task, Activity, User, Signal, SearchRun } = require('../models');
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
    notContactedLeads,
    repliedLeads,
    highPriorityLeads,
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
    Lead.count({ where: { contact_status: 'NOT_CONTACTED' } }),
    Lead.count({ where: { contact_status: 'REPLIED' } }),
    Lead.count({ where: { priority: 'HIGH' } }),
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
      notContactedLeads,
      repliedLeads,
      highPriorityLeads,
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

const leadWithCompany = {
  include: [{ model: Company, as: 'company', attributes: ['id', 'company_name', 'industry', 'city', 'state'] }, { model: User, as: 'assignedUser', attributes: ['id', 'name'] }],
};

exports.todaysWork = async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const [hotNotContacted, followUpsToday, overdueFollowUps, repliedLeads, proposalsPending, interestedLeads] = await Promise.all([
    Lead.findAll({ where: { lead_temperature: 'HOT', contact_status: 'NOT_CONTACTED' }, order: [['lead_score', 'DESC']], limit: 20, ...leadWithCompany }),
    Task.findAll({
      where: { is_follow_up: true, status: { [Op.notIn]: ['COMPLETED', 'CANCELLED'] }, due_date: { [Op.between]: [startOfDay, endOfDay] } },
      include: [{ model: Lead, as: 'lead', include: [{ model: Company, as: 'company', attributes: ['id', 'company_name'] }] }],
      order: [['due_date', 'ASC']],
    }),
    Task.findAll({
      where: { is_follow_up: true, status: { [Op.notIn]: ['COMPLETED', 'CANCELLED'] }, due_date: { [Op.lt]: startOfDay } },
      include: [{ model: Lead, as: 'lead', include: [{ model: Company, as: 'company', attributes: ['id', 'company_name'] }] }],
      order: [['due_date', 'ASC']],
    }),
    Lead.findAll({ where: { contact_status: 'REPLIED' }, order: [['last_contacted_at', 'DESC']], limit: 20, ...leadWithCompany }),
    Lead.findAll({ where: { contact_status: 'PROPOSAL_SENT' }, order: [['last_contacted_at', 'DESC']], limit: 20, ...leadWithCompany }),
    Lead.findAll({ where: { contact_status: 'INTERESTED' }, order: [['last_contacted_at', 'DESC']], limit: 20, ...leadWithCompany }),
  ]);

  return ok(res, { hotNotContacted, followUpsToday, overdueFollowUps, repliedLeads, proposalsPending, interestedLeads });
};

exports.dailySummary = async (req, res) => {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const [
    runsToday,
    hotLeadsToday,
    highPriorityToday,
    noWebsiteToday,
    followUpsToday,
    topLeads,
  ] = await Promise.all([
    SearchRun.findAll({ where: { started_at: { [Op.gte]: startOfDay } } }),
    Lead.count({ where: { lead_temperature: 'HOT', created_at: { [Op.gte]: startOfDay } } }),
    Lead.count({ where: { priority: 'HIGH', created_at: { [Op.gte]: startOfDay } } }),
    Company.count({ where: { has_website: false, first_discovered_at: { [Op.gte]: startOfDay } } }),
    Task.count({ where: { is_follow_up: true, due_date: { [Op.gte]: startOfDay, [Op.lt]: new Date(startOfDay.getTime() + 86400000) }, status: { [Op.notIn]: ['COMPLETED', 'CANCELLED'] } } }),
    Lead.findAll({ where: { contact_status: 'NOT_CONTACTED' }, order: [['lead_score', 'DESC']], limit: 5, ...leadWithCompany }),
  ]);

  const newLeadsFound = runsToday.reduce((s, r) => s + r.qualified_leads, 0);
  const duplicatesSkipped = runsToday.reduce((s, r) => s + r.duplicates_skipped, 0);
  const alreadyContactedSkipped = runsToday.reduce((s, r) => s + r.already_contacted_skipped, 0);
  const businessesDiscovered = runsToday.reduce((s, r) => s + r.businesses_discovered, 0);

  return ok(res, {
    date: startOfDay.toISOString().slice(0, 10),
    searchRuns: runsToday.length,
    businessesDiscovered,
    newLeadsFound,
    hotLeads: hotLeadsToday,
    highPriority: highPriorityToday,
    noWebsite: noWebsiteToday,
    duplicatesSkipped,
    alreadyContactedSkipped,
    followUpsDueToday: followUpsToday,
    topLeads,
  });
};

exports.activityFeed = async (req, res) => {
  const activities = await Activity.findAll({
    include: [{ model: User, as: 'user', attributes: ['id', 'name'] }],
    order: [['occurred_at', 'DESC']],
    limit: 20,
  });
  return ok(res, { activities });
};
