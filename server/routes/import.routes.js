const router = require('express').Router();
const multer = require('multer');
const ctrl = require('../controllers/importController');
const { asyncHandler } = require('../utils/http');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okType =
      file.mimetype === 'text/csv' ||
      file.mimetype === 'application/vnd.ms-excel' ||
      file.mimetype === 'application/octet-stream' ||
      file.originalname.toLowerCase().endsWith('.csv');
    cb(okType ? null : new Error('Only CSV files are allowed'), okType);
  },
});

router.get('/providers', asyncHandler(ctrl.providers));
router.get('/', asyncHandler(ctrl.list));
router.get('/:id', asyncHandler(ctrl.get));
router.get('/:id/errors.csv', asyncHandler(ctrl.errorsCsv));
router.post('/companies/preview', upload.single('file'), asyncHandler(ctrl.preview));
router.post('/companies', upload.single('file'), asyncHandler(ctrl.create));
router.post('/signals/preview', upload.single('file'), asyncHandler(ctrl.previewSignals));
router.post('/signals', upload.single('file'), asyncHandler(ctrl.createSignals));

module.exports = router;
