const { sequelize, Company, CompanyContact, CompanyWebsite, CompanyImport, CompanyImportError, Activity, Signal } = require('../models');
const { getProvider } = require('../providers');
const { rescoreCompany } = require('./companyService');
const { createSignal } = require('./signalService');
const { Op } = require('sequelize');

/**
 * Detect which normalized records already exist (by CIN, else by name+city).
 * Returns a Map keyed by rowNumber -> existing Company instance.
 */
async function detectDuplicates(records) {
  const cins = records.map((r) => r.value.cin).filter(Boolean);
  const nameCityKeys = records
    .filter((r) => !r.value.cin)
    .map((r) => ({ company_name: r.value.company_name, city: r.value.city }));

  const where = [];
  if (cins.length) where.push({ cin: { [Op.in]: cins } });
  if (nameCityKeys.length) where.push({ [Op.or]: nameCityKeys });

  const existing = where.length ? await Company.findAll({ where: { [Op.or]: where } }) : [];

  const byCin = new Map();
  const byNameCity = new Map();
  existing.forEach((c) => {
    if (c.cin) byCin.set(c.cin.toUpperCase(), c);
    byNameCity.set(`${(c.company_name || '').toLowerCase()}|${(c.city || '').toLowerCase()}`, c);
  });

  const map = new Map();
  for (const r of records) {
    let hit = null;
    if (r.value.cin) hit = byCin.get(r.value.cin.toUpperCase());
    if (!hit) hit = byNameCity.get(`${r.value.company_name.toLowerCase()}|${(r.value.city || '').toLowerCase()}`);
    if (hit) map.set(r.rowNumber, hit);
  }
  return map;
}

/**
 * Dry-run analysis for the preview step — no writes.
 */
async function analyze({ providerKey = 'csv', fileBuffer }) {
  const provider = getProvider(providerKey);
  const parsed = provider.parse(fileBuffer);

  if (!parsed.requiredPresent) {
    return {
      ok: false,
      message: 'CSV is missing a recognizable "company_name" column',
      headerMap: parsed.headerMap,
      unknownHeaders: parsed.unknownHeaders,
    };
  }

  const { records, errors } = await provider.importCompanies(parsed.rows);
  const dupMap = await detectDuplicates(records);

  const preview = records.slice(0, 25).map((r) => ({
    row_number: r.rowNumber,
    ...r.value,
    _duplicate: dupMap.has(r.rowNumber),
    _existing_id: dupMap.get(r.rowNumber)?.id || null,
  }));

  return {
    ok: true,
    headerMap: parsed.headerMap,
    unknownHeaders: parsed.unknownHeaders,
    totals: {
      total_records: parsed.rows.length,
      valid_records: records.length,
      invalid_records: parsed.rows.length - records.length,
      duplicate_records: dupMap.size,
      new_records: records.length - dupMap.size,
    },
    preview,
    errors: errors.slice(0, 200),
  };
}

/**
 * Persist an import. Creates/updates companies, contacts, websites, scores.
 */
