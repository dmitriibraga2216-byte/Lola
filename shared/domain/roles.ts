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
  // Оценка и чек-листы (docs/20 §2)
  'assessment.own', 'assessment.team', 'assessment.run', 'assessment.manage', 'checklist.run', 'checklist.manage',
  // Очные занятия, вебинары, комплексные тесты (docs/18 §2)
  'meetup.view', 'meetup.enroll', 'meetup.manage', 'meetup.attendance', 'webinar.manage', 'complextest.manage',
  // Хаб (docs/03 §3.22, §3.26)
  'wiki.edit', 'report.builder',
  // Программы и траектории (docs/17 §2)
  'program.manage', 'program.publish', 'program.link_rule',
] as const

export type Scope = typeof SCOPES[number]

/** Матрица docs/01-roles.md §1.4. */
export const SYSTEM_ROLES: Record<string, { name: string, scopes: Scope[] }> = {
  employee: {
    name: 'Співробітник',
    scopes: ['learn.view', 'learn.catalog', 'learn.attempt', 'report.own', 'development.own', 'assessment.own', 'meetup.view', 'meetup.enroll'],
  },
  mentor: {
    name: 'Наставник',
    scopes: [
      'learn.view', 'learn.catalog', 'learn.attempt', 'course.view', 'media.upload',
      'people.view', 'assignment.create', 'assignment.cancel',
      'review.queue', 'review.grade', 'certification.confirm',
      'report.own', 'report.team', 'development.own', 'development.team', 'assessment.own', 'checklist.run',
      'meetup.view', 'meetup.enroll', 'meetup.attendance',
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
      'meetup.view', 'meetup.enroll', 'meetup.manage', 'meetup.attendance', 'webinar.manage',
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
      'program.manage', 'program.publish',
    ],
  },
  admin: {
    name: 'Адміністратор',
    scopes: [...SCOPES],
  },
}
