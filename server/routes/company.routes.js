const router = require('express').Router();
const ctrl = require('../controllers/companyController');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/http');

router.get('/', asyncHandler(ctrl.list));
router.get('/export', asyncHandler(ctrl.exportCsv));
router.get('/:id', asyncHandler(ctrl.get));
router.post(
  '/',
  validate({ company_name: { required: true, minLength: 2, maxLength: 255 } }),
  asyncHandler(ctrl.create)
);
router.put('/:id', asyncHandler(ctrl.update));
router.delete('/:id', asyncHandler(ctrl.remove));
router.post('/:id/rescore', asyncHandler(ctrl.rescore));
router.post(
  '/:id/contacts',
  validate({ type: { required: true, in: ['email', 'phone'] }, value: { required: true } }),
  asyncHandler(ctrl.addContact)
);
router.post(
  '/:id/socials',
  validate({
    platform: { required: true, in: ['linkedin', 'facebook', 'instagram', 'twitter', 'youtube', 'other'] },
    url: { required: true },
  }),
  asyncHandler(ctrl.addSocial)
);

module.exports = router;
