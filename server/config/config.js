require('dotenv').config();

const env = (key, fallback) => {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
};

module.exports = {
  port: parseInt(env('PORT', '5000'), 10),
  nodeEnv: env('NODE_ENV', 'development'),
  clientOrigin: env('CLIENT_ORIGIN', 'http://localhost:5173'),

  db: {
    host: env('DB_HOST', 'localhost'),
    port: parseInt(env('DB_PORT', '3306'), 10),
    name: env('DB_NAME', 'leadhunter'),
    user: env('DB_USER', 'root'),
    password: env('DB_PASSWORD', ''),
    dialect: 'mysql',
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
