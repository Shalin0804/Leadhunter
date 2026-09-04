const router = require('express').Router();
const ctrl = require('../controllers/dashboardController');
const { asyncHandler } = require('../utils/http');

router.get('/stats', asyncHandler(ctrl.stats));
router.get('/opportunities', asyncHandler(ctrl.opportunities));
router.get('/activity', asyncHandler(ctrl.activityFeed));

module.exports = router;
