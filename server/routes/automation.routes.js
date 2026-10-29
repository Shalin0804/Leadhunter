const router = require('express').Router();
const ctrl = require('../controllers/automationController');
const { asyncHandler } = require('../utils/http');
const { requireRole } = require('../middleware/auth');

// Everything here requires an authenticated user (mounted after `authenticate` in routes/index.js).
// Scheduled location x category discovery jobs (whole /automation tree is Main Admin: discovery.use).
const jobs = require('../controllers/discoveryJobController');
router.get('/location-jobs', asyncHandler(jobs.list));
router.get('/location-jobs/legacy', asyncHandler(jobs.legacy));
router.post('/location-jobs', asyncHandler(jobs.create));
router.patch('/location-jobs/:id', asyncHandler(jobs.update));
router.delete('/location-jobs/:id', asyncHandler(jobs.remove));
router.post('/location-jobs/:id/run', asyncHandler(jobs.runNow));

router.get('/settings', asyncHandler(ctrl.getSettings));
router.put('/settings', asyncHandler(ctrl.updateSettings));
router.post('/run-now', asyncHandler(ctrl.runNow));
router.get('/runs', asyncHandler(ctrl.listRuns));
router.get('/runs/:id', asyncHandler(ctrl.getRun));
router.get('/api-usage', asyncHandler(ctrl.apiUsage));
router.get('/status', asyncHandler(ctrl.isRunning));
router.get('/monitor', asyncHandler(ctrl.monitorStatus));
// Sends a fixed test email to ALERT_EMAIL_TO only — no caller-supplied recipient/content.
router.post('/alerts/test', requireRole('admin'), asyncHandler(ctrl.testAlert));

module.exports = router;
