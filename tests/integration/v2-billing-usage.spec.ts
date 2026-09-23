import postgres from 'postgres'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { LIMIT_AXES, LIMIT_NOTICE_LEVELS, USAGE_REF_KINDS } from '../../shared/enums'

/**
 * PR-09 пакета `docs/v2` (`45-plan.md`): учёт потребления по одиннадцати осям,
 * предупреждения и деградация (`35-billing-limits.md` §3.3, §3.5, §7.1, §7.5, §7.9;
 * патч П-25.2, решение `44` В-16).
 *
 * Критерии приёмки `35` §13, закрываемые этим PR: 1, 2, 3, 5 (часть о потреблении), 8.
 * Условие выхода: SQL сквозной проверки 15 (`42` §5) даёт ноль строк; одно открытое
 * предупреждение на ось и уровень.
 *
 * Лимит здесь не пересчитывается ни разу: квоту знает только `effectiveLimits()` (PR-08).
 * Тесты сверяют **факт** — счётчик, журнал и предупреждение.
 */

process.env.PLATFORM_DATABASE_URL ??= 'postgres://platform_admin:platform_admin_dev@localhost:5432/lola'
process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const {
  AXIS_METER, LIVE_AXES, LIMIT_WARN_PCT, billingWindow, currentWindow, currentUsage, eventSum,
  levelOf, measureLive, meterOrDegrade, recordUsage, syncCounter, syncLiveAxes, usageByAxis,
} = await import('../../server/services/usageCounters')
const { activeNotices, dismissNotice, limitScan, syncNotice } = await import('../../server/services/limitNotices')
const { effectiveLimits, invalidateLimits, GIB } = await import('../../server/services/tenantLimits')
const { setTenantLimits } = await import('../../server/services/platformTenants')
const { platformLogin, validatePlatformSession, ensureFirstAdmin, checkPlanLimit } = await import('../../server/services/platform')
const { collectUsage, usageView } = await import('../../server/services/usage')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const OPS_EMAIL = 'ops-v2-09@lola.local'
const OPS_PASSWORD = 'test-password-123'

let tenantId: string
let adminId: string
let opsAuth: Awaited<ReturnType<typeof validatePlatformSession>>

async function clean() {
  await admin`delete from usage_events where tenant_id = ${tenantId}`
  await admin`delete from usage_counters where tenant_id = ${tenantId}`
  await admin`delete from limit_notices where tenant_id = ${tenantId}`
  await admin`delete from tenant_addons where tenant_id = ${tenantId}`
  await admin`delete from tenant_limits where tenant_id = ${tenantId}`
  invalidateLimits()
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  process.env.PLATFORM_ADMIN_EMAIL = OPS_EMAIL
  process.env.PLATFORM_ADMIN_PASSWORD = OPS_PASSWORD
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await ensureFirstAdmin()
  const session = await platformLogin(OPS_EMAIL, OPS_PASSWORD)
  opsAuth = await validatePlatformSession(session!.token)
}, 60_000)

afterEach(clean)

afterAll(async () => {
  await admin`delete from platform_audit where admin_email in (${OPS_EMAIL}, 'system')`
  await admin`delete from platform_sessions where admin_id in (select id from platform_admins where email = ${OPS_EMAIL})`
  await admin`delete from platform_admins where email = ${OPS_EMAIL}`
  await admin.end()
})

// ── Миграция ────────────────────────────────────────────────────────────────────────────

