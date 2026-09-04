const router = require('express').Router();
const ctrl = require('../controllers/dashboardController');
const { asyncHandler } = require('../utils/http');

router.get('/stats', asyncHandler(ctrl.stats));
router.get('/opportunities', asyncHandler(ctrl.opportunities));
router.get('/activity', asyncHandler(ctrl.activityFeed));
router.get('/todays-work', asyncHandler(ctrl.todaysWork));
router.get('/daily-summary', asyncHandler(ctrl.dailySummary));
router.get('/automation-status', asyncHandler(ctrl.automationStatus));

module.exports = router;
