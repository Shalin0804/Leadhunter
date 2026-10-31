const router = require('express').Router();
const ctrl = require('../controllers/agentController');
const { asyncHandler } = require('../utils/http');
const ApiError = require('../utils/ApiError');

// Mounted behind requirePermission('agent.manage') — Main Admin only.

// Bridge: only the MCP server (agent token) may report heartbeats or work tasks, so a
// browser session can never fake a "Connected" status. The agent token can reach
// nothing else under /agent (see agentService.AGENT_ROUTES).
const bridge = require('express').Router();
bridge.use((req, res, next) => next(req.agent ? undefined : ApiError.forbidden('Agent token required')));
bridge.post('/heartbeat', asyncHandler(ctrl.heartbeat));
bridge.post('/disconnect', asyncHandler(ctrl.disconnect));
bridge.get('/status', asyncHandler(ctrl.bridgeStatus));
bridge.post('/tasks/claim', asyncHandler(ctrl.claim));
bridge.post('/tasks/:id/complete', asyncHandler(ctrl.complete));
bridge.post('/tasks/:id/fail', asyncHandler(ctrl.fail));
router.use('/bridge', bridge);

router.get('/overview', asyncHandler(ctrl.overview));
router.post('/control', asyncHandler(ctrl.control));
router.post('/token', asyncHandler(ctrl.issueToken));
router.delete('/token', asyncHandler(ctrl.revokeToken));
router.get('/tasks', asyncHandler(ctrl.listTasks));
router.post('/tasks', asyncHandler(ctrl.createTask));
router.get('/tasks/:id', asyncHandler(ctrl.getTask));
router.post('/tasks/:id/:action(pause|resume|cancel|retry)', asyncHandler(ctrl.taskAction));
router.get('/activity', asyncHandler(ctrl.listActivity));

module.exports = router;
