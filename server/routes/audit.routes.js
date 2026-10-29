const router = require('express').Router();
const ctrl = require('../controllers/auditController');
const { requirePermission } = require('../middleware/auth');
const { asyncHandler } = require('../utils/http');

// Read-only by design: there are no update/delete routes for audit records.
router.get('/logs', requirePermission('audit.view'), asyncHandler(ctrl.list));
router.get('/logs/export', requirePermission('audit.export'), asyncHandler(ctrl.exportCsv));
router.get('/logs/:id', requirePermission('audit.view'), asyncHandler(ctrl.get));
router.get('/meta', requirePermission('audit.view'), asyncHandler(ctrl.meta));
router.get('/performance', requirePermission('performance.view'), asyncHandler(ctrl.performance));
router.get('/settings', requirePermission('settings.manage'), asyncHandler(ctrl.settings));

module.exports = router;