describe('миграция 0061: три таблицы потребления на чистой БД', () => {
  it('usage_counters: PK (tenant_id, axis, period_start), CHECK по одиннадцати осям, RLS', async () => {
    const cols = (await admin`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'usage_counters'`)
      .map(c => c.column_name as string)
    expect(cols.sort()).toEqual(['axis', 'limit_snapshot', 'period_end', 'period_start', 'tenant_id', 'updated_at', 'used'])
    const pk = await admin`
      select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'usage_counters'::regclass and i.indisprimary`
    expect(pk.map(r => r.attname).sort()).toEqual(['axis', 'period_start', 'tenant_id'])
    const [check] = await admin`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'usage_counters'::regclass and conname = 'usage_counters_axis_check'`
    const values = [...(check!.def as string).matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]!)
    expect(values).toEqual([...LIMIT_AXES])
    const [c] = await admin`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'usage_counters'`
    expect([c!.relrowsecurity, c!.relforcerowsecurity]).toEqual([true, true])
  })

  it('usage_events: шесть ref_kind документа и request_context как у всех журналов', async () => {
    const [check] = await admin`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'usage_events'::regclass and conname = 'usage_events_ref_kind_check'`
    const values = [...(check!.def as string).matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]!)
    expect(values).toEqual([...USAGE_REF_KINDS])
    const cols = (await admin`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'usage_events'`)
      .map(c => c.column_name as string)
    expect(cols).toContain('request_context') // CLAUDE.md п. 14
  })

  it('limit_notices: одно открытое предупреждение на ось и уровень (условие выхода PR-09)', async () => {
    const [idx] = await admin`
      select indexdef from pg_indexes where tablename = 'limit_notices' and indexname = 'limit_notices_open_uidx'`
    expect(idx!.indexdef as string).toMatch(/UNIQUE.*\(tenant_id, axis, "?level"?\).*WHERE.*resolved_at IS NULL/i)
    const [check] = await admin`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'limit_notices'::regclass and conname = 'limit_notices_level_check'`
    const values = [...(check!.def as string).matchAll(/'([a-z_]+)'::text/g)].map(m => m[1]!)
    expect(values).toEqual([...LIMIT_NOTICE_LEVELS])
  })

  it('tenant_usage получил восемь колонок §3.3, plan_code вместо plan_id (В-5)', async () => {
    const cols = (await admin`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'tenant_usage'`)
      .map(c => c.column_name as string)
    for (const c of ['plan_code', 'candidates_active', 'storage_by_category', 'ai_ops', 'sms_out', 'telegram_out', 'integrations_active', 'axes']) {
      expect(cols, `tenant_usage.${c}`).toContain(c)
    }
    // У `plans` нет колонки `id` — ссылка только по коду (решение В-5, то же что у plan_prices)
    expect(cols).not.toContain('plan_id')
    const fks = await admin`
      select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'tenant_usage'::regclass and contype = 'f'`
    expect(fks.map(f => f.def as string).join(' ')).toMatch(/FOREIGN KEY \(plan_code\) REFERENCES plans\(code\)/)
  })
})

// ── Оси: как считаются и что перестаёт работать ─────────────────────────────────────────

describe('35 §7.1: одиннадцать осей, тип и поведение при исчерпании', () => {
  it('таблица AXIS_METER покрывает все одиннадцать осей и ни одной сверх', () => {
    expect(Object.keys(AXIS_METER).sort()).toEqual([...LIMIT_AXES].sort())
  })

  it('тип оси совпадает со столбцом «Тип» документа', () => {
    expect(AXIS_METER.users_active.kind).toBe('hard')
    expect(AXIS_METER.candidates_active.kind).toBe('hard')
    expect(AXIS_METER.storage_bytes.kind).toBe('hard')
    expect(AXIS_METER.ai_generate_ops.kind).toBe('hard')
    expect(AXIS_METER.ai_review_ops.kind).toBe('hard_degraded') // «жёсткий с деградацией»
    expect(AXIS_METER.ai_interview_ops.kind).toBe('hard')
    expect(AXIS_METER.sms_out.kind).toBe('hard')
    expect(AXIS_METER.telegram_out.kind).toBe('soft') // мягкая: только наблюдение
    expect(AXIS_METER.integrations_active.kind).toBe('hard')
    expect(AXIS_METER.api_rate_rpm.kind).toBe('hard')
    expect(AXIS_METER.export_rows.kind).toBe('hard_degraded')
  })

  it('«при исчерпании» совпадает со столбцом документа, ни одна ось не останавливает обучение', () => {
    expect(AXIS_METER.ai_review_ops.onExhausted).toBe('manual_review')
    expect(AXIS_METER.ai_interview_ops.onExhausted).toBe('finish_started')
    expect(AXIS_METER.sms_out.onExhausted).toBe('channel_fallback')
    expect(AXIS_METER.export_rows.onExhausted).toBe('background_job')
    expect(AXIS_METER.api_rate_rpm.onExhausted).toBe('retry_after')
    expect(AXIS_METER.telegram_out.onExhausted).toBe('observe')
    // Ни у одной оси нет значения, которое закрывало бы прохождение назначенного (§7.4)
    expect(Object.values(AXIS_METER).some(m => m.onExhausted === 'stop_learning' as never)).toBe(false)
  })

  it('журнал расхода ведут только измеряемые операции (шесть ref_kind §3.5)', () => {
    const kinds = Object.values(AXIS_METER).map(m => m.refKind).filter(Boolean)
    for (const k of kinds) expect(USAGE_REF_KINDS as readonly string[]).toContain(k!)
    // Моментальные оси строк расхода не создают — их счётчик сходится пересчётом
    expect(AXIS_METER.users_active.refKind).toBeNull()
    expect(AXIS_METER.candidates_active.refKind).toBeNull()
    expect(AXIS_METER.integrations_active.refKind).toBeNull()
  })
})

