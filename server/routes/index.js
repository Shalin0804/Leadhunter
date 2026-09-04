const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const automationController = require('../controllers/automationController');
const { asyncHandler } = require('../utils/http');

router.get('/health', (req, res) => res.json({ success: true, data: { status: 'ok', time: new Date().toISOString() } }));

router.use('/auth', require('./auth.routes'));

// Secret-protected external-cron entry point — intentionally NOT behind user auth,
// since a cron service (cron-job.org, GitHub Actions) has no user session.
router.post('/automation/run-scheduled', asyncHandler(automationController.runScheduled));

// Everything below requires a valid JWT.
router.use(authenticate);

router.use('/users', require('./user.routes'));
router.use('/companies', require('./company.routes'));
router.use('/discovery', require('./discovery.routes'));
router.use('/leads', require('./lead.routes'));
router.use('/pipeline', require('./pipeline.routes'));
router.use('/tasks', require('./task.routes'));
router.use('/notes', require('./note.routes'));
router.use('/imports', require('./import.routes'));
router.use('/signals', require('./signal.routes'));
router.use('/apollo', require('./apollo.routes'));
router.use('/automation', require('./automation.routes'));
router.use('/outreach', require('./outreach.routes'));
router.use('/dashboard', require('./dashboard.routes'));

module.exports = router;
