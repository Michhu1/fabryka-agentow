import type { Router } from 'express';
import express from 'express';
import { collectDefaultMetrics, Registry } from 'prom-client';

export type ReadinessCheck = { name: string; check: () => Promise<boolean> };

async function runCheck({ check }: ReadinessCheck): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

export function healthRouter(checks: ReadinessCheck[], opts: { metrics: boolean }): Router {
  const router = express.Router();
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  router.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/healthz/readiness', async (_req, res) => {
    const results = await Promise.all(checks.map(async (c) => ({ name: c.name, ok: await runCheck(c) })));
    const failed = results.filter((r) => !r.ok).map((r) => r.name);
    if (failed.length > 0) {
      res.status(503).json({ status: 'error', failed });
      return;
    }
    res.json({ status: 'ok' });
  });

  if (opts.metrics) {
    router.get('/metrics', async (_req, res) => {
      res.type(registry.contentType).send(await registry.metrics());
    });
  }

  return router;
}
