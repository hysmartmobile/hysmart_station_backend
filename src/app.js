import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { requestContext } from './middleware/requestContext.js';
import { authMiddleware } from './middleware/auth.js';
import { subscriptionAccess } from './middleware/subscriptionAccess.js';
import { notFound, errorHandler } from './middleware/errors.js';

import healthRoutes from './routes/health.js';
import meRoutes from './routes/me.js';
import stationRoutes from './routes/stations.js';
import teamRoutes from './routes/team.js';
import publicInvitationRoutes from './routes/publicInvitations.js';
import companyRoutes from './routes/companies.js';
import attendanceRoutes from './routes/attendance.js';
import operationsRoutes from './routes/operations.js';
import controlsRoutes from './routes/controls.js';
import governanceRoutes from './routes/governance.js';
import billingRoutes, {
  billingWebhookRoutes,
} from './routes/billing.js';
import alertRoutes from './routes/alerts.js';
import notificationRoutes from './routes/notifications.js';
import messageRoutes from './routes/messages.js';
import payrollRoutes from './routes/payroll.js';
import accountabilityRoutes from './routes/accountability.js';
import advancedOperationsRoutes from './routes/advancedOperations.js';
import supportRoutes from './routes/support.js';
import creatorAdminRoutes from './routes/creatorAdmin.js';

/**
 * Normalize an origin for consistent allowlist comparison.
 *
 * Browser origins do not normally contain a trailing slash, but trimming
 * one here makes environment configuration less error-prone.
 */
function normalizeOrigin(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

/**
 * Build the CORS policy.
 *
 * Production:
 *   Only origins explicitly configured in config.frontendOrigins are allowed.
 *
 * Development:
 *   Explicitly configured origins plus common local Vite origins are allowed.
 *
 * Requests without an Origin header are permitted by CORS middleware.
 * This does NOT bypass authentication or authorization.
 */
function createCorsOptions(config) {
  const isProduction = config.nodeEnv === 'production';

  const allowedOrigins = new Set(
    (config.frontendOrigins || [])
      .map(normalizeOrigin)
      .filter(Boolean),
  );

  if (!isProduction) {
    allowedOrigins.add('http://localhost:5173');
    allowedOrigins.add('http://127.0.0.1:5173');
    allowedOrigins.add('http://localhost:3000');
    allowedOrigins.add('http://127.0.0.1:3000');
  }

  return {
    origin(origin, callback) {
      // Non-browser requests commonly have no Origin header.
      if (!origin) {
        return callback(null, true);
      }

      const normalizedOrigin = normalizeOrigin(origin);

      if (allowedOrigins.has(normalizedOrigin)) {
        return callback(null, true);
      }

      // Reject unapproved origins without crashing the Express app.
      // The browser will not receive Access-Control-Allow-Origin.
      return callback(null, false);
    },

    // No cookie-based cross-origin authentication is enabled.
    // API authentication should use the Authorization header.
    credentials: false,

    methods: [
      'GET',
      'POST',
      'PUT',
      'PATCH',
      'DELETE',
      'OPTIONS',
    ],

    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'X-Request-Id',
    ],

    exposedHeaders: [
      'X-Request-Id',
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
      'Retry-After',
    ],

    optionsSuccessStatus: 204,
    maxAge: 600,
  };
}

