import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { CONTENT_ISSUE_LIMITS } from '../../shared/enums'

/**
 * PR-23 пакета `docs/v2` (`45-plan.md`): жалоба на материал — подача и дедупликация
 * (`36-content-feedback.md` §7.1, §7.2, §7.7, §7.10, §7.11).
 *
 * Критерии приёмки `36` §13, закреплённые за этим PR:
 * - **1** — жалоба на видеоблок создаётся без единого введённого символа, а в `context`
 *   есть `block_id`, `content_version` и `player_position_sec`;
 * - **2** — второй человек на тот же дефект: новой карточки нет, `reports_count = 2`,
 *   в журнале событие `merged`;
 * - **3** — жалоба во время попытки с `time_limit_sec`: попытка не прервана, `deadline_at`
 *   сдвинут на время формы, карточка получила `affects_scoring` и `rescore_state = needed`;
 * - **7** — шестая жалоба за сутки блокируется **текстом**, а не молча; mute закрывает форму.
 *
 * Плюс изоляция тенантов (контрактные тесты 1–3 проверяют схему, здесь — поведение:
 * жалоба на материал чужого тенанта даёт «не найдено», а не «запрещено», CLAUDE.md п. 15).
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'

const { submitReport, applyResolutionToReporters, myReports } = await import('../../server/services/contentIssues')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

let tenantId: string
let otherTenantId: string
let adminId: string
let employeeId: string
let mentorId: string
let resourceId: string
let questionId: string
let questionVersion: number
let quizId: string
let lessonId: string
let otherResourceId: string

/** Блоки материала — короткие строки редактора, а не uuid (`36` §3.1, исправлено PR-23). */
const BLOCK = 'v223-video-block'

async function cleanup() {
  await admin`delete from content_issue_events where tenant_id in (${tenantId}, ${otherTenantId})`
  await admin`delete from content_reports where tenant_id in (${tenantId}, ${otherTenantId})`
  await admin`delete from content_issues where tenant_id in (${tenantId}, ${otherTenantId})`
  await admin`delete from content_reporter_stats where tenant_id in (${tenantId}, ${otherTenantId})`
  await admin`delete from attempts where tenant_id = ${tenantId} and device = 'v2-23-test'`
  await admin`delete from media_assets where tenant_id = ${tenantId} and original_name like 'v223-%'`
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  const [other] = await admin`
    insert into tenants (slug, name) values ('test-isolation', 'Тест ізоляції')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  employeeId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000003'`)[0]!.id as string
  mentorId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380670000002'`)[0]!.id as string
  resourceId = (await admin`select id from resources where tenant_id = ${tenantId} order by created_at limit 1`)[0]!.id as string
  lessonId = (await admin`select id from lessons where tenant_id = ${tenantId} order by created_at limit 1`)[0]!.id as string
  quizId = (await admin`select id from quizzes where tenant_id = ${tenantId} order by created_at limit 1`)[0]!.id as string
  const q = (await admin`select id, version from questions where tenant_id = ${tenantId} order by created_at limit 1`)[0]!
  questionId = q.id as string
  questionVersion = q.version as number

  // Материал чужого тенанта: на него нельзя пожаловаться из нашего (CLAUDE.md п. 15)
  const [foreign] = await admin`
    insert into resources (tenant_id, title, slug, kind, body)
    values (${otherTenantId}, 'Чужий матеріал', ${`v223-foreign-${Date.now()}`}, 'article', '[]'::jsonb)
    returning id`
  otherResourceId = foreign!.id as string
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await admin`delete from resources where id = ${otherResourceId}`
  await admin.end()
})

beforeEach(cleanup)

const ctxOf = (actorId: string) => ({ tenantId, actorId })

/**
 * Попытка с таймером: снапшот содержит вопрос со своей версией (правило 4). Снапшот — массив
 * вопросов, как его пишет `attempts.ts` `buildSnapshot` (PR-24: раньше здесь была форма
 * `{ questions: […] }`, и тест не видел, что на настоящей попытке версия бралась не из снимка).
 */
