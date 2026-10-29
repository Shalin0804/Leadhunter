const sequelize = require('../config/database');

const User = require('./User')(sequelize);
const Company = require('./Company')(sequelize);
const CompanyContact = require('./CompanyContact')(sequelize);
const CompanyWebsite = require('./CompanyWebsite')(sequelize);
const CompanySocial = require('./CompanySocial')(sequelize);
const Lead = require('./Lead')(sequelize);
const LeadScore = require('./LeadScore')(sequelize);
const LeadStatusHistory = require('./LeadStatusHistory')(sequelize);
const Activity = require('./Activity')(sequelize);
const Task = require('./Task')(sequelize);
const Note = require('./Note')(sequelize);
const Setting = require('./Setting')(sequelize);
const CompanyImport = require('./CompanyImport')(sequelize);
const CompanyImportError = require('./CompanyImportError')(sequelize);
const Signal = require('./Signal')(sequelize);
const LeadSource = require('./LeadSource')(sequelize);
const SearchRun = require('./SearchRun')(sequelize);
const ApiUsage = require('./ApiUsage')(sequelize);
const Outreach = require('./Outreach')(sequelize);
const DetectedSignal = require('./DetectedSignal')(sequelize);
const HermesResearchRun = require('./HermesResearchRun')(sequelize);
const HermesResearchEvidence = require('./HermesResearchEvidence')(sequelize);
const LeadExport = require('./LeadExport')(sequelize);
const AuditLog = require('./AuditLog')(sequelize);
const LeadAssignment = require('./LeadAssignment')(sequelize);
const Location = require('./Location')(sequelize);
const LocationImportJob = require('./LocationImportJob')(sequelize);
const BusinessCategory = require('./BusinessCategory')(sequelize);
const DiscoveryJob = require('./DiscoveryJob')(sequelize);
const DuplicateReview = require('./DuplicateReview')(sequelize);

/* ---------------- Associations ---------------- */

// Company -> presence
Company.hasMany(CompanyContact, { as: 'contacts', foreignKey: 'company_id', onDelete: 'CASCADE' });
CompanyContact.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });

Company.hasMany(CompanyWebsite, { as: 'websites', foreignKey: 'company_id', onDelete: 'CASCADE' });
CompanyWebsite.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });

Company.hasMany(CompanySocial, { as: 'socials', foreignKey: 'company_id', onDelete: 'CASCADE' });
CompanySocial.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });

// Company -> Leads
Company.hasMany(Lead, { as: 'leads', foreignKey: 'company_id', onDelete: 'CASCADE' });
Lead.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });

// User -> Leads
User.hasMany(Lead, { as: 'assignedLeads', foreignKey: 'assigned_user_id' });
Lead.belongsTo(User, { as: 'assignedUser', foreignKey: 'assigned_user_id' });
Lead.belongsTo(User, { as: 'createdBy', foreignKey: 'created_by_user_id' });

// Lead scores
Company.hasMany(LeadScore, { as: 'scoreHistory', foreignKey: 'company_id', onDelete: 'CASCADE' });
LeadScore.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });
Lead.hasMany(LeadScore, { as: 'scoreHistory', foreignKey: 'lead_id' });
LeadScore.belongsTo(Lead, { as: 'lead', foreignKey: 'lead_id' });

// Lead status history
Lead.hasMany(LeadStatusHistory, { as: 'statusHistory', foreignKey: 'lead_id', onDelete: 'CASCADE' });
LeadStatusHistory.belongsTo(Lead, { as: 'lead', foreignKey: 'lead_id' });
LeadStatusHistory.belongsTo(User, { as: 'changedBy', foreignKey: 'changed_by_user_id' });

// Activities
Lead.hasMany(Activity, { as: 'activities', foreignKey: 'lead_id', onDelete: 'CASCADE' });
Activity.belongsTo(Lead, { as: 'lead', foreignKey: 'lead_id' });
Company.hasMany(Activity, { as: 'activities', foreignKey: 'company_id', onDelete: 'CASCADE' });
Activity.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });
Activity.belongsTo(User, { as: 'user', foreignKey: 'user_id' });

// Tasks
Lead.hasMany(Task, { as: 'tasks', foreignKey: 'lead_id', onDelete: 'CASCADE' });
Task.belongsTo(Lead, { as: 'lead', foreignKey: 'lead_id' });
Company.hasMany(Task, { as: 'tasks', foreignKey: 'company_id', onDelete: 'CASCADE' });
Task.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });
Task.belongsTo(User, { as: 'assignedUser', foreignKey: 'assigned_user_id' });
Task.belongsTo(User, { as: 'createdBy', foreignKey: 'created_by_user_id' });

// Notes
Lead.hasMany(Note, { as: 'notes', foreignKey: 'lead_id', onDelete: 'CASCADE' });
Note.belongsTo(Lead, { as: 'lead', foreignKey: 'lead_id' });
Company.hasMany(Note, { as: 'notes', foreignKey: 'company_id', onDelete: 'CASCADE' });
Note.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });
Note.belongsTo(User, { as: 'user', foreignKey: 'user_id' });

// Signals (buying intent)
Company.hasMany(Signal, { as: 'signals', foreignKey: 'company_id', onDelete: 'CASCADE' });
Signal.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });
Lead.hasMany(Signal, { as: 'signals', foreignKey: 'lead_id' });
Signal.belongsTo(Lead, { as: 'lead', foreignKey: 'lead_id' });
Signal.belongsTo(User, { as: 'createdBy', foreignKey: 'created_by_user_id' });

