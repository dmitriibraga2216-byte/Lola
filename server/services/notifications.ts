import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import { currentRequestContext } from '../utils/requestContext'
import { db } from '../db/client'
import { notificationTemplates, notifications, tenants, userNotificationPrefs, users } from '../db/schema'
import { withTenant } from '../utils/withTenant'
import { business } from '../utils/metrics'
import type { TenantTx } from '../utils/withTenant'
import { sendTelegram } from './telegram'
import { readSettings } from './settings'
import type { NotificationSchedule } from '../../shared/schemas/settings'
import { tenantOverrides } from './translations'
import type { Locale } from './translations'
import { buildEmailHtml } from './emailRender'
import { EMPLOYEES_ONLY } from './repo/people'
import { formatDate } from '../../shared/domain/dateFormat'
import { recipientLocale } from '../utils/formatLocale'
import { managerIdOf, managerIdsOf } from './orgManager'

/**
 * Уведомления (docs/03 §3.10, docs/06 §6.4): ни одна задача не шлёт напрямую —
 * только через таблицу notifications: журнал, дедупликация, тихие часы.
 */

/** Шаблоны по умолчанию (uk). Тенант переопределяет через notification_templates. */
export const DEFAULT_TEMPLATES: Record<string, string> = {
  assignment_created: 'Тобі призначили курс «{{course}}».{{#due}} Пройти до {{due}}.{{/due}}',
  enrollment_due_soon: 'Залишилось {{days}} дн.: «{{course}}»',
  enrollment_due_today: 'Сьогодні останній день: «{{course}}»',
  enrollment_overdue: 'Прострочено: «{{course}}»',
  enrollment_overdue_manager: 'Прострочено: {{name}} — «{{course}}»',
  enrollment_extended: 'Термін по «{{course}}» продовжено до {{due}}',
  assignment_content_updated: 'Матеріал «{{title}}» оновлено — переглянь зміни', // docs/15 §14.6: тільки за командою адміністратора
  content_used_changed: 'Ресурс «{{title}}» оновлено до версії {{version}} — він використовується у вашому курсі «{{course}}»', // docs/11 §8
  enrollment_completed_manager: '{{name}} завершив «{{course}}»{{#score}} — {{score}}%{{/score}}',
  attempt_passed: 'Тест «{{quiz}}» зараховано: {{score}}%',
  attempt_failed: 'Тест «{{quiz}}» не зараховано: {{score}}%. {{#left}}Залишилось спроб: {{left}}{{/left}}',
  review_needed: 'Розгорнута відповідь чекає перевірки: {{name}}, «{{quiz}}»',
  review_done: 'Наставник перевірив «{{quiz}}»: {{status}}',
  attempt_request_created: '{{name}} просить ще одну спробу тесту «{{quiz}}»',
  attempt_request_decided: 'Запит на додаткову спробу «{{quiz}}»: {{status}}. {{comment}}',
  certificate_issued: 'Сертифікат {{number}} за «{{course}}» видано',
  weekly_digest: '{{location}} — тиждень: завершено {{completed}}, прострочено {{overdue}}, нових призначень {{assigned}}',
  telegram_linked: 'Telegram підключено. Сюди приходитимуть нагадування про навчання.',
  survey_invite: 'Коротке опитування «{{survey}}» — 1 хвилина',
  workshop_assigned: 'Практикум «{{title}}». Здати до {{due}}',
  workshop_submitted: '{{name}} здав «{{title}}». Перевірити',
  workshop_accepted: 'Практикум «{{title}}» зараховано',
  workshop_rework: 'Практикум «{{title}}»: потрібно доопрацювати. {{comment}}',
  workshop_rejected: 'Практикум «{{title}}» не зараховано. {{comment}}',
  workshop_sla_breach: 'Перевірка «{{title}}» висить {{hours}} год',
  workshop_comment: 'Новий коментар до практикуму «{{title}}»',
  news_published: 'Новина: {{title}}',
  plan_on_approval: 'План розвитку чекає погодження',
  plan_approved: 'План розвитку погоджено',
  plan_returned: 'План розвитку повернуто на доопрацювання. {{comment}}',
  goal_status: 'Ціль «{{title}}»: {{status}}. {{comment}}',
  goal_due: 'Ціль «{{title}}» — термін {{due}}',
  goal_due_mentor: 'У підопічного ціль «{{title}}» — термін {{due}}',
  request_new: 'Нова заявка: «{{title}}». Потрібне рішення',
  request_step: 'Заявку «{{title}}» погоджено на цьому етапі',
  request_approved: 'Заявку «{{title}}» схвалено. {{comment}}',
  request_rejected: 'Заявку «{{title}}» відхилено. {{comment}}',
  request_report_required: 'Після навчання «{{title}}» потрібен звіт і сертифікат — додайте їх у заявці',
  request_report_required_manager: 'Підопічний ще не додав звіт про навчання «{{title}}»',
  goal_created: 'Вам поставили ціль «{{title}}»{{#due}} до {{due}}{{/due}}',
  goal_needs_approval: 'Ціль «{{title}}» чекає вашого погодження',
  goal_approved: 'Ціль «{{title}}» погоджено. {{comment}}',
  goal_returned: 'Ціль «{{title}}» повернуто на доопрацювання: {{comment}}',
  plan_period_ending: 'Період плану розвитку завершується {{until}} — час підбити підсумки',
  plan_period_ended: 'Період плану розвитку завершено: цілі без результату закрито як «Не досягнуто». Напишіть підсумок',
  competency_gap_detected: '{{name}}: критичний розрив за компетенціями — {{competencies}}',
  competency_expiring: 'Оцінка компетенції «{{name}}» діє ще 14 днів — потрібне підтвердження',
  competency_expired: 'Оцінка компетенції «{{name}}» протерміновано і більше не враховується',
  assessment_task_assigned: 'Оцінка «{{title}}»: заповніть анкету до {{due}}',
  assessment_due_soon: 'Оцінка «{{title}}»: анкета ще не заповнена, термін {{due}}',
  assessment_not_submitted: 'Оцінка «{{title}}»: {{name}} не заповнив анкету',
  assessment_cycle_finished: 'Цикл оцінки «{{title}}» завершено: {{subjects}} осіб',
  assessment_results_ready: 'Результати оцінки «{{title}}» готові',
  checklist_due: 'Чек-лист «{{title}}» на точці {{location}}: проведено {{done}} з {{norm}} за тиждень',
  checklist_failed: 'Чек-лист «{{title}}» на точці {{location}} не пройдено: {{score}}%',
  checklist_critical_failed: 'Критичний провал чек-листа «{{title}}» на точці {{location}}',
  action_item_due: 'План дій: «{{text}}» — до {{due}}',
  action_item_overdue: 'Прострочено: «{{text}}» (термін {{due}})',
  meetup_registered: 'Ви записані: «{{title}}», {{starts}}',
  meetup_waitlisted: '«{{title}}»: місць немає, ви в черзі{{#position}} ({{position}}-й){{/position}}',
  meetup_seat_freed: '«{{title}}»: місце звільнилось, ви в списку. {{starts}}',
  meetup_reminder_day: 'Завтра: «{{title}}», {{starts}}{{#room}}, {{room}}{{/room}}',
  meetup_reminder_hour: 'Скоро починається: «{{title}}», {{starts}}',
  meetup_cancelled: 'Заняття «{{title}}» скасовано: {{reason}}{{#alternative}}. Альтернатива: {{alternative}}{{/alternative}}',
  meetup_changed: 'Змінилось заняття «{{title}}»: тепер {{starts}}',
  meetup_missed: 'Ви пропустили заняття «{{title}}»',
  meetup_missed_manager: 'Не прийшли на «{{title}}»: {{names}}',
  meetup_feedback_request: 'Оцініть заняття «{{title}}»',
  webinar_record_ready: 'Запис вебінару «{{title}}» доступний',
  // docs/23 §13: notice.assigned (обязательное), notice.not_acknowledged; birthday.today, birthday.upcoming (Spec 21)
  notice_assigned: 'Вам оголошення «{{title}}» — прочитайте і натисніть «Ознайомився»{{#due}} до {{due}}{{/due}}',
  notice_not_acknowledged: 'Оголошення «{{title}}» чекає на підтвердження{{#due}} до {{due}}{{/due}}',
  announcement_overdue_manager: 'Не підтвердили оголошення «{{title}}»: {{names}}',
  birthday_upcoming: 'За {{days}} дн. день народження у {{name}} ({{date}}) — час подбати про привітання',
  // Докс/33 D-044: щоденний дайджест на точку замість окремого сповіщення на кожного іменинника
  birthday_today: 'Сьогодні день народження: {{names}} — привітайте!',
  // Докс/33 D-049: клас сповіщень `anniversaries` — річниця роботи за `user_placements.started_at`
  anniversary_upcoming: 'За {{days}} дн. річниця роботи у {{name}} ({{years}} р.) — час подбати про привітання',
  anniversary_today: 'Сьогодні річниця роботи: {{names}} — привітайте!',
  anniversary_self: 'Вітаємо! Сьогодні {{years}} р. відколи ви в команді',
  scheduled_report: 'Звіт «{{name}}» готовий: {{rows}} рядків. {{url}}',
  program_assigned: 'Вам призначено програму «{{title}}»{{#due}}. Термін: {{due}}{{/due}}',
  program_node_unlocked: '«{{title}}»: відкрився наступний крок{{#step}} — {{step}}{{/step}}',
  program_due_soon: 'Програма «{{title}}»: термін {{due}}',
  program_completed: 'Програму «{{title}}» завершено',
  program_stuck: 'Підопічний не рухається по програмі «{{title}}» 14 днів',
  program_request: 'Заявка на програму «{{title}}» чекає рішення',
  // Докс/33 D-049: клас сповіщень `programReminder` — нагадування за день до старту елемента програми
  program_reminder: 'Завтра відкриється програма «{{title}}»',
  // docs/17 §14.3, docs/30 (trajectory.next_unlocked, trajectory.finished)
  trajectory_assigned: 'Вам призначено траєкторію «{{title}}»{{#availableFrom}}. Відкриється {{availableFrom}}{{/availableFrom}}',
  trajectory_next_unlocked: 'Траєкторія «{{title}}»: відкрився наступний крок{{#step}} — {{step}}{{/step}}',
  trajectory_finished: 'Траєкторію «{{title}}» завершено. Вітаємо!',
  trajectory_access_closed: 'Траєкторія «{{title}}»: доступ до наступного кроку закрито{{#step}} ({{step}}){{/step}}',
  trajectory_mentor_confirm: 'Траєкторія «{{title}}»: підопічний чекає на ваше підтвердження кроку{{#step}} «{{step}}»{{/step}}',
  trajectory_request: 'Заявка на траєкторію «{{title}}» чекає рішення',
  // Оргструктура (docs/v2/32 §8, PR-30). Адресат везде — результат `resolveManager()`,
  // а не `locations.manager_id`: вопрос «кто руководитель» задаётся одному месту (П-16.4).
  org_node_assigned: 'Вас додано до оргструктури: {{node_title}}. Керівник — {{manager_name}}.',
  org_manager_changed: 'Ваш керівник змінився: тепер це {{manager_name}}.',
  org_subordinate_added: 'У вашій команді новий співробітник: {{user_name}} ({{node_title}}).',
  org_node_vacant: 'Вузол «{{node_title}}» став вакантним.',
  org_structure_conflict: 'В оргструктурі виявлено {{count}} конфліктів.',
  // docs/16 §8
  user_invited: 'Вас запрошено до Lola. Посилання для входу: {{url}}',
  knowledge_review_due: 'Статтю «{{title}}» час перечитати й підтвердити актуальність',
  report_export_ready: 'Вивантаження «{{report}}» готове: {{rows}} рядків. {{url}} (посилання діє 24 години)',
  report_export_failed: 'Вивантаження «{{report}}» не вдалося — спробуйте ще раз або зменшіть період',
  user_role_granted: '{{#name}}{{name}}: {{/name}}видано роль «{{role}}»',
  role_expiring: 'Роль «{{name}}» діє ще 7 днів — за потреби продовжте термін', // docs/28 «Паритет 4» отк. (3)
  user_blocked: 'Доступ для {{name}} заблоковано',
  people_inactive: '{{n}} люд. не заходили понад 30 днів — перевірте, чи не час архівувати',
  import_finished: 'Імпорт «{{file}}» завершено: створено {{created}}, оновлено {{updated}}, помилок {{errors}}. {{url}}',
  import_failed: 'Імпорт «{{file}}» не вдався: {{error}}',
  // docs/23
  manual: '{{text}}',
  test_message: 'Це перевірка сповіщень Lola, {{user.first_name}}. Усе працює ✅',
  telegram_blocked_manager: '{{name}} заблокував(ла) бота — нагадування йдуть у SMS. Попросіть повернути Telegram',
  escalation: 'Без реакції: {{name}} — «{{text}}»',
  security_suspicious_login: 'Вхід з нового пристрою: {{device}}. Якщо це не ви — закрийте сесії в профілі',
  security_alert: 'Журнал безпеки · {{level}}: {{event}}{{#person}} — {{person}}{{/person}}, {{when}}{{#ip}}, IP {{ip}}{{/ip}}. Деталі: {{link}}',
  // docs/24 §8: вход «от имени» и смена критичных настроек
  impersonation_started: 'Оператор платформи {{operator}} увійшов як {{subject}}. Причина: {{reason}}',
  settings_critical_changed: 'Змінено налаштування безпеки простору: {{group}}',
  // docs/24 §8, docs/25 §10, докс/33 D-054: 80% ліміту тарифу — попередження, 100% і більше — перевищення
  limit_warning: 'Використано {{pct}}% ліміту тарифу: {{resource}} ({{used}} з {{limit}})',
  limit_exceeded: 'Перевищено ліміт тарифу: {{resource}} ({{used}} з {{limit}}). Зверніться до підтримки Lola, щоб підвищити тариф',
  // docs/v2/28 §8 (PR-14): воронка кандидатов. Коды — в принятом здесь виде `snake_case`
  // (в документе они записаны через точку, `candidate.hired`): точка в коде уведомления
  // означала бы второе соглашение об именах рядом с полусотней существующих кодов, а
  // `emailDefaultEnabled` и `BYPASS_DAILY_LIMIT` разбирают именно суффиксы `_manager`/`_expiring`.
  // Кандидату уходят только приглашение, напоминание и финальное решение (§8 [решение]):
  // о внутренних статусах («Під сумнівом», «На перевірці») он не узнаёт.
  candidate_hired: 'Вітаємо у команді! Ваш перший день — {{date}}',
  candidate_hired_manager: '{{name}} виходить {{date}} на посаду',
  candidate_rejected: 'Дякуємо за інтерес до компанії. Цього разу ми обрали іншого кандидата{{#comment}}. {{comment}}{{/comment}}',
  candidate_completed: '{{name}} завершив(ла) відбір. Потрібне рішення',
  candidate_review_needed: '{{name}}: завдання відбору не зараховано — потрібне ваше рішення',
  candidate_consent_expiring: 'У {{n}} кандидат(ів) завершується строк згоди на обробку даних — після цього дані буде знеособлено',
  candidate_stale: '{{n}} кандидат(ів) без руху більше тижня',
  // docs/v2/28 §8 (PR-37): двух кодов не хватало против реестра `41-api-delta.md` §6.1 —
  // `candidate.invited`/`candidate.reminder` в PR-14 не завелись (там были только найм,
  // відмова, дайджести). `candidate.hired.internal` уже покрыт `candidate_hired_manager`,
  // `candidate.limit_warning` схлопнут в `limit_warning` (докс/v2/39 П-23) — новых кодов нет.
  candidate_invited: 'Вітаємо! Для участі у відборі на посаду «{{vacancy}}» пройдіть матеріали за посиланням: {{url}}{{#until}}. Доступ до {{until}}{{/until}}',
  candidate_reminder: 'Залишилось {{days}} дн., щоб завершити відбір на посаду «{{vacancy}}»',
  // docs/v2/29 §8 (PR-16): отклик по публичной ссылке. Кандидату — только приветствие со
  // ссылкой на отбор; о том, что его отклик задержала проверка §7.7, он не узнаёт никогда.
  vacancy_applied_welcome: 'Дякуємо за відгук на вакансію «{{vacancy}}». Ми надіслали вам посилання для проходження відбору',
  vacancy_application_received: 'Новий відгук на вакансію «{{vacancy}}»',
  // docs/28 «Вхід: код на e-mail» (Spec: канал OTP): лист не йде через чергу — шле напряму otpChannel.ts,
  // але текст лежить тут, як і решта, — тенант бачить і може переозначити на /admin/settings/notifications
  otp_code: 'Код для входу до Lola: {{code}}. Дійсний {{minutes}} хв. Нікому не повідомляйте цей код.',
  // docs/v2/41-api-delta.md §6 (PR-37, П-23): недостающие коды пакета сверх PR-14/16/23/30
  // (найдены сверкой факт. main против реестра — см. docs/v2/46-progress.md). Публикация на
  // джобборды, ai_quota и addon-коды намеренно не заводятся здесь — они принадлежат PR-17 и
  // PR-08/09/10/36, у которых нет ни схемы, ни вызывающего кода; регистрировать шаблон без
  // события, которое пакет ещё не описал числом/условием, означает угадывать текст.
  //
  // 29-vacancies.md §8 (докс/v2/45 PR-16 уже завёл vacancy_applied_welcome/vacancy_application_received)
  vacancy_application_review: 'Відгук на «{{vacancy}}» потребує перевірки: підозра на спам',
  vacancy_spam_burst: 'Незвична активність на сторінці вакансії «{{vacancy}}». Посилання тимчасово обмежено',
  vacancy_published_external: 'Вакансію «{{vacancy}}» опубліковано на {{platform}}',
  vacancy_publication_failed: 'Не вдалося опублікувати «{{vacancy}}» на {{platform}}: {{error}}',
  vacancy_account_revoked: 'Акаунт {{platform}} більше не авторизований. Підключіть його заново',
  vacancy_publication_expiring: 'Оголошення «{{vacancy}}» на {{platform}} завершується {{date}}',
  // vacancies.ts (PR-15) уже пише в комментарии «получает vacancy.closed_with_candidates» —
  // код был анонсирован раньше, чем заведён; закрываем разрыв.
  vacancy_closed_with_candidates: 'Вакансію «{{vacancy}}» закрито. {{n}} кандидат(ів) ще проходять відбір',
  vacancy_subscriber_reopened: 'Набір на «{{vacancy}}» знову відкрито',
  // 32-org-structure.md §8 (докс/v2/45 PR-30 уже завёл пять из семи кодов — org_node_assigned,
  // org_manager_changed, org_subordinate_added, org_node_vacant, org_structure_conflict)
  org_structure_import_finished: 'Імпорт оргструктури: створено {{created}}, оновлено {{updated}}, помилок {{errors}}',
  org_structure_rollback: 'Оргструктуру відкочено до знімка «{{label}}» від {{date}}',
  // 36-content-feedback.md §8: PR-23 создал таблицы `content_issues`/`content_issue_events`,
  // но явно отложил уведомления на PR-24 (`docs/v2/46-progress.md`, «Что осталось — PR-24»).
  // Шаблоны заведены здесь как реестр (П-23 требует зарегистрировать код, а не отправку);
  // вызовы enqueueNotification с этими кодами добавляет PR-24 при подключении резолюций.
  content_issue_created: 'Нова скарга на «{{title}}»: {{typeLabel}}',
  content_issue_merged: 'Вже {{count}} скарг на «{{title}}»',
  content_issue_blocking: 'Контент не працює: {{title}}',
  content_issue_overdue: 'Скарга на «{{title}}» прострочена на {{days}} дн.',
  content_issue_accepted: 'Твоє повідомлення про «{{title}}» прийняли в роботу',
  content_issue_fixed: 'Помилку в «{{title}}» виправлено. Дякуємо{{#points}} — {{points}} балів{{/points}}',
  content_issue_rejected: 'Ми перевірили скаргу на «{{title}}»: {{comment}}',
  content_issue_rescore_ready: '{{count}} спроб можна перерахувати після виправлення «{{title}}»',
  content_issue_rescored: 'Питання «{{title}}» виправили, твій результат перераховано: {{scoreOld}} → {{scoreNew}}',
  content_reporter_muted: 'Надсилання повідомлень про помилки контенту призупинено до {{until}}',
}

