import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { enrollments, interviewConsents, interviewScenarios, quizzes, users } from '../../db/schema'
import type { TenantTx } from '../../utils/withTenant'
import { sha256Hex } from '../ai/policy'
import { aiUnavailable, type AiUnavailableReason } from '../ai/policy'
import { effectiveLimits } from '../tenantLimits'
import { axisState } from '../usageCounters'
import { findAssignmentFor } from '../taskParams'
import { enqueueNotification, tenantAdminIds } from '../notifications'
import { personById } from '../repo/people'
import { resolveLocale, type Locale } from '../../../shared/domain/dateFormat'
import { INTERVIEW_AUDIO_KEEP_DAYS, INTERVIEW_CONSENT_TEXT_VERSION, consentDocument, type ConsentDocument } from '../../../shared/domain/interview'
import type { InterviewAlternativePath, InterviewAnswerMode } from '../../../shared/enums'

/**
 * Общее для кандидатских ручек собеседования (`docs/v2/30` §5.1–§5.2, §7.4–§7.5, §10): где
 * открыт тест, какой сценарий действует, текст согласия и его хеш, доступен ли ИИ, кому из
 * рекрутинга сообщить. Прав у кандидата нет (`41` §2.3: «— (кандидат)»): доступ — **по данным**,
 * тест должен быть назначен именно ему, а сессия — принадлежать ему; чужое — `404`.
 */

export interface Ctx { tenantId: string, actorId: string }

export type Scenario = typeof interviewScenarios.$inferSelect

export interface Entry {
  quiz: { id: string, title: string }
  scenario: Scenario
}

export type EntryError = 'not_found' | 'not_published'

/**
 * Тест назначен человеку: самостоятельным назначением теста или записью на курс, в котором он
 * урок. Без назначения тест для человека не существует — `404`, а не «нет прав».
 */
export async function isAssigned(tx: TenantTx, userId: string, quizId: string, enrollmentId?: string | null): Promise<boolean> {
  if (enrollmentId) {
    const [e] = await tx.select({ userId: enrollments.userId, cancelledAt: enrollments.cancelledAt }).from(enrollments).where(eq(enrollments.id, enrollmentId))
    if (e && e.userId === userId && !e.cancelledAt) return true
  }
  return !!(await findAssignmentFor(tx, 'test', quizId, userId))
}

/** Тест вида `interview`, назначенный человеку, и действующий (опубликованный) сценарий к нему. */
export async function resolveEntry(tx: TenantTx, ctx: Ctx, quizId: string, enrollmentId?: string | null): Promise<{ ok: true, entry: Entry } | { ok: false, code: EntryError }> {
  const [quiz] = await tx.select({ id: quizzes.id, title: quizzes.title, kind: quizzes.kind })
    .from(quizzes).where(and(eq(quizzes.id, quizId), sql`${quizzes.deletedAt} is null`))
  if (!quiz || quiz.kind !== 'interview') return { ok: false, code: 'not_found' }
  if (!await isAssigned(tx, ctx.actorId, quizId, enrollmentId)) return { ok: false, code: 'not_found' }
  const [scenario] = await tx.select().from(interviewScenarios)
    .where(and(eq(interviewScenarios.quizId, quizId), eq(interviewScenarios.status, 'published')))
  if (!scenario) return { ok: false, code: 'not_published' }
  return { ok: true, entry: { quiz: { id: quiz.id, title: quiz.title }, scenario } }
}

/** Все версии сценария этого теста — решение по согласию принимается о тесте, а не о версии. */
export async function scenarioIdsOf(tx: TenantTx, quizId: string): Promise<string[]> {
  const rows = await tx.select({ id: interviewScenarios.id }).from(interviewScenarios).where(eq(interviewScenarios.quizId, quizId))
  return rows.map(r => r.id)
}

/** Последнее решение человека по согласию на собеседование этого теста (любая версия сценария). */
export async function latestDecision(tx: TenantTx, userId: string, quizId: string) {
  const ids = await scenarioIdsOf(tx, quizId)
  if (!ids.length) return null
  const [row] = await tx.select().from(interviewConsents)
    .where(and(eq(interviewConsents.userId, userId), inArray(interviewConsents.scenarioId, ids)))
    .orderBy(desc(interviewConsents.decidedAt), desc(interviewConsents.createdAt))
    .limit(1)
  return row ?? null
}

