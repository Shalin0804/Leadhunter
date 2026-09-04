const app = require('./app');
const config = require('./config/config');
const { sequelize } = require('./models');
const { reschedule } = require('./jobs/automationScheduler');

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
}

start();
