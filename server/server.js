const app = require('./app');
const config = require('./config/config');
const { sequelize } = require('./models');
const { reschedule } = require('./jobs/automationScheduler');
const { logConfigStatus } = require('./services/alertService');
const { reportStartup, installShutdownHook } = require('./services/monitoringService');

async function start() {
  try {
    await sequelize.authenticate();
    const target = config.db.url
      ? `${config.db.dialect} (DATABASE_URL)`
      : `${config.db.dialect} ${config.db.name}@${config.db.host}:${config.db.port}`;
    // eslint-disable-next-line no-console
    console.log(`[db] connected — ${target}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db] connection failed:', err.message);
    console.error('     Run `npm run migrate` and `npm run seed` after configuring server/.env');
    process.exit(1);
  }

  app.listen(config.port, '0.0.0.0', () => {
    // eslint-disable-next-line no-console
    console.log(`[server] LeadHunter CRM API listening on port ${config.port} (${config.nodeEnv})`);
  });

  try {
    await reschedule();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[automation] scheduler init failed:', err.message);
  }

  // Audit-log retention (AUDIT_RETENTION_DAYS); a no-op when unset.
  const purge = () => require('./services/auditService').purgeExpired().catch((err) => console.error('[audit] retention purge failed:', err.message));
  purge();
  setInterval(purge, 24 * 3600 * 1000).unref();

  // Resume geographic imports interrupted by a restart/sleep (checkpointed, idempotent).
  require('./services/locationImportService').resumeStaleJobs().catch((err) => console.error('[locations] resume failed:', err.message));

  // Titan email: rows left SENDING by a restart are marked FAILED (they may have gone out),
  // and the optional IMAP reply sync runs on its interval when EMAIL_IMAP_SYNC_MINUTES > 0.
  require('./services/emailService').recoverInterrupted().catch((err) => console.error('[email] recovery failed:', err.message));
  const { email: emailCfg } = config;
  console.log(`[email] Titan SMTP ${emailCfg.user && emailCfg.pass ? `configured (${emailCfg.host}:${emailCfg.port})` : 'not configured (set TITAN_SMTP_USER + TITAN_SMTP_PASSWORD)'}`);
  if (emailCfg.imap.enabled && emailCfg.imap.syncMinutes > 0) {
    const sync = () => require('./services/emailReplyService').syncReplies().catch((err) => console.error('[email] reply sync failed:', err.message));
    setInterval(sync, emailCfg.imap.syncMinutes * 60000).unref();
  }

  logConfigStatus();
  installShutdownHook();
  reportStartup().catch((err) => console.error('[monitoring] startup report failed:', err.message));
}

start();
