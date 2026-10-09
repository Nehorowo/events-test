import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // Tests share one database, so files run one after another.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://slotwise:slotwise@localhost:5432/slotwise_test',
      APP_URL: 'http://localhost:5173',
      NODE_ENV: 'test',
    },
  },
});
