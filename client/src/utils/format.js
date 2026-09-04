export const fmtDate = (d) => {
  if (!d) return '—';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
};

export const fmtDateTime = (d) => {
  if (!d) return '—';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
};

export const fmtRelative = (d) => {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const abs = Math.abs(diff);
  const day = 86400000;
  const units = [
    ['year', 365 * day],
    ['month', 30 * day],
    ['day', day],
    ['hour', 3600000],
    ['minute', 60000],
  ];
  for (const [name, ms] of units) {
    if (abs >= ms) {
      const n = Math.round(diff / ms);
      const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
      return rtf.format(-n, name);
    }
  }
  return 'just now';
};

export const fmtMoney = (n) => {
  if (n === null || n === undefined || n === '') return '—';
  const num = Number(n);
  if (Number.isNaN(num)) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(num);
};

export const fmtNumber = (n) => new Intl.NumberFormat('en-IN').format(Number(n) || 0);

export const initials = (name = '') =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join('') || '?';

export const TEMP_LABELS = {
  HOT: 'Hot',
  HIGH: 'High',
  WARM: 'Warm',
  LOW: 'Low',
  NOT_QUALIFIED: 'Not qualified',
};

export const STATUS_LABELS = {
  NEW: 'New',
  QUALIFIED: 'Qualified',
  CONTACTED: 'Contacted',
  REPLIED: 'Replied',
  MEETING: 'Meeting',
  PROPOSAL: 'Proposal',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
};

export const titleCase = (s = '') => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export const SIGNAL_SERVICE_LABELS = {
  WEBSITE_DEVELOPMENT: 'Website Development',
  WEBSITE_REDESIGN: 'Website Redesign',
  SOFTWARE_DEVELOPMENT: 'Software Development',
  MOBILE_APP: 'Mobile App',
  CRM: 'CRM',
  ECOMMERCE: 'E-commerce',
  DIGITAL_MARKETING: 'Digital Marketing',
  OTHER: 'Other',
};

export const SIGNAL_SOURCE_LABELS = {
  linkedin: 'LinkedIn',
  instagram: 'Instagram',
  facebook: 'Facebook',
  twitter: 'Twitter / X',
  youtube: 'YouTube',
  referral: 'Referral',
  inbound_form: 'Inbound form',
  event: 'Event',
  marketplace: 'Marketplace',
  cold_outreach: 'Cold outreach',
  manual: 'Manual',
  csv: 'CSV import',
};

export const SIGNAL_STATUS_LABELS = {
  NEW: 'New',
  REVIEWED: 'Reviewed',
  CONVERTED: 'Converted',
  DISMISSED: 'Dismissed',
};

export const CONTACT_STATUS_LABELS = {
  NOT_CONTACTED: 'Not Contacted',
  CONTACTED: 'Contacted',
  FOLLOW_UP: 'Follow-up',
  REPLIED: 'Replied',
  INTERESTED: 'Interested',
  MEETING_BOOKED: 'Meeting Booked',
  PROPOSAL_SENT: 'Proposal Sent',
  NEGOTIATION: 'Negotiation',
  WON: 'Won',
  LOST: 'Lost',
  NOT_INTERESTED: 'Not Interested',
  DO_NOT_CONTACT: 'Do Not Contact',
};

export const LEAD_QUALIFICATION_LABELS = {
  NEW: 'New',
  QUALIFIED: 'Qualified',
  UNQUALIFIED: 'Unqualified',
  ARCHIVED: 'Archived',
};

export const CONTACT_METHOD_LABELS = {
  EMAIL: 'Email',
  WHATSAPP: 'WhatsApp',
  PHONE: 'Phone',
  LINKEDIN: 'LinkedIn',
  INSTAGRAM: 'Instagram',
  OTHER: 'Other',
};

export const OPPORTUNITY_LABELS = {
  WEBSITE: 'Website',
  WEBSITE_REDESIGN: 'Website Redesign',
  CRM: 'CRM',
  BOOKING_SYSTEM: 'Booking System',
  APPOINTMENT_SYSTEM: 'Appointment System',
  ECOMMERCE: 'E-commerce',
  CUSTOM_SOFTWARE: 'Custom Software',
  MOBILE_APP: 'Mobile App',
  BUSINESS_AUTOMATION: 'Business Automation',
  ADMIN_DASHBOARD: 'Admin Dashboard',
};
