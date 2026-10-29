import type { ResolvePasswordTokenResponse } from '@app/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { strictBody, validate } from '../http/errors.js';
import type { AuthService } from './auth-service.js';
import { createPasswordResetService } from './password-reset.js';
import {
  changePasswordRateLimits,
  forgotPasswordEmailRateLimit,
  forgotPasswordIpRateLimit,
  loginIpRateLimit,
  loginRateLimit,
  signupRateLimit,
} from './rate-limit.js';
import { authenticate, currentUser, issueSession, revokeSession } from './session.js';

const loginSchema = strictBody({
  email: z.string({ error: 'Email is required' }).max(512, { error: 'Invalid email address' }),
  password: z.string({ error: 'Password is required' }).max(1024, { error: 'Password is too long' }),
  mfaCode: z.string().max(64).optional(),
  mfaRecoveryCode: z.string().max(64).optional(),
});

/**
 * `/rest/signup`, `/rest/login`, `/rest/logout` and the password reset flow (`/rest/forgot-password`,
 * `/rest/resolve-password-token`, `/rest/change-password`) — same paths as n8n.
 */
export function createAuthRouter(deps: AppDeps, services: { auth: AuthService }): Router {
  const { auth } = services;
  const passwordReset = createPasswordResetService({ ...deps, auth });
  const router = Router();

  router.post('/signup', signupRateLimit(deps.redis), async (req, res) => {
    const user = await auth.signup(req.body ?? {});
    issueSession(res, user, deps.config);
    res.json(await auth.toPublicUser(user));
  });

  router.post('/login', loginIpRateLimit(deps.redis), loginRateLimit(deps.redis), async (req, res) => {
    const input = validate(loginSchema, req.body ?? {});
    const user = await auth.login(input.email, input.password, {
      code: input.mfaCode,
      recoveryCode: input.mfaRecoveryCode,
    });
    issueSession(res, user, deps.config);
    res.json(await auth.toPublicUser(user));
  });

  router.get('/login', authenticate(deps), async (req, res) => {
    res.json(await auth.toPublicUser(currentUser(req)));
  });

  // Not behind `authenticate`: logging out must work for a disabled user or an already invalid session.
  router.post('/logout', async (req, res) => {
    await revokeSession(req, res, deps);
    res.json({ loggedOut: true });
  });

  // Always the same 200: the answer must not reveal whether an account exists.
  router.post(
    '/forgot-password',
    forgotPasswordIpRateLimit(deps.redis),
    forgotPasswordEmailRateLimit(deps.redis),
    async (req, res) => {
      await passwordReset.requestReset(req.body ?? {});
      res.json({});
    },
  );

  // `mfaRequired` lets the reset page show the 2FA code field up front (only to whoever holds the link).
  router.get('/resolve-password-token', async (req, res) => {
    const user = await passwordReset.resolveToken(req.query.token);
    res.json({ mfaRequired: user.mfaEnabled } satisfies ResolvePasswordTokenResponse);
  });

  // Signs the user in on the device that reset the password (all older sessions are invalid now).
  router.post('/change-password', ...changePasswordRateLimits(deps.redis), async (req, res) => {
    const user = await passwordReset.changePassword(req.body ?? {});
    issueSession(res, user, deps.config);
    res.json(await auth.toPublicUser(user));
  });

  return router;
}