/**
 * Канал увімкнено за замовчуванням для глобального шаблону, поки тенант не перевизначив свій
 * рядок каналу в `notification_templates` (docs/23 §13.1 — колонки в еталоні саме Email і
 * Telegram; §4 — «E-mail: керівникам, дайджестам, вивантаженням», решта — Telegram, він
 * основний для всіх). У перелік коду потрапляє те, що вже узгоджено з рештою системи:
 * `security_alert` — єдиний код, який сьогодні реально надсилається каналом email
 * (`securityLog.ts`), `*_manager` — «керівникам», клас `managerDigest` — «дайджестам»,
 * `scheduled_report`/`report_export_*` — «вивантаженням». SMS у цю перевірку не потрапляє —
 * в еталоні його немає (§13.2), а in-app завжди резервний канал без власного рядка шаблону.
 * `otp_code`/`manual`/`test_message` — виняток: канал там обирає не шаблон, а конкретний
 * виклик (`otpChannel.ts` завжди шле email, ручна розсилка й «Надіслати собі» — автор/адмін
 * власноруч), тому тумблер коду їх не повинен вимикати.
 */
export function emailDefaultEnabled(code: string): boolean {
  if (code === 'otp_code' || code === 'manual' || code === 'test_message') return true
  return code === 'security_alert'
    || /_manager$/.test(code)
    || eventClassOf(code) === 'managerDigest'
    || /^(scheduled_report|report_export_)/.test(code)
}

