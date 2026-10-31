const jwt = require('jsonwebtoken');
const config = require('../config/config');
const { User } = require('../models');
const { can } = require('../config/permissions');
const ApiError = require('../utils/ApiError');
const { asyncHandler } = require('../utils/http');
const agent = require('../services/agentService');

const signToken = (user) =>
  // iat_ms: exact issue time, so logout/password-change revocation isn't limited to 1-second iat.
  jwt.sign({ sub: user.id, email: user.email, role: user.role, iat_ms: Date.now() }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });

const ACTIVITY_TOUCH_MS = 60 * 1000;

const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw ApiError.unauthorized('Authentication token missing');

  if (agent.isAgentToken(token)) return authenticateAgent(req, res, next, token);

  let payload;
  try {
    payload = jwt.verify(token, config.jwt.secret);
  } catch (e) {
    throw ApiError.unauthorized('Invalid or expired token');
  }

  // Role, status and team are always re-read from the DB — never trusted from the token,
  // so a deactivation or role change takes effect on the very next request.
  const user = await User.findByPk(payload.sub);
  if (!user || !user.is_active) throw ApiError.unauthorized('Account not found or inactive');
  // Sessions issued before the last password change or logout are revoked server-side.
  const cutoff = Math.max(user.password_changed_at?.getTime() || 0, user.sessions_revoked_at?.getTime() || 0);
  const revoked = payload.iat_ms ? payload.iat_ms <= cutoff : payload.iat * 1000 < cutoff - 1000; // legacy tokens: second precision
  if (cutoff && revoked) {
    throw ApiError.unauthorized('Session expired — please sign in again');
  }

  if (!user.last_activity_at || Date.now() - user.last_activity_at.getTime() > ACTIVITY_TOUCH_MS) {
    user.last_activity_at = new Date();
    await User.update({ last_activity_at: user.last_activity_at }, { where: { id: user.id }, silent: true });
  }

  req.user = user;
  next();
});

/**
 * Claude Code agent token (MCP server). Acts as the admin who issued it, minus
 * permissions.AGENT_DENIED, and only on agentService's route allowlist. Every call
 * lands in the agent activity feed with its outcome and duration.
 */
async function authenticateAgent(req, res, next, token) {
  const user = await agent.userForToken(token);
  if (!user) throw ApiError.unauthorized('Invalid or revoked agent token');
  const sessionId = String(req.get('x-agent-session') || '').slice(0, 64) || null;
  const tool = String(req.get('x-agent-tool') || '').slice(0, 60) || null;
  const path = req.originalUrl.replace(/^\/api/, '');
  if (!agent.agentRouteAllowed(req.method, path)) {
    await agent.logActivity({ type: 'tool_call', tool, status: 'denied', action: `${req.method} ${path.split('?')[0]}`, error: 'Route not available to the agent', sessionId });
    throw ApiError.forbidden('This endpoint is not available to the Claude Code agent');
  }
  user.is_agent = true; // permissions.can() drops AGENT_DENIED for this request
  req.user = user;
  req.agent = { sessionId, tool };

  const started = Date.now();
  let failure = null;
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && body.success === false) failure = body.message;
    return json(body);
  };
  res.on('finish', () => {
    if (path.startsWith('/agent/bridge/heartbeat')) return; // once a minute; shown as "last heartbeat" instead
    const id = (re, field) => Number((path.match(re) || [])[1]) || Number(req.body?.[field]) || null;
    agent.logActivity({
      type: 'tool_call',
      tool,
      status: res.statusCode < 400 ? 'success' : res.statusCode === 403 ? 'denied' : 'failure',
      action: `${req.method} ${path.split('?')[0]}`,
      durationMs: Date.now() - started,
      error: failure,
      leadId: id(/^\/leads\/(\d+)/, 'lead_id'),
      companyId: id(/^\/companies\/(\d+)/, 'company_id'),
      taskId: Number((path.match(/^\/agent\/bridge\/tasks\/(\d+)/) || [])[1]) || null,
      sessionId,
    });
  });
  next();
}

const requireRole = (...roles) => (req, res, next) => {
  if (!req.user || !roles.includes(req.user.role)) {
    return next(ApiError.forbidden('You do not have permission to perform this action'));
  }
  next();
};

const requirePermission = (...permissions) => (req, res, next) => {
  if (!permissions.every((p) => can(req.user, p))) {
    return next(ApiError.forbidden('You do not have permission to perform this action'));
  }
  next();
};

module.exports = { authenticate, requireRole, requirePermission, signToken };
