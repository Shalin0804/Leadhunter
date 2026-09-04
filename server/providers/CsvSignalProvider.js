const { parse } = require('csv-parse/sync');
const CompanyDataProvider = require('./CompanyDataProvider');
const { SERVICES, SOURCES } = require('../models/Signal');

/**
 * Parses a CSV of buying signals — exports from tools you are permitted to use
 * (LinkedIn Lead Gen Forms, Meta Lead Ads, Typeform, your website contact form,
 * a manually maintained sheet). This is NOT a scraper.
 */
const HEADER_ALIASES = {
  company_name: ['company_name', 'company', 'organisation', 'organization', 'business_name', 'account'],
  cin: ['cin'],
  website: ['website', 'url', 'company_website', 'web'],
  contact_name: ['contact_name', 'name', 'full_name', 'first_name'],
  contact_email: ['contact_email', 'email', 'work_email', 'email_address'],
  contact_phone: ['contact_phone', 'phone', 'phone_number', 'mobile'],
  service: ['service', 'service_interest', 'interested_in', 'requirement', 'need', 'project_type'],
  source: ['source', 'channel', 'platform', 'lead_source'],
  source_url: ['source_url', 'post_url', 'link', 'permalink'],
  headline: ['headline', 'subject', 'title', 'summary'],
  detail: ['detail', 'message', 'notes', 'description', 'comments', 'enquiry'],
  captured_at: ['captured_at', 'date', 'created_time', 'timestamp', 'submitted_at'],
  industry: ['industry', 'sector'],
  state: ['state', 'region'],
  city: ['city', 'location'],
  confidence: ['confidence', 'quality'],
};

const norm = (h) => String(h || '').trim().toLowerCase().replace(/[\s.-]+/g, '_');

const SERVICE_KEYWORDS = [
  [/redesign|revamp|refresh/i, 'WEBSITE_REDESIGN'],
  [/e-?commerce|online store|shopify|woocommerce/i, 'ECOMMERCE'],
  [/\bcrm\b|salesforce|hubspot|pipeline|lead management/i, 'CRM'],
  [/mobile app|android|ios|flutter|react native/i, 'MOBILE_APP'],
  [/software|saas|web app|application|platform|automation|api|erp/i, 'SOFTWARE_DEVELOPMENT'],
  [/seo|marketing|ads|social media|branding/i, 'DIGITAL_MARKETING'],
  [/website|web ?site|landing page|web development|web design/i, 'WEBSITE_DEVELOPMENT'],
];

function mapService(raw) {
  if (!raw) return 'OTHER';
  const up = String(raw).trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (SERVICES.includes(up)) return up;
  for (const [re, val] of SERVICE_KEYWORDS) if (re.test(raw)) return val;
  return 'OTHER';
}

function mapSource(raw) {
  if (!raw) return 'csv';
  const low = String(raw).trim().toLowerCase();
  const direct = SOURCES.find((s) => low.includes(s));
  if (direct) return direct;
  if (/insta/.test(low)) return 'instagram';
  if (/linked/.test(low)) return 'linkedin';
  if (/fb|facebook|meta/.test(low)) return 'facebook';
  if (/whats ?app|wa\b/.test(low)) return 'referral';
  if (/form|site|web/.test(low)) return 'inbound_form';
  return 'csv';
}

class CsvSignalProvider extends CompanyDataProvider {
  get key() {
    return 'signal-csv';
  }
  get label() {
    return 'Buying Signals CSV';
  }

  parse(input) {
    const records = parse(input, {
      columns: (headers) => headers.map((h) => norm(h)),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    });

    const present = records.length ? Object.keys(records[0]) : [];
    const headerMap = {};
    const used = new Set();
    for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
      const found = present.find((h) => aliases.includes(h));
      if (found) {
        headerMap[canonical] = found;
        used.add(found);
      }
    }

    const rows = records.map((rec) => {
      const raw = {};
      for (const canonical of Object.keys(HEADER_ALIASES)) {
        const src = headerMap[canonical];
        raw[canonical] = src ? rec[src] ?? null : null;
      }
      raw._original = rec;
      return raw;
    });

    // Need at least something identifying the prospect.
    const requiredPresent = !!(headerMap.company_name || headerMap.website || headerMap.contact_email);
    return { rows, headerMap, unknownHeaders: present.filter((h) => !used.has(h)), requiredPresent };
  }

  validateRow(raw, rowNumber) {
    const errors = [];
    const v = {
      company_name: raw.company_name ? String(raw.company_name).trim() : null,
      cin: raw.cin ? String(raw.cin).trim().toUpperCase() : null,
      website: raw.website ? String(raw.website).trim() : null,
      contact_name: raw.contact_name ? String(raw.contact_name).trim() : null,
      contact_email: raw.contact_email ? String(raw.contact_email).trim().toLowerCase() : null,
      contact_phone: raw.contact_phone ? String(raw.contact_phone).trim() : null,
      service: mapService(raw.service),
      source: mapSource(raw.source),
      source_url: raw.source_url ? String(raw.source_url).trim() : null,
      headline: raw.headline ? String(raw.headline).trim().slice(0, 255) : null,
      detail: raw.detail ? String(raw.detail).trim() : null,
      industry: raw.industry || null,
      state: raw.state || null,
      city: raw.city || null,
      confidence: ['LOW', 'MEDIUM', 'HIGH'].includes(String(raw.confidence).toUpperCase())
        ? String(raw.confidence).toUpperCase()
        : 'MEDIUM',
      captured_at: null,
      raw: raw._original,
    };

    if (raw.captured_at) {
      const d = new Date(raw.captured_at);
      if (!Number.isNaN(d.getTime())) v.captured_at = d.toISOString();
    }

    if (!v.company_name && !v.website && !v.contact_email) {
      errors.push({ row_number: rowNumber, field: 'company_name', message: 'Row has no company name, website or contact email' });
    }
    if (v.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.contact_email)) {
      errors.push({ row_number: rowNumber, field: 'contact_email', message: 'Invalid email' });
      v.contact_email = null;
    }

    return { valid: errors.length === 0, errors, value: v };
  }

  async importCompanies(rawRows) {
    const records = [];
    const errors = [];
    rawRows.forEach((raw, idx) => {
      const rowNumber = idx + 2;
      const { valid, errors: e, value } = this.validateRow(raw, rowNumber);
      if (valid) records.push({ rowNumber, value });
      else errors.push(...e.map((x) => ({ ...x, raw_row: raw._original })));
    });
    return { records, errors };
  }
}

CsvSignalProvider.mapService = mapService;
CsvSignalProvider.mapSource = mapSource;
module.exports = CsvSignalProvider;
