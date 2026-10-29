const router = require('express').Router();
const ctrl = require('../controllers/leadDiscoveryController');
const { requirePermission } = require('../middleware/auth');
const { rateLimit } = require('../middleware/rateLimit');
const { asyncHandler } = require('../utils/http');

const run = requirePermission('discovery.run');
const runLimit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, keyFn: (req) => `discover:${req.user.id}`, message: 'Discovery run limit reached for this hour' });

router.get('/options', run, asyncHandler(ctrl.options));
router.put('/categories', requirePermission('settings.manage'), asyncHandler(ctrl.updateCategories));
router.post('/run', run, runLimit, asyncHandler(ctrl.run));
router.get('/runs', run, asyncHandler(ctrl.runs));
router.get('/runs/:id/leads', run, asyncHandler(ctrl.runLeads));

module.exports = router;
