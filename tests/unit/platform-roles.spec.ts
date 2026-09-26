import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PLATFORM_ROLES } from '../../shared/enums'
import { PLATFORM_ACTIONS, platformCan, type PlatformAction } from '../../shared/domain/platformRoles'

/**
 * Матрица прав операторов платформы (docs/25 §7 п. 7, решение владельца 26.09.2026): каждая роль ×
 * каждое действие — явным ожиданием, а не пересказом самой матрицы. Изменение прав роли обязано
 * менять и эту таблицу, и docs/25.
 */

const Y = true
const N = false
//                                      owner admin billing support viewer
const EXPECTED: Record<PlatformAction, [boolean, boolean, boolean, boolean, boolean]> = {
  'platform.read': [Y, Y, Y, Y, Y],
  'tenant.read': [Y, Y, Y, Y, Y],
  'tenant.users.read': [Y, Y, Y, Y, Y],
  'billing.read': [Y, Y, Y, N, Y],
  'operators.read': [Y, Y, Y, Y, Y],
  'tenant.create': [Y, Y, N, N, N],
  'tenant.update': [Y, Y, N, N, N],
  'tenant.suspend': [Y, Y, N, N, N],
  'tenant.purge': [Y, N, N, N, N],
  'tenant.impersonate': [Y, Y, N, Y, N],
  'tenant.two_factor_reset': [Y, Y, N, Y, N],
  'billing.limits': [Y, Y, Y, N, N],
  'billing.payments': [Y, Y, Y, N, N],
  'billing.plan_change': [Y, Y, Y, N, N],
  'billing.extend': [Y, Y, Y, N, N],
  'announcements.manage': [Y, Y, N, N, N],
  'operators.manage': [Y, N, N, N, N],
  'operators.two_factor_reset': [Y, N, N, N, N],
}

describe('матрица прав операторов (docs/25 §7 п. 7)', () => {
  it('таблица ожиданий покрывает все действия', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...PLATFORM_ACTIONS].sort())
  })

  for (const action of PLATFORM_ACTIONS) {
    PLATFORM_ROLES.forEach((role, i) => {
      it(`${role} × ${action} → ${EXPECTED[action][i] ? 'можно' : 'нельзя'}`, () => {
        expect(platformCan(role, action)).toBe(EXPECTED[action][i])
      })
    })
  }

  it('неизвестная или пустая роль не может ничего', () => {
    for (const action of PLATFORM_ACTIONS) {
      expect(platformCan('superuser', action)).toBe(false)
      expect(platformCan(null, action)).toBe(false)
      expect(platformCan(undefined, action)).toBe(false)
    }
  })
})

/** Все файлы ручек под каталогом. */
function handlers(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return handlers(p)
    return /\.(get|post|put|patch|delete)\.ts$/.test(n) ? [p] : []
  })
}

describe('каждая ручка /api/v1/platform/* проверяет право на сервере', () => {
  const root = join(process.cwd(), 'server/api/v1/platform')
  // Открыты без действия: вход, выход, `me`, второй фактор (своя сессия) и принятие приглашения (без сессии)
  const OPEN = /\/(login\.post|logout\.post|me\.get)\.ts$|\/two-factor\/|\/invite\//

  it('ручка без действия или с неизвестным действием — ошибка', () => {
    const files = handlers(root)
    expect(files.length).toBeGreaterThan(25)
    const bad: string[] = []
    for (const f of files) {
      if (OPEN.test(f)) continue
      const src = readFileSync(f, 'utf8')
      const actions = [...src.matchAll(/requirePlatform\(event, '([^']+)'\)/g)].map(m => m[1]!)
      if (!actions.length || actions.some(a => !(PLATFORM_ACTIONS as readonly string[]).includes(a))) bad.push(f.slice(root.length))
      if (/requirePlatform\(event\)/.test(src)) bad.push(`${f.slice(root.length)} (без действия)`)
    }
    expect(bad).toEqual([])
  })
})
