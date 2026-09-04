/**
 * Seed realistic demo data for development.
 *   npm run seed            -> upsert admin + demo dataset (idempotent-ish)
 *   npm run seed -- --wipe   -> delete existing demo data first
 *
 * All demo companies are flagged is_demo = true and shown with a "DEMO" badge in the UI.
 */
require('dotenv').config();
const config = require('../config/config');
const db = require('../models');
const { companies: DEMO, T, CAT, daysAgo } = require('./demoData');
const { rescoreCompany } = require('../services/companyService');
const { convertCompanyToLead, changeLeadStatus } = require('../services/leadService');

const {
  sequelize,
  User,
  Company,
  CompanyContact,
  CompanyWebsite,
  CompanySocial,
  Lead,
  Task,
  Note,
  Activity,
  Setting,
} = db;

const WIPE = process.argv.includes('--wipe');

async function ensureAdmin() {
  const email = config.admin.email.toLowerCase();
  let user = await User.findOne({ where: { email } });
  if (!user) {
    user = await User.create({
      name: config.admin.name,
      email,
      password_hash: await User.hashPassword(config.admin.password),
      role: 'admin',
    });
    console.log(`[seed] created admin ${email}`);
  } else {
    user.password_hash = await User.hashPassword(config.admin.password);
    user.role = 'admin';
    user.is_active = true;
    await user.save();
    console.log(`[seed] admin ${email} password reset to ADMIN_PASSWORD`);
  }
  return user;
}

async function ensureTeam() {
  const defs = [
    { name: 'Riya Sharma', email: 'riya@leadhunter.local', role: 'manager' },
    { name: 'Arjun Mehta', email: 'arjun@leadhunter.local', role: 'agent' },
    { name: 'Neha Verma', email: 'neha@leadhunter.local', role: 'agent' },
  ];
  const users = [];
  for (const d of defs) {
    const [u] = await User.findOrCreate({
      where: { email: d.email },
      defaults: { name: d.name, role: d.role, password_hash: await User.hashPassword('Agent@123456') },
    });
    users.push(u);
  }
  return users;
}

async function wipeDemo() {
  console.log('[seed] --wipe: removing existing demo data');
  const demoCompanies = await Company.findAll({ where: { is_demo: true }, attributes: ['id'] });
  const ids = demoCompanies.map((c) => c.id);
  if (ids.length) {
    const leads = await Lead.findAll({ where: { company_id: ids }, attributes: ['id'] });
    const leadIds = leads.map((l) => l.id);
    await Task.destroy({ where: { [db.Sequelize.Op.or]: [{ company_id: ids }, { lead_id: leadIds }] } });
    await Note.destroy({ where: { [db.Sequelize.Op.or]: [{ company_id: ids }, { lead_id: leadIds }] } });
    await Activity.destroy({ where: { [db.Sequelize.Op.or]: [{ company_id: ids }, { lead_id: leadIds }] } });
    await Lead.destroy({ where: { company_id: ids } });
    await Company.destroy({ where: { id: ids } });
  }
}

async function seedCompanies() {
  const created = [];
  for (const d of DEMO) {
    const existing = await Company.findOne({ where: { cin: d.cin } });
    if (existing) {
      created.push(existing);
      continue;
    }
    const company = await Company.create({
      company_name: d.company_name,
      cin: d.cin,
      registration_number: d.cin.slice(-6),
      date_of_incorporation: d.doi,
      company_status: 'Active',
      company_type: T,
      company_category: CAT,
      industry: d.industry,
      roc: d.roc,
      state: d.state,
      city: d.city,
      registered_address: `${Math.floor(Math.random() * 400) + 1}, ${d.city} Business Park, ${d.state}`,
      authorized_capital: d.auth,
      paid_up_capital: d.paid,
      website: d.website || null,
      source: 'seed',
      is_demo: true,
    });

    if (d.email) await CompanyContact.create({ company_id: company.id, type: 'email', value: d.email, is_primary: true, is_public_business: true });
    if (d.phone) await CompanyContact.create({ company_id: company.id, type: 'phone', value: d.phone, is_primary: true });
    if (d.website)
      await CompanyWebsite.create({
        company_id: company.id,
        url: d.website,
        status: 'live',
        is_https: /^https:/i.test(d.website),
        health: d.websiteHealth || 'fair',
        last_checked_at: new Date(),
      });
    if (d.social)
      await CompanySocial.create({ company_id: company.id, platform: d.social, url: `https://${d.social}.com/${company.company_name.toLowerCase().replace(/[^a-z]+/g, '')}` });

    company.has_email = !!d.email;
    company.has_phone = !!d.phone;
    company.has_website = !!d.website;
    await company.save();

    await rescoreCompany(company.id);
    await Activity.create({ company_id: company.id, type: 'import', title: 'Seeded demo company', occurred_at: new Date(d.doi) });
    created.push(company);
  }
  console.log(`[seed] companies: ${created.length}`);
  return created;
}

