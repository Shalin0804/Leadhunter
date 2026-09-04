const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const config = require('./config/config');
const routes = require('./routes');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');

const app = express();
app.set('trust proxy', 1); // behind Render/Vercel/other proxies

const allowList = config.clientOrigin.split(',').map((s) => s.trim()).filter(Boolean);

const corsOrigin = (origin, cb) => {
  // Allow same-origin / server-to-server / curl (no Origin header).
  if (!origin) return cb(null, true);
  if (allowList.includes('*') || allowList.includes(origin)) return cb(null, true);
  if (config.allowVercelPreviews && /\.vercel\.app$/.test(new URL(origin).hostname)) return cb(null, true);
  return cb(new Error(`Origin not allowed by CORS: ${origin}`));
};

app.use(helmet());
app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) =>
  res.json({ success: true, data: { name: 'LeadHunter CRM API', version: '1.0.0', health: '/api/health' } })
);

app.use('/api', routes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