/**
 * Дефолтний стан тумблерів «Email»/«Telegram» на екрані `NotificationTemplates` (докс/31
 * залишок: «дефолтний стан тумблера на рівні коду не змодельований на сервері») — поки тенант
 * не створив кастомний рядок каналу, таблиця показує саме це, а не «—».
 */
export const DEFAULT_TEMPLATE_CHANNELS: Record<string, { telegram: boolean, email: boolean, inapp: boolean }> = Object.fromEntries(
  Object.keys(DEFAULT_TEMPLATES).map(code => [code, { telegram: true, email: emailDefaultEnabled(code), inapp: true }]),
)

/**
 * Мини-шаблонизатор: {{var}} и блоки {{#var}}…{{/var}} при непустом var. `{{#_tr}}текст{{/_tr}}`
 * (docs/23 §13.4) — особый блок: содержимое не условие, а фраза для перевода по локали получателя;
 * `tr` — резолвер (по умолчанию тождественный, фраза как есть). Резолвится до общих блоков,
 * иначе `_tr` попал бы под правило {{#var}} и пропал бы, если такой переменной нет.
 * `locale` (докс/28, долг PR-107) — локаль получателя для дат-переменных внутри тексту, за
 * замовчуванням `uk` (лист без явно переданої локалі — старий викликач, поведінка як була).
 */
