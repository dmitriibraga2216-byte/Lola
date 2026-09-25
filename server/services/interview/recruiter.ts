import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { aiCalls, interviewConsents, interviewCriteria, interviewCriterionScores, interviewScenarios, interviewSessions, interviewTurns, mediaAssets } from '../../db/schema'
import { withTenant } from '../../utils/withTenant'
import { recordAudit } from '../audit'
import { candidateVisible, type Viewer } from '../candidates'
import { LISTEN_URL_TTL_SEC, signedListenUrl } from '../media'
import { confidenceWord, type ConfidenceWord } from '../../../shared/domain/interview'
import type { InterviewSessionState } from '../../../shared/enums'

/**
 * Вкладка «Співбесіда» карточки кандидата и прослушивание записи (`docs/v2/30-ai-interview.md`
 * §2, §5.3, §7.2, §7.8, §10; план `45` PR-28).
 *
 * Рядом с оценкой ИИ — всегда четыре вещи (`30` §7.2): обоснование, цитаты с переходом к
 * реплике, уверенность словом и техпаспорт (модель, версия промпта, дата). И пятая, сверх
 * документа, — **признак заглушки** (Р-28.4): оценка профиля `stub` показывается с пометкой
 * «не модель — не підстава для рішення», иначе человек принял бы решение по случайному числу.
 *
 * Слушать аудио — только `interview.listen` (голос — биометрически значимые данные, `30` §2):
 * ссылка на 15 минут, каждое прослушивание — строка `audit_log` `interview.media.listen`, файл
 * отдаётся `inline` — «доступ есть, выноса нет» (`30` §7.8). Без права — `403`, и журнал не
 * пишется (`30` §13 к. 12). Невидимый зрителю кандидат — `404` (CLAUDE.md п. 15).
 */

export interface InterviewCriterionView {
  criterionId: string
  name: string
  description: string
  scaleMax: number
  weight: number
  value: number | null
  confidence: number | null
  confidenceWord: ConfidenceWord | null
  rationale: string | null
  evidence: { turnId: string, ordinal: number, quote: string, charFrom: number, charTo: number, msFrom: number | null }[]
  agreement: string | null
  humanValue: number | null
  redacted: boolean
}

export interface InterviewTurnView {
  id: string
  ordinal: number
  promptText: string | null
  answerMode: string | null
  durationMs: number | null
  retakes: number
  transcript: string | null
  transcriptStatus: string
  transcriptConfidence: number | null
  transcriptLang: string | null
  /** Аудио можно послушать (есть и не удалено); удалённое — дата удаления, текст цитаты остаётся (`30` §12 п. 10). */
  audio: 'available' | 'deleted' | 'none'
  audioDeletedAt: string | null
}

export interface InterviewSessionReport {
  id: string
  scenarioName: string
  scenarioVersion: number
  state: InterviewSessionState
  degradedReason: string | null
  needsHumanReason: string | null
  aiScore: number | null
  aiConfidence: number | null
  confidenceWord: ConfidenceWord | null
  /** Оценку дала заглушка, а не модель: не основание для решения (Р-28.4). */
  aiStub: boolean
  /** Техпаспорт оценки (`30` §7.2 г). */
  model: { name: string, version: string | null, promptKey: string, promptVersion: string, at: string } | null
  startedAt: string | null
  finishedAt: string | null
  redactedAt: string | null
  metrics: { turnsTotal: number, turnsAnswered: number, disconnects: number, resumes: number, silenceEvents: number, tabSwitches: number, ipChanges: number, retakes: number }
  /** «Що варто перевірити людині» (`30` §7.17) — измеримые факты, ни один не влияет на балл. */
  flags: { code: string, ordinal: number | null }[]
  criteria: InterviewCriterionView[]
  turns: InterviewTurnView[]
  consent: { decision: string, decidedAt: string, withdrawnAt: string | null } | null
}

export interface CandidateInterview {
  sessions: InterviewSessionReport[]
  /** Решения без сессии: отказ от ИИ в пользу альтернативы (`30` §7.5). */
  declined: { scenarioName: string, alternative: string | null, decidedAt: string }[]
}

const num = (v: string | null): number | null => (v === null ? null : Number(v))

