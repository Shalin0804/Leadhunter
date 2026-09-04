const router = require('express').Router();
const ctrl = require('../controllers/outreachController');
const { asyncHandler } = require('../utils/http');

router.get('/', asyncHandler(ctrl.list));
router.post('/generate', asyncHandler(ctrl.generate));
router.delete('/:id', asyncHandler(ctrl.remove));

module.exports = router;