async function makeAttempt(deadlineInSec = 1800) {
  const [a] = await admin`
    insert into attempts (tenant_id, quiz_id, user_id, attempt_no, snapshot, params, status, deadline_at, device)
    values (
      ${tenantId}, ${quizId}, ${employeeId}, 1,
      ${admin.json([{ id: questionId, version: questionVersion, kind: 'single' }])},
      ${admin.json({ timeLimitSec: deadlineInSec })},
      'in_progress', ${new Date(Date.now() + deadlineInSec * 1000)}, 'v2-23-test')
    returning id, deadline_at`
  return { id: a!.id as string, deadlineAt: new Date(a!.deadline_at as string) }
}

// ── Критерий 1. Два тапа, ноль введённых символов ────────────────────────────────────────

describe('критерий 1: жалоба у блока урока — без единого введённого символа', () => {
  it('создаёт карточку и кладёт в context block_id, content_version и player_position_sec', async () => {
    const r = await submitReport(ctxOf(employeeId), {
      targetType: 'resource',
      targetId: resourceId,
      blockId: BLOCK,
      issueType: 'broken_media',
      source: 'lesson',
      lessonId,
      context: { playerPositionSec: 42, scrollPct: 60, device: 'mobile' },
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return

    const [issue] = await admin`select * from content_issues where id = ${r.result.issueId}`
    expect(issue!.block_id).toBe(BLOCK)
    expect(issue!.issue_type).toBe('broken_media')
    // Битое видео блокирует прохождение по определению (§7.4)
    expect(issue!.severity).toBe('blocking')
    expect(issue!.due_at).not.toBeNull()
    expect(issue!.reports_count).toBe(1)
    // Заголовок карточки берётся из самого материала: человек его не вводил
    expect(String(issue!.title).length).toBeGreaterThanOrEqual(3)

    const [report] = await admin`select * from content_reports where id = ${r.result.reportId}`
    expect(report!.comment).toBeNull()
    const ctx = report!.context as Record<string, unknown>
    expect(ctx.block_id).toBe(BLOCK)
    expect(ctx.content_version).toBe(issue!.content_version)
    expect(ctx.playerPositionSec).toBe(42)
    expect(ctx.item_id).toBe(resourceId)
    expect(ctx.lesson_id).toBe(lessonId)
    // Правило 14: технический контекст пишется журналом одинаково
    expect('request_context' in ctx).toBe(true)
  })

  it('комментарий обязателен ровно у четырёх типов — это ловит контракт, а не сервис', async () => {
    const { contentReportSchema } = await import('../../shared/schemas/contentIssues')
    const base = { targetType: 'resource' as const, targetId: resourceId, source: 'lesson' as const, context: {} }
    expect(contentReportSchema.safeParse({ ...base, issueType: 'typo' }).success).toBe(true)
    expect(contentReportSchema.safeParse({ ...base, issueType: 'wrong_key' }).success).toBe(false)
    expect(contentReportSchema.safeParse({ ...base, issueType: 'wrong_key', comment: 'Ключ невірний зовсім' }).success).toBe(true)
  })

  it('материал чужого тенанта — «не найдено», а не «запрещено» (CLAUDE.md п. 15)', async () => {
    const r = await submitReport(ctxOf(employeeId), {
      targetType: 'resource', targetId: otherResourceId, issueType: 'typo', source: 'lesson', context: {},
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('not_found')
  })
})

// ── Критерий 2. Склейка ─────────────────────────────────────────────────────────────────

describe('критерий 2: второй человек на тот же дефект', () => {
  it('новой карточки нет, reports_count = 2, в журнале событие merged', async () => {
    const input = {
      targetType: 'question' as const, targetId: questionId, issueType: 'bad_question' as const,
      source: 'lesson' as const, comment: 'Питання сформульоване неоднозначно', context: {},
    }
    const first = await submitReport(ctxOf(employeeId), input)
    const second = await submitReport(ctxOf(mentorId), input)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.result.issueId).toBe(first.result.issueId)
    expect(second.result.merged).toBe(true)
    const [issue] = await admin`select * from content_issues where id = ${first.result.issueId}`
    expect(issue!.reports_count).toBe(2)
    const rows = await admin`select count(*)::int as n from content_issues where tenant_id = ${tenantId}`
    expect(rows[0]!.n).toBe(1)

    const events = await admin`select kind from content_issue_events where issue_id = ${first.result.issueId} order by created_at`
    // PR-24: при подаче карточка сразу получает ответственного (`36` §7.5) — событие `assigned`
    expect(events.map(e => e.kind)).toEqual(['created', 'assigned', 'merged'])
  })

  it('повторная жалоба того же человека — 409, счётчик не растёт', async () => {
    const input = {
      targetType: 'resource' as const, targetId: resourceId, issueType: 'typo' as const,
      source: 'lesson' as const, context: {},
    }
    const first = await submitReport(ctxOf(employeeId), input)
    const again = await submitReport(ctxOf(employeeId), input)
    expect(first.ok).toBe(true)
    expect(again.ok).toBe(false)
    expect(!again.ok && again.code).toBe('already_reported')
    const [issue] = await admin`select reports_count from content_issues where tenant_id = ${tenantId}`
    expect(issue!.reports_count).toBe(1)
  })

  it('другой тип проблемы на тот же материал — отдельная карточка: это разные починки', async () => {
    await submitReport(ctxOf(employeeId), { targetType: 'resource', targetId: resourceId, issueType: 'typo', source: 'lesson', context: {} })
    await submitReport(ctxOf(employeeId), { targetType: 'resource', targetId: resourceId, issueType: 'broken_link', source: 'lesson', context: {} })
    const [row] = await admin`select count(*)::int as n from content_issues where tenant_id = ${tenantId}`
    expect(row!.n).toBe(2)
  })

  it('закрытая карточка не склеивает: новая жалоба заводит новую (§4)', async () => {
    const input = { targetType: 'resource' as const, targetId: resourceId, issueType: 'outdated' as const, source: 'lesson' as const, context: {} }
    const first = await submitReport(ctxOf(employeeId), input)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    await admin`update content_issues set status = 'closed', closed_at = now() where id = ${first.result.issueId}`
    const second = await submitReport(ctxOf(mentorId), input)
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.result.merged).toBe(false)
    expect(second.result.issueId).not.toBe(first.result.issueId)
  })
})

// ── Критерий 3. Жалоба не блокирует попытку и не съедает time_limit_sec ─────────────────

describe('критерий 3: жалоба на вопрос во время попытки', () => {
  it('попытка не прервана, deadline_at сдвинут на 40 секунд, карточка помечена для пересчёта', async () => {
    const attempt = await makeAttempt(1800)
    const r = await submitReport(ctxOf(employeeId), {
      targetType: 'question', targetId: questionId, issueType: 'wrong_key',
      comment: 'Правильна відповідь інша, ніж у ключі',
      source: 'attempt', attemptId: attempt.id, context: { formSeconds: 40 },
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    expect(r.result.deadlineShiftSec).toBe(40)

    const [after] = await admin`select status, deadline_at, snapshot from attempts where id = ${attempt.id}`
    // Попытка живёт своей жизнью: статус тот же, снапшот не переписан (правило 4)
    expect(after!.status).toBe('in_progress')
    expect(new Date(after!.deadline_at as string).getTime() - attempt.deadlineAt.getTime()).toBe(40_000)

    const [issue] = await admin`select * from content_issues where id = ${r.result.issueId}`
    expect(issue!.affects_scoring).toBe(true)
    expect(issue!.rescore_state).toBe('needed')
    // Версия вопроса взята из снапшота попытки, а не из текущей редакции
    const [report] = await admin`select question_version from content_reports where id = ${r.result.reportId}`
    expect(report!.question_version).toBe(questionVersion)
  })

  it('компенсация не больше 60 секунд на жалобу и 180 за попытку (§7.7 б)', async () => {
    const attempt = await makeAttempt(1800)
    const shifts: number[] = []
    for (const issueType of ['bad_question', 'wrong_key', 'tech'] as const) {
      const r = await submitReport(ctxOf(employeeId), {
        targetType: 'question', targetId: questionId, issueType,
        comment: 'Опис проблеми для перевірки компенсації',
        source: 'attempt', attemptId: attempt.id, context: { formSeconds: 600 },
      })
      expect(r.ok, JSON.stringify(r)).toBe(true)
      if (r.ok) shifts.push(r.result.deadlineShiftSec)
    }
    expect(shifts).toEqual([60, 60, 60])
    expect(shifts.reduce((a, b) => a + b, 0)).toBe(CONTENT_ISSUE_LIMITS.deadlineShiftSecPerAttempt)

    const [after] = await admin`select deadline_at from attempts where id = ${attempt.id}`
    expect(new Date(after!.deadline_at as string).getTime() - attempt.deadlineAt.getTime()).toBe(180_000)
  })

  it('четвёртая жалоба за попытку отклоняется (§7.7 а), попытка при этом цела', async () => {
    const attempt = await makeAttempt(1800)
    for (const issueType of ['bad_question', 'wrong_key', 'tech'] as const) {
      await submitReport(ctxOf(employeeId), {
        targetType: 'question', targetId: questionId, issueType,
        comment: 'Опис проблеми для перевірки ліміту', source: 'attempt', attemptId: attempt.id, context: {},
      })
    }
    const fourth = await submitReport(ctxOf(employeeId), {
      targetType: 'question', targetId: questionId, issueType: 'unclear',
      source: 'attempt', attemptId: attempt.id, context: {},
    })
    expect(fourth.ok).toBe(false)
    expect(!fourth.ok && fourth.code === 'rate_limited' && fourth.reason).toBe('per_attempt')
    const [after] = await admin`select status from attempts where id = ${attempt.id}`
    expect(after!.status).toBe('in_progress')
  })

  it('чужая попытка не принимается — «не найдено»', async () => {
    const attempt = await makeAttempt(1800)
    const r = await submitReport(ctxOf(mentorId), {
      targetType: 'question', targetId: questionId, issueType: 'tech',
      source: 'attempt', attemptId: attempt.id, context: {},
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('not_found')
  })
})

// ── Критерий 7. Защита от злоупотребления ───────────────────────────────────────────────

describe('критерий 7: шестая жалоба за сутки и авто-mute', () => {
  it('пять проходят, шестая блокируется текстом: отказ несёт счётчик и предел', async () => {
    const types = ['typo', 'unclear', 'outdated', 'broken_link', 'broken_file'] as const
    for (const issueType of types) {
      const r = await submitReport(ctxOf(employeeId), { targetType: 'resource', targetId: resourceId, issueType, source: 'lesson', context: {} })
      expect(r.ok, `${issueType}: ${JSON.stringify(r)}`).toBe(true)
    }
    const sixth = await submitReport(ctxOf(employeeId), { targetType: 'resource', targetId: resourceId, issueType: 'tech', source: 'lesson', context: {} })
    expect(sixth.ok).toBe(false)
    if (sixth.ok || sixth.code !== 'rate_limited') throw new Error('шестая жалоба обязана быть отвергнута')
    expect(sixth.reason).toBe('per_day')
    expect(sixth.used).toBe(CONTENT_ISSUE_LIMITS.perDay)
    expect(sixth.limit).toBe(CONTENT_ISSUE_LIMITS.perDay)
  })

  it('носитель content_issue.triage лимитом не связан', async () => {
    const types = ['typo', 'unclear', 'outdated', 'broken_link', 'broken_file'] as const
    for (const issueType of types) {
      await submitReport(ctxOf(adminId), { targetType: 'resource', targetId: resourceId, issueType, source: 'lesson', context: {} })
    }
    const sixth = await submitReport(
      ctxOf(adminId),
      { targetType: 'resource', targetId: resourceId, issueType: 'tech', source: 'lesson', context: {} },
      { exemptFromLimits: true },
    )
    expect(sixth.ok, JSON.stringify(sixth)).toBe(true)
  })

  it('три spam подряд ставят mute на 14 дней, и форма закрывается явным кодом', async () => {
    for (const issueType of ['typo', 'unclear', 'outdated'] as const) {
      const r = await submitReport(ctxOf(employeeId), { targetType: 'resource', targetId: resourceId, issueType, source: 'lesson', context: {} })
      expect(r.ok).toBe(true)
      if (r.ok) await applyResolutionToReporters(ctxOf(adminId), r.result.issueId, 'spam')
    }
    const [stats] = await admin`select * from content_reporter_stats where tenant_id = ${tenantId} and user_id = ${employeeId}`
    expect(stats!.consecutive_spam).toBe(CONTENT_ISSUE_LIMITS.spamStreakToMute)
    const until = new Date(stats!.muted_until as string)
    const days = Math.round((until.getTime() - Date.now()) / 86_400_000)
    expect(days).toBe(CONTENT_ISSUE_LIMITS.muteDays)

    const blocked = await submitReport(ctxOf(employeeId), { targetType: 'resource', targetId: resourceId, issueType: 'broken_link', source: 'lesson', context: {} })
    expect(blocked.ok).toBe(false)
    expect(!blocked.ok && blocked.code).toBe('reporter_muted')
  })

  it('подтверждённая жалоба обнуляет серию spam (§7.11)', async () => {
    const r = await submitReport(ctxOf(mentorId), { targetType: 'resource', targetId: resourceId, issueType: 'typo', source: 'lesson', context: {} })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    await applyResolutionToReporters(ctxOf(adminId), r.result.issueId, 'spam')
    await applyResolutionToReporters(ctxOf(adminId), r.result.issueId, 'confirmed')
    const [stats] = await admin`select * from content_reporter_stats where tenant_id = ${tenantId} and user_id = ${mentorId}`
    expect(stats!.consecutive_spam).toBe(0)
    expect(stats!.confirmed_count).toBe(1)
    expect(stats!.muted_until).toBeNull()
  })
})

// ── Скриншот и изоляция ─────────────────────────────────────────────────────────────────

describe('скриншот через media_assets и изоляция тенантов', () => {
  async function makeMedia(origin: string, tenant = tenantId) {
    const [m] = await admin`
      insert into media_assets (tenant_id, key, original_name, kind, mime, bytes, status, origin)
      values (${tenant}, ${`v223/${origin}-${Date.now()}`}, ${`v223-${origin}.png`}, 'image', 'image/png', 1024, 'ready', ${origin})
      returning id`
    return m!.id as string
  }

  it('файл с origin=issue_screenshot принимается и остаётся ссылкой на media_assets', async () => {
    const mediaId = await makeMedia('issue_screenshot')
    const r = await submitReport(ctxOf(employeeId), {
      targetType: 'resource', targetId: resourceId, issueType: 'typo',
      source: 'lesson', screenshotMediaId: mediaId, context: {},
    })
    expect(r.ok, JSON.stringify(r)).toBe(true)
    if (!r.ok) return
    const [report] = await admin`select screenshot_media_id from content_reports where id = ${r.result.reportId}`
    expect(report!.screenshot_media_id).toBe(mediaId)
  })

  it('файл с чужим origin не принимается: перечень закрыт констрейнтом, а не пожеланием', async () => {
    const mediaId = await makeMedia('avatar')
    const r = await submitReport(ctxOf(employeeId), {
      targetType: 'resource', targetId: resourceId, issueType: 'typo',
      source: 'lesson', screenshotMediaId: mediaId, context: {},
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.code).toBe('not_found')
  })

  it('жалобы чужого тенанта не видны: RLS, а не фильтр в коде', async () => {
    const r = await submitReport(ctxOf(employeeId), { targetType: 'resource', targetId: resourceId, issueType: 'typo', source: 'lesson', context: {} })
    expect(r.ok).toBe(true)
    // Тот же сервис в контексте другого тенанта не видит ни одной строки
    const foreign = await myReports({ tenantId: otherTenantId, actorId: employeeId })
    expect(foreign).toEqual([])
    const mine = await myReports(ctxOf(employeeId))
    expect(mine.length).toBe(1)
    expect(mine[0]!.status).toBe('new')
  })

  it('политика RLS: прямой select ролью приложения без тенанта не отдаёт ничего', async () => {
    await submitReport(ctxOf(employeeId), { targetType: 'resource', targetId: resourceId, issueType: 'typo', source: 'lesson', context: {} })
    const app = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} })
    try {
      const rows = await app`select id from content_issues`
      expect(rows.length).toBe(0)
      const scoped = await app.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${tenantId}, true)`
        return tx`select id from content_issues`
      })
      expect(scoped.length).toBe(1)
    }
    finally {
      await app.end()
    }
  })
})
