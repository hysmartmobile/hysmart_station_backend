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
import billingRoutes, { billingWebhookRoutes } from './routes/billing.js';
import alertRoutes from './routes/alerts.js';
import notificationRoutes from './routes/notifications.js';
import messageRoutes from './routes/messages.js';
import payrollRoutes from './routes/payroll.js';
import accountabilityRoutes from './routes/accountability.js';
import advancedOperationsRoutes from './routes/advancedOperations.js';
import supportRoutes from './routes/support.js';
import creatorAdminRoutes from './routes/creatorAdmin.js';

export function createApp(config, supabase) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.nodeEnv === 'production' ? 1 : false);
  app.use(requestContext);
  app.use(helmet({ contentSecurityPolicy: config.nodeEnv === 'production' ? undefined : false }));
  const allowedOrigins = new Set(config.frontendOrigins || []);
  app.use(cors({
    credentials: false,
    origin(origin, callback) {
      // Non-browser clients have no Origin header; authentication still applies to /api.
      if (!origin || allowedOrigins.has(origin.replace(/\/$/, ''))) return callback(null, true);
      return callback(new Error('ORIGIN_NOT_ALLOWED'));
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
  }));
  app.use(express.json({ limit: config.requestBodyLimit || '100kb', strict: true, verify(req, _res, buffer) { req.rawBody = Buffer.from(buffer); } }));
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false }));
  // Mount the router, not a Router object as a single GET handler; this exposes /api/health and /api/health/ready.
  app.use('/api/health', healthRoutes(config, supabase));
  app.use('/api/billing', billingWebhookRoutes(config, supabase));
  // Read-only token-validated invitation preview must be available before authentication.
  app.use('/api', publicInvitationRoutes(supabase));
  app.use('/api', authMiddleware(supabase));
  app.use('/api/me', meRoutes());
  app.use('/api/billing', billingRoutes(config));
  app.use('/api/companies', companyRoutes());
  app.use('/api/alerts', subscriptionAccess(supabase), alertRoutes());
  app.use('/api/notifications', subscriptionAccess(supabase), notificationRoutes());
  app.use('/api/messages', subscriptionAccess(supabase), messageRoutes());
  app.use('/api/creator', creatorAdminRoutes(config));
  app.use('/api/support', supportRoutes(config));
  // Enforce the seven-day trial / paid-entitlement policy on operational and
  // team APIs server-side. Billing, /me, company bootstrap/audit, and invitees
  // who have not joined a company remain reachable for recovery/onboarding.
  app.use('/api/attendance', subscriptionAccess(supabase), attendanceRoutes());
  app.use('/api/operations', subscriptionAccess(supabase), operationsRoutes());
  app.use('/api/advanced-operations', subscriptionAccess(supabase), advancedOperationsRoutes());
  app.use('/api/payroll', subscriptionAccess(supabase), payrollRoutes());
  app.use('/api/accountability', subscriptionAccess(supabase), accountabilityRoutes());
  app.use('/api/controls', subscriptionAccess(supabase), controlsRoutes());
  app.use('/api/governance', subscriptionAccess(supabase), governanceRoutes());
  app.use('/api/stations', stationRoutes());
  app.use('/api', subscriptionAccess(supabase), teamRoutes(config));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