export function createApp(config, supabase) {
  const app = express();

  const isProduction = config.nodeEnv === 'production';

  /*
   * Basic application hardening.
   */
  app.disable('x-powered-by');

  /*
   * Render normally runs behind a reverse proxy.
   * Trust one proxy hop in production so Express can interpret forwarded
   * client IP information for rate limiting.
   */
  app.set('trust proxy', isProduction ? 1 : false);

  /*
   * Attach request metadata before other middleware so request IDs can
   * be used throughout request processing and error reporting.
   */
  app.use(requestContext);

  /*
   * Security headers.
   *
   * CSP is enabled in production. If your frontend uses external scripts,
   * payment widgets, or other external resources, configure an appropriate
   * policy for those resources rather than disabling CSP globally.
   */
  app.use(
    helmet({
      contentSecurityPolicy: isProduction ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  /*
   * CORS must run before routes so it can handle OPTIONS preflight requests.
   */
  const corsOptions = createCorsOptions(config);

  app.use(cors(corsOptions));

  /*
   * Parse JSON requests and retain the original request body.
   *
   * Keeping req.rawBody can be necessary for payment webhook signature
   * verification. The webhook handler must still verify the signature
   * against the exact raw bytes expected by the provider.
   */
  app.use(
    express.json({
      limit: config.requestBodyLimit || '100kb',
      strict: true,

      verify(req, res, buffer) {
        req.rawBody = Buffer.from(buffer);
      },
    }),
  );

  /*
   * Parse URL-encoded forms with bounded input.
   * This does not replace JSON parsing; it supports form-encoded clients.
   */
  app.use(
    express.urlencoded({
      extended: false,
      limit: config.requestBodyLimit || '100kb',
      parameterLimit: 1000,
    }),
  );

  /*
   * General API rate limit.
   *
   * This is a baseline protection, not a substitute for stricter
   * authentication, login, invitation, or payment-specific limits.
   */
  app.use(
    '/api',
    rateLimit({
      windowMs: 60 * 1000,
      limit: 120,
      standardHeaders: true,
      legacyHeaders: false,

      handler(req, res) {
        return res.status(429).json({
          success: false,
          error: {
            code: 'RATE_LIMIT_EXCEEDED',
            message: 'Too many requests. Please try again shortly.',
          },
          requestId: req.id || req.requestId || undefined,
        });
      },
    }),
  );

  /*
   * Health endpoints are mounted before authentication so hosting
   * platforms can check service health.
   */
  app.use('/api/health', healthRoutes(config, supabase));

  /*
   * Payment webhooks must be reachable by the payment provider without
   * a normal user access token.
   *
   * The webhook route itself MUST verify its signature, reject invalid
   * payloads, and process events idempotently.
   */
  app.use(
    '/api/billing',
    billingWebhookRoutes(config, supabase),
  );

  /*
   * Public invitation routes:
   * Only routes designed for public, token-validated invitation access
   * should be exposed here. These routes must validate invitation tokens
   * and enforce expiry and usage rules.
   */
  app.use(
    '/api',
    publicInvitationRoutes(supabase),
  );

  /*
   * Authenticate subsequent API routes.
   *
   * Confirm that authMiddleware calls next() only after successful
   * authentication and that it rejects invalid or expired tokens.
   */
  app.use('/api', authMiddleware(supabase));

  /*
   * Authenticated account and company routes.
   */
  app.use('/api/me', meRoutes());

  app.use(
    '/api/billing',
    billingRoutes(config),
  );

  app.use(
    '/api/companies',
    companyRoutes(),
  );

  /*
   * Subscription-protected routes.
   *
   * subscriptionAccess must validate entitlements server-side. The
   * frontend must never be the authority for subscription enforcement.
   */
  app.use(
    '/api/alerts',
    subscriptionAccess(supabase),
    alertRoutes(),
  );

  app.use(
    '/api/notifications',
    subscriptionAccess(supabase),
    notificationRoutes(),
  );

  app.use(
    '/api/messages',
    subscriptionAccess(supabase),
    messageRoutes(),
  );

  /*
   * Creator administration and customer support.
   *
   * These routers must enforce creator-admin and support permissions
   * inside their handlers or dedicated middleware. Authentication alone
   * must not grant creator-administrator access.
   */
  app.use(
    '/api/creator',
    creatorAdminRoutes(config),
  );

  app.use(
    '/api/support',
    supportRoutes(config),
  );

  /*
   * Operational routes requiring subscription access.
   */
  app.use(
    '/api/attendance',
    subscriptionAccess(supabase),
    attendanceRoutes(),
  );

  app.use(
    '/api/operations',
    subscriptionAccess(supabase),
    operationsRoutes(),
  );

  app.use(
    '/api/advanced-operations',
    subscriptionAccess(supabase),
    advancedOperationsRoutes(),
  );

  app.use(
    '/api/payroll',
    subscriptionAccess(supabase),
    payrollRoutes(),
  );

  app.use(
    '/api/accountability',
    subscriptionAccess(supabase),
    accountabilityRoutes(),
  );

  app.use(
    '/api/controls',
    subscriptionAccess(supabase),
    controlsRoutes(),
  );

  app.use(
    '/api/governance',
    subscriptionAccess(supabase),
    governanceRoutes(),
  );

  /*
   * Station routes.
   *
   * Keep these routes available to authenticated users only. Each handler
   * must enforce company membership, branch assignments, and role-specific
   * permissions before returning or modifying station data.
   */
  app.use(
    '/api/stations',
    stationRoutes(),
  );

  /*
   * Team routes use the subscription gate.
   * Their handlers must separately enforce invitation and role permissions.
   */
  app.use(
    '/api',
    subscriptionAccess(supabase),
    teamRoutes(config),
  );

  /*
   * Final middleware order matters:
   * 1. Not-found handler
   * 2. Central error handler
   */
  app.use(notFound);
  app.use(errorHandler);

  return app;
}