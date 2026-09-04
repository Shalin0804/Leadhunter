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
};

module.exports = db;
