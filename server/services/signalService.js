const { Op } = require('sequelize');
const {
  sequelize,
  Company,
  CompanyContact,
  CompanyWebsite,
  Signal,
  Lead,
  Activity,
} = require('../models');
const { rescoreCompany } = require('./companyService');
const { convertCompanyToLead } = require('./leadService');
const { likeOp } = require('../utils/dialect');

const domainOf = (url) => {
  if (!url) return null;
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Find the company a signal belongs to, or create a lightweight one.
 * Match priority: CIN → website domain → exact-ish name.
 */
async function matchOrCreateCompany(input, { transaction, userId } = {}) {
  const { cin, company_name, website, email, phone, industry, state, city } = input;

  let company = null;
  if (cin) company = await Company.findOne({ where: { cin: String(cin).toUpperCase() }, transaction });

  if (!company && website) {
    const dom = domainOf(website);
    if (dom) {
      const hits = await CompanyWebsite.findAll({
        where: { url: { [likeOp]: `%${dom}%` } },
        include: [{ model: Company, as: 'company' }],
        transaction,
      });
      company = hits[0]?.company || null;
    }
  }

  if (!company && company_name) {
    company = await Company.findOne({
      where: { company_name: { [likeOp]: company_name.trim() } },
      transaction,
    });
  }

  let created = false;
  if (!company) {
    company = await Company.create(
      {
        company_name: (company_name || 'Unknown (from signal)').trim(),
        cin: cin ? String(cin).toUpperCase() : null,
        industry: industry || null,
        state: state || null,
        city: city || null,
        website: website || null,
        company_status: 'Active',
        source: 'signal',
      },
      { transaction }
    );
    created = true;
    if (email) await CompanyContact.create({ company_id: company.id, type: 'email', value: String(email).toLowerCase(), is_primary: true }, { transaction });
    if (phone) await CompanyContact.create({ company_id: company.id, type: 'phone', value: String(phone), is_primary: true }, { transaction });
    if (website) await CompanyWebsite.create({ company_id: company.id, url: website, is_https: /^https:/i.test(website) }, { transaction });

    const contacts = await company.getContacts({ transaction });
    const websites = await company.getWebsites({ transaction });
    company.has_email = contacts.some((c) => c.type === 'email');
    company.has_phone = contacts.some((c) => c.type === 'phone');
    company.has_website = websites.length > 0 || !!company.website;
    await company.save({ transaction });
  }

  return { company, created };
}

/** Create a single signal, matching/creating its company, then rescore. */
async function createSignal(payload, { userId } = {}) {
  return sequelize.transaction(async (transaction) => {
    const { company, created } = await matchOrCreateCompany(
      {
        cin: payload.cin,
        company_name: payload.company_name || payload.company_name_raw,
        website: payload.website || payload.website_raw,
        email: payload.contact_email,
        phone: payload.contact_phone,
        industry: payload.industry,
        state: payload.state,
        city: payload.city,
      },
      { transaction, userId }
    );

    const existingLead = await Lead.findOne({ where: { company_id: company.id }, transaction });

    const signal = await Signal.create(
      {
        company_id: company.id,
        lead_id: existingLead?.id || null,
        created_by_user_id: userId || null,
        service: Signal.SERVICES.includes(payload.service) ? payload.service : 'OTHER',
        source: Signal.SOURCES.includes(payload.source) ? payload.source : 'manual',
        source_url: payload.source_url || null,
        headline: payload.headline || null,
        detail: payload.detail || null,
        contact_name: payload.contact_name || null,
        contact_email: payload.contact_email || null,
        contact_phone: payload.contact_phone || null,
        company_name_raw: payload.company_name || payload.company_name_raw || null,
        website_raw: payload.website || payload.website_raw || null,
        confidence: ['LOW', 'MEDIUM', 'HIGH'].includes(payload.confidence) ? payload.confidence : 'MEDIUM',
        status: 'NEW',
        captured_at: payload.captured_at ? new Date(payload.captured_at) : new Date(),
        import_id: payload.import_id || null,
        raw: payload.raw || null,
      },
      { transaction }
    );

    await Activity.create(
      {
        company_id: company.id,
        lead_id: existingLead?.id || null,
        user_id: userId || null,
        type: 'system',
        title: `Buying signal: ${signal.service.replace(/_/g, ' ')} via ${signal.source}`,
        body: signal.headline || signal.detail || null,
        meta: { signal_id: signal.id },
      },
      { transaction }
    );

    await rescoreCompany(company.id, { transaction, leadId: existingLead?.id });

    return { signal, company, companyCreated: created, matchedLead: existingLead?.id || null };
  });
}

/** Turn a signal's company into a lead (or attach to the existing one). */
async function convertSignal(signalId, { userId, assignedUserId, priority } = {}) {
  const signal = await Signal.findByPk(signalId);
  if (!signal) return null;

  const { lead, created } = await convertCompanyToLead(signal.company_id, {
    userId,
    assignedUserId,
    priority,
  });

  signal.lead_id = lead.id;
  signal.status = 'CONVERTED';
  await signal.save();

  await Activity.create({
    lead_id: lead.id,
    company_id: signal.company_id,
    user_id: userId || null,
    type: 'system',
    title: 'Lead created from buying signal',
    body: `${signal.service.replace(/_/g, ' ')} · ${signal.source}`,
  });

  return { lead, created, signal };
}

module.exports = { createSignal, convertSignal, matchOrCreateCompany, domainOf };
