import type { Request, Response } from 'express';
import { getLiveness, getReadiness } from '../services/health.service.js';
import { getLeadWorkerStatus } from '../services/leadWorker.service.js';

/** GET /health - liveness. Always 200 while the process can serve requests. */
export function healthCheck(_req: Request, res: Response): void {
  res.status(200).json(getLiveness());
}

/** GET /health/ready - readiness. 503 when a required dependency is down. */
export async function readinessCheck(_req: Request, res: Response): Promise<void> {
  const result = await getReadiness();
  res.status(result.status === 'ready' ? 200 : 503).json(result);
}

/**
 * GET /health/worker - background lead-worker status.
 *
 * Returns whether the worker is enabled/running, when it last polled, its recent
 * safe tallies and any sanitised last error. No secrets or PII. 200 when the
 * worker is running (or disabled by config); 503 when it is enabled but not
 * running (e.g. crashed loop) so an orchestrator can alert.
 */
export function workerStatus(_req: Request, res: Response): void {
  const status = getLeadWorkerStatus();
  const unhealthy = status.enabled && !status.running;
  res.status(unhealthy ? 503 : 200).json(status);
}
