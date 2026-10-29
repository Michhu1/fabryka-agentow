import type { UserSettings } from '@app/shared';
import { Router } from 'express';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import {
  type AuthService,
  CURRENT_PASSWORD_REQUIRED,
  currentPasswordField,
  emailField,
  firstNameField,
  lastNameField,
  newPasswordField,
  personalProjectName,
} from '../auth/auth-service.js';
import { authenticate, currentUser, issueSession } from '../auth/session.js';
import { hashPassword } from '../crypto/password.js';
import { Project } from '../db/entities/project.entity.js';
import { User } from '../db/entities/user.entity.js';
import { HttpError, strictBody, validate } from '../http/errors.js';

const profileSchema = strictBody({
  firstName: firstNameField.optional(),
  lastName: lastNameField.optional(),
  email: emailField.optional(),
  currentPassword: currentPasswordField.optional(),
  mfaCode: z.string().max(64).optional(),
});

const passwordSchema = strictBody({
  currentPassword: currentPasswordField,
  newPassword: newPasswordField,
  mfaCode: z.string().max(64).optional(),
});

const settingsSchema = strictBody({
  theme: z.enum(['system', 'light', 'dark'], { error: 'Theme must be system, light or dark' }).optional(),
});

/**
 * The signed-in user's own account (n8n: `/rest/me`): profile, email, password and preferences.
 * Role, disabled state and 2FA are never changed here (admin endpoints and `/rest/mfa/*` do that).
 * Current passwords and second factors are checked through the app's shared `auth` service, so the
 * per-user limits on failures count these routes together with login, password reset, the 2FA settings
 * and project transfers.
 */
export function createMeRouter(deps: AppDeps, services: { auth: AuthService }): Router {
  const { auth } = services;
  const { dataSource, config } = deps;
  const router = Router();
  router.use('/me', authenticate(deps));

  router.patch('/me', async (req, res) => {
    const input = validate(profileSchema, req.body ?? {});
    const user = currentUser(req);
    const changes: Partial<Pick<User, 'firstName' | 'lastName' | 'email'>> = {};
    if (input.firstName !== undefined && input.firstName !== user.firstName)
      changes.firstName = input.firstName;
    if (input.lastName !== undefined && input.lastName !== user.lastName) changes.lastName = input.lastName;
    // The same address in another case is no change (the field is normalized) and needs no password.
    if (input.email !== undefined && input.email !== user.email) changes.email = input.email;
    if (Object.keys(changes).length === 0) {
      res.json(await auth.toPublicUser(user));
      return;
    }

    const emailChange = changes.email !== undefined;
    let verifiedHash: string | undefined;
    if (emailChange) {
      if (!input.currentPassword) throw new HttpError(400, CURRENT_PASSWORD_REQUIRED);
      // bcrypt before the transaction: no connection is held meanwhile.
      verifiedHash = await auth.verifyCurrentPassword(user, input.currentPassword);
      // The new address receives password reset links, so it takes the same proof as a password change:
      // otherwise a stolen session plus the password would take over an account protected by 2FA.
      await auth.verifyCurrentSecondFactor(user, input.mfaCode);
    }

    let saved: User;
    try {
      saved = await dataSource.transaction(async (em) => {
        // Row lock: concurrent edits of the same profile run one after another, so the personal
        // project name below is always built from the row as it ends up.
        const fresh = await em.findOne(User, { where: { id: user.id }, lock: { mode: 'pessimistic_write' } });
        // The email changes only while the password checked above is still the current one.
        if (!fresh || fresh.disabled || (verifiedHash && fresh.passwordHash !== verifiedHash)) {
          throw new HttpError(401, 'Unauthorized');
        }
        if (changes.email !== undefined && (await em.existsBy(User, { email: changes.email }))) {
          throw new HttpError(400, 'Email already in use');
        }
        await em.update(User, { id: user.id }, changes);
        Object.assign(fresh, changes);
        await em
          .createQueryBuilder()
          .update(Project)
          .set({ name: personalProjectName(fresh) })
          .where(
            `id IN (SELECT project_id FROM project_relation WHERE user_id = :userId AND role = 'project:personalOwner')`,
            { userId: user.id },
          )
          .execute();
        return fresh;
      });
    } catch (error) {
      // The unique index wins a race with a concurrent signup or email change to the same address.
      if ((error as { code?: unknown }).code === '23505') throw new HttpError(400, 'Email already in use');
      throw error;
    }
    // The session fingerprint covers the email: every older session (this cookie included) has ended,
    // so this browser gets a new one.
    if (emailChange) issueSession(res, saved, config);
    res.json(await auth.toPublicUser(saved));
  });

  router.patch('/me/password', async (req, res) => {
    const input = validate(passwordSchema, req.body ?? {});
    const user = currentUser(req);
    const oldHash = await auth.verifyCurrentPassword(user, input.currentPassword);
    await auth.verifyCurrentSecondFactor(user, input.mfaCode);
    const passwordHash = await hashPassword(input.newPassword);
    // Applies only over the password just checked: of two concurrent changes exactly one wins, and the
    // loser's session has ended with the other change anyway.
    const result = await dataSource
      .getRepository(User)
      .update({ id: user.id, passwordHash: oldHash, disabled: false }, { passwordHash });
    if (result.affected !== 1) throw new HttpError(401, 'Unauthorized');
    // Every older session (other devices) dies: their `h` was computed from the old hash.
    user.passwordHash = passwordHash;
    issueSession(res, user, config);
    res.json(await auth.toPublicUser(user));
  });

  router.patch('/me/settings', async (req, res) => {
    const input = validate(settingsSchema, req.body ?? {});
    const user = currentUser(req);
    const patch: UserSettings = {};
    if (input.theme !== undefined) patch.theme = input.theme;
    if (Object.keys(patch).length > 0) {
      // Merged in SQL: keys this request does not send (including ones added later) are kept, even
      // when another request changes them at the same time.
      const result = await dataSource
        .getRepository(User)
        .createQueryBuilder()
        .update()
        .set({ settings: () => `settings || :patch::jsonb` })
        .setParameter('patch', JSON.stringify(patch))
        .where('id = :id', { id: user.id })
        .returning('settings')
        .execute();
      const rows = result.raw as { settings: UserSettings }[];
      user.settings = rows[0]?.settings ?? { ...user.settings, ...patch };
    }
    res.json(await auth.toPublicUser(user));
  });

  return router;
}
