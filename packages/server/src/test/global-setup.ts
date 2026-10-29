import { testConfig } from './db.js';
import { ensureDatabase } from './ensure-database.js';

/** Creates the int test database `moj_n8n_test` if it is missing. */
export default async function setup(): Promise<void> {
  await ensureDatabase(testConfig());
}
