const CompanyDataProvider = require('./CompanyDataProvider');
const CsvCompanyProvider = require('./CsvCompanyProvider');
const CsvSignalProvider = require('./CsvSignalProvider');
const MCAProvider = require('./MCAProvider');
const ApiCompanyProvider = require('./ApiCompanyProvider');
const ApolloCompanyProvider = require('./ApolloCompanyProvider');

// Provider registry — add new sources here.
const registry = {
  csv: new CsvCompanyProvider(),
  'signal-csv': new CsvSignalProvider(),
  mca: new MCAProvider(),
  api: new ApiCompanyProvider(),
  apollo: new ApolloCompanyProvider(),
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
  CsvSignalProvider,
  MCAProvider,
  ApiCompanyProvider,
  ApolloCompanyProvider,
  registry,
  getProvider,
  listProviders,
};
