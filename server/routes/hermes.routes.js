const router = require('express').Router();
const ctrl = require('../controllers/hermesController');
const { asyncHandler } = require('../utils/http');
const { requirePermission } = require('../middleware/auth');
const { assertCompanyAccess } = require('../services/accessService');

const companyAccess = asyncHandler(async (req, res, next) => {
  await assertCompanyAccess(req.user, req.params.companyId);
  next();
});

router.get('/status', requirePermission('discovery.use'), asyncHandler(ctrl.status));
router.post('/research/:companyId', requirePermission('discovery.use'), asyncHandler(ctrl.research));
router.get('/research/:companyId', requirePermission('contacts.view_unmasked'), companyAccess, asyncHandler(ctrl.getResearch));
router.get('/research/:companyId/evidence', requirePermission('contacts.view_unmasked'), companyAccess, asyncHandler(ctrl.getEvidence));

module.exports = router;
