// vitest.config.ts
//
// Separate from vite.config.ts (rather than merged via vite's own
// `test` key) so the production build config stays untouched by test
// tooling. Re-declares the same '@' alias vite.config.ts uses, since
// every source file under src/ imports via '@/...'.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    css: false,
    // e2e/ holds Playwright specs (run via `npx playwright test`, see
    // playwright.config.ts), not vitest tests — vitest's default include
    // pattern (**/*.spec.ts) would otherwise pick them up and fail trying
    // to execute Playwright's test.describe() outside the Playwright
    // runner.
    exclude: ['node_modules', 'dist', 'e2e'],
  },
});
