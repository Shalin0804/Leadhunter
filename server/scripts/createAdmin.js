/**
 * Explicit Main Admin provisioning — the only way to create or promote an admin
 * outside the Team Management UI (there is no public sign-up).
 *
 *   npm --prefix server run create-admin -- --email you@company.com --name "Your Name"
 *
 * Creates the account (or promotes an existing one), and prints a one-time
 * set-password link valid for 24 hours. No password ever passes through the CLI.
 */
require('dotenv').config();
const config = require('../config/config');
const { sequelize, User } = require('../models');
const audit = require('../services/auditService');

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

async function main() {
  const email = String(arg('email') || '').toLowerCase().trim();
  const name = arg('name');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Usage: create-admin --email you@company.com [--name "Full Name"]');

  let user = await User.findOne({ where: { email } });
  const created = !user;
  if (created) {
    if (!name) throw new Error('--name is required when creating a new account');
    user = await User.create({ name, email, password_hash: User.NO_PASSWORD, role: 'admin' });
  } else {
    user.role = 'admin';
    user.is_active = true;
    if (name) user.name = name;
    await user.save();
  }
  const token = await user.issueSetPasswordToken(24);
  await audit.record(null, {
    action: created ? 'user.invited' : 'user.role_changed',
    resourceType: 'user',
    resourceId: user.id,
    metadata: { via: 'create-admin script', role: 'admin' },
  });

  const base = (process.env.APP_URL || config.clientOrigin.split(',')[0]).replace(/\/$/, '');
  console.log(`[create-admin] ${created ? 'created' : 'promoted'} ${email} as Main Admin`);
  console.log(`[create-admin] set-password link (single use, 24h):\n  ${base}/set-password?token=${encodeURIComponent(token)}`);
}

main()
  .catch((err) => {
    console.error('[create-admin] failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
