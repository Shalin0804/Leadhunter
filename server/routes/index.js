const router = require('express').Router();
const { authenticate, requirePermission } = require('../middleware/auth');
const automationController = require('../controllers/automationController');
const { asyncHandler } = require('../utils/http');

router.get('/health', (req, res) => res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() } }));
// Readiness: also checks the database. 503 with no internals on failure.
router.get('/ready', asyncHandler(automationController.ready));

router.use('/auth', require('./auth.routes'));

// Secret-protected external-cron entry point — intentionally NOT behind user auth,
// since a cron service (cron-job.org, GitHub Actions) has no user session.
router.post('/automation/run-scheduled', asyncHandler(automationController.runScheduled));
// Same secret. An external cron hits this to detect overdue automation (an asleep process can't).
router.get('/automation/heartbeat', asyncHandler(automationController.heartbeat));

// Everything below requires a valid JWT.
router.use(authenticate);

// Record-level scoping (which leads/companies) is enforced in the controllers via
// services/accessService.js; these gates decide which feature areas a role may use.
const discovery = requirePermission('discovery.use');

router.use('/users', require('./user.routes'));
router.use('/audit', require('./audit.routes'));
router.use('/locations', require('./location.routes'));
router.use('/lead-discovery', require('./leadDiscovery.routes'));
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

module.exports = router;