async function runImport({ providerKey = 'csv', fileBuffer, originalFilename, userId, updateExisting = true }) {
  const provider = getProvider(providerKey);
  const parsed = provider.parse(fileBuffer);

  const importRow = await CompanyImport.create({
    user_id: userId || null,
    provider: providerKey,
    original_filename: originalFilename || null,
    status: 'pending',
    total_records: parsed.rows.length,
  });

  if (!parsed.requiredPresent) {
    await importRow.update({ status: 'failed', summary: { message: 'Missing company_name column' } });
    return importRow.reload({ include: [{ model: CompanyImportError, as: 'errors' }] });
  }

  const { records, errors } = await provider.importCompanies(parsed.rows);
  const dupMap = await detectDuplicates(records);

  let imported = 0;
  let updated = 0;
  let duplicates = 0;
  const affectedCompanyIds = [];
  const errorRows = [...errors];

  for (const rec of records) {
    const v = rec.value;
    const existing = dupMap.get(rec.rowNumber);

    try {
      await sequelize.transaction(async (transaction) => {
        let company;
        if (existing) {
          duplicates += 1;
          if (!updateExisting) return;
          company = await Company.findByPk(existing.id, { transaction });
          await company.update(
            {
              company_name: v.company_name,
              registration_number: v.registration_number || company.registration_number,
              date_of_incorporation: v.date_of_incorporation || company.date_of_incorporation,
              company_status: v.company_status || company.company_status,
              company_type: v.company_type || company.company_type,
              company_category: v.company_category || company.company_category,
              industry: v.industry || company.industry,
              roc: v.roc || company.roc,
              state: v.state || company.state,
              city: v.city || company.city,
              registered_address: v.registered_address || company.registered_address,
              authorized_capital: v.authorized_capital ?? company.authorized_capital,
              paid_up_capital: v.paid_up_capital ?? company.paid_up_capital,
              website: v.website || company.website,
            },
            { transaction }
          );
          updated += 1;
        } else {
          company = await Company.create(
            {
              company_name: v.company_name,
              cin: v.cin || null,
              registration_number: v.registration_number,
              date_of_incorporation: v.date_of_incorporation,
              company_status: v.company_status || 'Active',
              company_type: v.company_type,
              company_category: v.company_category,
              industry: v.industry,
              roc: v.roc,
              state: v.state,
              city: v.city,
              registered_address: v.registered_address,
              authorized_capital: v.authorized_capital,
              paid_up_capital: v.paid_up_capital,
              website: v.website,
              source: providerKey,
            },
            { transaction }
          );
          imported += 1;
        }

        // Contacts
        if (v.email) {
          const [c] = await CompanyContact.findOrCreate({
            where: { company_id: company.id, type: 'email', value: v.email },
            defaults: { is_primary: true, is_public_business: true },
            transaction,
          });
          void c;
        }
        if (v.phone) {
          await CompanyContact.findOrCreate({
            where: { company_id: company.id, type: 'phone', value: v.phone },
            defaults: { is_primary: true },
            transaction,
          });
        }
        if (v.website) {
          await CompanyWebsite.findOrCreate({
            where: { company_id: company.id, url: v.website },
            defaults: { status: 'unknown', is_https: /^https:/i.test(v.website) },
            transaction,
          });
        }

        // sync flags
        const contacts = await company.getContacts({ transaction });
        const websites = await company.getWebsites({ transaction });
        company.has_email = contacts.some((x) => x.type === 'email');
        company.has_phone = contacts.some((x) => x.type === 'phone');
        company.has_website = websites.length > 0 || !!company.website;
        await company.save({ transaction });

        await rescoreCompany(company.id, { transaction });
        affectedCompanyIds.push(company.id);
      });
    } catch (e) {
      errorRows.push({ row_number: rec.rowNumber, field: null, message: e.message, raw_row: v });
    }
  }

  if (errorRows.length) {
    await CompanyImportError.bulkCreate(
      errorRows.map((e) => ({
        import_id: importRow.id,
        row_number: e.row_number || null,
        field: e.field || null,
        message: e.message,
        raw_row: e.raw_row || null,
      }))
    );
  }

  const summary = {
    total_records: parsed.rows.length,
    successfully_imported: imported,
    updated,
    duplicate_records: duplicates,
    invalid_records: parsed.rows.length - records.length,
    error_rows: errorRows.length,
  };

  await importRow.update({
    status: 'completed',
    imported_count: imported,
    updated_count: updated,
    duplicate_count: duplicates,
    invalid_count: parsed.rows.length - records.length,
    summary,
  });

  await Activity.create({
    company_id: null,
    user_id: userId || null,
    type: 'import',
    title: `CSV import: ${originalFilename || 'upload'}`,
    body: `${imported} new, ${updated} updated, ${duplicates} duplicates, ${errorRows.length} errors`,
    meta: summary,
  });

  return CompanyImport.findByPk(importRow.id, { include: [{ model: CompanyImportError, as: 'errors' }] });
}