// Lead sources (discovery hits) + search runs
SearchRun.belongsTo(User, { as: 'triggeredByUser', foreignKey: 'triggered_by_user_id' });
SearchRun.hasMany(LeadSource, { as: 'leadSources', foreignKey: 'search_run_id' });
LeadSource.belongsTo(SearchRun, { as: 'searchRun', foreignKey: 'search_run_id' });
Company.hasMany(LeadSource, { as: 'sources', foreignKey: 'company_id', onDelete: 'CASCADE' });
LeadSource.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });

// Outreach
Company.hasMany(Outreach, { as: 'outreach', foreignKey: 'company_id', onDelete: 'CASCADE' });
Outreach.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });
Lead.hasMany(Outreach, { as: 'outreach', foreignKey: 'lead_id' });
Outreach.belongsTo(Lead, { as: 'lead', foreignKey: 'lead_id' });
Outreach.belongsTo(User, { as: 'createdBy', foreignKey: 'created_by_user_id' });

// Detected (auto-inferred) signals
Company.hasMany(DetectedSignal, { as: 'detectedSignals', foreignKey: 'company_id', onDelete: 'CASCADE' });
DetectedSignal.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });

// Hermes Agent research runs + evidence
Company.hasMany(HermesResearchRun, { as: 'hermesResearchRuns', foreignKey: 'company_id', onDelete: 'CASCADE' });
HermesResearchRun.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });
HermesResearchRun.belongsTo(User, { as: 'triggeredByUser', foreignKey: 'triggered_by_user_id' });
HermesResearchRun.hasMany(HermesResearchEvidence, { as: 'evidence', foreignKey: 'research_run_id', onDelete: 'CASCADE' });
HermesResearchEvidence.belongsTo(HermesResearchRun, { as: 'researchRun', foreignKey: 'research_run_id' });
Company.hasMany(HermesResearchEvidence, { as: 'hermesEvidence', foreignKey: 'company_id', onDelete: 'CASCADE' });
HermesResearchEvidence.belongsTo(Company, { as: 'company', foreignKey: 'company_id' });

// Team hierarchy
User.belongsTo(User, { as: 'manager', foreignKey: 'manager_id', constraints: false });
User.hasMany(User, { as: 'reports', foreignKey: 'manager_id', constraints: false });

// Audit trail + assignment history (no FK constraints: audit rows must outlive deleted leads/users)
AuditLog.belongsTo(User, { as: 'actor', foreignKey: 'actor_user_id', constraints: false });
AuditLog.belongsTo(Lead, { as: 'lead', foreignKey: 'lead_id', constraints: false });
AuditLog.belongsTo(Company, { as: 'company', foreignKey: 'company_id', constraints: false });
Lead.hasMany(LeadAssignment, { as: 'assignments', foreignKey: 'lead_id', constraints: false });
LeadAssignment.belongsTo(User, { as: 'previousUser', foreignKey: 'previous_user_id', constraints: false });
LeadAssignment.belongsTo(User, { as: 'newUser', foreignKey: 'new_user_id', constraints: false });
LeadAssignment.belongsTo(User, { as: 'assignedBy', foreignKey: 'assigned_by_user_id', constraints: false });

// Geographic locations (separate from companies; no FK to keep imports independent)
Location.belongsTo(Location, { as: 'parent', foreignKey: 'parent_id', constraints: false });
Location.hasMany(Location, { as: 'children', foreignKey: 'parent_id', constraints: false });
Location.belongsTo(User, { as: 'createdBy', foreignKey: 'created_by_user_id', constraints: false });
LocationImportJob.belongsTo(User, { as: 'startedBy', foreignKey: 'started_by_user_id', constraints: false });

BusinessCategory.belongsTo(BusinessCategory, { as: 'parent', foreignKey: 'parent_id', constraints: false });
DiscoveryJob.belongsTo(Location, { as: 'location', foreignKey: 'location_id', constraints: false });
DiscoveryJob.belongsTo(BusinessCategory, { as: 'category', foreignKey: 'business_category_id', constraints: false });
SearchRun.belongsTo(Location, { as: 'location', foreignKey: 'location_id', constraints: false });
SearchRun.belongsTo(BusinessCategory, { as: 'category', foreignKey: 'business_category_id', constraints: false });
DuplicateReview.belongsTo(Company, { as: 'company', foreignKey: 'company_id', constraints: false });
DuplicateReview.belongsTo(Company, { as: 'candidate', foreignKey: 'candidate_company_id', constraints: false });

// Excel export audit trail
LeadExport.belongsTo(User, { as: 'user', foreignKey: 'user_id' });

// Imports
User.hasMany(CompanyImport, { as: 'imports', foreignKey: 'user_id' });
CompanyImport.belongsTo(User, { as: 'user', foreignKey: 'user_id' });
CompanyImport.hasMany(CompanyImportError, { as: 'errors', foreignKey: 'import_id', onDelete: 'CASCADE' });
CompanyImportError.belongsTo(CompanyImport, { as: 'import', foreignKey: 'import_id' });

const db = {
  sequelize,
  Sequelize: require('sequelize'),
  User,
  Company,
  CompanyContact,
  CompanyWebsite,
  CompanySocial,
  Lead,
  LeadScore,
  LeadStatusHistory,
  Activity,
  Task,
  Note,
  Setting,
  CompanyImport,
  CompanyImportError,
  Signal,
  LeadSource,
  SearchRun,
  ApiUsage,
  Outreach,
  DetectedSignal,
  HermesResearchRun,
  HermesResearchEvidence,
  LeadExport,
  AuditLog,
  LeadAssignment,
  Location,
  LocationImportJob,
  BusinessCategory,
  DiscoveryJob,
  DuplicateReview,
};

module.exports = db;
