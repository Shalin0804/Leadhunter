const router = require('express').Router();
const ctrl = require('../controllers/automationController');
const { asyncHandler } = require('../utils/http');

// Everything here requires an authenticated user (mounted after `authenticate` in routes/index.js).
router.get('/settings', asyncHandler(ctrl.getSettings));
router.put('/settings', asyncHandler(ctrl.updateSettings));
router.post('/run-now', asyncHandler(ctrl.runNow));
router.get('/runs', asyncHandler(ctrl.listRuns));
router.get('/runs/:id', asyncHandler(ctrl.getRun));
router.get('/api-usage', asyncHandler(ctrl.apiUsage));
router.get('/status', asyncHandler(ctrl.isRunning));

module.exports = router;
