import type { AppConfig } from '@app/config';
import { createDataSource } from '../db/data-source.js';
import { describeError } from '../describe-error.js';

/** Postgres error code for "database already exists". */
const DUPLICATE_DATABASE = '42P04';

/**
 * Creates `config.db.database` if it is missing. The docker init script creates the test database on a
 * fresh volume, but init scripts never rerun on an existing one, so older dev volumes only have `moj_n8n`.
 */
export async function ensureDatabase(config: AppConfig): Promise<void> {
  const { db } = config;
  // Same credentials, but the maintenance database (a database cannot be created from inside itself).
  const maintenance = createDataSource({ ...config, db: { ...db, database: 'postgres' } });
  try {
    await maintenance.initialize();
  } catch (error) {
    throw new Error(
      `Cannot connect to PostgreSQL at ${db.host}:${db.port} (${describeError(error)}) - start it with: pnpm infra:up`,
    );
  }
  try {
    const found = await maintenance.query('SELECT 1 FROM pg_database WHERE datname = $1', [db.database]);
    if (found.length === 0) {
      try {
        await maintenance.query(`CREATE DATABASE "${db.database.replaceAll('"', '""')}"`);
      } catch (error) {
        // Another run created it between the check and the CREATE.
        const code = (error as { driverError?: { code?: string } }).driverError?.code;
        if (code !== DUPLICATE_DATABASE) throw error;
      }
    }
  } finally {
    await maintenance.destroy();
  }
}
