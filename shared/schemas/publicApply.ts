import { z } from 'zod'
import { phoneSchema } from './auth'
import { VACANCY_APPLICATION_STATES } from '../enums'

/**
 * Контракты публичного контура вакансии (docs/v2/29-vacancies.md §6.3, §10; решение
 * docs/v2/44 В-9). Один источник для клиента и сервера (CLAUDE.md п. 7).
 *
 * **Почему отдельный файл, а не `vacancies.ts`.** Сквозная проверка 13 (`docs/v2/42` §5,
 * `scripts/v2-crosschecks.sh`) грепает `shared/schemas/vacanc*.ts` по словам `attempts`,
 * `pass_score`, `due_at`, `time_limit` и обязана возвращать пусто. Журнал попыток
 * публичной формы называется `public_apply_attempts` — слово `attempts` в его имени
 * законно и к правилам прохождения отношения не имеет, но подменять проверку исключением
 * ради одного имени нельзя: проверка сторожит инвариант 1, а не орфографию. Контракты
 * контура живут отдельным файлом, и проверка остаётся буквальной.
 *
 * Здесь нет ни одного поля, которое сообщало бы отправителю, **какая** проверка сработала:
 * §7.3 — форма отвечает одинаково при успехе и при отказе, иначе частотное ограничение и
 * honeypot превращаются в отладчик для бота.
 */

/**
 * «Ім'я та прізвище» одним полем (`29` §6.3): 2–120 знаков, минимум два слова. Публичная
 * форма не разбивает имя на три поля — посетитель заполняет её с телефона, и три поля вместо
 * одного стоят дороже, чем разбор строки на сервере.
 */
const fullName = z.string().trim().min(2).max(120).refine(v => v.split(/\s+/).filter(Boolean).length >= 2, 'name_two_words')
const email = z.string().trim().email().max(200)

/**
 * Отправка отклика (`29` §6.3, `POST /api/v1/public/j/:token/apply`).
 *
 * `website` — honeypot: поле есть в DOM, скрыто CSS и `tabindex="-1"`; человек его не
 * видит и не заполняет (§7.6). Схема его **не отвергает** — иначе бот узнал бы о проверке
 * по коду ответа; значение уходит в `spam_score`.
 *
 * `consent` обязан быть `true`: отклик без согласия на обработку ПД не создаётся никогда
 * (§7.23, `not null` в БД). Это единственная проверка, о которой форма говорит прямо, —
 * она про право, а не про спам.
 */
export const publicApplySchema = z
  .object({
    fullName,
    phone: phoneSchema.optional(),
    email: email.optional(),
    comment: z.string().trim().max(1000).optional(),
    consent: z.literal(true),
    formNonce: z.string().min(10).max(400),
    /** Honeypot (§7.6): ожидается пустым, непустое значение — вход в `spam_score`, а не отказ. */
    website: z.string().max(200).optional(),
    /** Метка источника из ссылки площадки `?s=<код публикации>` (§7.19). */
    s: z.string().trim().max(64).optional(),
  })
  .strict()
  .refine(v => Boolean(v.phone || v.email), { path: ['phone'], message: 'contact_required' })

export type PublicApplyInput = z.infer<typeof publicApplySchema>

/** Подтверждение контакта кодом (`29` §7.5, `POST …/apply/:aid/confirm`). */
export const publicApplyConfirmSchema = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .strict()

export type PublicApplyConfirmInput = z.infer<typeof publicApplyConfirmSchema>

/** Фильтр списка откликов в кабинете рекрутера (`29` §10 `GET /vacancies/:id/applications`). */
export const applicationListSchema = z
  .object({
    state: z.enum(VACANCY_APPLICATION_STATES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict()

export type ApplicationListFilter = z.infer<typeof applicationListSchema>

/** Отказ по отклику (`29` §10): причина обязательна — она уходит человеку и в отчёт. */
export const applicationRejectSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict()

export type ApplicationRejectInput = z.infer<typeof applicationRejectSchema>
