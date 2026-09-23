import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { OWNER_ONLY_SCOPES, OWNER_ROLE_CODE, SCOPES, SYSTEM_ROLES } from '../../shared/domain/roles'
import { SCOPE_GROUPS } from '../../server/services/roles'
import { rankRole } from '../../server/services/activeRole'

/**
 * Состав прав владельца (docs/01 §1.2, §1.4, §1.9.4; `docs/v2/35-billing-limits.md` §2).
 *
 * Тест сторожит не «список из N строк», а смысл роли: администратор управляет системой,
 * владелец — тем, что нельзя отдать наёмному администратору. Если завтра кто-нибудь добавит
 * `billing.manage` администратору «чтобы было удобнее» или превратит `owner` в копию `admin`,
 * падать должно здесь, а не на демонстрации заказчику.
 */

const root = resolve(__dirname, '../..')
const owner = SYSTEM_ROLES[OWNER_ROLE_CODE]!
const admin = SYSTEM_ROLES.admin!

describe('роль «Власник»: состав прав', () => {
  it('роль есть среди системных и называется «Власник»', () => {
    expect(OWNER_ROLE_CODE).toBe('owner')
    expect(owner.name).toBe('Власник')
  })

  it('деньги и владение — только у владельца, у администратора их нет', () => {
    for (const scope of OWNER_ONLY_SCOPES) {
      expect(owner.scopes, `${scope} обязан быть у владельца`).toContain(scope)
      expect(admin.scopes, `${scope} не должен быть у администратора`).not.toContain(scope)
    }
    // Ни у одной другой системной роли их тоже нет: «единственный распоряжается тарифом»
    for (const [code, role] of Object.entries(SYSTEM_ROLES)) {
      if (code === OWNER_ROLE_CODE) continue
      expect(role.scopes.filter(s => (OWNER_ONLY_SCOPES as readonly string[]).includes(s)), `лишнее у ${code}`).toEqual([])
    }
  })

  it('владелец единственный распоряжается тарифом и оплатой, но счётчики видит и администратор', () => {
    expect(owner.scopes).toContain('billing.manage')
    expect(owner.scopes).toContain('billing.payments.view')
    // `docs/v2/35` §2: «Счётчики потребления — admin ✓ owner ✓», «Суммы и история платежей — admin —»
    expect(admin.scopes).toContain('billing.usage.view')
    expect(admin.scopes).toContain('billing.view')
    expect(admin.scopes).not.toContain('billing.payments.view')
  })

  it('владелец может передать владение и сменить администратора', () => {
    expect(owner.scopes).toContain('tenant.transfer')
    // Иначе владелец не смог бы уволить администратора и нанять другого — §1.9.4
    for (const s of ['role.assign', 'people.view', 'people.invite', 'people.edit', 'people.deactivate']) {
      expect(owner.scopes, s).toContain(s)
    }
  })

  it('владелец — не копия администратора: контент, проверка, рассылки и интеграции ему не принадлежат', () => {
    for (const s of ['course.create', 'course.edit', 'course.publish', 'question.manage', 'assignment.create', 'review.queue', 'review.grade', 'settings.notifications', 'settings.integrations', 'people.import']) {
      expect(owner.scopes, `${s} у владельца быть не должно`).not.toContain(s)
    }
    // И количественно: владелец заметно уже администратора, а не «admin + немного»
    expect(owner.scopes.length).toBeLessThan(admin.scopes.length / 2)
  })

  it('владелец учится и видит отчёты по сети — иначе роль бесполезна в интерфейсе', () => {
    for (const s of ['learn.view', 'report.own', 'report.tenant', 'audit.view', 'settings.tenant']) {
      expect(owner.scopes, s).toContain(s)
    }
  })

  it('в наборе владельца нет дублей и все скоупы известны', () => {
    expect(new Set(owner.scopes).size).toBe(owner.scopes.length)
    expect(owner.scopes.filter(s => !(SCOPES as readonly string[]).includes(s))).toEqual([])
  })

  it('`tenant.transfer` попал в группы редактора ролей — иначе право невидимо на экране', () => {
    const inGroups = SCOPE_GROUPS.flatMap(g => g.scopes)
    expect(inGroups).toContain('tenant.transfer')
    // И ни один скоуп не потерян: экран ролей обязан показывать их все
    expect(SCOPES.filter(s => !inGroups.includes(s)), 'скоупы вне групп редактора').toEqual([])
  })

  it('у каждого скоупа владельца есть текст в uk и en (CLAUDE.md п. 8)', () => {
    for (const locale of ['uk', 'en']) {
      const dict = JSON.parse(readFileSync(join(root, `i18n/locales/${locale}.json`), 'utf8')) as { settings: { scopes: Record<string, string>, roles: { group: Record<string, string> } } }
      for (const s of owner.scopes) expect(dict.settings.scopes[s], `${locale}: ${s}`).toBeTruthy()
      for (const g of SCOPE_GROUPS) expect(dict.settings.roles.group[g.key], `${locale}: группа ${g.key}`).toBeTruthy()
    }
  })
})

describe('роль по умолчанию при нескольких ролях', () => {
  /**
   * Владелец стоит после администратора, хотя в таблице §1.2 он выше: речь о широте рабочего
   * интерфейса, а не о старшинстве. Человек с обеими ролями при входе попадает в админку и
   * переключается во владельца осознанно — иначе собственник малой сети, который сам ведёт
   * обучение, каждый вход начинал бы с пустого меню.
   */
  it('admin → owner → author → manager → mentor → своя роль → employee', () => {
    expect([
      rankRole('admin'), rankRole('owner'), rankRole('author'),
      rankRole('manager'), rankRole('mentor'), rankRole('custom_x'), rankRole('employee'),
    ]).toEqual([0, 1, 2, 3, 4, 5, 6])
  })
})
