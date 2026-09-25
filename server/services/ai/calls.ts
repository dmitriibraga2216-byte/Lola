import { and, desc, eq, gte, lt, sql } from 'drizzle-orm'
import { aiCalls, aiProviders } from '../../db/schema'
import { withTenant } from '../../utils/withTenant'
import { keysetAfter, keysetAt } from '../../utils/keyset'
import { KEYSETS, encodeKeyset } from '../../../shared/domain/keyset'
import type { AiCallsQuery } from '../../../shared/schemas/ai'

/**
 * Журнал ИИ-вызовов тенанта (`docs/v2/30` §2, §5.6, §10 `GET /ai/calls`; план `45` PR-27) и
 * его уборка (`30` §11 `ai.calls_cleanup`). Читает HR/админ со скоупом `ai.audit` — содержимое
 * вместе с выходом модели. Оператор платформы по `30` §2 видит только метрики; его панель —
 * вне этого PR.
 *
 * Имён людей в ответе нет — только `actorUserId`: журнал не делает выборок людей (инвариант 17),
 * а подпись к идентификатору экран берёт из своего справочника.
 */

export interface AiCallRow {
  id: number
  createdAt: string
  finishedAt: string | null
  purpose: string
  promptKey: string
  promptVersion: string
  providerId: string | null
  providerName: string | null
  modelName: string
  modelVersion: string | null
  refKind: string
  refId: string | null
  actorUserId: string | null
  status: string
  errorCode: string | null
  httpStatus: number | null
  latencyMs: number | null
  tokensIn: number | null
  tokensOut: number | null
  costMinor: number
  currency: string
  usageAxis: string | null
  billed: boolean
  tryNo: number
  output: unknown
}

export async function listAiCalls(ctx: { tenantId: string, actorId: string }, q: AiCallsQuery): Promise<{ items: AiCallRow[], nextCursor: string | null }> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const after = keysetAfter(KEYSETS.aiCalls, q.cursor, [aiCalls.createdAt, sql`${aiCalls.id}::text`], 'desc')
    const rows = await tx.select({
      id: aiCalls.id, createdAt: aiCalls.createdAt, finishedAt: aiCalls.finishedAt, purpose: aiCalls.purpose,
      promptKey: aiCalls.promptKey, promptVersion: aiCalls.promptVersion, providerId: aiCalls.providerId,
      providerName: aiProviders.name, modelName: aiCalls.modelName, modelVersion: aiCalls.modelVersion,
      refKind: aiCalls.refKind, refId: aiCalls.refId, actorUserId: aiCalls.actorUserId, status: aiCalls.status,
      errorCode: aiCalls.errorCode, httpStatus: aiCalls.httpStatus, latencyMs: aiCalls.latencyMs, tokensIn: aiCalls.tokensIn,
      tokensOut: aiCalls.tokensOut, costMinor: aiCalls.costMinor, currency: aiCalls.currency, usageAxis: aiCalls.usageAxis,
      billed: aiCalls.billed, tryNo: aiCalls.tryNo, output: aiCalls.output, cursorAt: keysetAt(aiCalls.createdAt),
    }).from(aiCalls)
      .leftJoin(aiProviders, eq(aiProviders.id, aiCalls.providerId))
      .where(and(
        q.purpose ? eq(aiCalls.purpose, q.purpose) : undefined,
        q.status ? eq(aiCalls.status, q.status) : undefined,
        q.from ? gte(aiCalls.createdAt, sql`${q.from}::date`) : undefined,
        q.to ? lt(aiCalls.createdAt, sql`(${q.to}::date + 1)`) : undefined,
        after,
      ))
      .orderBy(desc(aiCalls.createdAt), desc(sql`${aiCalls.id}::text`))
      .limit(q.limit + 1)
    const page = rows.slice(0, q.limit)
    const last = rows.length > q.limit ? page[page.length - 1] : undefined
    return {
      items: page.map(({ cursorAt: _c, createdAt, finishedAt, ...r }) => ({
        ...r, createdAt: createdAt.toISOString(), finishedAt: finishedAt?.toISOString() ?? null,
      })),
      nextCursor: last ? encodeKeyset(KEYSETS.aiCalls, [last.cursorAt, String(last.id)]) : null,
    }
  })
}

/** Сколько живёт ссылка на полный вход вызова в S3 и сама строка журнала (`30` §7.7, §11). */
export const AI_INPUT_REF_DAYS = 90
export const AI_CALLS_KEEP_DAYS = 400

/**
 * `ai.calls_cleanup` (`30` §11, ежедневно 04:10): ссылка на вход старше 90 дней обнуляется,
 * строки старше 400 дней удаляются. Сейчас вход в S3 не пишет ни один вызов — первым его начнёт
 * писать собеседование (PR-28), и удаление самого объекта приедет вместе с ним; обнуление
 * ссылки заведено уже здесь, чтобы срок жизни журнала был один с первого дня.
 */
export async function aiCallsCleanup(tenantId: string): Promise<{ inputRefs: number, rows: number }> {
  return withTenant(tenantId, null, async (tx) => {
    const refs = await tx.update(aiCalls).set({ inputRef: null })
      .where(and(sql`${aiCalls.inputRef} is not null`, lt(aiCalls.createdAt, sql`now() - ${`${AI_INPUT_REF_DAYS} days`}::interval`)))
      .returning({ id: aiCalls.id })
    const gone = await tx.delete(aiCalls)
      .where(lt(aiCalls.createdAt, sql`now() - ${`${AI_CALLS_KEEP_DAYS} days`}::interval`))
      .returning({ id: aiCalls.id })
    return { inputRefs: refs.length, rows: gone.length }
  })
}
