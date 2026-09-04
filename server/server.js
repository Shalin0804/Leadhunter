const app = require('./app');
const config = require('./config/config');
const { sequelize } = require('./models');

async function start() {
  try {
    await sequelize.authenticate();
    // eslint-disable-next-line no-console
    console.log(`[db] connected to ${config.db.name}@${config.db.host}:${config.db.port}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[db] connection failed:', err.message);
    console.error('     Run `npm run migrate` and `npm run seed` after configuring server/.env');
    process.exit(1);
  }

  app.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] LeadHunter CRM API listening on http://localhost:${config.port} (${config.nodeEnv})`);
  });
}

start();
