const CompanyDataProvider = require('./CompanyDataProvider');
const CsvCompanyProvider = require('./CsvCompanyProvider');
const MCAProvider = require('./MCAProvider');
const ApiCompanyProvider = require('./ApiCompanyProvider');

// Provider registry — add new sources here.
const registry = {
  csv: new CsvCompanyProvider(),
  mca: new MCAProvider(),
  api: new ApiCompanyProvider(),
};

const getProvider = (key = 'csv') => {
  const p = registry[key];
  if (!p) throw new Error(`Unknown company data provider: ${key}`);
  return p;
};

const listProviders = () =>
  Object.values(registry).map((p) => ({
    key: p.key,
    label: p.label,
    configured: p.isConfigured(),
  }));

module.exports = {
  CompanyDataProvider,
  CsvCompanyProvider,
  MCAProvider,
  ApiCompanyProvider,
  registry,
  getProvider,
  listProviders,
};
