const CompanyDataProvider = require('./CompanyDataProvider');

/**
 * ApiCompanyProvider — generic template for a third-party company-data API
 * (enrichment / discovery vendor). Phase 1: inert, no credentials required.
 *
 * A concrete implementation would:
 *   - read an API key from config
 *   - implement searchCompanies() against the vendor's search endpoint
 *   - map the vendor payload in normalizeCompany()
 *   - respect the vendor's rate limits and licensing terms
 */
class ApiCompanyProvider extends CompanyDataProvider {
  constructor(options = {}) {
    super(options);
    this.baseUrl = options.baseUrl || process.env.COMPANY_API_URL || null;
    this.apiKey = options.apiKey || process.env.COMPANY_API_KEY || null;
  }

  get key() {
    return 'api';
  }
  get label() {
    return 'External Company API (Phase 2)';
  }

  isConfigured() {
    return !!(this.baseUrl && this.apiKey);
  }

  async searchCompanies() {
    if (!this.isConfigured()) throw new Error('ApiCompanyProvider is not configured');
    throw new Error('ApiCompanyProvider.searchCompanies not implemented in Phase 1');
  }

  async getCompanyById() {
    if (!this.isConfigured()) throw new Error('ApiCompanyProvider is not configured');
    throw new Error('ApiCompanyProvider.getCompanyById not implemented in Phase 1');
  }

  async importCompanies() {
    throw new Error('ApiCompanyProvider.importCompanies not implemented in Phase 1');
  }
}

module.exports = ApiCompanyProvider;