// ── Текст согласия (`30` §5.1, §7.4) ───────────────────────────────────────────────────

export interface ConsentText extends ConsentDocument {
  textVersion: string
  textHash: string
  lang: Locale
}

/**
 * Текст согласия ровно в том виде, в каком его увидит человек, и его хеш. Язык — язык
 * коммуникации кандидата (`users.comm_language`), срок текста — срок согласия на обработку ПД
 * (`users.consent_expires_at`): до него живут расшифровки (`30` §7.7).
 */
export async function consentText(tx: TenantTx, userId: string, scenario: Scenario): Promise<ConsentText> {
  const [person] = await personById(tx, { commLanguage: users.commLanguage, locale: users.locale, consentExpiresAt: users.consentExpiresAt }, userId) as unknown as { commLanguage: string | null, locale: string | null, consentExpiresAt: string | null }[]
  const lang = resolveLocale(person?.commLanguage ?? person?.locale ?? 'uk')
  const doc = consentDocument(lang, {
    voice: (scenario.answerModes as InterviewAnswerMode[]).includes('voice'),
    audioDays: INTERVIEW_AUDIO_KEEP_DAYS,
    textUntil: person?.consentExpiresAt ?? null,
  })
  return { ...doc, textVersion: INTERVIEW_CONSENT_TEXT_VERSION, textHash: sha256Hex(`${INTERVIEW_CONSENT_TEXT_VERSION}\n${lang}\n${doc.full.join('\n')}`), lang }
}

// ── Доступность ИИ (`30` §7.12, §7.20; `35` §7.1, §7.7) ────────────────────────────────

export type AiState = { available: true } | { available: false, reason: AiUnavailableReason | 'limit_exceeded' }

/**
 * Можно ли сейчас начать **новую** ИИ-сессию: действует ИИ-подписка и ось `ai_interview_ops`
 * не исчерпана. Ничего не резервирует — для экрана входа; сам резерв — `reserveSessionOp()`
 * на старте, и его отказ окончателен.
 */
export async function aiState(tenantId: string): Promise<AiState> {
  const reason = aiUnavailable((await effectiveLimits(tenantId)).subscription)
  if (reason) return { available: false, reason }
  const axis = await axisState(tenantId, 'ai_interview_ops')
  return axis.ok ? { available: true } : { available: false, reason: 'limit_exceeded' }
}

// ── Кому сообщить (`30` §8) ─────────────────────────────────────────────────────────────

/** Рекрутер карточки, а если его нет — администраторы тенанта (HR в терминах `30` §2). */
export async function recruitingRecipients(tx: TenantTx, tenantId: string, recruiterId: string | null, withAdmins = false): Promise<string[]> {
  const admins = !recruiterId || withAdmins ? await tenantAdminIds(tx, tenantId) : []
  return [...new Set([...(recruiterId ? [recruiterId] : []), ...admins])]
}

export async function notifyAll(tx: TenantTx, tenantId: string, userIds: string[], code: string, payload: Record<string, unknown>, dedup: string, refId?: string, channel?: 'email' | 'inapp'): Promise<void> {
  for (const userId of userIds) {
    await enqueueNotification(tx, { tenantId, userId, code, payload, dedupKey: `${code}:${dedup}:${userId}`, ...(refId ? { refType: 'user', refId } : {}), ...(channel ? { channel } : {}) })
  }
}

/** Подпись альтернативы в уведомлении рекрутеру — на языке шаблона по умолчанию (uk). */
export const ALTERNATIVE_LABEL_UK: Record<InterviewAlternativePath, string> = {
  human_interview: 'співбесіда з рекрутером',
  text_form: 'письмова форма',
}

/** Текст вопроса снимка — первые текстовые блоки без разметки (реплика интервьюера, `prompt_text`). */
export function promptTextOf(stem: unknown): string {
  const blocks = Array.isArray(stem) ? stem as { type?: string, text?: string, html?: string, title?: string }[] : []
  return blocks
    .map(b => b.html ?? b.text ?? '')
    .filter(t => typeof t === 'string' && t.trim())
    .join(' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 4000)
}