export function renderTemplate(tpl: string, vars: Record<string, unknown>, tr: (phrase: string) => string = s => s, locale: Locale = 'uk'): string {
  let out = tpl.replace(/\{\{#_tr\}\}([\s\S]*?)\{\{\/_tr\}\}/g, (_, phrase: string) => tr(phrase))
  out = out.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key: string, inner: string) =>
    vars[key] ? inner : '')
  out = out.replace(/\{\{([\w.]+)\}\}/g, (_, key: string) => {
    const v = vars[key]
    if (v === null || v === undefined) return ''
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      return formatDate(new Date(v), locale, { day: 'numeric', month: 'long' })
    }
    return String(v)
  })
  return out.trim()
}

/** Тихие часы (docs/03 §3.10): 09:00–20:00 по таймзоне тенанта; вне окна — на утро. */
export function scheduleWithQuietHours(now: Date, timezone: string, quiet: { from: number, to: number } = { from: 9, to: 20 }): Date {
  const local = new Date(now.toLocaleString('en-US', { timeZone: timezone }))
  const hour = local.getHours()
  if (hour >= quiet.from && hour < quiet.to) return now
  const next = new Date(local)
  if (hour >= quiet.to) next.setDate(next.getDate() + 1)
  next.setHours(quiet.from, 0, 0, 0)
  // Разница local↔now даёт смещение таймзоны
  return new Date(now.getTime() + (next.getTime() - local.getTime()))
}

/** Ближайшее время HH:MM в таймзоне (docs/23 §13.2.1): если сегодняшнее уже прошло — завтра. */
export function nextOccurrence(now: Date, timezone: string, hour: number, minute: number): Date {
  const local = new Date(now.toLocaleString('en-US', { timeZone: timezone }))
  const target = new Date(local)
  target.setHours(hour, minute, 0, 0)
  if (target.getTime() <= local.getTime()) target.setDate(target.getDate() + 1)
  return new Date(now.getTime() + (target.getTime() - local.getTime()))
}

/**
 * Класс события по коду (docs/23 §13.2.1: «не одне вікно тиші на все, а час на кожен клас»).
 * `anniversaries`/`programReminder` — коды в проекте пока не заведены (долг, docs/28 «Spec 23»).
 */
export function eventClassOf(code: string): keyof NotificationSchedule | null {
  if (/^birthday_/.test(code)) return 'birthdays'
  if (/^anniversary_/.test(code)) return 'anniversaries' // докс/33 D-049
  if (/^(weekly_digest|digest_)/.test(code)) return 'managerDigest'
  if (/^enrollment_(due_soon|due_today)$/.test(code)) return 'dueTasks'
  if (code === 'program_reminder') return 'programReminder' // докс/33 D-049
  return null
}

export interface EnqueueInput {
  tenantId: string
  userId: string
  code: string
  payload: Record<string, unknown>
  dedupKey?: string
  channel?: 'telegram' | 'sms' | 'email' | 'push'
  urgent?: boolean // OTP и подобное — минуя тихие часы
  refType?: string
  refId?: string
}

/**
 * Коды, которые обходят дневной лимит (docs/23 §6.4, решение Б.9): дедлайны, аттестации,
 * блокирующие объявления, безопасность. OTP в очередь не попадает вовсе.
 */
export const BYPASS_DAILY_LIMIT = (code: string) => /(_due_today|_overdue|_expiring|^assessment_|^announcement_|^notice_|^security_|^user_invited$|^import_)/.test(code)
export const DAILY_LIMIT = 10

/**
 * Тихі часи кандидата (докс/v2/39-patches.md П-23, сквозная проверка 19 — `docs/v2/42` §5):
 * 09:00–20:00 **по його власному часовому поясу**, і це вікно абсолютне — воно не звірене з
 * тумблером `settings.quietHours.enabled` тенанта і не обходиться через `urgent`/
 * `ignoreQuietHours` (кандидатських кодів такого типу немає: OTP кандидата йде мимо черги,
 * як і у співробітника). Тенант не має права присунути кандидату розсилку вночі, вимкнувши
 * власні тихі часи для персоналу.
 */
export const CANDIDATE_QUIET_HOURS = { from: 9, to: 20 }

/**
 * Часовий пояс кандидата [решение] (докс/v2/39 П-23): у `users` для кандидата такої колонки
 * немає, і заводити її окремою міграцією заради одного поля не пропорційно — кандидат не
 * заповнює розширений профіль, як співробітник (докс/v2/28 §3.2 таких полів не додає).
 * Джерело — часовий пояс **точки вакансії**, на яку кандидат відгукнувся:
 * `users.vacancy_id → vacancies.location_id → locations.timezone` — ланцюжок уже існуючих
 * зовнішніх ключів, без нової колонки. Це не фізичне місце кандидата, а обґрунтоване
 * наближення: тихі часи існують, щоб не розбудити людину вночі, а більшість кандидатів
 * фізично перебувають біля міста, куди відгукнулись. Без вакансії (кандидат заведений вручну
 * рекрутером) повертає `null` — далі береться таймзона тенанта, той самий порядок відмови,
 * що і в співробітника нижче.
 */
async function candidateTimezone(tx: TenantTx, userId: string): Promise<string | null> {
  const [row] = await tx.execute(sql`
    select l.timezone from users u
    join vacancies v on v.id = u.vacancy_id
    join locations l on l.id = v.location_id
    where u.id = ${userId}::uuid
  `) as unknown as { timezone: string | null }[]
  return row?.timezone ?? null
}

