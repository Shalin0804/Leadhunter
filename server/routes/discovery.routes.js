const router = require('express').Router();
const ctrl = require('../controllers/discoveryController');
const { asyncHandler } = require('../utils/http');

router.get('/companies', asyncHandler(ctrl.companies));
router.get('/stats', asyncHandler(ctrl.stats));

module.exports = router;