async function seedLeads(companies, team, admin) {
  // Pick the 18 highest-scoring companies and convert them.
  const ranked = [...companies].sort((a, b) => b.lead_score - a.lead_score).slice(0, 18);
  const stagePlan = [
    'NEW', 'NEW', 'NEW',
    'QUALIFIED', 'QUALIFIED', 'QUALIFIED',
    'CONTACTED', 'CONTACTED',
    'REPLIED', 'REPLIED',
    'MEETING', 'MEETING',
    'PROPOSAL', 'PROPOSAL',
    'NEGOTIATION',
    'WON', 'WON',
    'LOST',
  ];
  const assignees = [admin, ...team];
  let i = 0;
  const leads = [];
  for (const company of ranked) {
    const assignee = assignees[i % assignees.length];
    const { lead } = await convertCompanyToLead(company.id, {
      userId: admin.id,
      assignedUserId: assignee.id,
      priority: ['LOW', 'MEDIUM', 'HIGH'][i % 3],
      estimatedValue: [45000, 80000, 120000, 250000, 60000][i % 5],
    });

    const targetStage = stagePlan[i] || 'NEW';
    const path = Lead.STATUSES.slice(0, Lead.STATUSES.indexOf(targetStage) + 1).filter((s) => s !== 'LOST');
    for (const s of path.slice(1)) {
      // eslint-disable-next-line no-await-in-loop
      await changeLeadStatus(lead.id, s, { userId: assignee.id, note: `Moved to ${s}` });
    }
    if (targetStage === 'LOST') {
      await changeLeadStatus(lead.id, 'LOST', { userId: assignee.id, note: 'Budget not available this quarter' });
    }

    // follow-up tasks
    if (['CONTACTED', 'REPLIED', 'MEETING', 'PROPOSAL', 'NEGOTIATION'].includes(targetStage)) {
      const overdue = i % 3 === 0;
      await Task.create({
        lead_id: lead.id,
        company_id: company.id,
        assigned_user_id: assignee.id,
        created_by_user_id: admin.id,
        title: overdue ? `Follow up with ${company.company_name}` : `Send recap to ${company.company_name}`,
        description: 'Auto-generated demo follow-up task.',
        due_date: new Date(Date.now() + (overdue ? -2 : 3) * 86400000),
        priority: overdue ? 'HIGH' : 'MEDIUM',
        status: 'TODO',
        is_follow_up: true,
      });
      await Lead.update(
        { next_follow_up_at: new Date(Date.now() + (overdue ? -2 : 3) * 86400000) },
        { where: { id: lead.id } }
      );
    }

    await Note.create({
      lead_id: lead.id,
      company_id: company.id,
      user_id: assignee.id,
      body: `Initial research done. ${company.recommended_service} looks like the best fit for ${company.company_name}.`,
    });

    leads.push(lead);
    i += 1;
  }

  // A couple of standalone overdue tasks not tied to a follow-up
  await Task.create({
    assigned_user_id: admin.id,
    created_by_user_id: admin.id,
    title: 'Review this week new-company import',
    due_date: new Date(Date.now() - 86400000),
    priority: 'MEDIUM',
    status: 'TODO',
  });

  console.log(`[seed] leads: ${leads.length}`);
  return leads;
}

async function seedSettings() {
  await Setting.findOrCreate({
    where: { key: 'demo_mode' },
    defaults: { value: { enabled: true }, description: 'Indicates seeded demo data is present' },
  });
}

async function run() {
  await sequelize.authenticate();
  // Ensure the schema exists (idempotent) — real changes belong in `npm run migrate`.
  await sequelize.sync();

  if (WIPE) await wipeDemo();

  const admin = await ensureAdmin();
  const team = await ensureTeam();
  const companies = await seedCompanies();
  await seedLeads(companies, team, admin);
  await seedSettings();

  console.log('\n[seed] done.');
  console.log(`       Login: ${config.admin.email} / ${config.admin.password}`);
  await sequelize.close();
  process.exit(0);
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
