import { pinoHttp } from 'pino-http';
import type { RequestHandler } from 'express';
import { logger } from '../lib/logger.js';

/**
 * Structured access logging.
 *
 * Request and response BODIES are never serialized: they can contain lead
 * personal data and provider payloads. Only method, URL, status, and the
 * correlation id are recorded.
 */
export const requestLogger: RequestHandler = pinoHttp({
  logger,
  genReqId: (req) => req.id ?? 'unknown',
  quietReqLogger: true,
  customLogLevel: (_req, res, err) => {
    if (err) return 'error';
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Health probes are high-frequency and low-signal.
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/health/ready',
  },
  serializers: {
    req: (req: { id: unknown; method: string; url: string }) => ({
      id: req.id,
      method: req.method,
      url: req.url,
    }),
    res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
  },
});
