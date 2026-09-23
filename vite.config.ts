import { defineConfig } from 'vitest/config';

// Served from https://jacobanana.github.io/beat-mapper/, so every asset URL is under /beat-mapper/.
export default defineConfig({
  base: '/beat-mapper/',
  build: { target: 'es2022', sourcemap: true },
  worker: { format: 'es' },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
  },
});