export async function candidateInterview(v: Viewer, candidateId: string): Promise<CandidateInterview | null> {
  if (!await candidateVisible(v, candidateId)) return null
  return withTenant(v.tenantId, v.actorId, async (tx) => {
    const sessions = await tx.select({ s: interviewSessions, scenarioName: interviewScenarios.name, scenarioVersion: interviewScenarios.version })
      .from(interviewSessions)
      .innerJoin(interviewScenarios, eq(interviewScenarios.id, interviewSessions.scenarioId))
      .where(eq(interviewSessions.candidateId, candidateId))
      .orderBy(desc(interviewSessions.createdAt))
      .limit(20)
    const reports: InterviewSessionReport[] = []
    for (const { s, scenarioName, scenarioVersion } of sessions) {
      const criteria = await tx.select().from(interviewCriteria).where(eq(interviewCriteria.scenarioId, s.scenarioId)).orderBy(asc(interviewCriteria.sort))
      const scores = await tx.select().from(interviewCriterionScores).where(eq(interviewCriterionScores.sessionId, s.id))
      const turns = await tx.select().from(interviewTurns).where(eq(interviewTurns.sessionId, s.id)).orderBy(asc(interviewTurns.ordinal))
      const mediaIds = turns.map(t => t.mediaId).filter((id): id is string => !!id)
      const media = mediaIds.length
        ? await tx.select({ id: mediaAssets.id, lifecycle: mediaAssets.lifecycle, deletedAt: mediaAssets.deletedAt }).from(mediaAssets).where(inArray(mediaAssets.id, mediaIds))
        : []
      const mediaById = new Map(media.map(m => [m.id, m]))
      const callId = scores.find(x => x.aiCallId)?.aiCallId ?? null
      const [call] = callId
        ? await tx.select({ modelName: aiCalls.modelName, modelVersion: aiCalls.modelVersion, promptKey: aiCalls.promptKey, promptVersion: aiCalls.promptVersion, createdAt: aiCalls.createdAt }).from(aiCalls).where(eq(aiCalls.id, callId))
        : []
      const [consent] = s.consentId
        ? await tx.select({ decision: interviewConsents.decision, decidedAt: interviewConsents.decidedAt, withdrawnAt: interviewConsents.withdrawnAt }).from(interviewConsents).where(eq(interviewConsents.id, s.consentId))
        : []
      const byCriterion = new Map(scores.map(x => [x.criterionId, x]))
      reports.push({
        id: s.id,
        scenarioName,
        scenarioVersion,
        state: s.state as InterviewSessionState,
        degradedReason: s.degradedReason,
        needsHumanReason: s.needsHumanReason,
        aiScore: num(s.aiScore),
        aiConfidence: num(s.aiConfidence),
        confidenceWord: confidenceWord(num(s.aiConfidence)),
        aiStub: s.aiStub,
        model: call ? { name: call.modelName, version: call.modelVersion, promptKey: call.promptKey, promptVersion: call.promptVersion, at: call.createdAt.toISOString() } : null,
        startedAt: s.startedAt?.toISOString() ?? null,
        finishedAt: s.finishedAt?.toISOString() ?? null,
        redactedAt: s.redactedAt?.toISOString() ?? null,
        metrics: {
          turnsTotal: s.turnsTotal, turnsAnswered: s.turnsAnswered, disconnects: s.disconnects, resumes: s.resumes,
          silenceEvents: s.silenceEvents, tabSwitches: s.tabSwitches, ipChanges: s.ipChanges, retakes: turns.reduce((n, t) => n + t.retakes, 0),
        },
        flags: (Array.isArray(s.flags) ? s.flags as { code: string, ordinal: number | null }[] : []).map(f => ({ code: f.code, ordinal: f.ordinal ?? null })),
        criteria: criteria.map((c) => {
          const x = byCriterion.get(c.id)
          return {
            criterionId: c.id,
            name: c.nameUk,
            description: c.description,
            scaleMax: Number(c.scaleMax),
            weight: Number(c.weight),
            value: x ? num(x.value) : null,
            confidence: x ? num(x.confidence) : null,
            confidenceWord: x ? confidenceWord(num(x.confidence)) : null,
            rationale: x?.rationale ?? null,
            evidence: (x?.evidence ?? []) as InterviewCriterionView['evidence'],
            agreement: x?.agreement ?? null,
            humanValue: x ? num(x.humanValue) : null,
            redacted: !!x?.redactedAt,
          }
        }),
        turns: turns.map((t) => {
          const m = t.mediaId ? mediaById.get(t.mediaId) : undefined
          return {
            id: t.id,
            ordinal: t.ordinal,
            promptText: t.promptText,
            answerMode: t.answerMode,
            durationMs: t.durationMs,
            retakes: t.retakes,
            transcript: t.transcript,
            transcriptStatus: t.transcriptStatus,
            transcriptConfidence: num(t.transcriptConfidence),
            transcriptLang: t.transcriptLang,
            audio: !m ? 'none' : m.lifecycle === 'active' ? 'available' : 'deleted',
            audioDeletedAt: m && m.lifecycle !== 'active' ? (m.deletedAt?.toISOString() ?? null) : null,
          }
        }),
        consent: consent ? { decision: consent.decision, decidedAt: consent.decidedAt.toISOString(), withdrawnAt: consent.withdrawnAt?.toISOString() ?? null } : null,
      })
    }
    const declined = await tx.select({ scenarioName: interviewScenarios.name, alternative: interviewConsents.alternativeChosen, decidedAt: interviewConsents.decidedAt })
      .from(interviewConsents)
      .innerJoin(interviewScenarios, eq(interviewScenarios.id, interviewConsents.scenarioId))
      .where(and(eq(interviewConsents.userId, candidateId), eq(interviewConsents.decision, 'declined')))
      .orderBy(desc(interviewConsents.decidedAt))
    return {
      sessions: reports,
      declined: declined.map(d => ({ scenarioName: d.scenarioName, alternative: d.alternative, decidedAt: d.decidedAt.toISOString() })),
    }
  })
}

