const router = require('express').Router();
const ctrl = require('../controllers/signalController');
const { validate } = require('../middleware/validate');
const { asyncHandler } = require('../utils/http');
const { Signal } = require('../models');

router.get('/', asyncHandler(ctrl.list));
router.get('/meta', asyncHandler(ctrl.meta));
router.get('/stats', asyncHandler(ctrl.stats));
router.get('/export', asyncHandler(ctrl.exportCsv));
router.get('/:id', asyncHandler(ctrl.get));
router.post(
  '/',
  validate({
    service: { in: Signal.SERVICES, default: 'OTHER' },
    source: { in: Signal.SOURCES, default: 'manual' },
  }),
  asyncHandler(ctrl.create)
);
router.put('/:id', asyncHandler(ctrl.update));
router.patch('/:id', asyncHandler(ctrl.update));
router.post('/:id/convert', asyncHandler(ctrl.convert));
router.delete('/:id', asyncHandler(ctrl.remove));

module.exports = router;
