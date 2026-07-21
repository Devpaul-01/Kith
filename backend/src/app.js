// src/app.js
require('dotenv').config();
const express     = require('express');
const helmet      = require('helmet');
const cors        = require('cors');
const compression = require('compression');
const crypto      = require('crypto');

const { requestId, requestLogger } = require('./middleware/requestLogger');
const { errorHandler }             = require('./middleware/errorHandler');
const { generalLimiter }           = require('./middleware/rateLimiter');
const { requireAuth, loadDbUser }  = require('./middleware/auth');

const workspaceCtrl = require('./controllers/workspace.controller');

const app = express();

// ── Security & core middleware ─────────────────────────────────────
app.set('trust proxy', 1);

// Kept deliberately conservative rather than a strict custom CSP: this
// process serves both a JSON API (which doesn't render HTML, so CSP is
// largely inert for it) AND the Bull Board admin dashboard (a full HTML
// app under /admin/queues) behind the SAME helmet instance — an
// aggressive custom CSP tuned for the API could break Bull Board's own
// asset loading. If Bull Board is ever split onto its own process/
// origin, this can be tightened further with a real CSP (script-src/
// style-src allowlists) instead of just the headers below.
app.use(helmet({
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
}));

// No `|| '*'` fallback: server.js's validateEnvironment() already refuses
// to boot without FRONTEND_URL set. Browsers reject wildcard origin +
// credentialed requests outright, so if FRONTEND_URL were ever unset,
// cookie-based auth (the refresh_token cookie) would silently stop
// working rather than silently becoming insecure. Failing loud at
// startup is the correct behavior.
app.use(cors({
  origin:         process.env.FRONTEND_URL,
  credentials:    true,
  methods:        ['GET','POST','PATCH','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization','X-Request-Id'],
}));
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestId);
app.use(requestLogger);
// This global, pre-auth mount means req.user is never populated when
// generalLimiter's keyGenerator runs, so it is — correctly and by design
// — an IP-based baseline covering every request, authenticated or not.
// The per-user guarantee lives in userGeneralLimiter, mounted separately
// AFTER requireAuth inside routes/workspace.routes.js, where req.user.id
// actually exists. See middleware/rateLimiter.js for the full
// explanation.
app.use(generalLimiter);
const cookieParser = require('cookie-parser');
app.use(cookieParser());

// ── Health check ───────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  try {
    const { checkConnection: checkDb }    = require('./config/database');
    const { checkConnection: checkRedis } = require('./config/redis');
    const [db, redis] = await Promise.all([checkDb(), checkRedis()]);
    const status = db && redis ? 'ok' : 'degraded';
    res.status(status === 'ok' ? 200 : 503).json({
      status,
      db:        db    ? 'connected' : 'error',
      redis:     redis ? 'connected' : 'error',
      version:   process.env.npm_package_version || '1.0.0',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// ── Auth routes (public + authenticated) ──────────────────────────
app.use('/v1/auth', require('./routes/auth.routes'));

// ── Public routes (no auth required, except invite accept) ────────
app.use('/v1/public', require('./routes/public.routes'));

// ── Legacy invite routes (kept for backwards compatibility) ────────
app.use('/v1/invites', require('./routes/invite.routes'));

// ── Workspace list + creation (no workspaceId in path) ────────────
// Dedicated top-level endpoints for workspace switcher + onboarding.
// Must be mounted BEFORE the /:workspaceId router to avoid conflicts.
app.get('/v1/workspaces',  requireAuth, loadDbUser, workspaceCtrl.listWorkspaces);
app.post('/v1/workspaces', requireAuth, loadDbUser, workspaceCtrl.createWorkspace);

// ── Workspace-scoped routes ────────────────────────────────────────
// Everything under /v1/workspaces/:workspaceId requires active membership.
// requireMembership is applied inside workspace.routes.js.
app.use('/v1/workspaces/:workspaceId', require('./routes/workspace.routes'));

// ── Notification routes (user-scoped, not workspace-scoped) ───────
app.use('/v1/notifications', require('./routes/notification.routes'));

// ── Bull Board (queue monitor — IP-restricted + basic auth) ────────
if (process.env.BULL_BOARD_USERNAME && process.env.BULL_BOARD_PASSWORD) {
  try {
    const { createBullBoard }  = require('@bull-board/api');
    const { BullMQAdapter }    = require('@bull-board/api/bullMQAdapter');
    const { ExpressAdapter }   = require('@bull-board/express');
    const { getAllQueues }      = require('./queues');

    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');
    createBullBoard({
      queues: getAllQueues().map((q) => new BullMQAdapter(q)),
      serverAdapter,
    });

    // Exact IP match, or a real (if minimal, IPv4-only) CIDR match for
    // entries containing "/". A naive `.includes()` substring match would
    // let an allowlisted "1.2.3.4" also match "21.2.3.40". For anything
    // beyond simple IPv4 CIDR ranges, swap this helper for `ipaddr.js`.
    function ipInCidr(ip, cidr) {
      const [range, bitsStr] = cidr.split('/');
      const bits = parseInt(bitsStr, 10);
      const ipv4Pattern = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
      if (!ipv4Pattern.test(ip) || !ipv4Pattern.test(range) || Number.isNaN(bits)) return false;
      const toInt = (addr) => addr.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (toInt(ip) & mask) === (toInt(range) & mask);
    }

    function isIpAllowed(reqIp, allowedIps) {
      return allowedIps.some((entry) => {
        if (entry === reqIp) return true;
        if (entry.includes('/')) return ipInCidr(reqIp, entry);
        return false;
      });
    }

    // crypto.timingSafeEqual guards against a timing side-channel on the
    // admin dashboard password (naive `!==` comparison is not
    // constant-time), and guards against length mismatches (which
    // timingSafeEqual itself throws on rather than returning false for).
    function safeEqual(a, b) {
      const bufA = Buffer.from(String(a ?? ''));
      const bufB = Buffer.from(String(b ?? ''));
      if (bufA.length !== bufB.length) return false;
      return crypto.timingSafeEqual(bufA, bufB);
    }

    const bullGuard = (req, res, next) => {
      const allowedIps = (process.env.ADMIN_IP_WHITELIST || '127.0.0.1,::1')
        .split(',')
        .map((s) => s.trim());

      if (!isIpAllowed(req.ip || '', allowedIps)) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }

      const auth = req.headers.authorization || '';
      if (!auth.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Kith Admin"');
        return res.status(401).end();
      }
      const [user, pass] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
      const credsOk =
        safeEqual(user, process.env.BULL_BOARD_USERNAME) &&
        safeEqual(pass, process.env.BULL_BOARD_PASSWORD);

      if (!credsOk) {
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

// ── 404 ────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    error: {
      code:    'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`,
    },
  });
});

// ── Global error handler ───────────────────────────────────────────
app.use(errorHandler);

module.exports = app;