/** Кладёт уведомление в очередь; при совпадении dedupKey — молча пропускает (в журнал duplicate не пишется: ключ уникален). */
export async function enqueueNotification(tx: TenantTx, input: EnqueueInput): Promise<boolean> {
  const [tenant] = await db.select({ timezone: tenants.timezone, settings: tenants.settings }).from(tenants).where(eq(tenants.id, input.tenantId))
  const settings = await readSettings(tx, input.tenantId)
  const [recipient] = await tx.select({ kind: users.kind }).from(users).where(eq(users.id, input.userId))
  const now = new Date()
  let scheduledFor: Date

  if (recipient?.kind === 'candidate') {
    // П-23: кандидат — поза тихими часами тенанта (він не працівник цієї мережі), але в межах
    // 09:00–20:00 свого часу. Без урахування urgent/ignoreQuietHours і тумблера тенанта — див.
    // коментар CANDIDATE_QUIET_HOURS.
    const timezone = (await candidateTimezone(tx, input.userId)) ?? tenant?.timezone ?? 'Europe/Kyiv'
    scheduledFor = scheduleWithQuietHours(now, timezone, CANDIDATE_QUIET_HOURS)
  }
  else {
    // Тихие часы по таймзоне точки человека (docs/23 §3.3), иначе — тенанта
    const [loc] = await tx.execute(sql`select l.timezone from user_placements up join locations l on l.id = up.location_id where up.user_id = ${input.userId}::uuid and up.is_primary and up.ended_at is null limit 1`) as unknown as { timezone: string | null }[]
    const [tpl] = await tx.select({ ignoreQuietHours: notificationTemplates.ignoreQuietHours }).from(notificationTemplates).where(and(eq(notificationTemplates.code, input.code), eq(notificationTemplates.channel, input.channel ?? 'telegram')))
    const timezone = loc?.timezone ?? tenant?.timezone ?? 'Europe/Kyiv'
    const cls = eventClassOf(input.code)
    if (input.urgent || tpl?.ignoreQuietHours) scheduledFor = now
    else if (cls) scheduledFor = nextOccurrence(now, timezone, settings.notificationSchedule[cls].hour, settings.notificationSchedule[cls].minute) // §13.2.1: свій час класу — понад тихі часи
    else if (settings.quietHours.enabled) scheduledFor = scheduleWithQuietHours(now, timezone, settings.quietHours)
    else scheduledFor = now
  }

  const [row] = await tx.insert(notifications).values({
    tenantId: input.tenantId,
    userId: input.userId,
    requestContext: currentRequestContext(), // null у фоновых задач — это норма
    code: input.code,
    channel: input.channel ?? 'telegram',
    payload: input.payload,
    dedupKey: input.dedupKey ?? null,
    scheduledFor,
    skipReason: scheduledFor.getTime() > now.getTime() + 60_000 ? 'quiet_hours' : null, // §13.1: в журнале причина переноса
    refType: input.refType ?? null,
    refId: input.refId ?? null,
    urgent: input.urgent ?? false,
  }).onConflictDoNothing().returning({ id: notifications.id })
  return !!row
}

interface TemplateRow { body: string, subject: string | null, bodyMjml: string | null, version: number, isMandatory: boolean, throttle: { maxPerDay?: number } | null, buttons: { text: string, action: string }[], scope: 'global' | 'custom' }

/**
 * Шаблон с учётом переопределений тенанта; отключённый → null. Fallback на uk (docs/23 §6.9).
 * `scope` (docs/23 §13.1, docs/30): «Глобальний» — код из `DEFAULT_TEMPLATES`, без строки в БД;
 * «Кастомний» — правка тенанта создала свою строку в `notification_templates`. Правка тенанта
 * не трогает стандартный текст (он остаётся в коде), «Повернути стандартний текст» — просто
 * удаляет кастомную строку.
 */
export async function templateFor(tx: TenantTx, tenantId: string, code: string, channel: string, locale: string): Promise<TemplateRow | null> {
  const pick = async (loc: string) => (await tx.select().from(notificationTemplates).where(and(eq(notificationTemplates.tenantId, tenantId), eq(notificationTemplates.code, code), eq(notificationTemplates.channel, channel), eq(notificationTemplates.locale, loc))))[0]
  const t = (await pick(locale)) ?? (locale !== 'uk' ? await pick('uk') : undefined)
  if (t) return t.isEnabled ? { body: t.body, subject: t.subject, bodyMjml: t.bodyMjml, version: t.version, isMandatory: t.isMandatory, throttle: t.throttle as TemplateRow['throttle'], buttons: t.buttons as TemplateRow['buttons'], scope: 'custom' } : null
  const body = DEFAULT_TEMPLATES[code]
  return body ? { body, subject: null, bodyMjml: null, version: 0, isMandatory: MANDATORY_DEFAULT(code), throttle: null, buttons: [], scope: 'global' } : null
}
/** Обязательные по умолчанию: дедлайны, аттестации, объявления, безопасность, приглашение. */
export const MANDATORY_DEFAULT = (code: string) => (BYPASS_DAILY_LIMIT(code) && code !== 'notice_not_acknowledged') || /_due_soon$|^user_blocked$|^user_role_granted$|^otp_|^content_issue_blocking$/.test(code) // docs/23 §13: notice.assigned обязательное, напоминание — нет; otp_* людина не вимикає; content_issue_blocking — docs/v2/36 §8, content_issue_overdue вже покриває BYPASS_DAILY_LIMIT (`_overdue`)

/** Общие переменные шаблонов (docs/23 §3.4): user.*, location.name, position.name, tenant.name, link. */
async function commonVars(tx: TenantTx, tenantId: string, userId: string): Promise<Record<string, unknown>> {
  const [r] = await tx.execute(sql`
    select u.full_name, u.first_name, l.name as location, p.name as position, t.name as tenant
    from users u left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null
    left join locations l on l.id = up.location_id left join positions p on p.id = up.position_id
    cross join (select name from tenants where id = ${tenantId}::uuid) t where u.id = ${userId}::uuid
  `) as unknown as { full_name: string, first_name: string | null, location: string | null, position: string | null, tenant: string }[]
  const appUrl = process.env.APP_URL ?? ''
  return {
    'user.full_name': r?.full_name ?? '', 'user.first_name': r?.first_name ?? r?.full_name?.split(' ')[1] ?? '', 'location.name': r?.location ?? '', 'position.name': r?.position ?? '', 'tenant.name': r?.tenant ?? '', 'name': r?.full_name ?? '',
    // docs/23 §13.4 п. 4: посилання «налаштувати сповіщення» в підвалі кожного листа — обовʼязкове
    'mail_settings_url': `${appUrl}/learn/notifications`,
  }
}

/** Ссылка на предмет уведомления для кнопки «Пройти» и колокольчика. */
export function refUrl(n: { refType: string | null, refId: string | null, payload: unknown }): string | null {
  const p = n.payload as Record<string, unknown>
  if (n.refType === 'enrollment' || p.enrollmentId) return `/learn/${n.refId ?? p.enrollmentId}`
  if (n.refType === 'program' || p.programId) return `/learn/programs/${n.refId ?? p.programId}`
  if (n.refType === 'goal' || p.goalId) return `/learn/development/goals/${n.refId ?? p.goalId}`
  if (n.refType === 'meetup' || p.meetupId) return `/learn/meetups/${n.refId ?? p.meetupId}`
  if (n.refType === 'article' || p.articleId) return `/learn/knowledge/${n.refId ?? p.articleId}`
  if (typeof p.url === 'string' && p.url.startsWith('/')) return p.url
  return null
}

const RETRY_MINUTES = [1, 5, 25, 60, 180] // docs/23 §6.5

