/**
 * Скоупы и системные роли (docs/01-roles.md §1.2–1.4).
 * Единый источник для сида, проверки прав и редактора ролей.
 *
 * Скоупы пакета docs/v2 (патч П-01, docs/v2/39-patches.md) только объявлены — эндпоинтов под
 * них ещё нет (docs/v2/45-plan.md PR-03), это ожидаемо. Состав взят из §2 «Роли и скоупы»
 * каждого документа пакета (28–38), а не из обзорной таблицы патча — модульный документ
 * побеждает при расхождении, как и предписывает патч. Новый скоуп назначается ролям
 * `employee`, `mentor`, `manager`, `author` не раньше, чем появляются эндпоинты под него, —
 * до тех пор он есть только у `admin` (через `[...SCOPES]` ниже). Первое исключение —
 * `lifecycle.view` у `mentor`, `manager` и `author` (PR-05: справочник этапов и экран
 * `/admin/settings/lifecycle` уже работают, `docs/v2/33` §2 даёт им право видеть этап);
 * `lifecycle.manage` остаётся только у `admin`. Второе — `offboarding.start` у `manager`
 * (PR-07: экран `/admin/offboarding` работает, `docs/v2/33` §2 — «Запустить офбординг:
 * керівник точки ✓ своей точки»); `offboarding.complete` остаётся только у `admin`. Роль `owner`
 * заведена (см. ниже) — `docs/v2/35` §2 ссылалась на неё как на существующую, хотя в `01` §1.2
 * её не было. Распределение по будущим ролям `recruiter` и `hr` — в PR, которые добавят
 * соответствующие эндпоинты. Скоупы `platform.*` из `docs/v2/35-billing-limits.md` §2
 * (`plans.manage`, `limits.override`, `ai.grant`, `payments.manage`) сюда не включены: доступ
 * оператора платформы работает отдельным механизмом (`platform_admin`, BYPASSRLS,
 * `server/services/platform.ts`), а не этим массивом скоупов тенанта.
 */

export const SCOPES = [
  // Обучение (потребление)
  'learn.view', 'learn.catalog', 'learn.attempt',
  // Контент
  'course.view', 'course.create', 'course.edit', 'course.publish', 'course.archive',
  'question.manage', 'media.upload', 'media.delete', 'knowledge.manage', 'survey.manage',
  // Люди и назначения
  'people.view', 'people.invite', 'people.edit', 'people.deactivate', 'people.import', 'people.password',
  'assignment.create', 'assignment.cancel', 'role.assign',
  // Проверка
  'review.queue', 'review.grade', 'certification.confirm',
  // Отчёты
  'report.own', 'report.team', 'report.tenant', 'report.export',
  // Настройки
  'settings.tenant', 'settings.notifications', 'settings.integrations', 'audit.view',
  // Владение простором (docs/01 §1.2, §1.3 «Власність»): передать владение другому человеку.
  // Скоуп заведён этим PR — ни `01`, ни пакет `v2` его не называли, хотя `v2/35` §2 уже
  // считает `owner` существующей ролью. Без отдельного скоупа передача владения была бы
  // либо частью `settings.tenant` (тогда её может сделать любой администратор — а это
  // ровно то, чего владение не допускает), либо проверкой по коду роли (запрещено
  // инвариантом 16 по духу: поведение — через права, не через `if (code === …)`).
  'tenant.transfer',
  // Развитие (docs/19 §2)
  'development.own', 'development.team', 'development.manage', 'competency.manage', 'position_profile.manage', 'request.decide',
  // Оценка и чек-листы (docs/20 §2)
  'assessment.own', 'assessment.team', 'assessment.run', 'assessment.manage', 'checklist.run', 'checklist.manage',
  // Очные занятия, вебинары, комплексные тесты (docs/18 §2)
  'meetup.view', 'meetup.enroll', 'meetup.manage', 'meetup.attendance', 'webinar.manage', 'complextest.manage',
  // Хаб (docs/03 §3.22, §3.26)
  'wiki.edit', 'report.builder',
  // Программы и траектории (docs/17 §2)
  'program.manage', 'program.publish', 'program.link_rule',

  // --- Пакет docs/v2 (patch П-01, docs/v2/39-patches.md) ---
  // Рекрутинг: кандидаты (docs/v2/28 §2)
  'candidate.view', 'candidate.edit', 'candidate.assign', 'candidate.decide', 'candidate.hire',
  'candidate.delete', 'candidate.status.manage',
  // Рекрутинг: вакансии (docs/v2/29 §2)
  'vacancy.view', 'vacancy.edit', 'vacancy.publish', 'vacancy.close', 'vacancy.template.manage',
  'vacancy.criteria.manage', 'vacancy.ai.use', 'jobboard.connect', 'jobboard.publish',
  // ИИ-собеседование (docs/v2/30 §2)
  'interview.configure', 'interview.view', 'interview.listen', 'interview.override',
  'summary.view', 'summary.edit', 'summary.send', 'ai.review.use', 'ai.audit',
  // Библиотека модулей (docs/v2/31 §2)
  'library.view', 'library.use', 'library.publish', 'library.manage',
  // Оргструктура (docs/v2/32 §2)
  'org.structure.view', 'org.structure.edit', 'org.structure.import',
  // Жизненный цикл и офбординг (docs/v2/33 §2)
  'lifecycle.view', 'lifecycle.manage', 'offboarding.start', 'offboarding.complete',
  // Хранилище (docs/v2/34 §2)
  'storage.view', 'storage.delete', 'storage.policy', 'storage.addon',
  // Тариф и лимиты (docs/v2/35 §2)
  'billing.view', 'billing.usage.view', 'billing.payments.view', 'billing.manage',
  // Обратная связь по контенту (docs/v2/36 §2)
  'content_issue.report', 'content_issue.view', 'content_issue.triage', 'content_issue.assign',
  'content_issue.rescore', 'content_issue.mute',
  // Делегирование проверки (docs/v2/37 §2)
  'review.delegate', 'review.delegate.any', 'review.routing.manage', 'review.workload.view',
  'review.absence.manage', 'time.metrics.view',
  // Расширения карточки человека (docs/v2/38 §2)
  'person.activity.view_others', 'person.note.read', 'person.note.write',
  'person.document.view_others', 'person.document.manage', 'person.absence.manage',
  'person.rating.view_others',
] as const

