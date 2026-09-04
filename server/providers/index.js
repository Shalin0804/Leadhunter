const CompanyDataProvider = require('./CompanyDataProvider');
const CsvCompanyProvider = require('./CsvCompanyProvider');
const CsvSignalProvider = require('./CsvSignalProvider');
const MCAProvider = require('./MCAProvider');
const ApiCompanyProvider = require('./ApiCompanyProvider');
const ApolloCompanyProvider = require('./ApolloCompanyProvider');
const OsmBusinessProvider = require('./OsmBusinessProvider');
const GooglePlacesProvider = require('./GooglePlacesProvider');
const YelpBusinessProvider = require('./YelpBusinessProvider');
const HunterProvider = require('./HunterProvider');

// Provider registry — add new sources here.
const registry = {
  csv: new CsvCompanyProvider(),
  'signal-csv': new CsvSignalProvider(),
  mca: new MCAProvider(),
  api: new ApiCompanyProvider(),
  apollo: new ApolloCompanyProvider(),
};

// Separate registry for automated *business discovery* sources (searchBusinesses()),
// as opposed to the company-data-import providers above (searchCompanies()).
const discoveryRegistry = {
  osm: new OsmBusinessProvider(),
  google_places: new GooglePlacesProvider(),
  yelp: new YelpBusinessProvider(),
};

// Separate registry for *contact enrichment* sources (domainSearch()/verifyEmail()).
const enrichmentRegistry = {
  hunter: new HunterProvider(),
};

const getProvider = (key = 'csv') => {
  const p = registry[key];
  if (!p) throw new Error(`Unknown company data provider: ${key}`);
  return p;
};

const getDiscoveryProvider = (key = 'osm') => {
  const p = discoveryRegistry[key];
  if (!p) throw new Error(`Unknown discovery provider: ${key}`);
  return p;
};

const getEnrichmentProvider = (key = 'hunter') => {
  const p = enrichmentRegistry[key];
  if (!p) throw new Error(`Unknown enrichment provider: ${key}`);
  return p;
};

const listProviders = () =>
  Object.values(registry).map((p) => ({ key: p.key, label: p.label, configured: p.isConfigured() }));

const listDiscoveryProviders = () =>
  Object.values(discoveryRegistry).map((p) => ({ key: p.key, label: p.label, configured: p.isConfigured() }));

const listEnrichmentProviders = () =>
  Object.values(enrichmentRegistry).map((p) => ({ key: p.key, label: p.label, configured: p.isConfigured() }));

module.exports = {
  CompanyDataProvider,
  CsvCompanyProvider,
  CsvSignalProvider,
  MCAProvider,
  ApiCompanyProvider,
  ApolloCompanyProvider,
  OsmBusinessProvider,
  GooglePlacesProvider,
  YelpBusinessProvider,
  HunterProvider,
  registry,
  discoveryRegistry,
  enrichmentRegistry,
  getProvider,
  getDiscoveryProvider,
  getEnrichmentProvider,
  listProviders,
  listDiscoveryProviders,
  listEnrichmentProviders,
};