export function isVirtualEmail(email: string, domains: string[]): boolean {
  const d = email.split('@')[1]?.toLowerCase() ?? ''
  return domains.some(v => d === v.toLowerCase() || d.endsWith(`.${v.toLowerCase()}`))
}

/**
 * notification.dispatch (docs/23 §6): выбор канала Telegram → SMS (обязательные) → in-app;
 * настройки человека, троттлинг, ретраи с экспонентой, 403 → telegram_blocked.
 */
export async function dispatchNotifications(tenantId: string, limit = 100): Promise<{ sent: number, skipped: number, failed: number }> {
  const stats = { sent: 0, skipped: 0, failed: 0 }
  await withTenant(tenantId, null, async (tx) => {
    const tenantSettings = await readSettings(tx, tenantId)
    const virtualDomains = tenantSettings.policies.notifications.virtualEmailDomains
    // Локаль отримувача (docs/23 §3.4, §13.4): своя — з `users.locale`, інакше локаль тенанта, інакше uk
    const [tenantRow] = await tx.select({ locale: tenants.locale }).from(tenants).where(eq(tenants.id, tenantId))
    const tenantLocale = (tenantRow?.locale ?? 'uk') as Locale
    const due = await tx.select({
      n: notifications,
      user: { telegramChatId: users.telegramChatId, telegramBlocked: users.telegramBlocked, locale: users.locale, fullName: users.fullName, phone: users.phone, email: users.email },
    })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(and(eq(notifications.status, 'queued'), lte(notifications.scheduledFor, new Date())))
      .orderBy(notifications.scheduledFor)
      .limit(limit)

    const skip = async (id: string, reason: string, text?: string) => {
      await tx.update(notifications).set({ status: 'skipped', skipReason: reason, error: reason, ...(text ? { renderedText: text } : {}), updatedAt: new Date() }).where(eq(notifications.id, id))
      stats.skipped++
    }
    const sent = async (id: string, text: string, channel: string, version: number) => {
      await tx.update(notifications).set({ status: 'sent', channel, renderedText: text, templateVersion: version, sentAt: new Date(), skipReason: null, error: null, updatedAt: new Date() }).where(eq(notifications.id, id))
      stats.sent++
      business.inc({ event: 'notification_sent' })
    }
    const failed = async (n: typeof due[number]['n'], text: string, error: string) => {
      const attempt = n.attempt + 1
      if (attempt < RETRY_MINUTES.length) {
        await tx.update(notifications).set({ status: 'queued', attempt, renderedText: text, error, scheduledFor: new Date(Date.now() + RETRY_MINUTES[attempt]! * 60_000), updatedAt: new Date() }).where(eq(notifications.id, n.id))
      }
      else {
        await tx.update(notifications).set({ status: 'failed', attempt, renderedText: text, error, updatedAt: new Date() }).where(eq(notifications.id, n.id))
        stats.failed++
        business.inc({ event: 'notification_failed' })
      }
    }

    for (const { n, user } of due) {
      const locale = (user.locale ?? tenantLocale) as Locale
      const tpl = await templateFor(tx, tenantId, n.code, n.channel, locale)
      if (!tpl) { await skip(n.id, 'template_disabled'); continue }

      // Настройки человека (docs/23 §3.3): необязательное можно отключить
      if (!tpl.isMandatory) {
        const [pref] = await tx.select().from(userNotificationPrefs).where(and(eq(userNotificationPrefs.userId, n.userId), eq(userNotificationPrefs.code, n.code)))
        if (pref && !pref.enabled) { await skip(n.id, 'unsubscribed'); continue }
      }
      // Троттлинг (§6.4): по коду и общий дневной лимит
      const maxPerDay = tpl.throttle?.maxPerDay
      if (maxPerDay) {
        const [c] = await tx.execute(sql`select count(*)::int as n from notifications where user_id = ${n.userId}::uuid and code = ${n.code} and status = 'sent' and sent_at >= current_date`) as unknown as { n: number }[]
        if ((c?.n ?? 0) >= maxPerDay) { await skip(n.id, 'throttled'); continue }
      }
      if (!n.urgent && !BYPASS_DAILY_LIMIT(n.code)) {
        const [c] = await tx.execute(sql`select count(*)::int as n from notifications where user_id = ${n.userId}::uuid and status = 'sent' and sent_at >= current_date`) as unknown as { n: number }[]
        if ((c?.n ?? 0) >= DAILY_LIMIT) { await skip(n.id, 'throttled'); continue }
      }

      const vars = { ...(await commonVars(tx, tenantId, n.userId)), ...(n.payload as Record<string, unknown>) }
      // {{#_tr}} (docs/23 §13.4): переклад фрази по локалі отримувача через ту саму таблицю `translations`
      const trMap = await tenantOverrides(tenantId, locale)
      const tr = (phrase: string) => trMap[phrase] ?? phrase
      const text = renderTemplate(tpl.body, vars, tr, locale)

      // Правило выбора канала (docs/23 §4): Telegram → SMS (обязательные) → in-app
      let channel = n.channel
      if (channel === 'telegram' && (!user.telegramChatId || user.telegramBlocked)) channel = tpl.isMandatory && user.phone ? 'sms' : 'inapp'
      if (channel === 'email' && !user.email) channel = 'inapp'
      // «Домени віртуальної пошти» (docs/24 §3.4.1): на технические адреса вида ivan@local система молча не шлёт
      if (channel === 'email' && user.email && isVirtualEmail(user.email, virtualDomains)) channel = 'inapp'
      if (channel === 'inapp') { await skip(n.id, 'no_channel', text); continue } // видно в колокольчике

      if (channel === 'telegram') {
        const url = refUrl(n)
        const res = await sendTelegram(tenantId, user.telegramChatId!, text, { url, notificationId: n.id, buttons: tpl.buttons, mandatory: tpl.isMandatory })
        if (res.ok) await sent(n.id, text, channel, tpl.version)
        else if (res.blocked) {
          // Бот заблокирован (docs/23 §6.5): помечаем, критичное — сразу SMS, руководителю уведомление
          await tx.update(users).set({ telegramBlocked: true }).where(eq(users.id, n.userId))
          const mgr = await managerIdOf(tx, n.userId) // П-16.4
          if (mgr) await enqueueNotification(tx, { tenantId, userId: mgr, code: 'telegram_blocked_manager', payload: { name: user.fullName }, dedupKey: `tg_blocked:${n.userId}` })
          if (tpl.isMandatory && user.phone) {
            const { sendViaChannel } = await import('./channels')
            const r2 = await sendViaChannel(tenantId, 'sms', { userId: n.userId, text, subject: n.code })
            if (r2.ok) { await sent(n.id, text, 'sms', tpl.version); continue }
          }
          await skip(n.id, 'blocked', text)
        }
        else { await failed(n, text, res.error ?? 'telegram error'); business.inc({ event: 'telegram_error' }) }
      }
      else {
        const { sendViaChannel } = await import('./channels')
        // docs/23 §13.4: заголовок листа з шаблону; body_mjml → HTML поверх обвʼязки тенанта (§13.5), інакше — лише текст
        const subject = channel === 'email' && tpl.subject ? renderTemplate(tpl.subject, vars, tr, locale) : n.code
        const html = channel === 'email' && tpl.bodyMjml
          ? buildEmailHtml({
              bodyMjml: renderTemplate(tpl.bodyMjml, vars, tr, locale),
              fallbackText: text,
              layout: { headerMjml: tenantSettings.emailLayout.headerMjml ? renderTemplate(tenantSettings.emailLayout.headerMjml, vars, tr, locale) : '', footerMjml: tenantSettings.emailLayout.footerMjml ? renderTemplate(tenantSettings.emailLayout.footerMjml, vars, tr, locale) : '' },
            })
          : undefined
        const res = await sendViaChannel(tenantId, channel as 'sms' | 'email' | 'push', { userId: n.userId, text, subject, html })
        if (res.ok) await sent(n.id, text, channel, tpl.version)
        else if (res.skipped) await skip(n.id, res.error?.includes('limit') ? 'blocked' : 'no_channel', text)
        else await failed(n, text, res.error ?? 'channel error')
      }
    }
  })
  return stats
}

