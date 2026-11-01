/**
 * Role -> permission matrix. The single source of truth for RBAC; the server
 * enforces it (middleware/auth.js requirePermission + services/accessService.js)
 * and the client only reads it to hide UI it can't use anyway.
 *
 * Role keys keep the existing DB values: admin = Main Admin, agent = BDE / Sales Executive.
 * Lead *visibility* is scoped separately (accessService.visibleUserIds): admin sees
 * everything, a manager sees their own + their team's leads, everyone else only theirs.
 */
const ROLES = ['admin', 'manager', 'agent', 'viewer'];

const ROLE_LABELS = { admin: 'Main Admin', manager: 'Manager', agent: 'BDE / Sales Executive', viewer: 'Viewer' };

const PERMISSIONS = {
  'leads.view': 'View leads within your scope',
  'leads.edit': 'Update status, record contact attempts, add notes, tasks and follow-ups',
  'leads.create': 'Convert companies into leads',
  'leads.delete': 'Delete leads',
  'leads.assign': 'Assign and reassign leads (managers: within their team)',
  'leads.export': 'Export leads to CSV / Excel',
  'contacts.reveal': 'Reveal a lead\'s phone numbers and email addresses (each reveal is logged)',
  'contacts.view_unmasked': 'Receive contact details unmasked without a per-field reveal',
  'discovery.use': 'Company discovery, automation, imports, signals and provider integrations',
  'discovery.run': 'Run business discovery on admin-approved locations (leads found are assigned to you)',
  'locations.manage': 'Import, add, edit, deactivate and delete geographic locations',
  'dashboard.view': 'Company-wide dashboard',
  'team.view': 'View team members',
  'users.manage': 'Invite, edit, activate/deactivate employees and change roles',
  'audit.view': 'View activity logs within your scope',
  'audit.export': 'Export activity logs to CSV',
  'performance.view': 'Team performance reports within your scope',
  'settings.manage': 'Admin settings',
  'agent.manage': 'AI Agent control center: Claude Code connection, tasks, activity, reports and approvals',
  'email.send': 'Send email from the official mailbox (Titan): composer, bulk campaigns, follow-ups, reply sync and email settings',
};

const ALL = Object.keys(PERMISSIONS);

const MATRIX = {
  admin: ALL,
  manager: ['leads.view', 'leads.edit', 'leads.assign', 'contacts.reveal', 'discovery.run', 'team.view', 'audit.view', 'performance.view'],
  agent: ['leads.view', 'leads.edit', 'contacts.reveal', 'audit.view'],
  viewer: ['leads.view', 'audit.view'],
};

// Requests made with a Claude Code agent token act as the admin who issued it, minus
// these: the agent never sees raw contact values or manages people, settings or exports.
const AGENT_DENIED = ['contacts.reveal', 'contacts.view_unmasked', 'users.manage', 'settings.manage', 'leads.delete', 'leads.export', 'audit.export', 'locations.manage', 'email.send'];

const permissionsFor = (role) => MATRIX[role] || [];
const can = (user, permission) =>
  !!user && user.is_active !== false && permissionsFor(user.role).includes(permission) && !(user.is_agent && AGENT_DENIED.includes(permission));

module.exports = { ROLES, ROLE_LABELS, PERMISSIONS, MATRIX, AGENT_DENIED, permissionsFor, can };