// ── Биллинговый период ──────────────────────────────────────────────────────────────────

describe('35 §7.8: окно периода', () => {
  it('без оплаты — календарный месяц, с оплатой — месяц от даты окончания', () => {
    const calendar = billingWindow({ billingPeriod: 'month', paidUntil: null }, new Date('2026-09-23T10:00:00Z'))
    expect(calendar).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    // paid_until — последний оплаченный день включительно
    const paid = billingWindow({ billingPeriod: 'month', paidUntil: '2026-10-14' }, new Date('2026-09-23T10:00:00Z'))
    expect(paid).toEqual({ start: '2026-09-15', end: '2026-10-14' })
  })

  it('окно катится вперёд, если оплаченная дата в прошлом (grace, просрочка)', () => {
    const w = billingWindow({ billingPeriod: 'month', paidUntil: '2026-07-10' }, new Date('2026-09-23T10:00:00Z'))
    expect(w.start <= '2026-09-23' && w.end >= '2026-09-23').toBe(true)
  })

  it('годовой период — двенадцать месяцев', () => {
    const w = billingWindow({ billingPeriod: 'year', paidUntil: '2026-12-31' }, new Date('2026-09-23T10:00:00Z'))
    expect(w).toEqual({ start: '2026-01-01', end: '2026-12-31' })
  })
})

// ── Счётчик, журнал и их сходимость ─────────────────────────────────────────────────────

describe('35 §3.5, §7.5: счётчик совпадает с агрегатом журнала', () => {
  it('recordUsage пополняет счётчик и пишет строку расхода; сумма журнала = счётчику', async () => {
    await setTenantLimits(tenantId, { aiGenerateOps: 100 }, opsAuth!)
    invalidateLimits()
    for (const n of [3, 5, 2]) {
      await recordUsage(tenantId, 'ai_generate_ops', n, { refKind: 'ai_generation', actorUserId: adminId })
    }
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(10)
    expect(await eventSum(tenantId, 'ai_generate_ops')).toBe(10)
  })

  it('снимок лимита берётся при открытии периода и не переписывается сменой тарифа (§7.3)', async () => {
    await setTenantLimits(tenantId, { aiReviewOps: 50 }, opsAuth!)
    invalidateLimits()
    await recordUsage(tenantId, 'ai_review_ops', 1, { refKind: 'ai_review' })
    const w = await currentWindow(tenantId)
    const [before] = await admin`select limit_snapshot from usage_counters where tenant_id = ${tenantId} and axis = 'ai_review_ops' and period_start = ${w.start}`
    expect(Number(before!.limit_snapshot)).toBe(50)
    await setTenantLimits(tenantId, { aiReviewOps: 5 }, opsAuth!)
    invalidateLimits()
    await recordUsage(tenantId, 'ai_review_ops', 1, { refKind: 'ai_review' })
    const [after] = await admin`select limit_snapshot, used from usage_counters where tenant_id = ${tenantId} and axis = 'ai_review_ops' and period_start = ${w.start}`
    expect(Number(after!.limit_snapshot), 'снимок периода не переписан задним числом').toBe(50)
    expect(Number(after!.used)).toBe(2)
  })

  it('сбой провайдера: счётчик не растёт и строки в журнале нет (§12, §13 к. 9)', async () => {
    await setTenantLimits(tenantId, { aiGenerateOps: 10 }, opsAuth!)
    invalidateLimits()
    // Точка учёта зовётся ПОСЛЕ успеха операции — падение до неё не двигает ничего
    const before = await currentUsage(tenantId, 'ai_generate_ops')
    await (async () => { throw new Error('provider down') })().catch(() => null)
    expect(await currentUsage(tenantId, 'ai_generate_ops')).toBe(before)
    expect(await eventSum(tenantId, 'ai_generate_ops')).toBe(0)
  })

  it('освобождение места уменьшает счётчик в той же транзакции (§7.5)', async () => {
    await recordUsage(tenantId, 'storage_bytes', 10 * GIB, { refKind: 'upload' })
    expect(await eventSum(tenantId, 'storage_bytes')).toBe(10 * GIB)
    await recordUsage(tenantId, 'storage_bytes', -4 * GIB, { refKind: 'upload' })
    expect(await eventSum(tenantId, 'storage_bytes')).toBe(6 * GIB)
  })
})

