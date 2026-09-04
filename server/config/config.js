require('dotenv').config();

const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};

const databaseUrl = env('DATABASE_URL', '');
const inferredDialect = databaseUrl.startsWith('postgres') ? 'postgres' : 'mysql';
const dialect = env('DB_DIALECT', inferredDialect);

module.exports = {
  port: parseInt(env('PORT', '5000'), 10),
  nodeEnv: env('NODE_ENV', 'development'),
  // Comma-separated list of allowed browser origins.
  clientOrigin: env('CLIENT_ORIGIN', 'http://localhost:5173'),
  allowVercelPreviews: env('ALLOW_VERCEL_PREVIEWS', 'false') === 'true',

  db: {
    // If DATABASE_URL is set (Supabase / Render / Heroku style) it wins.
    url: databaseUrl,
    host: env('DB_HOST', 'localhost'),
    port: parseInt(env('DB_PORT', dialect === 'postgres' ? '5432' : '3306'), 10),
    name: env('DB_NAME', 'leadhunter'),
    user: env('DB_USER', dialect === 'postgres' ? 'postgres' : 'root'),
    password: env('DB_PASSWORD', ''),
    dialect,
    // SSL on by default for hosted Postgres; disable locally with DB_SSL=false.
    ssl: env('DB_SSL', dialect === 'postgres' && (databaseUrl || env('DB_HOST', '') !== 'localhost') ? 'true' : 'false') === 'true',
  },

  jwt: {
    secret: env('JWT_SECRET', 'dev-insecure-secret-change-me'),
    expiresIn: env('JWT_EXPIRES_IN', '7d'),
  },

  admin: {
    email: env('ADMIN_EMAIL', 'admin@leadhunter.local'),
    password: env('ADMIN_PASSWORD', 'Admin@123456'),
    name: env('ADMIN_NAME', 'LeadHunter Admin'),
  },
};
