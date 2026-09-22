const nvidiaClient = require('../services/ai/nvidiaClient');
const { ALLOWED_SERVICES } = require('../services/ai/aiQualificationPromptBuilder');
const config = require('../config/config');
const { ok } = require('../utils/http');

exports.status = async (req, res) =>
  ok(res, {
    configured: nvidiaClient.isConfigured(),
    testMode: config.nvidia.testMode,
    model: config.nvidia.model,
    allowedServices: ALLOWED_SERVICES,
  });
