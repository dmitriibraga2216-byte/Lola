#!/usr/bin/env tsx
/**
 * Эталоны визуальных тестов (docs/28 «visual-mockups», PR visual-mockups): открывает
 * статические мокапы docs/mockups/screens/<Имя>.html в Chromium и снимает скриншот
 * элемента `.frame` (сам мокап рисует изолированную рамку экрана на бежевом фоне —
 * это и есть «полная страница» в терминах мокапа, снимать `page.screenshot({fullPage:true})`
 * не нужно и даже вредно: он утянет в кадр примонтированный вокруг рамки паддинг).
 *
 * Эталон = единственный «полный» скриншот мокапа. Второй, более полезный контур проверки —
 * структурные тексты (scripts/mockupText.ts) — используется прямо в тесте, тут не нужен.
 *
 * Размер вьюпорта берём равным размеру рамки мокапа (десктоп 1440×900, кабинет 390×844,
 * см. docs/31 «Общие элементы»), а не размеру браузерных `devices` Playwright — иначе рамка
 * мокапа (фиксированного размера) и вьюпорт разъезжаются и элемент обрезается или остаётся
 * лишнее поле. Названия совпадают с `snapshotPathTemplate` в playwright.visual.config.ts:
 * `<Имя>-<project>.png`, где <project> — имя Playwright-проекта (desktop/mobile).
 *
 * Запуск: pnpm visual:mockups
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const MOCKUPS_DIR = path.join(ROOT, 'docs/mockups/screens')
const OUT_DIR = path.join(ROOT, 'tests/visual/mockups')

type Project = 'desktop' | 'mobile'
// Тело мокапа — flex-контейнер с padding:40px 20px вокруг `.frame` (центрирует рамку на
// бежевом фоне); если вьюпорт браузера равен точному размеру рамки, flex по главной оси
// (ширина) сжимает саму рамку, чтобы вписаться в паддинг — рамка выходит уже, чем задумано.
// Поэтому вьюпорт для съёмки эталона больше рамки на запас под паддинг, а сам элемент
// `.frame` снимается один в один по его собственным CSS-размерам (1440×900 / 390×844,
// см. docs/31 «Общие элементы») — именно они и есть размер вьюпорта для playwright.visual.config.ts.
const VIEWPORT: Record<Project, { width: number, height: number }> = {
  desktop: { width: 1600, height: 1040 },
  mobile: { width: 520, height: 984 },
}

/** Экраны из docs/32 §Б строка 21 (Main, Login, TaskCard, Profile) + Learn home, Notice. */
const SCREENS: { mockup: string, project: Project }[] = [
  { mockup: 'Main', project: 'desktop' },
  { mockup: 'TaskCard', project: 'desktop' },
  { mockup: 'Login', project: 'mobile' }, // только шаг кода — другого мокапа для шага телефона нет (docs/28)
  { mockup: 'Profile', project: 'mobile' },
  { mockup: 'MyTasks', project: 'mobile' }, // Learn home (/learn)
  { mockup: 'Notice', project: 'mobile' },
]

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()
  try {
    for (const { mockup, project } of SCREENS) {
      const file = path.join(MOCKUPS_DIR, `${mockup}.html`)
      const page = await browser.newPage({ viewport: VIEWPORT[project] })
      await page.goto(`file://${file}`, { waitUntil: 'load' })
      try { await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready) }
      catch { /* шрифт не загрузился (нет сети) — снимаем на фолбэке, это не мешает структурным проверкам */ }
      await page.waitForTimeout(150) // досвоп шрифта/анимаций после fonts.ready
      const frame = page.locator('.frame')
      const outFile = path.join(OUT_DIR, `${mockup}-${project}.png`)
      await frame.screenshot({ path: outFile })
      console.log(`✓ ${mockup}-${project}.png`)
      await page.close()
    }
  }
  finally {
    await browser.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
