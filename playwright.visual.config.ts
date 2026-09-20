import 'dotenv/config'
import { defineConfig, devices } from '@playwright/test'

/**
 * Визуальные тесты по мокапам (docs/28 «visual-mockups», docs/32 §Б строка 21) — отдельный
 * конфиг, а не project в playwright.config.ts: другой набор проектов (сравнение вьюпорта
 * приложения с фиксированным размером рамки мокапа, а не устройства из docs/06), свой
 * webServer-порт (чтобы можно было гонять параллельно с обычным e2e), свой html-отчёт
 * (visual-report/) и они не входят в `pnpm check` — расхождения фиксируются, не блокируют
 * мердж (CLAUDE.md «Экономия контекста»: этот PR отдельный, «не смешивать с функциональными»).
 *
 * `snapshotPathTemplate` указывает toHaveScreenshot() брать эталон прямо из
 * tests/visual/mockups/<имя-переданное-в-toHaveScreenshot> — то есть из тех же PNG, что
 * кладёт `pnpm visual:mockups` (scripts/mockup-shots.ts). Копировать эталон в отдельную
 * `-snapshots/` папку не нужно.
 */
const PORT = 3791

export default defineConfig({
  testDir: 'tests/visual',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  // json-репортёр — источник для шага CI, который собирает список расхождений (аннотации
  // mockup-gap из checkStructure) в $GITHUB_STEP_SUMMARY.
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never', outputFolder: 'visual-report' }], ['json', { outputFile: 'visual-report/results.json' }]]
    : [['html', { open: 'never', outputFolder: 'visual-report' }], ['list']],
  snapshotPathTemplate: 'tests/visual/mockups/{arg}{ext}',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
    locale: 'uk-UA',
  },
  projects: [
    // Вьюпорт = размер рамки мокапа (docs/31 «Общие элементы»), не дефолт devices — иначе
    // размеры скриншота приложения и эталона (снятого mockup-shots.ts) не совпадут.
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } } },
  ],
  webServer: {
    command: `PORT=${PORT} NITRO_PORT=${PORT} OTP_DEBUG=1 WORKER_ENABLED=0 node .output/server/index.mjs`,
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { ...process.env as Record<string, string>, NUXT_DATABASE_URL: process.env.DATABASE_URL ?? '' },
  },
})