// ── Сходимость моментальных осей (сквозная проверка 15) ─────────────────────────────────

describe('42 §5 проверка 15: счётчик сходится с прямым пересчётом', () => {
  it('SQL сквозной проверки 15 даёт ноль строк после синхронизации (условие выхода PR-09)', async () => {
    await syncLiveAxes(tenantId)
    const rows = await admin`
      select t.id,
             (select used from usage_counters u
               where u.tenant_id = t.id and u.axis = 'users_active'
                 and current_date between u.period_start and u.period_end) as counter,
             (select count(*) from users
               where tenant_id = t.id and status = 'active' and kind = 'employee') as fact
      from tenants t
      where t.id = ${tenantId}
        and (select used from usage_counters u
              where u.tenant_id = t.id and u.axis = 'users_active'
                and current_date between u.period_start and u.period_end)
         is distinct from
            (select count(*) from users
              where tenant_id = t.id and status = 'active' and kind = 'employee')`
    expect(rows.length, `расхождение счётчика и факта: ${JSON.stringify(rows)}`).toBe(0)
  })

  it('кандидат не попадает в ось сотрудников и наоборот (§7.1, В-8)', async () => {
    await syncLiveAxes(tenantId)
    const [employees] = await admin`select count(*)::int as n from users where tenant_id = ${tenantId} and status = 'active' and not is_blocked and kind = 'employee'`
    // С PR-13 ось считается по состоянию воронки, а не по `users.status`: в лимит идут только
    // `candidate_state = 'active'` (docs/v2/28 §7.1) — тенант не платит за отказанных и архив.
    const [candidates] = await admin`select count(*)::int as n from users where tenant_id = ${tenantId} and candidate_state = 'active' and kind = 'candidate'`
    expect(await currentUsage(tenantId, 'users_active')).toBe(employees!.n)
    expect(await currentUsage(tenantId, 'candidates_active')).toBe(candidates!.n)
    expect(candidates!.n, 'в сиде есть канареечные кандидаты — без них тест зелёный всегда').toBeGreaterThan(0)
  })

  it('жёсткая проверка лимита пополняет счётчик тем же числом, по которому решает', async () => {
    const r = await checkPlanLimit(tenantId, 'users')
    expect(await currentUsage(tenantId, 'users_active')).toBe(r.current)
    const c = await checkPlanLimit(tenantId, 'candidates')
    expect(await currentUsage(tenantId, 'candidates_active')).toBe(c.current)
  })

  it('моментальные оси мерятся прямым пересчётом и совпадают со счётчиком', async () => {
    for (const axis of LIVE_AXES) {
      const live = await measureLive(tenantId, axis)
      await syncCounter(tenantId, axis, live)
      expect(await currentUsage(tenantId, axis), axis).toBe(live)
    }
  })
})

