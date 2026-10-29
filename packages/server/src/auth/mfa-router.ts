import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { strictBody, validate } from '../http/errors.js';
import type { AuthService } from './auth-service.js';
import type { MfaService } from './mfa-service.js';
import { authenticate, currentUser } from './session.js';

const enableSchema = strictBody({
  mfaCode: z.string({ error: 'Two-factor code is required' }).max(64, { error: 'Invalid two-factor code' }),
});

const disableSchema = strictBody({
  mfaCode: z.string().max(64).optional(),
  mfaRecoveryCode: z.string().max(64).optional(),
});

/** Two-factor settings of the signed-in user: `/rest/mfa/setup`, `/rest/mfa/enable`, `/rest/mfa/disable`. */
export function createMfaRouter(deps: AppDeps, services: { auth: AuthService; mfa: MfaService }): Router {
  const { auth, mfa } = services;
  const router = Router();
  router.use('/mfa', authenticate(deps));

  // The only response that ever carries the secret and the recovery codes: never cache it.
  router.post('/mfa/setup', async (req, res) => {
    const setup = await mfa.setup(currentUser(req));
    res.set('Cache-Control', 'no-store');
    res.json(setup);
  });

  router.post('/mfa/enable', async (req, res) => {
    const { mfaCode } = validate(enableSchema, req.body ?? {});
    const user = currentUser(req);
    await mfa.enable(user, mfaCode);
    res.json(await auth.toPublicUser(user));
  });

  router.post('/mfa/disable', async (req, res) => {
    const input = validate(disableSchema, req.body ?? {});
    const user = currentUser(req);
    await mfa.disable(user, { code: input.mfaCode, recoveryCode: input.mfaRecoveryCode });
    res.json(await auth.toPublicUser(user));
  });

  return router;
}