export type ListenResult
  = | { ok: true, url: string, expiresAt: string }
    | { ok: false, code: 'not_found' }
    | { ok: false, code: 'purged', deletedAt: string | null }

/**
 * Ссылка на прослушивание реплики (`30` §7.8, §10 `GET /candidates/:id/interview/media/:turnId`).
 * Скоуп `interview.listen` проверяет ручка — до этой функции роль без права не доходит, и строка
 * журнала не появляется (`30` §13 к. 12). Удалённое аудио — `410 media.purged` с датой удаления:
 * текст цитаты при этом остаётся на месте (`30` §12 п. 10).
 */
export async function listenTurn(v: Viewer, candidateId: string, turnId: string): Promise<ListenResult> {
  if (!await candidateVisible(v, candidateId)) return { ok: false, code: 'not_found' }
  const found = await withTenant(v.tenantId, v.actorId, async (tx) => {
    const [row] = await tx.select({ turn: interviewTurns, sessionId: interviewSessions.id })
      .from(interviewTurns)
      .innerJoin(interviewSessions, eq(interviewSessions.id, interviewTurns.sessionId))
      .where(and(eq(interviewTurns.id, turnId), eq(interviewSessions.candidateId, candidateId)))
    if (!row) return null
    const [m] = row.turn.mediaId ? await tx.select().from(mediaAssets).where(eq(mediaAssets.id, row.turn.mediaId)) : []
    return { turn: row.turn, sessionId: row.sessionId, media: m ?? null }
  })
  if (!found || !found.turn.mediaId) return { ok: false, code: 'not_found' }
  const m = found.media
  if (!m || m.lifecycle !== 'active') return { ok: false, code: 'purged', deletedAt: m?.deletedAt?.toISOString() ?? null }

  const url = await signedListenUrl(m.key, m.mime)
  await withTenant(v.tenantId, v.actorId, tx => recordAudit(tx, {
    tenantId: v.tenantId,
    actorId: v.actorId,
    action: 'interview.media.listen',
    entity: 'interview_turn',
    entityId: turnId,
    after: { candidateId, sessionId: found.sessionId, mediaId: m.id },
  }))
  return { ok: true, url, expiresAt: new Date(Date.now() + LISTEN_URL_TTL_SEC * 1000).toISOString() }
}