export type Scope = typeof SCOPES[number]

/**
 * Скоупы, которые есть только у владельца и которых нет у администратора (docs/01 §1.2,
 * `docs/v2/35-billing-limits.md` §2: «Суммы видит только он, `admin` — потребление и даты
 * [решение]: администратор обучения и подписант договора — разные люди»).
 *
 * Это и есть содержательная граница между ролями: администратор управляет системой,
 * владелец — деньгами и самим владением. Всё остальное `admin` умеет по-прежнему.
 */
export const OWNER_ONLY_SCOPES = ['billing.payments.view', 'billing.manage', 'tenant.transfer'] as const satisfies readonly Scope[]

/** Код системной роли владельца — один на тенант (частичный уникальный индекс `user_roles_single_owner_uq`). */
export const OWNER_ROLE_CODE = 'owner'

/**
 * Матрица docs/01-roles.md §1.4.
 *
 * Порядок ключей — порядок таблицы §1.2 (от узкой роли к широкой): им сортируется список
 * ролей на экране `/admin/settings/roles` и по нему же строится приоритет роли по умолчанию
 * (`server/services/activeRole.ts`).
 */
export const SYSTEM_ROLES: Record<string, { name: string, scopes: Scope[], defaultScopeType?: 'tenant' | 'org_unit' | 'location' }> = {
  employee: {
    name: 'Співробітник',
    scopes: ['learn.view', 'learn.catalog', 'learn.attempt', 'report.own', 'development.own', 'assessment.own', 'meetup.view', 'meetup.enroll', 'content_issue.report'],
  },
  mentor: {
    name: 'Наставник',
    scopes: [
      'learn.view', 'learn.catalog', 'learn.attempt', 'course.view', 'media.upload',
      'people.view', 'assignment.create', 'assignment.cancel',
      'review.queue', 'review.grade', 'certification.confirm',
      'report.own', 'report.team', 'development.own', 'development.team', 'assessment.own', 'checklist.run',
      'meetup.view', 'meetup.enroll', 'meetup.attendance', 'lifecycle.view', 'content_issue.report',
    ],
  },
  manager: {
    name: 'Керівник точки',
    scopes: [
      'learn.view', 'learn.catalog', 'learn.attempt', 'course.view', 'media.upload',
      'survey.manage', 'people.view', 'people.invite', 'people.edit', 'people.deactivate',
      'assignment.create', 'assignment.cancel',
      'review.queue', 'review.grade', 'certification.confirm',
      'report.own', 'report.team', 'report.export', 'development.own', 'development.team', 'request.decide',
      'assessment.own', 'assessment.team', 'assessment.run', 'checklist.run',
      'meetup.view', 'meetup.enroll', 'meetup.manage', 'meetup.attendance', 'webinar.manage', 'lifecycle.view',
      'content_issue.report',
      // PR-07: «Запустить офбординг» — керівник точки своей точки (`docs/v2/33` §2);
      // завершает офбординг только администратор (`offboarding.complete` остаётся у него).
      'offboarding.start',
    ],
  },
  author: {
    name: 'Методист',
    scopes: [
      'learn.view', 'learn.catalog', 'learn.attempt',
      'course.view', 'course.create', 'course.edit', 'course.publish', 'course.archive',
      'question.manage', 'media.upload', 'knowledge.manage', 'survey.manage',
      'people.view', 'people.invite', 'people.edit',
      'assignment.create', 'assignment.cancel',
      'review.queue', 'review.grade',
      'report.own', 'report.team', 'report.tenant', 'report.export',
      'development.own', 'development.team', 'development.manage', 'competency.manage', 'position_profile.manage',
      'assessment.own', 'assessment.run', 'assessment.manage', 'checklist.manage',
      'meetup.view', 'meetup.enroll', 'meetup.manage', 'webinar.manage', 'complextest.manage', 'wiki.edit', 'report.builder',
      'program.manage', 'program.publish', 'lifecycle.view',
      // Автор и сам жалуется на чужой материал (`v2/36` §2); очередь и разбор — PR-24
      'content_issue.report', 'content_issue.view',
    ],
  },
  admin: {
    name: 'Адміністратор',
    // Всё, кроме денег и владения (`OWNER_ONLY_SCOPES`): администратор ведёт систему,
    // но не меняет тариф, не видит сумм платежей и не распоряжается самим пространством.
    scopes: SCOPES.filter(s => !(OWNER_ONLY_SCOPES as readonly string[]).includes(s)),
  },
  /**
   * Власник (docs/01 §1.2, §1.4; `docs/v2/35` §2). **Не копия администратора и не надмножество
   * его прав, а другая роль.** Администратор управляет системой — курсами, людьми, настройками,
   * рассылками. Владелец распоряжается тем, что нельзя отдать наёмному администратору:
   *
   *  - деньги: тариф, аддоны, суммы и история платежей (`billing.*`, `docs/v2/35` §2, §5.3, §6.1–6.2);
   *  - владение: передать пространство другому человеку (`tenant.transfer`);
   *  - кто в пространстве главный: нанять и уволить администратора, раздать роли
   *    (`people.*`, `role.assign`) — иначе владелец не смог бы сменить администратора;
   *  - договор и контроль: бренд и домены (`settings.tenant`), журнал действий (`audit.view`),
   *    отчёты по всей сети, оргструктуру видит, но не правит.
   *
   * Чего у владельца нет: контента, назначений, проверки, рассылок, интеграций. Владелец,
   * который ведёт обучение сам (малая сеть), берёт **вторую роль** `admin` и переключается
   * между ними — ровно для этого и нужен переключатель ролей (docs/01 §1.9.2). Так сохраняется
   * смысл: у роли «Власник» ровно те права, которые никому не передают.
   *
   * Владелец в тенанте ровно один (§1.2): частичный уникальный индекс `user_roles_single_owner_uq`
   * плюс `server/services/owner.ts`. Снять с себя владение можно только передачей.
   */
  owner: {
    name: 'Власник',
    // Владение не бывает «на точке» (§1.2 «Область по умолчанию — сеть»): назначение всегда
    // на весь тенант. У остальных системных ролей область по умолчанию остаётся прежней —
    // расхождение §1.2 с умолчанием таблицы `roles` тянется с нулевой миграции и правится
    // не здесь.
    defaultScopeType: 'tenant',
    scopes: [
      // Учится как все и видит свои результаты
      'learn.view', 'learn.catalog', 'learn.attempt', 'report.own',
      // Нанимает и увольняет, в том числе администраторов, и раздаёт роли
      'people.view', 'people.invite', 'people.edit', 'people.deactivate', 'role.assign',
      'org.structure.view',
      // Владение и договор
      'tenant.transfer', 'settings.tenant',
      // Деньги: тариф, аддоны, суммы (docs/v2/35 §2)
      'billing.view', 'billing.usage.view', 'billing.payments.view', 'billing.manage',
      // Сколько места занято и по каким правилам оно чистится — счёт за хранение его
      'storage.view', 'storage.policy', 'storage.addon',
      // Контроль: журнал и отчёты по всей сети
      'audit.view', 'report.team', 'report.tenant', 'report.export',
    ],
  },
}
