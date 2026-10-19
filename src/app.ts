import express, { type Express } from 'express';
import helmet from 'helmet';
import cors, { type CorsOptions } from 'cors';
import { env } from './config/env.js';
import { router } from './routes/index.js';
import { retellWebhookRouter } from './routes/retell.routes.js';
import { requestId } from './middleware/requestId.js';
import { requestLogger } from './middleware/requestLogger.js';
import { notFoundHandler } from './middleware/notFound.js';
import { errorHandler } from './middleware/errorHandler.js';

/** Generous enough for JSON webhooks, small enough to bound memory use. */
const JSON_BODY_LIMIT = '100kb';

function buildCorsOptions(): CorsOptions {
  const allowed = env.CORS_ALLOWED_ORIGINS;

  // No allowlist configured -> no cross-origin access headers at all.
  // This service is server-to-server by default; wildcard CORS is never used.
  if (allowed.length === 0) {
    return { origin: false };
  }

  return {
    origin: allowed,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  };
}

/**
 * Builds the Express application.
 *
 * Exported as a factory (rather than a module-level singleton) so tests can
 * create an isolated instance without starting a listener.
 */
export function createApp(): Express {
  const app = express();

  // Behind a load balancer this is required for correct client IPs; `1` trusts
  // exactly one proxy hop rather than blindly trusting every forwarded header.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(cors(buildCorsOptions()));

  app.use(requestId);
  app.use(requestLogger);

  // Retell webhook is mounted BEFORE the global JSON parser: it needs the raw
  // body bytes for signature verification, so it uses its own raw parser. It is
  // isolated from lead polling and outbound-call initiation.
  app.use('/webhooks/retell', retellWebhookRouter);

  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: JSON_BODY_LIMIT }));

  app.use(router);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
