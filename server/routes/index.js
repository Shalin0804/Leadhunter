const router = require('express').Router();
const { authenticate, requirePermission } = require('../middleware/auth');
const automationController = require('../controllers/automationController');
const { asyncHandler } = require('../utils/http');
const { rateLimit } = require('../middleware/rateLimit');
const { isAgentToken } = require('../services/agentService');

router.get('/health', (req, res) => res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() } }));
// Readiness: also checks the database. 503 with no internals on failure.
router.get('/ready', asyncHandler(automationController.ready));

router.use('/auth', require('./auth.routes'));

// Secret-protected external-cron entry point — intentionally NOT behind user auth,
// since a cron service (cron-job.org, GitHub Actions) has no user session.
router.post('/automation/run-scheduled', asyncHandler(automationController.runScheduled));
// Same secret. An external cron hits this to detect overdue automation (an asleep process can't).
router.get('/automation/heartbeat', asyncHandler(automationController.heartbeat));

// Claude Code agent token: its own budget, so a runaway agent loop can't starve anything.
const agentLimit = rateLimit({ windowMs: 60 * 1000, max: parseInt(process.env.AGENT_RATE_LIMIT_PER_MIN || '120', 10), keyFn: () => 'agent', message: 'Agent rate limit reached — slow down' });
router.use((req, res, next) => (isAgentToken((req.headers.authorization || '').slice(7)) ? agentLimit(req, res, next) : next()));

// Everything below requires a valid JWT (or the agent token — see middleware/auth.js).
router.use(authenticate);

// Record-level scoping (which leads/companies) is enforced in the controllers via
// services/accessService.js; these gates decide which feature areas a role may use.
const discovery = requirePermission('discovery.use');

router.use('/users', require('./user.routes'));
router.use('/audit', require('./audit.routes'));
router.use('/locations', require('./location.routes'));
router.use('/lead-discovery', require('./leadDiscovery.routes'));
router.use('/contacts', require('./contact.routes'));
router.use('/companies', require('./company.routes'));
router.use('/discovery', discovery, require('./discovery.routes'));
router.use('/leads', require('./lead.routes'));
router.use('/pipeline', require('./pipeline.routes'));
router.use('/tasks', require('./task.routes'));
router.use('/notes', require('./note.routes'));
router.use('/imports', discovery, require('./import.routes'));
router.use('/signals', discovery, require('./signal.routes'));
router.use('/apollo', discovery, require('./apollo.routes'));
router.use('/automation', discovery, require('./automation.routes'));
router.use('/outreach', require('./outreach.routes'));
router.use('/dashboard', requirePermission('dashboard.view'), require('./dashboard.routes'));
router.use('/hermes', require('./hermes.routes'));
router.use('/ai', discovery, require('./ai.routes'));
router.use('/leadiq', discovery, require('./leadiq.routes'));
router.use('/explorium', discovery, require('./explorium.routes'));
router.use('/agent', requirePermission('agent.manage'), require('./agent.routes'));
router.use('/email', requirePermission('email.send'), require('./email.routes'));

module.exports = router;
