import { Router } from 'express';
import type { AppDeps } from '../app.js';
import { authenticate, currentUser, normalizeId } from '../auth/session.js';
import type { ApiKeyService } from './api-key-service.js';

/** `/rest/api-keys`: the signed-in user's own public API keys (n8n: Settings → n8n API). */
export function createApiKeysRouter(deps: AppDeps, services: { apiKeys: ApiKeyService }): Router {
  const { apiKeys } = services;
  const router = Router();
  router.use('/api-keys', authenticate(deps));

  router.get('/api-keys', async (req, res) => {
    res.json(await apiKeys.list(currentUser(req).id));
  });

  router.post('/api-keys', async (req, res) => {
    const created = await apiKeys.create(currentUser(req).id, req.body ?? {});
    // The full key is in this response only; no cache may keep a copy.
    res.set('Cache-Control', 'no-store');
    res.json(created);
  });

  router.delete('/api-keys/:id', async (req, res) => {
    await apiKeys.remove(currentUser(req).id, normalizeId(req.params.id));
    res.json({ deleted: true });
  });

  return router;
}
