import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.spec.ts', 'tests/integration/**/*.spec.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Все файлы делят одну БД и один тенант «Каппі» — гонки между файлами недопустимы
    fileParallelism: false,
  },
})
