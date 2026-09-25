import { defineConfig } from 'vitest/config';

// The benchmarks: run on demand (`make eval-notes`), never by `npm test`.
export default defineConfig({
  test: { include: ['bench/**/*.eval.ts'], environment: 'node', testTimeout: 3_600_000 },
});
