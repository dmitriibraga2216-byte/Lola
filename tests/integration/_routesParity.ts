import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Разбор docs/04-api.md и сверка с server/api/v1 (spec-04-routes, docs/28 «Spec 04»).
 *
 * Формат документа: почти везде таблица `| Метод | Путь | Описание |` — метод в первом
 * столбце (`GET`, `POST`, комбинации через `/`, либо `CRUD`), путь(и) в backtick’ах во
 * втором. Раздел «4.14 Отчёты и журналы» — исключение, у него два столбца `| Путь | Что |`,
 * метод (если не GET) написан текстом перед путём в первом столбце.
 *
 * Разбираются только «канонические» столбцы таблицы — пути, упомянутые только в тексте
 * описания (например, старые пути «Сегодня — …»), парсер не собирает: это ожидаемо,
 * старые пути и так работают, а не должны появляться в списке требований `04`.
 */

export interface DocRoute {
  method: string
  path: string
  section: string
}

const METHOD_WORD = '(?:GET|POST|PUT|PATCH|DELETE)'
const METHOD_CELL_RE = new RegExp(`^${METHOD_WORD}(?:/${METHOD_WORD})*$`)
const PATHS_RE = /`(\/[^`]*)`/g

function isReportsSection(section: string): boolean {
  return section.includes('Отчёты и журналы')
}

/**
 * Эллиптический список в одной ячейке docs/04 (например §4.8:
 * `` `/resources/:id/duplicate`, `/archive`, `/restore` ``) — второй и третий путь
 * подразумевают тот же префикс, что и первый. Разворачиваем однословные «хвосты»
 * в полный путь, многосегментные оставляем как есть.
 */
function expandShorthand(paths: string[]): string[] {
  if (paths.length < 2) return paths
  const prefix = paths[0]!.split('/').filter(Boolean).slice(0, -1).join('/')
  if (!prefix) return paths
  return paths.map((p, i) => {
    if (i === 0) return p
    const segs = p.split('/').filter(Boolean)
    return segs.length === 1 ? `/${prefix}/${segs[0]}` : p
  })
}

export function parseDocRoutes(md: string): DocRoute[] {
  const routes: DocRoute[] = []
  let section = ''
  for (const rawLine of md.split('\n')) {
    const line = rawLine.trim()
    if (line.startsWith('## ')) { section = line.slice(3).trim(); continue }
    if (!line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map(c => c.trim())
    if (cells.length < 2) continue
    if (cells.every(c => /^:?-+:?$/.test(c))) continue // строка-разделитель таблицы

    if (isReportsSection(section)) {
      // «Путь | Что»: метод — необязательный префикс перед путём (по умолчанию GET)
      const cell = cells[0]!
      const pathMatch = cell.match(/`(\/[^`]*)`/)
      if (!pathMatch) continue
      const prefixMatch = cell.match(new RegExp(`^(${METHOD_WORD}(?:/${METHOD_WORD})*)\\s`))
      const methods = prefixMatch ? prefixMatch[1]!.split('/') : ['GET']
      for (const m of methods) routes.push({ method: m.toLowerCase(), path: pathMatch[1]!, section })
      continue
    }

    // «Метод | Путь | Описание»
    if (cells.length < 3) continue
    const methodCell = cells[0]!
    const pathsCell = cells[1]!
    const paths = expandShorthand([...pathsCell.matchAll(PATHS_RE)].map(m => m[1]!))
    if (!paths.length) continue

    if (methodCell === 'CRUD') {
      for (const p of paths) {
        routes.push({ method: 'get', path: p, section })
        routes.push({ method: 'post', path: p, section })
        routes.push({ method: 'patch', path: `${p}/:id`, section })
        routes.push({ method: 'delete', path: `${p}/:id`, section })
      }
      continue
    }
    if (!METHOD_CELL_RE.test(methodCell)) continue
    const methods = methodCell.split('/')
    for (const p of paths) for (const m of methods) routes.push({ method: m.toLowerCase(), path: p, section })
  }
  return routes
}

/** `:id`, `:contentType`, … → `{param}`; регистр и хвостовой query — не важны. */
export function toTemplate(path: string): string {
  return path.split('?')[0]!.split('/').filter(Boolean)
    .map(s => (s.startsWith(':') ? '{param}' : s.toLowerCase()))
    .join('/')
}

function walk(dir: string, base = ''): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const rel = base ? `${base}/${entry}` : entry
    if (statSync(full).isDirectory()) out.push(...walk(full, rel))
    else if (entry.endsWith('.ts')) out.push(rel)
  }
  return out
}

export interface ActualRoute {
  method: string
  segments: string[]
}

/** Реальные маршруты (метод + сегменты шаблона), обслуживаемые файлами в server/api/v1. */
export function buildRouteIndex(apiRoot: string): ActualRoute[] {
  const routes: ActualRoute[] = []
  for (const f of walk(apiRoot)) {
    const m = f.match(/^(.*)\.(get|post|put|patch|delete)\.ts$/)
    if (!m) continue
    const [, pathPart, method] = m
    const segs = pathPart!.split('/').filter(s => s && s !== 'index')
      .map(s => (/^\[.+\]$/.test(s) ? '{param}' : s.toLowerCase()))
    routes.push({ method: method!, segments: segs })
  }
  return routes
}

/**
 * Динамический сегмент (`{param}`) совпадает с любым сегментом на той же позиции —
 * с обеих сторон: doc может писать `:kind` буквально как `task-status` (Nitro-маршрут
 * один файл `[kind].get.ts` на всё семейство `/logs/*`), а может и совпадать по имени
 * параметра с обеих сторон дословно.
 */
function segmentsMatch(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  return a.every((s, i) => s === b[i] || s === '{param}' || b[i] === '{param}')
}

export interface ParityResult {
  covered: string[]
  missing: string[]
}

export function checkParity(md: string, apiRoot: string): ParityResult {
  const actual = buildRouteIndex(apiRoot)
  const dedup = new Map<string, DocRoute>()
  for (const r of parseDocRoutes(md)) dedup.set(`${r.method}:${toTemplate(r.path)}`, r)

  const covered: string[] = []
  const missing: string[] = []
  for (const [, r] of dedup) {
    const label = `${r.method.toUpperCase()} ${r.path}`
    const docSegs = toTemplate(r.path).split('/').filter(Boolean)
    const found = actual.some(a => a.method === r.method && segmentsMatch(a.segments, docSegs))
    if (found) covered.push(label)
    else missing.push(label)
  }
  return { covered: covered.sort(), missing: missing.sort() }
}
