import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  globalTeardown: './e2e/teardown.mjs',
  use: { baseURL: 'http://127.0.0.1:4174' },
  webServer: [
    {
      command: 'node ./dashboard/e2e/mock-llm.mjs',
      cwd: '..',
      url: 'http://127.0.0.1:8082/healthz',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'sh ./dashboard/e2e/control-plane.sh',
      cwd: '..',
      url: 'http://127.0.0.1:8081/healthz',
      env: { ZENCHRON_LISTEN_ADDR: '127.0.0.1:8081' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'go run ./cmd/zenchron-worker',
      cwd: '..',
      url: 'http://127.0.0.1:8081/api/v1/workers/healthz',
      env: {
        ZENCHRON_CONTROL_PLANE_URL: 'http://127.0.0.1:8081',
        ZENCHRON_WORKER_NAME: 'playwright-worker',
        ZENCHRON_PROJECTS_ROOT: '.playwright-state/projects',
        ZENCHRON_WORKTREES_ROOT: '.playwright-state/worktrees',
        ZENCHRON_LLM_BASE_URL: 'http://127.0.0.1:8082/v1',
        ZENCHRON_LLM_API_KEY: 'e2e-test-key',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run build && ZENCHRON_DASHBOARD_PORT=4174 ZENCHRON_API_PROXY=http://127.0.0.1:8081 npm run dev',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
