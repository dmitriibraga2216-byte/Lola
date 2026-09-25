import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_LEVEL_KEYS, ACTIVITY_LEVELS, ACTIVITY_SOURCES, activityLevel, formatHoursMinutes, isIanaTimezone, yearGrid,
} from '../../shared/domain/activity'
import type { ActivityDay } from '../../shared/domain/activity'
import { USER_ACTIVITY_KINDS } from '../../shared/enums'

/**
 * Правила ленты и карты активности без базы (docs/v2/38 §5.1, §7.9, §7.10; PR-34): уровень по
 * числу событий, раскладка года по неделям, время «HH:MM», проверка пояса — и сторож закрытого
 * списка: каждый из двенадцати видов где-то порождается, и ссылается на свою таблицу.
 */

describe('уровень дня — по числу событий, не по времени (§7.10)', () => {
  it('0 — нет; 1 — 1–2; 2 — 3–5; 3 — 6–10; 4 — больше 10', () => {
    const cases: [number, number][] = [[0, 0], [1, 1], [2, 1], [3, 2], [5, 2], [6, 3], [10, 3], [11, 4], [250, 4], [-1, 0]]
    for (const [n, level] of cases) expect(activityLevel(n), `${n} подій`).toBe(level)
  })

  it('пять уровней легенды «Немає · Невелика · Середня · Висока · Дуже висока»', () => {
    expect([...ACTIVITY_LEVELS]).toEqual([0, 1, 2, 3, 4])
    expect(ACTIVITY_LEVEL_KEYS).toHaveLength(5)
  })
})

describe('сетка года (§5.1): недели с понедельника, день — локальная дата человека', () => {
  const day = (date: string, count: number): ActivityDay => ({ date, count, seconds: 0, level: activityLevel(count), kinds: { lesson_completed: count } })

  it('2026: 53 колонки, 1 января — четверг, клетка 11 марта закрашена, 10 марта — пустая', () => {
    const grid = yearGrid(2026, [day('2026-03-11', 1)])
    expect(grid).toHaveLength(53)
    expect(grid[0]!.map(c => c.date)).toEqual([null, null, null, '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'])
    const cells = grid.flat()
    expect(cells.filter(c => c.date).length).toBe(365)
    expect(cells.find(c => c.date === '2026-03-11')!.day!.level).toBe(1)
    expect(cells.find(c => c.date === '2026-03-10')!.day).toBeNull()
    // 11.03.2026 — среда: третья строка своей колонки
    const col = grid.find(w => w.some(c => c.date === '2026-03-11'))!
    expect(col.findIndex(c => c.date === '2026-03-11')).toBe(2)
  })

  it('високосный год с воскресенья (2012) — 54 колонки и 366 дней', () => {
    const grid = yearGrid(2012, [])
    expect(grid).toHaveLength(54)
    expect(grid.flat().filter(c => c.date).length).toBe(366)
  })

  it('окно смотрящего: до `from` и после `to` клетки приглушены и без данных', () => {
    const grid = yearGrid(2026, [day('2026-06-01', 4), day('2026-09-01', 2)], { from: '2026-07-01', to: '2026-09-25' })
    const cells = grid.flat()
    expect(cells.find(c => c.date === '2026-06-01')).toMatchObject({ muted: true, day: null })
    expect(cells.find(c => c.date === '2026-09-01')).toMatchObject({ muted: false })
    expect(cells.find(c => c.date === '2026-09-01')!.day!.count).toBe(2)
    expect(cells.find(c => c.date === '2026-12-31')!.muted).toBe(true)
  })

  it('раскладка не зависит от пояса процесса: даты считаются в UTC', () => {
    const before = process.env.TZ
    process.env.TZ = 'Pacific/Kiritimati' // UTC+14 — любой сдвиг поясом сломал бы 1 января
    try {
      expect(yearGrid(2026, [])[0]!.map(c => c.date)[3]).toBe('2026-01-01')
    }
    finally {
      process.env.TZ = before
    }
  })
})

describe('время в подсказке «{HH:MM} у навчанні»', () => {
  it('секунды → часы и минуты, сутки не сворачиваются', () => {
    expect(formatHoursMinutes(0)).toBe('00:00')
    expect(formatHoursMinutes(59)).toBe('00:00')
    expect(formatHoursMinutes(65 * 60)).toBe('01:05')
    expect(formatHoursMinutes(26 * 3600 + 120)).toBe('26:02')
  })
})

describe('users.timezone — только IANA (§3.1)', () => {
  it('имена поясов принимаются, смещения и выдумки — нет', () => {
    for (const tz of ['Europe/Kyiv', 'Asia/Dubai', 'America/Argentina/Buenos_Aires', 'Etc/GMT-4', 'UTC']) expect(isIanaTimezone(tz), tz).toBe(true)
    for (const tz of ['', 'UTC+4', '+04:00', 'Mars/Olympus_Mons', 'Europe', 'kyiv']) expect(isIanaTimezone(tz), tz).toBe(false)
  })
})

describe('закрытый список событий (§7.9) полностью подключён', () => {
  const root = resolve(__dirname, '../..')
  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, out)
      else if (p.endsWith('.ts')) out.push(p)
    }
    return out
  }
  /** Вызовы `recordActivity(…)` в server/ с их видом и таблицей-источником. */
  const calls = walk(join(root, 'server')).flatMap((file) => {
    const src = readFileSync(file, 'utf8')
    return [...src.matchAll(/recordActivity\(tx, [^{]*\{([^\n]*)\}\)/g)].map((m) => {
      const kind = /kind: '([a-z_]+)'/.exec(m[1]!)?.[1] ?? null
      const entity = /entity: '([a-z_]+)'/.exec(m[1]!)?.[1] ?? null
      return { file: relative(root, file), kind, entity }
    })
  })

  it('сканер видит вызовы — иначе проверка проходит по построению', () => {
    expect(calls.length).toBeGreaterThanOrEqual(12)
    expect(calls.every(c => c.kind), JSON.stringify(calls.filter(c => !c.kind))).toBe(true)
  })

  it('каждый из двенадцати видов порождается хотя бы одним местом, лишних видов нет', () => {
    const kinds = new Set(calls.map(c => c.kind))
    expect([...kinds].sort()).toEqual([...USER_ACTIVITY_KINDS].sort())
  })

  it('источник события — таблица из ACTIVITY_SOURCES', () => {
    const bad = calls.filter(c => !c.entity || !(ACTIVITY_SOURCES as Record<string, { refs: readonly string[] }>)[c.kind!]!.refs.includes(c.entity))
    expect(bad, JSON.stringify(bad)).toEqual([])
    expect(Object.keys(ACTIVITY_SOURCES).sort()).toEqual([...USER_ACTIVITY_KINDS].sort())
  })

  it('события пишет только сервис ленты', () => {
    const writers = walk(join(root, 'server')).filter(f => /insert into user_activity_(events|daily)|\.insert\(userActivity(Events|Daily)\)/.test(readFileSync(f, 'utf8')))
      .map(f => relative(root, f))
    expect(writers).toEqual(['server/services/activity.ts'])
  })
})
