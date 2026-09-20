import type postgres from 'postgres'

/**
 * Правило зачёта страницы (docs/11 Г-11.5): доскроллена до конца + время чтения.
 * Тестам, для которых урок — лишь ступень к тесту/программе, помогает эта «прочитка»:
 * факты прогресса выставляются напрямую в БД, как если бы ученик дочитал и досидел.
 */
export async function readThrough(admin: postgres.Sql, enrollmentId: string, lessonId: string, seconds = 600) {
  await admin`update lesson_progress set scroll_pct = 100, video_pct = 100, seconds_spent = greatest(seconds_spent, ${seconds}),
    first_opened_at = now() - interval '1 hour', last_tick_at = null
    where enrollment_id = ${enrollmentId} and lesson_id = ${lessonId}`
}

/** Сдвинуть время открытия урока назад — чтобы тик мог засчитать секунды (анти-накрутка: не больше реального интервала). */
export async function backdateOpen(admin: postgres.Sql, enrollmentId: string, lessonId: string, seconds: number) {
  await admin`update lesson_progress set first_opened_at = now() - make_interval(secs => ${seconds}), last_tick_at = null
    where enrollment_id = ${enrollmentId} and lesson_id = ${lessonId}`
}
