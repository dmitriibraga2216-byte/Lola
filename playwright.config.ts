import 'dotenv/config'
import { defineConfig, devices } from '@playwright/test'

/**
 * e2e (docs/06 §6.10): гоняются против собранного приложения (.output) на
 * отдельном порту, с OTP_DEBUG=1 — код приходит в ответе request.
 * Мобильный вьюпорт — сотрудник учится с телефона (docs/00 §0.2).
 */
const PORT = 3790

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // одна БД, один тенант
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    locale: 'uk-UA',
  },
  projects: [
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testMatch: /admin.*\.spec\.ts/ },
  ],
  webServer: {
    command: `PORT=${PORT} NITRO_PORT=${PORT} OTP_DEBUG=1 WORKER_ENABLED=0 node .output/server/index.mjs`,
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { ...process.env as Record<string, string>, NUXT_DATABASE_URL: process.env.DATABASE_URL ?? '' },
  },
})
