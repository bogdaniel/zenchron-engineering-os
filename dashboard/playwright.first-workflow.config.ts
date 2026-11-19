import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.config';

const baseServers = Array.isArray(baseConfig.webServer) ? baseConfig.webServer :
  baseConfig.webServer ? [baseConfig.webServer] : [];

export default defineConfig({
  ...baseConfig,
  testMatch: 'e2e/workflows-first-run.acceptance.ts',
  webServer: baseServers.map((server) => {
    if (typeof server !== 'string' && server.url === 'http://127.0.0.1:8083/healthz') {
      return { ...server, env: { ...server.env, ZENCHRON_E2E_EMPTY_WORKFLOWS: 'true' } };
    }
    return server;
  }),
});
