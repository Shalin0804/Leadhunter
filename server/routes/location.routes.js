const router = require('express').Router();
const ctrl = require('../controllers/locationController');
const { requirePermission } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { can } = require('../config/permissions');
const ApiError = require('../utils/ApiError');
const { asyncHandler } = require('../utils/http');

const manage = requirePermission('locations.manage');
// Reading approved locations: anyone who may run discovery (or manage locations).
const browse = (req, res, next) =>
  can(req.user, 'discovery.run') || can(req.user, 'locations.manage') ? next() : next(ApiError.forbidden('You do not have permission to use locations'));

router.get('/catalog', manage, asyncHandler(ctrl.catalog));
router.get('/import-jobs', manage, asyncHandler(ctrl.jobs));
router.post('/import', manage, validate({ country_code: { required: true, minLength: 2, maxLength: 2 } }), asyncHandler(ctrl.importCountry));
router.post('/import-jobs/:id/resume', manage, asyncHandler(ctrl.resumeJob));
router.post('/import-jobs/:id/cancel', manage, asyncHandler(ctrl.cancelJob));

router.get('/', browse, asyncHandler(ctrl.list));
router.get('/:id', browse, asyncHandler(ctrl.get));
router.post(
  '/',
  manage,
  validate({ name: { required: true, minLength: 1, maxLength: 200 }, location_type: { required: true }, is_active: { type: 'boolean' } }),
  asyncHandler(ctrl.create)
);
router.patch('/:id', manage, validate({ is_active: { type: 'boolean' }, cascade: { type: 'boolean' } }), asyncHandler(ctrl.update));
router.delete('/:id', manage, asyncHandler(ctrl.remove));
router.post('/:id/discover-localities', manage, asyncHandler(ctrl.discoverLocalities));

module.exports = router;
