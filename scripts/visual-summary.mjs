#!/usr/bin/env node
/**
 * Итог визуальных тестов (docs/28 «visual-mockups») в $GITHUB_STEP_SUMMARY: сколько экранов
 * проверено, сколько прошли оба сигнала (скриншот + структура), и список расхождений —
 * собирается из аннотаций `mockup-gap`, которые screens.spec.ts кладёт в json-отчёт
 * Playwright (visual-report/results.json, репортёр настроен в playwright.visual.config.ts).
 *
 * Отдельный файл, а не `node -e "…"` прямо в ci.yml — внутри YAML `run: |` шаблонные строки
 * JS (`${…}`, обратные кавычки) конфликтуют с подстановкой переменных bash.
 */
import { readFileSync } from 'node:fs'

const RESULTS_FILE = 'visual-report/results.json'

function collectSpecs(suites, out = []) {
  for (const suite of suites ?? []) {
    collectSpecs(suite.suites, out)
    for (const spec of suite.specs ?? []) out.push(spec)
  }
  return out
}

function main() {
  let report
  try {
    report = JSON.parse(readFileSync(RESULTS_FILE, 'utf-8'))
  }
  catch {
    console.log(`\`${RESULTS_FILE}\` не создан — тесты не запустились, см. шаг «Визуальные тесты»`)
    return
  }

  const specs = collectSpecs(report.suites)
  let total = 0
  let passed = 0
  const gaps = new Set()

  for (const spec of specs) {
    for (const t of spec.tests ?? []) {
      if (t.results.every(r => r.status === 'skipped')) continue // другой проект (desktop/mobile) для этого экрана
      total++
      if (t.results.every(r => r.status === 'passed')) passed++
      for (const res of t.results) {
        for (const a of res.annotations ?? []) {
          if (a.type !== 'mockup-gap') continue
          try {
            const d = JSON.parse(a.description)
            if (d.missing?.length) gaps.add(`- **${d.screen}**: ${d.missing.join(', ')}`)
          }
          catch { /* аннотация не наша — игнор */ }
        }
      }
    }
  }

  console.log(`Экранов проверено: ${total}, прошли оба сигнала: ${passed}\n`)
  if (gaps.size) {
    console.log('Расхождения с мокапом (текст мокапа не найден на экране приложения):\n')
    console.log([...gaps].join('\n'))
  }
  else {
    console.log('Расхождений по текстам мокапа не найдено.')
  }
}

main()