// ── Колокольчик, настройки, повторная отправка, рассылка (docs/23 §5, §9) ──

export async function inbox(ctx: { tenantId: string, actorId: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.select().from(notifications).where(and(eq(notifications.userId, ctx.actorId), sql`${notifications.status} in ('sent','skipped','read')`)).orderBy(sql`${notifications.createdAt} desc`).limit(50)
    const items = []
    // Локаль — тільки для рідкого фолбеку (renderedText зазвичай вже є, докс/28): рахуємо
    // лінько, один раз на весь список, а не на кожен рядок.
    let locale: Locale | null = null
    for (const n of rows) {
      let text = n.renderedText
      if (!text) {
        const tpl = DEFAULT_TEMPLATES[n.code]
        if (tpl) {
          if (locale === null) {
            const [userRow] = await tx.select({ locale: users.locale }).from(users).where(eq(users.id, ctx.actorId))
            const [tenantRow] = await tx.select({ locale: tenants.locale }).from(tenants).where(eq(tenants.id, ctx.tenantId))
            locale = recipientLocale(userRow?.locale, tenantRow?.locale)
          }
          text = renderTemplate(tpl, { ...(await commonVars(tx, ctx.tenantId, ctx.actorId)), ...(n.payload as Record<string, unknown>) }, undefined, locale)
        }
      }
      items.push({ id: n.id, code: n.code, text: text ?? n.code, createdAt: n.createdAt, readAt: n.readAt, url: refUrl(n) })
    }
    const [c] = await tx.execute(sql`select count(*)::int as n from notifications where user_id = ${ctx.actorId}::uuid and read_at is null and status in ('sent','skipped')`) as unknown as { n: number }[]
    return { items, unread: c?.n ?? 0 }
  })
}

export async function markRead(ctx: { tenantId: string, actorId: string }, ids?: string[]) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.update(notifications).set({ readAt: new Date(), updatedAt: new Date() })
      .where(and(eq(notifications.userId, ctx.actorId), sql`${notifications.readAt} is null`, ...(ids?.length ? [sql`${notifications.id} in ${ids}`] : []))).returning({ id: notifications.id })
    return rows.length
  })
}

/** Клик по ссылке из уведомления — реакция (docs/23 §8 «Реакція», §6.6 эскалация). */
export async function markReacted(tenantId: string, notificationId: string) {
  await withTenant(tenantId, null, tx => tx.update(notifications).set({ reactedAt: new Date(), readAt: sql`coalesce(${notifications.readAt}, now())` }).where(and(eq(notifications.id, notificationId), sql`${notifications.reactedAt} is null`)))
}

export async function listPrefs(ctx: { tenantId: string, actorId: string }) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const prefs = await tx.select().from(userNotificationPrefs).where(eq(userNotificationPrefs.userId, ctx.actorId))
    const custom = await tx.select({ code: notificationTemplates.code, isMandatory: notificationTemplates.isMandatory }).from(notificationTemplates).where(eq(notificationTemplates.channel, 'telegram'))
    const mandatory = new Map(custom.map(c => [c.code, c.isMandatory]))
    return Object.keys(DEFAULT_TEMPLATES).map(code => ({ code, enabled: prefs.find(p => p.code === code)?.enabled ?? true, channel: prefs.find(p => p.code === code)?.channel ?? null, isMandatory: mandatory.get(code) ?? MANDATORY_DEFAULT(code), group: groupOf(code) }))
  })
}
/** Группы кодов на экране «Мої сповіщення» (docs/23 §5.1). */
export function groupOf(code: string): 'learning' | 'assessment' | 'reminders' | 'hub' | 'other' {
  if (/^(assignment|enrollment|program|attempt|workshop|review|certificate)/.test(code)) return 'learning'
  if (/^(assessment|checklist|action_item|competency|goal|plan|request)/.test(code)) return 'assessment'
  if (/_due|_overdue|reminder|meetup|webinar|digest/.test(code)) return 'reminders'
  if (/^(news|announcement|notice|knowledge|survey|event|wiki|birthday|anniversary)/.test(code)) return 'hub'
  return 'other'
}

export async function setPref(ctx: { tenantId: string, actorId: string }, input: { code: string, enabled?: boolean, channel?: 'telegram' | 'sms' | 'email' | 'push' | null }): Promise<{ ok: true } | { ok: false, code: 'mandatory' | 'unknown' }> {
  if (!(input.code in DEFAULT_TEMPLATES)) return { ok: false, code: 'unknown' }
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const [t] = await tx.select({ isMandatory: notificationTemplates.isMandatory }).from(notificationTemplates).where(and(eq(notificationTemplates.code, input.code), eq(notificationTemplates.channel, 'telegram')))
    if ((t?.isMandatory ?? MANDATORY_DEFAULT(input.code)) && input.enabled === false) return { ok: false as const, code: 'mandatory' as const }
    await tx.insert(userNotificationPrefs).values({ tenantId: ctx.tenantId, userId: ctx.actorId, code: input.code, enabled: input.enabled ?? true, channel: input.channel ?? null })
      .onConflictDoUpdate({ target: [userNotificationPrefs.tenantId, userNotificationPrefs.userId, userNotificationPrefs.code], set: { ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(input.channel !== undefined ? { channel: input.channel } : {}), updatedAt: new Date() } })
    return { ok: true as const }
  })
}

/** «Перевірити» / «Надіслати собі»: тестовое сообщение сразу, минуя тихие часы. */
export async function sendTest(ctx: { tenantId: string, actorId: string }, code = 'test_message', payload: Record<string, unknown> = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, tx => enqueueNotification(tx, { tenantId: ctx.tenantId, userId: ctx.actorId, code, payload, urgent: true, dedupKey: `test:${ctx.actorId}:${Date.now()}` }))
}

export async function resend(ctx: { tenantId: string, actorId: string }, id: string): Promise<boolean> {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const rows = await tx.update(notifications).set({ status: 'queued', attempt: 0, error: null, skipReason: null, scheduledFor: new Date(), urgent: true, updatedAt: new Date() })
      .where(and(eq(notifications.id, id), sql`${notifications.status} in ('failed','skipped','sent')`)).returning({ id: notifications.id })
    return rows.length > 0
  })
}