// ── Деградация вместо остановки (П-25.2) ────────────────────────────────────────────────

describe('35 §7.1, §7.4, П-25.2: деградация вместо остановки', () => {
  it('исчерпанная ai_review_ops не отклоняет задание, а уводит в ручную проверку (§13 к. 3)', async () => {
    await setTenantLimits(tenantId, { aiReviewOps: 1 }, opsAuth!)
    invalidateLimits()
    await recordUsage(tenantId, 'ai_review_ops', 1, { refKind: 'ai_review' })
    const gate = await meterOrDegrade(tenantId, 'ai_review_ops')
    expect(gate.allowed, 'задание принято, а не отклонено').toBe(true)
    expect(gate.degradation).toBe('manual_review')
  })

  it('исчерпанная export_rows уводит выгрузку в фоновую задачу, а не отказывает', async () => {
    await setTenantLimits(tenantId, { exportRows: 5 }, opsAuth!)
    invalidateLimits()
    await recordUsage(tenantId, 'export_rows', 5, { refKind: 'export' })
    const gate = await meterOrDegrade(tenantId, 'export_rows')
    expect(gate.allowed).toBe(true)
    expect(gate.degradation).toBe('background_job')
  })

  it('жёсткая ось без деградации операцию не пропускает', async () => {
    await setTenantLimits(tenantId, { aiGenerateOps: 2 }, opsAuth!)
    invalidateLimits()
    await recordUsage(tenantId, 'ai_generate_ops', 2, { refKind: 'ai_generation' })
    const gate = await meterOrDegrade(tenantId, 'ai_generate_ops')
    expect(gate.allowed).toBe(false)
    expect(gate.degradation).toBe('reject')
  })

  it('мягкая telegram_out не блокируется никогда — доставка не останавливается (§7.1, `25` §10)', async () => {
    await recordUsage(tenantId, 'telegram_out', 10_000)
    const gate = await meterOrDegrade(tenantId, 'telegram_out')
    expect(gate.allowed).toBe(true)
    expect(gate.state.limit).toBeNull()
  })

  it('исчерпание по каждой из одиннадцати осей называет ось и последствие', async () => {
    await setTenantLimits(tenantId, {
      users: 0, storageGb: 0, smsPerMonth: 0, apiPerMinute: 0, webhooks: 0,
      candidates: 0, aiGenerateOps: 0, aiReviewOps: 0, aiInterviewOps: 0, exportRows: 0,
    }, opsAuth!)
    invalidateLimits()
    for (const axis of LIMIT_AXES) {
      const gate = await meterOrDegrade(tenantId, axis)
      if (axis === 'telegram_out') {
        expect(gate.allowed, axis).toBe(true) // лимита нет вовсе
        continue
      }
      expect(gate.state.axis, axis).toBe(axis)
      expect(gate.degradation, axis).toBe(AXIS_METER[axis].onExhausted)
      expect(gate.allowed, axis).toBe(AXIS_METER[axis].kind !== 'hard')
    }
  })
})

// ── Предупреждения и баннер ─────────────────────────────────────────────────────────────

