import type { MemberRole } from '@app/shared';
import type { DataSource } from 'typeorm';
import type { createFakeMailer } from './app.js';

/**
 * Makes `userId` an editor or viewer of a project straight in the database, for tests that need members
 * but are not about invitations (the API only adds members through an accepted invitation).
 */
export async function insertMember(
  dataSource: DataSource,
  projectId: string,
  userId: string,
  role: MemberRole,
): Promise<void> {
  await dataSource.query(`INSERT INTO project_relation (project_id, user_id, role) VALUES ($1, $2, $3)`, [
    projectId,
    userId,
    role,
  ]);
}

/**
 * The token of the last link to `/<page>?token=…` mailed to `to` (e.g. `project-invitation`,
 * `project-transfer`); throws when there is none.
 */
export function mailedToken(
  mailer: ReturnType<typeof createFakeMailer>,
  to: string,
  page: 'project-invitation' | 'project-transfer',
): string {
  const link = new RegExp(`/${page}\\?token=([\\w-]+)`);
  const mail = mailer.sent.filter((m) => m.to === to && link.test(m.text)).at(-1);
  const token = mail ? link.exec(mail.text)?.[1] : undefined;
  if (!token) throw new Error(`no ${page} link mailed to ${to}`);
  return token;
}
