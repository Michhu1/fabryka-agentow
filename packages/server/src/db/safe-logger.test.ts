import { afterEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../test/db.js';
import { createDataSource } from './data-source.js';
import { SafeTypeormLogger } from './safe-logger.js';

const SECRET = '$2b$10$secretsecretsecretsecretsecretsecretsecretsecret';

afterEach(() => {
  vi.restoreAllMocks();
});

function captured(spy: { mock: { calls: unknown[][] } }): string {
  return JSON.stringify(spy.mock.calls);
}

describe('SafeTypeormLogger', () => {
  it('logs a failed query with its text and error, never its parameters', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    new SafeTypeormLogger().logQueryError(
      new Error('duplicate key value violates unique constraint "UQ_user_email"'),
      'INSERT INTO "user"("email", "password_hash") VALUES ($1, $2)',
      ['jan@firma.pl', SECRET],
    );
    const out = captured(error);
    expect(out).toContain('INSERT INTO');
    expect(out).toContain('UQ_user_email');
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain('jan@firma.pl');
  });

  it('never logs parameters of slow queries or plain queries', () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    const logger = new SafeTypeormLogger();
    logger.logQuery('SELECT $1', [SECRET]);
    logger.logQuerySlow(5000, 'SELECT $1', [SECRET]);
    for (const spy of spies) expect(captured(spy)).not.toContain(SECRET);
  });

  it('is the logger of the application DataSource', () => {
    expect(createDataSource(testConfig()).logger).toBeInstanceOf(SafeTypeormLogger);
  });
});