/** Ручная рассылка (docs/23 §5.4): аудитория из конструктора, код manual, автор в payload. */
export async function broadcast(ctx: { tenantId: string, actorId: string }, input: { audience: unknown, text: string, channel?: 'telegram' | 'sms' | 'email' | 'push' }): Promise<{ recipients: number, queued: number }> {
  const { resolveAudience } = await import('./audience')
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const ids = [...await resolveAudience(tx, input.audience as never)]
    const [author] = await tx.select({ fullName: users.fullName }).from(users).where(eq(users.id, ctx.actorId))
    let queued = 0
    const stamp = Date.now()
    for (const userId of ids) {
      if (await enqueueNotification(tx, { tenantId: ctx.tenantId, userId, code: 'manual', channel: input.channel, payload: { text: input.text, author: author?.fullName ?? '', authorId: ctx.actorId }, dedupKey: `manual:${stamp}:${userId}` })) queued++
    }
    const { recordAudit } = await import('./audit')
    await recordAudit(tx, { tenantId: ctx.tenantId, actorId: ctx.actorId, action: 'notification.broadcast', entity: 'notification', after: { recipients: ids.length, text: input.text.slice(0, 200) } })
    return { recipients: ids.length, queued }
  })
}

/** Окно одного прохода эскалации (`escalationScan`): столько строк разбирается за час на тенант. */
export const ESCALATION_BATCH = 200

/**
 * Ежечасно (docs/23 §6.6): отправленное с `escalate_after_hours` без реакции → руководителю.
 *
 * Адресат — руководитель по `resolveManager()` (П-16.4), и известен он только после резолва,
 * поэтому отбор не фильтрует «у кого есть руководитель» в `where`. Отсюда правило прохода:
 * **каждая выбранная строка закрывается** — эскалацией (`escalated_to_id` = руководитель) или
 * отметкой «эскалировать некому» (`escalated_at` без `escalated_to_id`). Незакрытая строка
 * выбиралась бы снова каждый час, и двести человек без руководителя навсегда заняли бы окно
 * `ESCALATION_BATCH` — до тех, у кого руководитель есть, эскалация не дошла бы никогда.
 *
 * Разбор — от самой старой отправки: раз всё выбранное закрывается, окно сдвигается само, и
 * любая строка обрабатывается не позже чем через «хвост перед ней / ESCALATION_BATCH» часов.
 * Шаблон проверяется через `exists`, а не `join`: у кода по шаблону на каждый язык, и `join`
 * повторял бы одно уведомление в окне столько раз, сколько у него переводов.
 */
export async function escalationScan(tenantId: string): Promise<number> {
  return withTenant(tenantId, null, async (tx) => {
    const rows = await tx.execute(sql`
      select n.id, n.user_id, n.code, n.rendered_text, u.full_name
      from notifications n
      join users u on u.id = n.user_id
      where n.status = 'sent' and n.reacted_at is null and n.escalated_at is null
        and exists (
          select 1 from notification_templates t
          where t.tenant_id = n.tenant_id and t.code = n.code and t.channel = 'telegram'
            and t.escalate_after_hours is not null
            and n.sent_at < now() - (t.escalate_after_hours || ' hours')::interval)
      order by n.sent_at, n.id
      limit ${ESCALATION_BATCH}
    `) as unknown as { id: string, user_id: string, code: string, rendered_text: string | null, full_name: string }[]
    const escalationManagers = await managerIdsOf(tx, rows.map(r => r.user_id))
    const at = new Date()
    const nobody: string[] = []
    let n = 0
    for (const r of rows) {
      const mgr = escalationManagers.get(r.user_id)
      if (!mgr || mgr === r.user_id) {
        nobody.push(r.id)
        continue
      }
      if (await enqueueNotification(tx, { tenantId, userId: mgr, code: 'escalation', payload: { name: r.full_name, text: r.rendered_text ?? r.code }, dedupKey: `esc:${r.id}` })) n++
      await tx.update(notifications).set({ escalatedAt: at, escalatedToId: mgr }).where(eq(notifications.id, r.id))
    }
    // «Эскалировать некому»: строка закрыта без адресата и в следующий проход не попадёт.
    if (nobody.length) await tx.update(notifications).set({ escalatedAt: at, escalatedToId: null }).where(inArray(notifications.id, nobody))
    return n
  })
}

/** Отчёты (docs/23 §8): доставляемость, реакция, SMS-сегменты, заблокированные боты. */
export async function notificationsReport(ctx: { tenantId: string, actorId: string }, f: { from?: string, to?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    const period = sql`${f.from ? sql`and n.created_at >= ${f.from}::date` : sql``} ${f.to ? sql`and n.created_at < (${f.to}::date + 1)` : sql``}`
    const delivery = await tx.execute(sql`
      select n.code, n.channel, count(*)::int as total, count(*) filter (where n.status in ('sent','read'))::int as sent, count(*) filter (where n.status = 'failed')::int as failed,
             count(*) filter (where n.status = 'skipped')::int as skipped,
             jsonb_object_agg(coalesce(n.skip_reason, '-'), 1) filter (where n.status = 'skipped') as skip_reasons,
             count(*) filter (where n.reacted_at is not null)::int as reacted,
             round(avg(extract(epoch from (n.reacted_at - n.sent_at)) / 60) filter (where n.reacted_at is not null))::int as avg_minutes_to_react
      from notifications n where true ${period} group by 1, 2 order by 3 desc limit 200
    `) as unknown as Record<string, unknown>[]
    const sms = await tx.execute(sql`
      select coalesce(l.name, '—') as location, count(*)::int as messages, sum(ceil(greatest(1, length(n.rendered_text)) / 70.0))::int as segments
      from notifications n left join user_placements up on up.user_id = n.user_id and up.is_primary and up.ended_at is null left join locations l on l.id = up.location_id
      where n.channel = 'sms' and n.status in ('sent','read') ${period} group by 1 order by 3 desc
    `) as unknown as Record<string, unknown>[]
    const blocked = await tx.execute(sql`select u.id, u.full_name, l.name as location from users u left join user_placements up on up.user_id = u.id and up.is_primary and up.ended_at is null left join locations l on l.id = up.location_id where u.telegram_blocked and u.status = 'active' ${EMPLOYEES_ONLY()} order by u.full_name limit 200`) as unknown as Record<string, unknown>[]
    return { delivery, sms, blocked }
  })
}

export async function listNotifications(ctx: { tenantId: string, actorId: string }, filter: { userId?: string, status?: string } = {}) {
  return withTenant(ctx.tenantId, ctx.actorId, async (tx) => {
    return tx.select({
      id: notifications.id,
      userId: notifications.userId,
      fullName: users.fullName,
      code: notifications.code,
      channel: notifications.channel,
      status: notifications.status,
      renderedText: notifications.renderedText,
      error: notifications.error,
      scheduledFor: notifications.scheduledFor,
      sentAt: notifications.sentAt,
      createdAt: notifications.createdAt,
    })
      .from(notifications)
      .innerJoin(users, eq(users.id, notifications.userId))
      .where(and(
        ...(filter.userId ? [eq(notifications.userId, filter.userId)] : []),
        ...(filter.status ? [eq(notifications.status, filter.status)] : []),
      ))
      .orderBy(sql`${notifications.createdAt} desc`)
      .limit(200)
  })
}

export async function tenantsWithQueued(): Promise<string[]> {
  const rows = await db.execute(sql`select distinct tenant_id from notifications where status = 'queued' and scheduled_for <= now()`)
  return (rows as unknown as { tenant_id: string }[]).map(r => r.tenant_id)
}
