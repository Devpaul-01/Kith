// src/app.js
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');

const { requestId, requestLogger } = require('./middleware/requestLogger');
const { errorHandler } = require('./middleware/errorHandler');
const { generalLimiter } = require('./middleware/rateLimiter');
const { requireAuth, loadDbUser } = require('./middleware/auth');

const containerCtrl = require('./controllers/container.controller');
const workspaceCtrl = require('./controllers/workspace.controller');

const app = express();

// ── Security & parsing ────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestId);
app.use(requestLogger);
app.use(generalLimiter);

// ── Health check (no auth) ────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { checkConnection: checkDb } = require('./config/database');
    const { checkConnection: checkRedis } = require('./config/redis');
    const [db, redis] = await Promise.all([checkDb(), checkRedis()]);
    const status = db && redis ? 'ok' : 'degraded';
    res.status(status === 'ok' ? 200 : 503).json({
      status,
      db: db ? 'connected' : 'error',
      redis: redis ? 'connected' : 'error',
      version: process.env.npm_package_version || '1.0.0',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// ── Public routes (no auth required) ─────────────────────────────
app.use('/v1/auth', require('./routes/auth.routes'));
app.use('/v1/invites', require('./routes/invite.routes'));
app.get('/v1/public/containers/:publicToken', containerCtrl.getPublicContainer);

// ── Workspace list & creation ─────────────────────────────────────
app.get('/v1/workspaces', requireAuth, loadDbUser, workspaceCtrl.listWorkspaces);
app.post('/v1/workspaces', requireAuth, loadDbUser, workspaceCtrl.createWorkspace);

// ── Notifications (user-scoped, not workspace-scoped) ─────────────
app.use('/v1/notifications', require('./routes/notification.routes'));

// ── Workspace-scoped routes ───────────────────────────────────────
app.use('/v1/workspaces/:workspaceId', require('./routes/workspace.routes'));

// ── Bull Board (IP-restricted queue monitor) ──────────────────────
if (process.env.BULL_BOARD_USERNAME && process.env.BULL_BOARD_PASSWORD) {
  try {
    const { createBullBoard } = require('@bull-board/api');
    const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
    const { ExpressAdapter } = require('@bull-board/express');
    const { getAllQueues } = require('./queues');

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');
    createBullBoard({
      queues: getAllQueues().map((q) => new BullMQAdapter(q)),
      serverAdapter,
    });

    const bullGuard = (req, res, next) => {
      const allowedIps = (process.env.ADMIN_IP_WHITELIST || '127.0.0.1,::1')
        .split(',').map((s) => s.trim());
      if (!allowedIps.some((ip) => (req.ip || '').includes(ip))) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }
      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Kith Admin"');
        return res.status(401).end();
      }
      const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      if (user !== process.env.BULL_BOARD_USERNAME || pass !== process.env.BULL_BOARD_PASSWORD) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Kith Admin"');
        return res.status(401).end();
      }
      next();
    };

    app.use('/admin/queues', bullGuard, serverAdapter.getRouter());
  } catch (err) {
    require('./utils/logger').warn('Bull Board not loaded', { error: err.message });
  }
}

// ── 404 ───────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
  });
});

// ── Global error handler ──────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
