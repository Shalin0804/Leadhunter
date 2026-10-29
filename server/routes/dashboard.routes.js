const router = require('express').Router();
const ctrl = require('../controllers/dashboardController');
const { asyncHandler } = require('../utils/http');

router.get('/stats', asyncHandler(ctrl.stats));
// Business-first lead-generation metrics + duplicate review (mounted behind dashboard.view = Main Admin).
const leadGen = require('../controllers/leadGenController');
router.get('/lead-generation', asyncHandler(leadGen.metrics));
router.get('/duplicates', asyncHandler(leadGen.duplicates));
router.patch('/duplicates/:id', asyncHandler(leadGen.reviewDuplicate));
router.get('/opportunities', asyncHandler(ctrl.opportunities));
router.get('/activity', asyncHandler(ctrl.activityFeed));
router.get('/todays-work', asyncHandler(ctrl.todaysWork));
router.get('/daily-summary', asyncHandler(ctrl.dailySummary));
router.get('/automation-status', asyncHandler(ctrl.automationStatus));

module.exports = router;
