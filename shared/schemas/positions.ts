import { z } from 'zod'

/**
 * Справочник должностей: группы (docs/v2/39 П-24.5) и курсы по умолчанию (П-24.3).
 * Курсы по умолчанию — правило автоматизации, привязанное к должности или группе
 * (`server/services/positionDefaults.ts`); отдельной таблицы у связи нет.
 */

export const defaultCourseItemSchema = z.object({
  courseId: z.string().uuid(),
  /** Срок в днях от найма или перевода — как у действия `assign_content` правила (1–365) */
  dueDays: z.number().int().min(1).max(365).default(14),
})
export type DefaultCourseItem = z.infer<typeof defaultCourseItemSchema>

/** PUT /positions/:id/default-courses, PUT /position-groups/:id/default-courses — список целиком. */
export const defaultCoursesSchema = z.object({
  items: z.array(defaultCourseItemSchema).max(10)
    .refine(list => new Set(list.map(i => i.courseId)).size === list.length, 'Курс уже є у списку'),
}).strict()
