import type { AppConfig } from '@app/config';
import type { AppDeps, ReadinessCheck } from '../app.js';
import { createDataSource } from '../db/data-source.js';
import type { Mailer } from '../mail/mailer.js';

type SentMail = Parameters<Mailer['send']>[0];

/** A mailer that only records what would have been sent. */
export function createFakeMailer(): Mailer & { sent: SentMail[] } {
  const sent: SentMail[] = [];
  return {
    sent,
    send: async (message) => {
      sent.push(message);
    },
  };
}

/** Value of the session cookie from a `Set-Cookie` header, or undefined. */
export function sessionCookie(setCookie: string | string[] | undefined): string | undefined {
  const all = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const line = all.find((c) => c.startsWith('moj-n8n-auth='));
  return line?.split(';')[0];
}

/** Dependencies for HTTP unit tests: the DataSource is never initialized, so no route may need it. */
export function testDeps(config: AppConfig, checks: ReadinessCheck[] = []): AppDeps {
  return { config, checks, dataSource: createDataSource(config), mailer: createFakeMailer() };
}
