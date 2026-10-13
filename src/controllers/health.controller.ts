import type { Request, Response } from 'express';
import { getLiveness, getReadiness } from '../services/health.service.js';

/** GET /health - liveness. Always 200 while the process can serve requests. */
export function healthCheck(_req: Request, res: Response): void {
  res.status(200).json(getLiveness());
}

/** GET /health/ready - readiness. 503 when a required dependency is down. */
export async function readinessCheck(_req: Request, res: Response): Promise<void> {
  const result = await getReadiness();
  res.status(result.status === 'ready' ? 200 : 503).json(result);
}
