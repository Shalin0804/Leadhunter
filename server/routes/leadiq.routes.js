const router = require('express').Router();
const ctrl = require('../controllers/leadiqController');
const { asyncHandler } = require('../utils/http');

router.get('/status', asyncHandler(ctrl.status));
router.post('/search', asyncHandler(ctrl.search));
router.post('/import', asyncHandler(ctrl.import));

module.exports = router;