/* -------------------- Buying-signal CSV import -------------------- */

async function analyzeSignals({ fileBuffer }) {
  const provider = getProvider('signal-csv');
  const parsed = provider.parse(fileBuffer);

  if (!parsed.requiredPresent) {
    return {
      ok: false,
      message: 'CSV needs at least a company_name, website or contact_email column',
      headerMap: parsed.headerMap,
      unknownHeaders: parsed.unknownHeaders,
    };
  }

  const { records, errors } = await provider.importCompanies(parsed.rows);

  const preview = records.slice(0, 25).map((r) => ({
    row_number: r.rowNumber,
    company_name: r.value.company_name || r.value.website || r.value.contact_email,
    service: r.value.service,
    source: r.value.source,
    headline: r.value.headline,
    contact_name: r.value.contact_name,
  }));

  return {
    ok: true,
    headerMap: parsed.headerMap,
    unknownHeaders: parsed.unknownHeaders,
    totals: {
      total_records: parsed.rows.length,
      valid_records: records.length,
      invalid_records: parsed.rows.length - records.length,
    },
    preview,
    errors: errors.slice(0, 200),
  };
}

async function runSignalImport({ fileBuffer, originalFilename, userId }) {
  const provider = getProvider('signal-csv');
  const parsed = provider.parse(fileBuffer);

  const importRow = await CompanyImport.create({
    user_id: userId || null,
    provider: 'signal-csv',
    original_filename: originalFilename || null,
    status: 'pending',
    total_records: parsed.rows.length,
  });

  if (!parsed.requiredPresent) {
    await importRow.update({ status: 'failed', summary: { message: 'No identifying column' } });
    return CompanyImport.findByPk(importRow.id, { include: [{ model: CompanyImportError, as: 'errors' }] });
  }

  const { records, errors } = await provider.importCompanies(parsed.rows);
  const errorRows = [...errors];
  let createdSignals = 0;
  let newCompanies = 0;
  let matchedCompanies = 0;

  for (const rec of records) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { companyCreated } = await createSignal(
        { ...rec.value, import_id: importRow.id, raw: rec.value.raw },
        { userId }
      );
      createdSignals += 1;
      if (companyCreated) newCompanies += 1;
      else matchedCompanies += 1;
    } catch (e) {
      errorRows.push({ row_number: rec.rowNumber, field: null, message: e.message, raw_row: rec.value.raw });
    }
  }

  if (errorRows.length) {
    await CompanyImportError.bulkCreate(
      errorRows.map((e) => ({
        import_id: importRow.id,
        row_number: e.row_number || null,
        field: e.field || null,
        message: e.message,
        raw_row: e.raw_row || null,
      }))
    );
  }

  const summary = {
    total_records: parsed.rows.length,
    signals_created: createdSignals,
    companies_matched: matchedCompanies,
    companies_created: newCompanies,
    invalid_records: parsed.rows.length - records.length,
    error_rows: errorRows.length,
  };

  await importRow.update({
    status: 'completed',
    imported_count: createdSignals,
    updated_count: matchedCompanies,
    duplicate_count: 0,
    invalid_count: parsed.rows.length - records.length,
    summary,
  });

  await Activity.create({
    user_id: userId || null,
    type: 'import',
    title: `Buying-signals import: ${originalFilename || 'upload'}`,
    body: `${createdSignals} signals, ${newCompanies} new companies, ${matchedCompanies} matched`,
    meta: summary,
  });

  return CompanyImport.findByPk(importRow.id, { include: [{ model: CompanyImportError, as: 'errors' }] });
}

module.exports = { analyze, runImport, detectDuplicates, analyzeSignals, runSignalImport };
