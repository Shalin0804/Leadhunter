const { parse } = require('csv-parse/sync');
const CompanyDataProvider = require('./CompanyDataProvider');

const HEADER_ALIASES = {
  company_name: ['company_name', 'company', 'name', 'companyname'],
  cin: ['cin', 'corporate_identification_number'],
  registration_number: ['registration_number', 'reg_no', 'registration_no', 'regno'],
  date_of_incorporation: ['date_of_incorporation', 'incorporation_date', 'doi', 'registration_date', 'date_of_registration'],
  company_status: ['company_status', 'status'],
  company_type: ['company_type', 'type'],
  company_category: ['company_category', 'category'],
  industry: ['industry', 'sector', 'nic_description', 'activity'],
  roc: ['roc', 'registrar'],
  state: ['state'],
  city: ['city', 'town', 'district'],
  registered_address: ['registered_address', 'address', 'registered_office_address'],
  authorized_capital: ['authorized_capital', 'authorised_capital', 'auth_capital'],
  paid_up_capital: ['paid_up_capital', 'paidup_capital', 'paid_capital'],
  website: ['website', 'url', 'web'],
  email: ['email', 'email_id', 'e-mail'],
  phone: ['phone', 'phone_number', 'mobile', 'contact', 'telephone'],
};

const norm = (h) => String(h || '').trim().toLowerCase().replace(/[\s.-]+/g, '_');

class CsvCompanyProvider extends CompanyDataProvider {
  get key() {
    return 'csv';
  }
  get label() {
    return 'CSV Import';
  }

  /**
   * Parse a CSV buffer/string into raw row objects keyed by canonical field names.
   * @returns {{ rows: object[], headerMap: object, unknownHeaders: string[] }}
   */
  parse(input) {
    const records = parse(input, {
      columns: (headers) => headers.map((h) => norm(h)),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
      bom: true,
    });

    const presentHeaders = records.length ? Object.keys(records[0]) : [];
    const headerMap = {};
    const usedHeaders = new Set();

    for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
      const found = presentHeaders.find((h) => aliases.includes(h));
      if (found) {
        headerMap[canonical] = found;
        usedHeaders.add(found);
      }
    }

    const unknownHeaders = presentHeaders.filter((h) => !usedHeaders.has(h));

    const rows = records.map((rec) => {
      const raw = {};
      for (const canonical of Object.keys(HEADER_ALIASES)) {
        const src = headerMap[canonical];
        raw[canonical] = src ? rec[src] ?? null : null;
      }
      return raw;
    });

    return { rows, headerMap, unknownHeaders, requiredPresent: !!headerMap.company_name };
  }

  /**
   * Normalize + validate every row. Does not touch the database.
   * @returns {{ records: Array, errors: Array }}
   */
  async importCompanies(rawRows) {
    const records = [];
    const errors = [];

    rawRows.forEach((raw, idx) => {
      const rowNumber = idx + 2; // + header + 1-index
      const normalized = this.normalizeCompany(raw);
      const { valid, errors: rowErrors, value } = this.validateCompany(normalized);

      if (!valid) {
        rowErrors.forEach((e) =>
          errors.push({ row_number: rowNumber, field: e.field, message: e.message, raw_row: raw })
        );
        return;
      }
      records.push({ rowNumber, value });
    });

    return { records, errors };
  }
}

CsvCompanyProvider.HEADER_ALIASES = HEADER_ALIASES;
module.exports = CsvCompanyProvider;