describe('35 §7.9, §13 к. 8: предупреждения 80 % и 100 %', () => {
  it('порог — 80 %, уровни считаются одной функцией', () => {
    expect(LIMIT_WARN_PCT).toBe(0.8)
    expect(levelOf(79, 100)).toBe('ok')
    expect(levelOf(80, 100)).toBe('warn')
    expect(levelOf(100, 100)).toBe('exceeded')
    expect(levelOf(1000, null)).toBe('ok') // без обмежень — предупреждать не о чем
  })

  it('хранилище на 80 % поднимает warn, на 100 % — exceeded; запись на ось и уровень одна', async () => {
    await setTenantLimits(tenantId, { storageGb: 10 }, opsAuth!)
    invalidateLimits()
    await syncCounter(tenantId, 'storage_bytes', 8 * GIB)
    let open = await activeNotices(tenantId)
    expect(open.map(n => n.level)).toEqual(['warn'])
    // повторный подъём не плодит вторую запись — частичный уникальный индекс
    await syncNotice(tenantId, 'storage_bytes', 8.5 * GIB, 10 * GIB)
    expect((await activeNotices(tenantId)).filter(n => n.level === 'warn')).toHaveLength(1)

    await syncCounter(tenantId, 'storage_bytes', 10 * GIB)
    open = await activeNotices(tenantId)
    expect(open[0]!.level, 'баннер показывает наиболее тяжёлый уровень').toBe('exceeded')
    expect(open[0]!.degradation).toBe('reject')
    const [cnt] = await admin`select count(*)::int as n from limit_notices where tenant_id = ${tenantId} and axis = 'storage_bytes' and resolved_at is null`
    expect(cnt!.n, 'одно открытое предупреждение на ось и уровень').toBe(2)
  })

  it('ниже 80 % записи закрываются: следующий подъём — новая (§7.9 п. 3)', async () => {
    await setTenantLimits(tenantId, { storageGb: 10 }, opsAuth!)
    invalidateLimits()
    await syncCounter(tenantId, 'storage_bytes', 9 * GIB)
    expect(await activeNotices(tenantId)).toHaveLength(1)
    await syncCounter(tenantId, 'storage_bytes', 1 * GIB)
    expect(await activeNotices(tenantId)).toHaveLength(0)
    const [closed] = await admin`select count(*)::int as n from limit_notices where tenant_id = ${tenantId} and resolved_at is not null`
    expect(closed!.n).toBeGreaterThan(0)
  })

  it('крестик прячет warn на 24 часа, exceeded закрыть нельзя (§13 к. 8)', async () => {
    await setTenantLimits(tenantId, { storageGb: 10 }, opsAuth!)
    invalidateLimits()
    await syncCounter(tenantId, 'storage_bytes', 8 * GIB)
    const [warn] = await activeNotices(tenantId)
    const ok = await dismissNotice({ tenantId, actorId: adminId }, warn!.id)
    expect(ok.ok).toBe(true)
    expect(await activeNotices(tenantId), 'скрыт на сутки').toHaveLength(0)
    // истекли 24 часа — баннер вернулся
    expect(await activeNotices(tenantId, new Date(Date.now() + 25 * 3600_000))).toHaveLength(1)

    await syncCounter(tenantId, 'storage_bytes', 10 * GIB)
    const exceeded = (await activeNotices(tenantId)).find(n => n.level === 'exceeded')!
    const no = await dismissNotice({ tenantId, actorId: adminId }, exceeded.id)
    expect(no).toEqual({ ok: false, code: 'cannot_dismiss_exceeded' })
  })

  it('превышение по каждой оси даёт запись в limit_notices', async () => {
    await setTenantLimits(tenantId, {
      users: 1, storageGb: 1, smsPerMonth: 1, apiPerMinute: 1, webhooks: 1,
      candidates: 1, aiGenerateOps: 1, aiReviewOps: 1, aiInterviewOps: 1, exportRows: 1,
    }, opsAuth!)
    invalidateLimits()
    for (const axis of LIMIT_AXES) {
      if (axis === 'telegram_out' || axis === 'api_rate_rpm') continue // лимита нет / скользящее окно
      await syncNotice(tenantId, axis, 99, 1)
    }
    const rows = await admin`select axis, level from limit_notices where tenant_id = ${tenantId} and resolved_at is null`
    const axes = rows.map(r => r.axis as string).sort()
    expect(axes).toEqual(LIMIT_AXES.filter(a => a !== 'telegram_out' && a !== 'api_rate_rpm').slice().sort())
    expect(new Set(rows.map(r => r.level))).toEqual(new Set(['exceeded']))
  })

  it('limitScan гасит запись, когда место освободилось, и не плодит дублей', async () => {
    await setTenantLimits(tenantId, { storageGb: 10 }, opsAuth!)
    invalidateLimits()
    await syncCounter(tenantId, 'storage_bytes', 10 * GIB)
    expect((await limitScan(tenantId)).axes).toBe(LIMIT_AXES.length)
    await syncCounter(tenantId, 'storage_bytes', 0)
    await limitScan(tenantId)
    expect(await activeNotices(tenantId)).toHaveLength(0)
  })

  it('уведомление уходит с машинной осью в payload и дедупом по оси (В-16)', async () => {
    await admin`delete from notifications where tenant_id = ${tenantId} and code in ('limit_warning', 'limit_exceeded')`
    await setTenantLimits(tenantId, { storageGb: 10 }, opsAuth!)
    invalidateLimits()
    await syncCounter(tenantId, 'storage_bytes', 10 * GIB)
    const rows = await admin`select code, payload, dedup_key from notifications where tenant_id = ${tenantId} and code = 'limit_exceeded'`
    expect(rows.length, 'админам тенанта ушло уведомление').toBeGreaterThan(0)
    const payload = rows[0]!.payload as Record<string, unknown>
    expect(payload.axis, 'машинная ось рядом с человекочитаемым resource').toBe('storage_bytes')
    expect(payload.resource).toBeTruthy()
    expect(rows[0]!.dedup_key as string).toContain('limit_exceeded:storage_bytes:')
  })
})

