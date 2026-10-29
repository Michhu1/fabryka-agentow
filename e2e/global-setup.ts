import { clearMailbox } from './helpers/mailpit';

/** Runs once before the tests (after Playwright started the server and the editor). */
export default async function globalSetup(): Promise<void> {
  await clearMailbox();
}
