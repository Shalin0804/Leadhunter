#!/usr/bin/env node
/**
 * Bridge letting Codefloor's internal AI agents (D:\CF\Claude, lead-research agent)
 * push discovered companies / buying signals into LeadHunter CRM through the
 * existing authenticated CSV-import API, instead of only writing markdown reports.
 * Reuses the same validate -> dedupe -> score pipeline the UI's CSV Import uses.
 *
 * Usage:
 *   node scripts/agentIngest.js --companies <csv> [--no-update-existing]
 *   node scripts/agentIngest.js --signals <csv>
 *   node scripts/agentIngest.js --companies <csv> --signals <csv> --dry-run
 *
 * Env (server/.env):
 *   CRM_API_URL                          default http://localhost:5000/api
 *   CRM_AGENT_EMAIL / CRM_AGENT_PASSWORD  falls back to ADMIN_EMAIL / ADMIN_PASSWORD
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const args = { dryRun: false, updateExisting: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--companies') args.companies = argv[++i];
    else if (a === '--signals') args.signals = argv[++i];
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-update-existing') args.updateExisting = false;
    else if (a === '--api-url') args.apiUrl = argv[++i];
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

async function login(apiUrl) {
  const email = process.env.CRM_AGENT_EMAIL || process.env.ADMIN_EMAIL;
  const password = process.env.CRM_AGENT_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'No CRM credentials: set CRM_AGENT_EMAIL/CRM_AGENT_PASSWORD (preferred) or ADMIN_EMAIL/ADMIN_PASSWORD in server/.env'
    );
  }
  const res = await fetch(`${apiUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    throw new Error(`CRM login failed: ${body.message || res.statusText}`);
  }
  return body.data.token;
}

async function uploadCsv({ apiUrl, token, filePath, kind, dryRun, updateExisting }) {
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
  const buf = fs.readFileSync(abs);

  const form = new FormData();
  form.append('file', new Blob([buf]), path.basename(abs));
  if (kind === 'companies') {
    form.append('provider', 'csv');
    form.append('update_existing', String(updateExisting));
  }

  const base = kind === 'companies' ? 'imports/companies' : 'imports/signals';
  const endpoint = `${apiUrl}/${base}${dryRun ? '/preview' : ''}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    throw new Error(`${kind} ${dryRun ? 'preview' : 'import'} failed: ${body.message || res.statusText}`);
  }
  return body.data;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.companies && !args.signals) {
    console.error(
      'Usage: node scripts/agentIngest.js --companies <csv> | --signals <csv> [--dry-run] [--no-update-existing]'
    );
    process.exit(1);
  }

  const apiUrl = args.apiUrl || process.env.CRM_API_URL || 'http://localhost:5000/api';
  const token = await login(apiUrl);
  const result = { apiUrl, dryRun: args.dryRun };

  if (args.companies) {
    result.companies = await uploadCsv({
      apiUrl,
      token,
      filePath: args.companies,
      kind: 'companies',
      dryRun: args.dryRun,
      updateExisting: args.updateExisting,
    });
  }
  if (args.signals) {
    result.signals = await uploadCsv({
      apiUrl,
      token,
      filePath: args.signals,
      kind: 'signals',
      dryRun: args.dryRun,
    });
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(`agentIngest failed: ${err.message}`);
  process.exit(1);
});
