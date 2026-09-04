const { sequelize, Company, CompanyContact, CompanyWebsite, Activity } = require('../models');
const { getProvider } = require('../providers');
const { rescoreCompany } = require('./companyService');
const { domainOf } = require('./signalService');

const apollo = () => getProvider('apollo');

async function search(filters, pagination) {
  return apollo().searchCompanies(filters, pagination);
}

/** Find an existing company for an Apollo result (by apollo id, then website domain, then name). */
async function findExistingForApolloResult(item, transaction) {
  if (item.apollo_organization_id) {
    const byApolloId = await Company.findOne({ where: { apollo_organization_id: item.apollo_organization_id }, transaction });
    if (byApolloId) return byApolloId;
  }
  const dom = domainOf(item.website);
  if (dom) {
    const websites = await CompanyWebsite.findAll({ transaction });
    const hit = websites.find((w) => domainOf(w.url) === dom);
    if (hit) return Company.findByPk(hit.company_id, { transaction });
  }
  if (item.company_name) {
    return Company.findOne({ where: { company_name: item.company_name }, transaction });
  }
  return null;
}

/** Persist one normalized Apollo result as a company (create or update+enrich). */
async function upsertCompany(item, { userId } = {}) {
  return sequelize.transaction(async (transaction) => {
    let company = await findExistingForApolloResult(item, transaction);
    let created = false;

    const fields = {
      company_name: item.company_name,
      industry: item.industry || undefined,
      state: item.state || undefined,
      city: item.city || undefined,
      registered_address: item.registered_address || undefined,
      website: item.website || undefined,
      apollo_organization_id: item.apollo_organization_id || undefined,
      linkedin_url: item.linkedin_url || undefined,
      employee_count: item.employee_count ?? undefined,
      annual_revenue: item.annual_revenue ?? undefined,
      founded_year: item.founded_year ?? undefined,
      date_of_incorporation: item.date_of_incorporation || undefined,
      enriched_at: new Date(),
      enrichment_source: 'apollo',
    };
    // strip undefined so we never clobber existing data with nulls
    Object.keys(fields).forEach((k) => fields[k] === undefined && delete fields[k]);

    if (company) {
      await company.update(fields, { transaction });
    } else {
      company = await Company.create(
        { ...fields, company_status: 'Active', source: 'apollo' },
        { transaction }
      );
      created = true;
    }

    if (item.phone) {
      await CompanyContact.findOrCreate({
        where: { company_id: company.id, type: 'phone', value: item.phone },
        defaults: { is_primary: true, label: 'Company (Apollo)' },
        transaction,
      });
    }
    if (item.website) {
      await CompanyWebsite.findOrCreate({
        where: { company_id: company.id, url: item.website },
        defaults: { status: 'unknown', is_https: /^https:/i.test(item.website) },
        transaction,
      });
    }

    const contacts = await company.getContacts({ transaction });
    const websites = await company.getWebsites({ transaction });
    company.has_email = contacts.some((c) => c.type === 'email') || company.has_email;
    company.has_phone = contacts.some((c) => c.type === 'phone') || company.has_phone;
    company.has_website = websites.length > 0 || !!company.website;
    await company.save({ transaction });

    await Activity.create(
      {
        company_id: company.id,
        user_id: userId || null,
        type: 'system',
        title: created ? 'Company created from Apollo' : 'Company enriched from Apollo',
        body: item.phone ? `Added company phone ${item.phone}` : null,
      },
      { transaction }
    );

    await rescoreCompany(company.id, { transaction });
    return { company, created };
  });
}

/** Import a batch of Apollo search results (already fetched) as companies. */
async function importResults(items, { userId } = {}) {
  const results = [];
  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    const r = await upsertCompany(item, { userId });
    results.push(r);
  }
  return {
    created: results.filter((r) => r.created).length,
    updated: results.filter((r) => !r.created).length,
    companies: results.map((r) => r.company),
  };
}

/** Enrich a single existing company by looking up its website domain on Apollo. */
async function enrichCompany(companyId, { userId } = {}) {
  const company = await Company.findByPk(companyId, { include: [{ model: CompanyWebsite, as: 'websites' }] });
  if (!company) return { ok: false, message: 'Company not found' };

  const website = company.website || company.websites?.[0]?.url;
  const dom = domainOf(website);
  if (!dom) return { ok: false, message: 'This company has no website on file — add one first, or search Apollo by name instead.' };

  const result = await apollo().enrichByDomain(dom);
  if (!result) return { ok: false, message: `No Apollo match for ${dom}` };

  const { company: updated } = await upsertCompany({ ...result, company_name: result.company_name || company.company_name }, { userId });
  return { ok: true, company: updated, apollo: result };
}

module.exports = { search, importResults, upsertCompany, enrichCompany, apollo };
