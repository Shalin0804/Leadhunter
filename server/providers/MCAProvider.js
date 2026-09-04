const CompanyDataProvider = require('./CompanyDataProvider');

/**
 * MCAProvider — placeholder for a future integration with an official / licensed
 * Ministry of Corporate Affairs style dataset (e.g. data.gov.in bulk company
 * master data, or a licensed data partner).
 *
 * Phase 1: not active. It exists so the provider registry and UI can already
 * reason about "where companies come from" without code changes later.
 *
 * IMPORTANT: any real implementation must use an official API / licensed dataset
 * and respect its terms — no scraping of the MCA portal.
 */
class MCAProvider extends CompanyDataProvider {
  get key() {
    return 'mca';
  }
  get label() {
    return 'MCA / Official Registry (Phase 2)';
  }

  isConfigured() {
    return false; // enable once a licensed dataset / API key is wired in
  }

  async searchCompanies() {
    throw new Error('MCAProvider is not available in Phase 1');
  }

  async getCompanyById() {
    throw new Error('MCAProvider is not available in Phase 1');
  }

  async importCompanies() {
    throw new Error('MCAProvider is not available in Phase 1');
  }
}

module.exports = MCAProvider;
