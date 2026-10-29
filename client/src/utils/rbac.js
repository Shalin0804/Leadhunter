export const ROLE_LABELS = { admin: 'Main Admin', manager: 'Manager', agent: 'BDE / Sales Exec', viewer: 'Viewer' };
export const ROLE_TONE = { admin: 'hot', manager: 'blue', agent: 'green', viewer: 'gray' };
export const STATUS_TONE = { active: 'green', invited: 'warm', inactive: 'not_qualified' };

export const ACTION_LABELS = {
  'auth.login': 'Signed in',
  'auth.login_failed': 'Failed sign-in',
  'auth.logout': 'Signed out',
  'auth.invite_accepted': 'Accepted invite',
  'auth.password_reset_initiated': 'Password reset started',
  'auth.password_reset_completed': 'Password reset completed',
  'user.invited': 'Employee invited',
  'user.role_changed': 'Role changed',
  'user.activated': 'Account activated',
  'user.deactivated': 'Account deactivated',
  'user.updated': 'Employee updated',
  'lead.viewed': 'Lead opened',
  'lead.searched': 'Lead search',
  'lead.created': 'Lead created',
  'lead.updated': 'Lead edited',
  'lead.status_changed': 'Pipeline status changed',
  'lead.contact_status_changed': 'Contact status changed',
  'lead.lead_status_changed': 'Qualification changed',
  'lead.contacted': 'Contact attempt recorded',
  'lead.recontacted': 'Re-contact started',
  'lead.assigned': 'Lead assigned',
  'lead.reassigned': 'Lead reassigned',
  'lead.unassigned': 'Lead unassigned',
  'lead.bulk_assigned': 'Bulk assignment',
  'lead.note_added': 'Note added',
  'lead.note_deleted': 'Note deleted',
  'lead.follow_up_added': 'Follow-up added',
  'lead.outreach_generated': 'Outreach drafted',
  'lead.deleted': 'Lead deleted',
  'lead.exported': 'Leads exported',
  'contact.phone_revealed': 'Phone viewed',
  'contact.email_revealed': 'Email viewed',
  'contact.revealed': 'Contact viewed',
  'company.viewed': 'Company details viewed',
  'task.created': 'Task created',
  'task.updated': 'Task updated',
  'task.completed': 'Task completed',
  'task.deleted': 'Task deleted',
  'audit.exported': 'Activity log exported',
  'location.created': 'Location created',
  'location.updated': 'Location renamed',
  'location.config_changed': 'Location settings changed',
  'location.activated': 'Location activated',
  'location.deactivated': 'Location deactivated',
  'location.deleted': 'Location deleted',
  'location.searched': 'Location search',
  'location.import_started': 'Country import started',
  'location.import_completed': 'Country import completed',
  'location.import_failed': 'Country import failed',
  'location.import_resumed': 'Country import resumed',
  'location.import_cancel_requested': 'Country import cancel requested',
  'location.import_cancelled': 'Country import cancelled',
  'discovery.location_selected': 'Location selected for discovery',
  'discovery.started': 'Business discovery started',
  'discovery.completed': 'Business discovery finished',
  'discovery.categories_changed': 'Business categories changed',
};

export const actionLabel = (a) => ACTION_LABELS[a] || a;

const ACTION_TONE = { contact: 'warm', auth: 'gray', user: 'blue', export: 'hot' };
export const actionTone = (a = '') =>
  a.endsWith('exported') || a === 'lead.deleted' ? ACTION_TONE.export : a === 'auth.login_failed' ? 'not_qualified' : ACTION_TONE[a.split('.')[0]] || 'green';

export const DISPLAY_TZ = 'Asia/Kolkata';
export const fmtIST = (d, tz = DISPLAY_TZ) =>
  d ? new Date(d).toLocaleString('en-IN', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';

/** yyyy-mm-dd for "today minus n days" in the display timezone. */
export const istDate = (daysAgo = 0) => new Date(Date.now() - daysAgo * 86400000).toLocaleDateString('en-CA', { timeZone: DISPLAY_TZ });

export const leadCode = (id) => (id ? `LEAD-${id}` : '—');
