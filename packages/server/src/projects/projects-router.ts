import { type Request, Router } from 'express';
import type { AppDeps } from '../app.js';
import { createRateLimit, ipKey } from '../auth/rate-limit.js';
import { authenticate, currentUser, normalizeId } from '../auth/session.js';
import type { ProjectInvitationService } from './project-invitations.js';
import type { ProjectService } from './project-service.js';
import type { ProjectTransferService } from './project-transfers.js';

/**
 * `/rest/projects/*` (n8n paths): the signed-in user's projects, team project settings, members,
 * invitations and transfer — plus `/rest/project-invitations/*` and `/rest/project-transfers/*`, which
 * the person a link was mailed to uses (resolving a link is public: they may have no account yet).
 * Access rules live in the services; this layer only maps HTTP to them.
 */
export function createProjectsRouter(
  deps: AppDeps,
  services: {
    projects: ProjectService;
    invitations: ProjectInvitationService;
    transfers: ProjectTransferService;
  },
): Router {
  const { projects, invitations, transfers } = services;
  // Every invitation sends a mail to an address of the owner's choosing: 30 per 10 minutes per user
  // keeps a stolen session from turning a project into a mail cannon.
  const invitationLimit = createRateLimit({
    name: 'project-members-user',
    windowMs: 10 * 60_000,
    limit: 30,
    key: (req) => req.user?.id ?? ipKey(req),
    redis: deps.redis,
  });
  // Each request mails a link too; the password or 2FA check has its own per-user limits on failures.
  const transferLimit = createRateLimit({
    name: 'project-transfer-user',
    windowMs: 10 * 60_000,
    limit: 10,
    key: (req) => req.user?.id ?? ipKey(req),
    redis: deps.redis,
  });
  const router = Router();
  router.use('/projects', authenticate(deps));

  // Fixed paths before `/projects/:id`, which would otherwise take them as an id.
  router.get('/projects/my-projects', async (req, res) => {
    res.json(await projects.listForUser(currentUser(req).id));
  });

  router.get('/projects/personal', async (req, res) => {
    res.json(await projects.personal(currentUser(req).id));
  });

  router.post('/projects', async (req, res) => {
    res.json(await projects.create(currentUser(req).id, req.body ?? {}));
  });

  router.get('/projects/:id', async (req, res) => {
    res.json(await projects.details(currentUser(req).id, normalizeId(req.params.id)));
  });

  router.patch('/projects/:id', async (req, res) => {
    res.json(await projects.update(currentUser(req).id, normalizeId(req.params.id), req.body ?? {}));
  });

  router.delete('/projects/:id', async (req, res) => {
    await projects.remove(currentUser(req).id, normalizeId(req.params.id));
    res.json({ deleted: true });
  });

  router.get('/projects/:id/invitations', async (req, res) => {
    res.json(await invitations.list(currentUser(req).id, normalizeId(req.params.id)));
  });

  router.post('/projects/:id/invitations', invitationLimit, async (req: Request<{ id: string }>, res) => {
    res.json(await invitations.invite(currentUser(req), normalizeId(req.params.id), req.body ?? {}));
  });

  router.delete('/projects/:id/invitations/:invitationId', async (req, res) => {
    const [id, invitationId] = [normalizeId(req.params.id), normalizeId(req.params.invitationId)];
    await invitations.cancel(currentUser(req).id, id, invitationId);
    res.json({ deleted: true });
  });

  router.patch('/projects/:id/members/:userId', async (req, res) => {
    const [id, userId] = [normalizeId(req.params.id), normalizeId(req.params.userId)];
    res.json(await projects.changeMemberRole(currentUser(req).id, id, userId, req.body ?? {}));
  });

  router.delete('/projects/:id/members/:userId', async (req, res) => {
    const [id, userId] = [normalizeId(req.params.id), normalizeId(req.params.userId)];
    await projects.removeMember(currentUser(req).id, id, userId);
    res.json({ removed: true });
  });

  router.post('/projects/:id/transfer', transferLimit, async (req: Request<{ id: string }>, res) => {
    res.json(await transfers.request(currentUser(req), normalizeId(req.params.id), req.body ?? {}));
  });

  router.get('/projects/:id/transfer', async (req, res) => {
    res.json(await transfers.pending(currentUser(req).id, normalizeId(req.params.id)));
  });

  router.delete('/projects/:id/transfer', async (req, res) => {
    await transfers.cancel(currentUser(req).id, normalizeId(req.params.id));
    res.json({ deleted: true });
  });

  // The link holder's side. Tokens are 32 random bytes, so they cannot be guessed.
  router.get('/project-invitations/resolve', async (req, res) => {
    res.json(await invitations.resolve(req.query.token));
  });

  router.post('/project-invitations/accept', authenticate(deps), async (req, res) => {
    res.json(await invitations.accept(currentUser(req), req.body ?? {}));
  });

  router.get('/project-transfers/resolve', async (req, res) => {
    res.json(await transfers.resolve(req.query.token));
  });

  router.post('/project-transfers/accept', authenticate(deps), async (req, res) => {
    res.json(await transfers.accept(currentUser(req), req.body ?? {}));
  });

  return router;
}
