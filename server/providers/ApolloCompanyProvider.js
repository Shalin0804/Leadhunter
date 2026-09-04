const CompanyDataProvider = require('./CompanyDataProvider');
const config = require('../config/config');

/**
 * ApolloCompanyProvider — live company data from Apollo.io's REST API.
 *
 * Requires APOLLO_API_KEY (Apollo → Settings → Integrations → API). The key is
 * read server-side only and never exposed to the client.
 *
 * Compliance: this uses Apollo's licensed B2B database via their official API and
 * respects their rate limits and per-request credit costs. It is not a scraper.
 */
class ApolloCompanyProvider extends CompanyDataProvider {
  get key() {
    return 'apollo';
  }
  get label() {
    return 'Apollo.io';
  }

  isConfigured() {
    return !!config.apollo.apiKey;
  }

  async request(path, { method = 'GET', query, body } = {}) {
    if (!this.isConfigured()) throw new Error('Apollo is not configured (set APOLLO_API_KEY)');
    const url = new URL(config.apollo.baseUrl.replace(/\/$/, '') + path);
    if (query) Object.entries(query).forEach(([k, v]) => v != null && url.searchParams.set(k, v));

    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': config.apollo.apiKey,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!res.ok) {
      const msg = json?.error || json?.message || `Apollo API error ${res.status}`;
      const err = new Error(msg);
      err.statusCode = res.status === 401 || res.status === 403 ? 502 : res.status;
      err.apollo = json;
      throw err;
    }
    return json;
  }

  /**
   * Organization search.
   * @param {object} filters { name, locations[], industries[], keywords[], employeeRanges[], domains[] }
   * @param {object} pagination { page, perPage }
   */
  async searchCompanies(filters = {}, { page = 1, perPage = 25 } = {}) {
    const body = { page, per_page: Math.min(perPage, 100) };
    if (filters.name) body.q_organization_name = filters.name;
    if (filters.locations?.length) body.organization_locations = filters.locations;
    if (filters.keywords?.length) body.q_organization_keyword_tags = filters.keywords;
    if (filters.employeeRanges?.length) body.organization_num_employees_ranges = filters.employeeRanges;
    if (filters.domains?.length) body.q_organization_domains_list = filters.domains;
    if (filters.foundedYearMin || filters.foundedYearMax) {
      body.organization_founded_year_range = {
        min: filters.foundedYearMin || undefined,
        max: filters.foundedYearMax || undefined,
      };
    }

    const data = await this.request('/mixed_companies/search', { method: 'POST', body });

    // Merge both buckets; normalise the org id difference.
    const orgs = [
      ...(data.organizations || []).map((o) => ({ ...o, _apollo_org_id: o.id })),
      ...(data.accounts || []).map((a) => ({ ...a, _apollo_org_id: a.organization_id, primary_domain: a.domain })),
    ];

    return {
      items: orgs.map((o) => this.normalizeCompany(o)),
      pagination: {
        page: data.pagination?.page || page,
        perPage: data.pagination?.per_page || perPage,
        total: data.pagination?.total_entries || orgs.length,
        totalPages: data.pagination?.total_pages || 1,
      },
    };
  }

  /** Enrich a single organization by domain. 1 Apollo credit if found. */
  async enrichByDomain(domain) {
    const data = await this.request('/organizations/enrich', { method: 'GET', query: { domain } });
    if (!data.organization) return null;
    return this.normalizeCompany({ ...data.organization, _apollo_org_id: data.organization.id });
  }

  async getCompanyById(domain) {
    return this.enrichByDomain(domain);
  }

  /** Map an Apollo org onto our canonical + extended company shape. */
  normalizeCompany(o = {}) {
    const phone =
      o.sanitized_phone ||
      o.phone ||
      o.primary_phone?.number ||
      (Array.isArray(o.phone_numbers) ? o.phone_numbers[0]?.sanitized_number || o.phone_numbers[0]?.raw_number : null) ||
      null;

    const website = o.website_url || (o.primary_domain ? `https://${o.primary_domain}` : null);

    return {
      // canonical
      company_name: o.name || null,
      cin: null,
      registration_number: null,
      date_of_incorporation: o.founded_year ? `${o.founded_year}-01-01` : null,
      company_status: 'Active',
      company_type: null,
      company_category: null,
      industry: o.industry || (Array.isArray(o.industries) ? o.industries[0] : null) || null,
      roc: null,
      state: o.state || null,
      city: o.city || null,
      registered_address:
        o.raw_address ||
        [o.street_address, o.city, o.state, o.postal_code, o.country].filter(Boolean).join(', ') ||
        null,
      authorized_capital: null,
      paid_up_capital: null,
      website,
      email: null, // org search does not return a business email; people enrichment does
      phone,

      // extended (persisted on companies)
      apollo_organization_id: o._apollo_org_id || o.id || null,
      linkedin_url: o.linkedin_url || null,
      employee_count: o.estimated_num_employees ?? o.organization_num_employees ?? null,
      annual_revenue: o.annual_revenue ?? o.organization_revenue ?? null,
      founded_year: o.founded_year ?? null,
      keywords: Array.isArray(o.keywords) ? o.keywords.slice(0, 20) : [],
      logo_url: o.logo_url || null,
    };
  }
}

module.exports = ApolloCompanyProvider;