// ── Сводка потребления: одно число в баннере, на экране и в счёте ────────────────────────

describe('35 §7.3, §13 к. 1: одно число в баннере, на экране и в проверке', () => {
  it('usageByAxis отдаёт все одиннадцать осей, лимит — из общей функции', async () => {
    await setTenantLimits(tenantId, { users: 50, storageGb: 100 }, opsAuth!)
    invalidateLimits()
    const rows = await usageByAxis(tenantId)
    expect(rows).toHaveLength(LIMIT_AXES.length)
    const eff = await effectiveLimits(tenantId)
    for (const r of rows) expect(r.limit, r.axis).toBe(eff.axes[r.axis])
    const storage = rows.find(r => r.axis === 'storage_bytes')!
    expect(storage.limit).toBe(100 * GIB) // единица оси — байт, колонка — ГБ
  })

  it('экран потребления и жёсткая проверка показывают одно и то же число', async () => {
    await setTenantLimits(tenantId, { users: 50 }, opsAuth!)
    invalidateLimits()
    const view = await usageView({ tenantId, actorId: adminId })
    const row = view.consumption.find(r => r.axis === 'users_active')!
    const hard = await checkPlanLimit(tenantId, 'users')
    expect(row.used).toBe(hard.current)
    expect(row.limit).toBe(hard.limit)
  })

  it('доплата «+100 ГБ» одинаково видна в проверке и на экране (§13 к. 9)', async () => {
    await setTenantLimits(tenantId, { storageGb: 100 }, opsAuth!)
    const { grantTenantAddon } = await import('../../server/services/platformTenants')
    await grantTenantAddon(tenantId, { addonCode: 'storage_pack', qty: 1 }, opsAuth!)
    invalidateLimits()
    const rows = await usageByAxis(tenantId)
    expect(rows.find(r => r.axis === 'storage_bytes')!.limit).toBe(200 * GIB)
    const gate = await meterOrDegrade(tenantId, 'storage_bytes', 1)
    expect(gate.state.limit).toBe(200 * GIB)
  })

  it('суточный срез пишет восемь колонок пакета и берёт числа из тех же счётчиков', async () => {
    await setTenantLimits(tenantId, { users: 50 }, opsAuth!)
    invalidateLimits()
    await recordUsage(tenantId, 'ai_generate_ops', 4, { refKind: 'ai_generation' })
    const snap = await collectUsage(tenantId)
    expect(snap.planCode).toBeTruthy()
    expect(snap.aiOps.ai_generate_ops).toBe(4)
    expect(snap.candidatesActive).toBe(await currentUsage(tenantId, 'candidates_active'))
    expect(snap.axes.telegram_out).toBe(await currentUsage(tenantId, 'telegram_out'))
    expect(Object.keys(snap.storageByCategory)).toContain('other')
    await admin`delete from tenant_usage where tenant_id = ${tenantId} and collected_at >= now() - interval '1 hour'`
  })
})
