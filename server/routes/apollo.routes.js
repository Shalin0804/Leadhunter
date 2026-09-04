const router = require('express').Router();
const ctrl = require('../controllers/apolloController');
const { asyncHandler } = require('../utils/http');

router.get('/status', asyncHandler(ctrl.status));
router.post('/search', asyncHandler(ctrl.search));
router.post('/import', asyncHandler(ctrl.import));
router.post('/companies/:id/enrich', asyncHandler(ctrl.enrich));

module.exports = router;
