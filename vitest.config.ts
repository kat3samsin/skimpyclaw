import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['dist/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**'],
      reporter: ['text'],
      thresholds: {
        statements: 57,
        branches: 48,
        functions: 64,
        lines: 59,
      },
    },
  },
});
