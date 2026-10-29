const router = require('express').Router();
const ctrl = require('../controllers/outreachController');
const { asyncHandler } = require('../utils/http');
const { requirePermission } = require('../middleware/auth');

router.get('/', requirePermission('leads.view'), asyncHandler(ctrl.list));
router.post('/generate', requirePermission('leads.edit'), asyncHandler(ctrl.generate));
router.delete('/:id', requirePermission('leads.edit'), asyncHandler(ctrl.remove));

module.exports = router;
