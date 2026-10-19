const router = require('express').Router();
const ctrl = require('../controllers/automationController');
const { asyncHandler } = require('../utils/http');
const { requireRole } = require('../middleware/auth');

// Everything here requires an authenticated user (mounted after `authenticate` in routes/index.js).
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
