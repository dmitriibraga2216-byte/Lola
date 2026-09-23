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
 * керівник точки ✓ своей точки»); `offboarding.complete` остаётся только у `admin`. Распределение по будущим ролям `recruiter`,
 * `hr`, `owner` — в PR, которые добавят соответствующие эндпоинты. Скоупы `platform.*` из `docs/v2/35-billing-limits.md` §2
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

/** Матрица docs/01-roles.md §1.4. */
export const SYSTEM_ROLES: Record<string, { name: string, scopes: Scope[] }> = {
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
    scopes: [...SCOPES],
  },
}
