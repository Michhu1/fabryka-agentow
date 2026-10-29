import { defineConfig } from 'vitest/config';

/** Integration tests: one shared test database, so files run one after another. */
export default defineConfig({
  test: {
    include: ['src/**/*.int.test.ts'],
    globalSetup: ['src/test/global-setup.ts'],
    fileParallelism: false,
  },
});
