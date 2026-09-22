const router = require('express').Router();
const ctrl = require('../controllers/aiController');
const { asyncHandler } = require('../utils/http');

router.get('/status', asyncHandler(ctrl.status));

module.exports = router;
