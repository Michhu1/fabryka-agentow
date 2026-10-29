import type { ProjectSummary, PublicApiList } from '@app/shared';
import { Router } from 'express';
import type { ApiKeyService } from '../api-keys/api-key-service.js';
import type { AppDeps } from '../app.js';
import { createRateLimit } from '../auth/rate-limit.js';
import { currentUser } from '../auth/session.js';
import { HttpError } from '../http/errors.js';
import type { ProjectService } from '../projects/project-service.js';

declare global {
  namespace Express {
    interface Request {
      /** Id of the API key the request was authenticated with (public API only). */
      apiKeyId?: string;
    }
  }
}

/**
 * The public API (`/api/v1`, n8n: `/api/v1` with `X-N8N-API-KEY`) for scripts and other services.
 * Only the `X-API-KEY` header authenticates: the session cookie is never read here, so a page the user
 * visits cannot use their browser session against this API (with no CORS, it cannot read the answers
 * either). Because of that, mutating endpoints added later need no `Content-Type` check like `/rest`
 * (`jsonOnly`): a cross-site request cannot attach the header without a preflight we never answer.
 */
export function createPublicApiRouter(
  deps: AppDeps,
  services: { apiKeys: ApiKeyService; projects: ProjectService },
): Router {
  const { apiKeys, projects } = services;
  const router = Router();

  // Authentication first, for every path: without a valid key even an unknown path is 401, so the API
  // does not reveal which endpoints exist.
  router.use(async (req, _res, next) => {
    const result = await apiKeys.authenticate(req.get('x-api-key'));
    if (!result) return next(new HttpError(401, 'Unauthorized'));
    req.user = result.user;
    req.apiKeyId = result.keyId;
    next();
  });

  // 60 requests per minute per key (all instances share the counters in queue mode).
  router.use(
    createRateLimit({
      name: 'public-api-key',
      windowMs: 60_000,
      limit: 60,
      key: (req) => req.apiKeyId ?? '',
      redis: deps.redis,
    }),
  );

  router.get('/projects', async (req, res) => {
    res.json({
      data: await projects.listForUser(currentUser(req).id),
    } satisfies PublicApiList<ProjectSummary>);
  });

  router.use((_req, res) => {
    res.status(404).json({ message: 'Not found' });
  });

  return router;
}
