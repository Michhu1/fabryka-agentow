import { loadConfig } from '@app/config';
import { createDataSource } from '../db/data-source.js';
import { truncateAll } from './db.js';
import { ensureDatabase } from './ensure-database.js';

/**
 * Prepares the E2E database before Playwright starts the server (`e2e/playwright.config.ts`): creates
 * it if missing, applies the migrations and empties all tables, so every run starts with no accounts
 * (the first signup becomes the platform owner). Reads the same environment variables as the server.
 * Refuses any database whose name does not end in `_e2e`, so it can never wipe the dev data.
 */
const config = loadConfig();
const { database } = config.db;
if (!database.endsWith('_e2e')) {
  console.error(`Refusing to empty "${database}": the E2E database name must end with _e2e`);
  process.exit(1);
}
await ensureDatabase(config);
const dataSource = createDataSource(config);
await dataSource.initialize();
try {
  await dataSource.runMigrations();
  await truncateAll(dataSource);
} finally {
  await dataSource.destroy();
}
console.log(`E2E database "${database}" is ready (migrated, empty)`);
