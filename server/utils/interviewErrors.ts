import type { H3Event } from 'h3'
import type { ZodError } from 'zod'
import { apiError } from './apiResponse'
import { aiUnavailableFail } from './aiErrors'
import type { AiUnavailableReason } from '../services/ai/policy'
import type { LimitCheck } from '../services/tenantLimits'
import type { InterviewAlternativePath } from '../../shared/enums'

/**
 * Коды ответов ИИ-собеседования (`docs/v2/30` §10, `docs/v2/41` §4.4, §8.2; план `45` PR-28) —
 * одна таблица на все ручки, чтобы один и тот же отказ не получал два текста. Каждый текст
 * объясняет, что делать (DoD). Коды согласия — в своём пространстве `interview_consent.*`
 * (`41` §8.2.1, §8.2.3): согласие на запись голоса — не согласие на обработку анкеты `29`.
 * «Нет скоупа» — общий `403 forbidden` (`44` В-16 §8.2.7), чужое — `404` (CLAUDE.md п. 15).
 */
const ERRORS: Record<string, readonly [number, string, string]> = {
  not_found: [404, 'not_found', 'Співбесіду не знайдено'],
  not_published: [409, 'interview.not_published', 'Співбесіда ще не готова. Зверніться до рекрутера'],
  already_decided: [409, 'interview_consent.already_decided', 'Рішення щодо згоди вже прийнято. Оновіть сторінку'],
  already_withdrawn: [409, 'interview_consent.already_withdrawn', 'Згоду вже відкликано, записи видалено'],
  invalid: [422, 'interview_consent.invalid', 'Згоду не збережено: текст згоди оновився. Оновіть сторінку й прочитайте його ще раз'],
  consent_required: [409, 'interview_consent.required', 'Спочатку потрібна згода на запис співбесіди'],
  answer_mode_invalid: [422, 'interview.answer_mode_invalid', 'Цей формат відповіді сценарій не допускає — оберіть інший'],
  attempt_in_progress: [409, 'interview.attempt_in_progress', 'У вас уже є незавершене проходження цього модуля — продовжіть його'],
  attempts_exhausted: [422, 'quiz.attempts_exhausted', 'Спроби вичерпано. Зверніться до рекрутера'],
  cooldown: [422, 'quiz.cooldown', 'Зачекайте перед наступною спробою'],
  not_enough_questions: [422, 'quiz.not_enough_questions', 'У модулі співбесіди немає питань. Зверніться до рекрутера'],
  ai_available: [409, 'interview.ai_available', 'Електронна співбесіда доступна: пройдіть її або відмовтеся на екрані згоди'],
  text_allowed: [422, 'interview.text_allowed', 'Мікрофон не обов’язковий: на питання можна відповісти текстом'],
  text_form_unavailable: [409, 'interview.text_form_unavailable', 'Письмова форма для цієї співбесіди не передбачена. З вами зв’яжеться рекрутер'],
  not_live: [409, 'interview.not_live', 'Співбесіду вже завершено'],
  expired: [409, 'interview.expired', 'Час на проходження сплив. Ваші відповіді збережено'],
  turn_closed: [422, 'turn.closed', 'Цю відповідь уже завершено — перейдіть до поточного питання'],
  voice_not_allowed: [422, 'interview.voice_not_allowed', 'У цій співбесіді відповідають лише текстом'],
  text_not_allowed: [422, 'interview.text_not_allowed', 'У цій співбесіді відповідають лише голосом'],
  answer_empty: [422, 'answer.empty', 'Відповідь порожня: запишіть або напишіть її ще раз'],
  retake_limit: [409, 'retake.limit', 'Спроби перезапису вичерпано — надішліть останній запис'],
  no_answers: [409, 'no_answers', 'Немає жодної відповіді — дайте відповідь хоча б на одне питання'],
}

export function interviewFail(event: H3Event, code: string, details?: Record<string, unknown>) {
  const [status, apiCode, text] = ERRORS[code] ?? [400, code, 'Не вдалося виконати дію. Спробуйте ще раз']
  return apiError(event, status, apiCode, text, details)
}

export function interviewValidationFail(event: H3Event, error: ZodError) {
  return apiError(event, 422, 'validation_failed', error.issues[0]?.message ?? 'Перевірте поля', { issues: error.issues })
}

/** Исчерпанная ось или истёкший ИИ на старте: сессии нет, кандидату — альтернатива сценария (`30` §7.12, §13 к. 7). */
export function interviewAiFail(event: H3Event, r: { code: 'ai_unavailable', reason: AiUnavailableReason, alternative: InterviewAlternativePath } | { code: 'limit_exceeded', check: LimitCheck, alternative: InterviewAlternativePath }) {
  if (r.code === 'ai_unavailable') {
    const res = aiUnavailableFail(event, r.reason)
    return { error: { ...res.error, details: { ...res.error.details, alternative: r.alternative } } }
  }
  return apiError(event, 409, 'limit_exceeded', 'Зараз електронну співбесіду провести не вдається — запропонуємо інший формат', {
    axis: r.check.axis, used: r.check.used, limit: r.check.limit, alternative: r.alternative,
  })
}

const SCENARIO_ERRORS: Record<string, readonly [number, string, string]> = {
  not_found: [404, 'not_found', 'Сценарій не знайдено'],
  quiz_not_found: [422, 'scenario.quiz_not_found', 'Оберіть модуль співбесіди'],
  quiz_not_interview: [422, 'scenario.quiz_not_interview', 'Оберіть модуль співбесіди: тест має бути виду «Співбесіда»'],
  alternative_required: [422, 'scenario.alternative_required', 'Вкажіть альтернативу для тих, хто відмовиться від ШІ'],
  criteria_required: [422, 'criteria.required', 'Додайте хоча б один критерій'],
  questions_invalid: [422, 'scenario.questions_invalid', 'Питання співбесіди — фіксований список розгорнутих відповідей. Приберіть інші типи питань і випадковий добір'],
  time_invalid: [422, 'scenario.time_invalid', 'Мінімальна тривалість відповіді має бути меншою за максимальну'],
  archived: [409, 'scenario.archived', 'Сценарій в архіві — створіть новий'],
  published: [409, 'scenario.published', 'Критерії опублікованого сценарію не змінюються: відредагуйте сценарій — буде створено нову версію'],
}

export function scenarioFail(event: H3Event, code: string, details?: Record<string, unknown>) {
  const [status, apiCode, text] = SCENARIO_ERRORS[code] ?? [400, code, 'Не вдалося зберегти сценарій']
  return apiError(event, status, apiCode, text, details)
}

/** Ошибки загрузки файла ответа: `413 media.too_big` (`30` §10), остальное — как у `/media/upload-url`. */
export function interviewMediaFail(event: H3Event, mediaCode: string, message: string) {
  return apiError(event, mediaCode === 'too_big' ? 413 : 400, `media.${mediaCode}`, message)
}
