const router = require('express').Router();
const ctrl = require('../controllers/hermesController');
const { asyncHandler } = require('../utils/http');

router.get('/status', asyncHandler(ctrl.status));
router.post('/research/:companyId', asyncHandler(ctrl.research));
router.get('/research/:companyId', asyncHandler(ctrl.getResearch));
router.get('/research/:companyId/evidence', asyncHandler(ctrl.getEvidence));

module.exports = router;
