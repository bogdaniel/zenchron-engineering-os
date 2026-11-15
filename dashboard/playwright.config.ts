import { defineConfig } from '@playwright/test';

const environment = (
  globalThis as typeof globalThis & { process?: { env?: Record<string, string | undefined> } }
).process?.env ?? {};
const dashboardPort = Number(environment.ZENCHRON_E2E_DASHBOARD_PORT) || 4173;
// The worker finds `codex` here first: a deterministic fake CLI, so runs use the real CLI process path.
const fakeCLIDirectory = decodeURIComponent(new URL('./e2e/fake-cli', import.meta.url).pathname);

export default defineConfig({
  testDir: './e2e',
  globalTeardown: './e2e/teardown.mjs',
  use: {
    baseURL: `http://zenchron.test:${dashboardPort}`,
    launchOptions: { args: ['--host-resolver-rules=MAP zenchron.test 127.0.0.1'] },
  },
  webServer: [
    {
      command: 'sh ./dev.sh',
      url: `http://127.0.0.1:${dashboardPort}`,
      env: {
        ZENCHRON_API_PROXY: 'http://127.0.0.1:8083', ZENCHRON_DASHBOARD_PORT: String(dashboardPort),
      },
      reuseExistingServer: !environment.ZENCHRON_E2E_DASHBOARD_PORT,
      timeout: 120_000,
    },
    {
      command: 'sh ./dashboard/e2e/control-plane.sh',
      cwd: '..',
      url: 'http://127.0.0.1:8083/healthz',
      env: { ZENCHRON_LISTEN_ADDR: '127.0.0.1:8083' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'go run ./cmd/zenchron-worker',
      cwd: '..',
      url: 'http://127.0.0.1:8083/api/v1/workers/healthz',
      env: {
        ZENCHRON_CONTROL_PLANE_URL: 'http://127.0.0.1:8083',
        ZENCHRON_WORKER_NAME: 'playwright-worker',
        ZENCHRON_PROJECTS_ROOT: '.playwright-state/projects',
        ZENCHRON_WORKTREES_ROOT: '.playwright-state/worktrees',
        PATH: `${fakeCLIDirectory}:${environment.PATH ?? ''}`,
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
