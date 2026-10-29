import { type Request, Router } from 'express';
import type { AppDeps } from '../app.js';
import type { AuthService } from '../auth/auth-service.js';
import { createRateLimit, ipKey } from '../auth/rate-limit.js';
import { authenticate, currentUser, issueSession, normalizeId, requireGlobalRole } from '../auth/session.js';
import type { InvitationService } from './invitations.js';
import type { UserService } from './users-service.js';

/**
 * Instance users (n8n: Settings → Users) for the owner and admins — `/rest/users/*`,
 * `POST /rest/invitations` — and the two public invitation routes the invited person uses.
 */
export function createUsersRouter(
  deps: AppDeps,
  services: { auth: AuthService; users: UserService; invitations: InvitationService },
): Router {
  const { auth, users, invitations } = services;
  const managers = [authenticate(deps), requireGlobalRole('global:owner', 'global:admin')];
  // Each request mails up to 20 addresses: 10 requests a minute per inviter keeps a stolen admin
  // session from turning the instance into a mail cannon.
  const inviteLimit = createRateLimit({
    name: 'invitations-user',
    windowMs: 60_000,
    limit: 10,
    key: (req) => req.user?.id ?? ipKey(req),
    redis: deps.redis,
  });
  const router = Router();
  router.use('/users', ...managers);

  router.get('/users', async (req, res) => {
    res.json(await users.list(req.query));
  });

  router.patch(
    '/users/:id/role',
    requireGlobalRole('global:owner'),
    async (req: Request<{ id: string }>, res) => {
      res.json(await users.changeRole(currentUser(req), normalizeId(req.params.id), req.body ?? {}));
    },
  );

  router.patch('/users/:id', async (req, res) => {
    res.json(await users.update(currentUser(req), normalizeId(req.params.id), req.body ?? {}));
  });

  router.delete('/users/:id', async (req, res) => {
    await users.remove(currentUser(req), normalizeId(req.params.id));
    res.json({ deleted: true });
  });

  router.post('/invitations', ...managers, inviteLimit, async (req, res) => {
    res.json(await invitations.invite(currentUser(req), req.body ?? {}));
  });

  // Public: the invited person has no session yet. The tokens are signed, so they cannot be guessed.
  router.get('/invitations/resolve', async (req, res) => {
    res.json(await invitations.resolve(req.query.token));
  });

  router.post('/invitations/accept', async (req, res) => {
    const user = await invitations.accept(req.body ?? {});
    issueSession(res, user, deps.config);
    res.json(await auth.toPublicUser(user));
  });

  return router;
}
