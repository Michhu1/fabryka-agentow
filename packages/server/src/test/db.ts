import { loadConfig } from '@app/config';
import type { DataSource } from 'typeorm';
import { createDataSource } from '../db/data-source.js';

/** All M1 tables; later milestones append theirs so every int test starts from empty data. */
export const M1_TABLES = [
  'user',
  'project',
  'project_relation',
  'invalid_auth_token',
  'api_key',
  'project_invitation',
  'project_transfer',
];

/**
 * Test configuration: the dev infra (`pnpm infra:up`) but its own database `moj_n8n_test`, because int
 * tests empty every table and must never wipe the accounts in the dev database `moj_n8n`.
 */
export function testConfig(env: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    ENCRYPTION_KEY: 'x'.repeat(32),
    DB_POSTGRESDB_DATABASE: 'moj_n8n_test',
    ...env,
  });
}

/** An initialized DataSource with all migrations applied. Destroy it in `afterAll`. */
export async function createTestDataSource(env: Record<string, string> = {}): Promise<DataSource> {
  const dataSource = createDataSource(testConfig(env));
  await dataSource.initialize();
  await dataSource.runMigrations();
  return dataSource;
}

/** Empties all M1 tables in one statement (int test files run sequentially on one database). */
export async function truncateAll(dataSource: DataSource): Promise<void> {
  const list = M1_TABLES.map((table) => `"${table}"`).join(', ');
  await dataSource.query(`TRUNCATE ${list} CASCADE`);
}
