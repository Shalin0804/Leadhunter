/**
 * CompanyDataProvider — interface-style base class.
 *
 * Every data source (CSV upload, MCA dataset, third-party API) implements this
 * contract so the rest of the app never needs to know where a company came from.
 *
 * Subclasses should override the methods they support and leave the rest throwing.
 */

const CANONICAL_FIELDS = [
  'company_name',
  'cin',
  'registration_number',
  'date_of_incorporation',
  'company_status',
  'company_type',
  'company_category',
  'industry',
  'roc',
  'state',
  'city',
  'registered_address',
  'authorized_capital',
  'paid_up_capital',
  'website',
  'email',
  'phone',
];

class CompanyDataProvider {
  constructor(options = {}) {
    this.options = options;
  }

  /** Machine name, e.g. "csv", "mca", "api". */
  get key() {
    throw new Error('provider must define a key');
  }

  /** Human label for the UI. */
  get label() {
    return this.key;
  }

  /** Whether this provider is usable in the current environment (creds present, etc). */
  isConfigured() {
    return true;
  }

  /* eslint-disable no-unused-vars */

  /** Search remote/source companies. Returns { items, total }. */
  async searchCompanies(query, pagination) {
    throw new Error(`${this.key}: searchCompanies not implemented`);
  }

  /** Fetch a single source company by its native id. */
  async getCompanyById(id) {
    throw new Error(`${this.key}: getCompanyById not implemented`);
  }

  /**
   * Turn a batch of raw source rows into { records, errors }.
   * `records` are normalized + validated canonical objects ready to persist.
   */
  async importCompanies(rawRows, context) {
    throw new Error(`${this.key}: importCompanies not implemented`);
  }

  /* eslint-enable no-unused-vars */

  /** Map an arbitrary source row onto the canonical company shape. */
  normalizeCompany(raw) {
    const out = {};
    for (const f of CANONICAL_FIELDS) out[f] = raw[f] !== undefined ? raw[f] : null;
    return out;
  }

  /**
   * Validate a normalized canonical record.
   * @returns {{ valid: boolean, errors: Array<{field,message}>, value: object }}
   */
  validateCompany(record) {
    const errors = [];
    const value = { ...record };

    if (!value.company_name || String(value.company_name).trim().length < 2) {
      errors.push({ field: 'company_name', message: 'Company name is required' });
    } else {
      value.company_name = String(value.company_name).trim();
    }

    if (value.cin) {
      value.cin = String(value.cin).trim().toUpperCase();
      if (value.cin.length < 6 || value.cin.length > 30) {
        errors.push({ field: 'cin', message: 'CIN looks invalid (expected 6-30 chars)' });
      }
    }

    if (value.date_of_incorporation) {
      const d = new Date(value.date_of_incorporation);
      if (Number.isNaN(d.getTime())) {
        errors.push({ field: 'date_of_incorporation', message: 'Invalid date' });
      } else {
        value.date_of_incorporation = d.toISOString().slice(0, 10);
        if (d.getTime() > Date.now()) {
          errors.push({ field: 'date_of_incorporation', message: 'Date is in the future' });
        }
      }
    }

    for (const capField of ['authorized_capital', 'paid_up_capital']) {
      if (value[capField] !== null && value[capField] !== undefined && value[capField] !== '') {
        const n = Number(String(value[capField]).replace(/[,\s]/g, ''));
        if (Number.isNaN(n) || n < 0) errors.push({ field: capField, message: 'Must be a non-negative number' });
        else value[capField] = n;
      } else {
        value[capField] = null;
      }
    }

    if (value.email) {
      value.email = String(value.email).trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email)) {
        errors.push({ field: 'email', message: 'Invalid email address' });
      }
    }

    if (value.website) {
      value.website = String(value.website).trim();
      if (!/^https?:\/\//i.test(value.website)) value.website = `https://${value.website}`;
    }

    if (value.phone) value.phone = String(value.phone).trim();

    return { valid: errors.length === 0, errors, value };
  }
}

CompanyDataProvider.CANONICAL_FIELDS = CANONICAL_FIELDS;
module.exports = CompanyDataProvider;
