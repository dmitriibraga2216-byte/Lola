import { sql } from 'drizzle-orm'
import type { TenantTx } from '../../utils/withTenant'
import { recordAudit } from '../audit'
import { discardInputFiles } from '../ai/calls'

/**
 * Стирание записей собеседования человека (`docs/v2/30-ai-interview.md` §7.6, §7.9; план `45`
 * PR-28) — **одна функция на оба пути**: отзыв согласия (`reason = 'consent_withdrawn'`, одна
 * сессия) и обезличивание кандидата механикой `candidate.consent_sweep` (`reason = 'anonymized'`,
 * все сессии человека; зовёт `candidateHire.ts#anonymizeCandidate` в той же транзакции). Второго
 * механизма сроков ПД не заводится: собеседование стирается там же и тогда же, что и анкета.
 *
 * Что стирается, в той же транзакции:
 * - аудио реплик — в корзину с немедленной очисткой (`lifecycle = 'pending_delete'`,
 *   `purge_after = now()`; `purge`, а не мягкое удаление с 30 днями корзины, `30` §7.7);
 * - расшифровки и вопросы реплик (`transcript`, `prompt_text`), письменные ответы попытки;
 * - обоснования и цитаты оценок ИИ (`redacted_at`, CHECK `ics_redacted_chk`);
 * - вход и выход вызовов модели по сессии и её репликам: файл входа — в корзину, `output` — пусто;
 * - Підсумки кандидата (PR-29): тело стёрто, ссылка отозвана, отправка по сроку снята; при
 *   обезличивании — и цитаты в подсказках проверяющему.
 *
 * Что остаётся — баллы, уверенность, расхождение, метрики сессии и строки `ai_calls` без входа:
 * то, что нужно статистике и не идентифицирует человека (`30` §7.9). Необратимо, пишется в
 * `audit_log`.
 */

export type RedactReason = 'consent_withdrawn' | 'anonymized'

export interface RedactResult { sessions: number, audio: number, inputs: number, summaries: number }

export async function redactInterviewData(
  tx: TenantTx,
  tenantId: string,
  userId: string,
  opts: { reason: RedactReason, actorId: string | null, sessionIds?: string[] },
): Promise<RedactResult> {
  const only = opts.sessionIds?.length
    ? sql`and s.id in (${sql.join(opts.sessionIds.map(id => sql`${id}::uuid`), sql`, `)})`
    : sql``
  const sessions = await tx.execute(sql`
    select s.id, s.attempt_id from interview_sessions s
     where s.candidate_id = ${userId}::uuid and s.redacted_at is null ${only}
     for update`) as unknown as { id: string, attempt_id: string }[]

  // Обезличивание стирает и ПД согласий (IP, браузер, технический контекст): решение и хеш текста
  // остаются — это доказательство, а не данные человека
  if (opts.reason === 'anonymized') {
    await tx.execute(sql`
      update interview_consents set ip = null, user_agent = null, request_context = null, updated_at = now()
       where user_id = ${userId}::uuid`)
    // Цитаты из ответов человека в подсказках проверяющему — те же его слова (PR-29). Импорт
    // по месту: модуль подсказок тянет очередь проверки, а та — попытки, где стирание не нужно
    const { redactHintsTx } = await import('../reviewHints')
    await redactHintsTx(tx, userId)
  }
  // Підсумок несёт обоснования и цитаты собеседования: при отзыве согласия он отзывается и
  // стирается вместе с ними (`30` §7.6 «дополнительно отзывает Підсумок», §12 п. 4), при
  // обезличивании — тем более (§7.9 «`candidate_summaries.body` и PDF — удаляются»)
  const { redactSummariesTx } = await import('../candidateSummaries')
  const summaries = await redactSummariesTx(tx, tenantId, userId, opts.reason)
  if (!sessions.length) return { sessions: 0, audio: 0, inputs: 0, summaries }

  const ids = sql.join(sessions.map(s => sql`${s.id}::uuid`), sql`, `)
  const attemptIds = sql.join(sessions.map(s => sql`${s.attempt_id}::uuid`), sql`, `)
  const turns = await tx.execute(sql`select id, media_id from interview_turns where session_id in (${ids})`) as unknown as { id: string, media_id: string | null }[]

  // Голос — самые чувствительные данные в продукте: в корзину с немедленной очисткой (`30` §7.7).
  // Сюда же — записи, заменённые перезаписью: у них тот же источник (реплика), но реплика их уже не держит
  const audio = await tx.execute(sql`
    update media_assets
       set lifecycle = 'pending_delete', deleted_at = now(), deleted_by = ${opts.actorId}::uuid,
           delete_reason = ${opts.reason}, purge_after = now(), updated_at = now()
     where origin = 'interview_answer' and lifecycle in ('active', 'orphaned')
       and (id in (select media_id from interview_turns where session_id in (${ids}) and media_id is not null)
            or (source_entity = 'interview_turns' and source_id in (select id from interview_turns where session_id in (${ids}))))
    returning id`) as unknown as { id: string }[]

  await tx.execute(sql`
    update interview_turns set transcript = null, prompt_text = null, updated_at = now()
     where session_id in (${ids})`)
  await tx.execute(sql`
    update interview_criterion_scores set rationale = null, evidence = '[]'::jsonb, redacted_at = now(), updated_at = now()
     where session_id in (${ids}) and redacted_at is null`)
  // Письменный ответ реплики и текст расшифровки в ответе попытки — те же слова человека
  await tx.execute(sql`update attempt_answers set answer = null, updated_at = now() where attempt_id in (${attemptIds})`)

  // Журнал модели: вход (файл) и выход (расшифровка, обоснования, цитаты) — стираются, строка остаётся
  const turnIds = turns.map(t => t.id)
  const refCond = turnIds.length
    ? sql`(ref_kind = 'interview_session' and ref_id in (${ids})) or (ref_kind = 'interview_turn' and ref_id in (${sql.join(turnIds.map(id => sql`${id}::uuid`), sql`, `)}))`
    : sql`(ref_kind = 'interview_session' and ref_id in (${ids}))`
  const calls = await tx.execute(sql`
    with old as (select id, input_ref from ai_calls where ${refCond} for update)
    update ai_calls c set input_ref = null, output = null from old where c.id = old.id
    returning old.input_ref as input_ref`) as unknown as { input_ref: string | null }[]
  const inputs = await discardInputFiles(tx, [...new Set(calls.map(c => c.input_ref).filter((k): k is string => !!k))], opts.reason)

  await tx.execute(sql`
    update interview_sessions set redacted_at = now(), ip = null, user_agent = null, updated_at = now()
     where id in (${ids})`)

  await recordAudit(tx, {
    tenantId,
    actorId: opts.actorId,
    action: 'interview.redacted',
    entity: 'user',
    entityId: userId,
    after: { reason: opts.reason, sessions: sessions.map(s => s.id), audio: audio.length, inputs, summaries },
  })
  return { sessions: sessions.length, audio: audio.length, inputs, summaries }
}
