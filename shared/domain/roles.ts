/**
 * Скоупы и системные роли (docs/01-roles.md §1.2–1.4).
 * Единый источник для сида, проверки прав и редактора ролей.
 */

export const SCOPES = [
  // Обучение (потребление)
  'learn.view', 'learn.catalog', 'learn.attempt',
  // Контент
  'course.view', 'course.create', 'course.edit', 'course.publish', 'course.archive',
  'question.manage', 'media.upload', 'media.delete', 'knowledge.manage', 'survey.manage',
  // Люди и назначения
  'people.view', 'people.invite', 'people.edit', 'people.deactivate', 'people.import',
  'assignment.create', 'assignment.cancel', 'role.assign',
  // Проверка
  'review.queue', 'review.grade', 'certification.confirm',
  // Отчёты
  'report.own', 'report.team', 'report.tenant', 'report.export',
  // Настройки
  'settings.tenant', 'settings.notifications', 'settings.integrations', 'audit.view',
  // Развитие (docs/19 §2)
  'development.own', 'development.team', 'development.manage', 'competency.manage', 'position_profile.manage', 'request.decide',
] as const

export type Scope = typeof SCOPES[number]

/** Матрица docs/01-roles.md §1.4. */
export const SYSTEM_ROLES: Record<string, { name: string, scopes: Scope[] }> = {
  employee: {
    name: 'Співробітник',
    scopes: ['learn.view', 'learn.catalog', 'learn.attempt', 'report.own', 'development.own'],
  },
  mentor: {
    name: 'Наставник',
    scopes: [
      'learn.view', 'learn.catalog', 'learn.attempt', 'course.view', 'media.upload',
      'people.view', 'assignment.create', 'assignment.cancel',
      'review.queue', 'review.grade', 'certification.confirm',
      'report.own', 'report.team', 'development.own', 'development.team',
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
    ],
  },
  admin: {
    name: 'Адміністратор',
    scopes: [...SCOPES],
  },
}
