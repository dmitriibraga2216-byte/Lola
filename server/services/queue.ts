import { PgBoss } from 'pg-boss'

/**
 * Очередь pg-boss (docs/06 §6.3) на том же Postgres. Схему pgboss создаёт
 * административное подключение. Все задачи идемпотентны по singletonKey.
 */

let boss: PgBoss | undefined
let started: Promise<PgBoss> | undefined

export async function getBoss(): Promise<PgBoss> {
  if (!started) {
    boss = new PgBoss({ connectionString: process.env.DATABASE_ADMIN_URL })
    boss.on('error', (err: Error) => console.error('[pg-boss]', err))
    started = boss.start().then(async (b: PgBoss) => {
      // retryLimit=5 с экспонентой (docs/06 §6.3); в pg-boss 12 это свойство очереди
      await b.createQueue('media.process', { retryLimit: 5, retryBackoff: true, expireInSeconds: 600 })
      await b.createQueue('attempt.expire', { retryLimit: 3, expireInSeconds: 300 })
      await b.createQueue('notification.dispatch', { retryLimit: 3, expireInSeconds: 300 })
      await b.createQueue('due.scan', { retryLimit: 3, expireInSeconds: 900 })
      await b.createQueue('due.scan.tenant', { retryLimit: 3, expireInSeconds: 900 }) // docs/25 §5: due.scan → задача на тенант (в pg-boss имя без «:»)
      await b.createQueue('tenant.purge', { retryLimit: 3, retryBackoff: true, expireInSeconds: 3600 }) // docs/25 §8: удаление через 30 дней
      await b.createQueue('assignment.sync', { retryLimit: 3, expireInSeconds: 900 })
      await b.createQueue('assignment.expand', { retryLimit: 5, retryBackoff: true, expireInSeconds: 900 })
      await b.createQueue('workshop.sla_scan', { retryLimit: 3, expireInSeconds: 600 })
      await b.createQueue('meetup.scan', { retryLimit: 3, expireInSeconds: 600 })
      await b.createQueue('certificate.render_pdf', { retryLimit: 3, expireInSeconds: 120 })
      await b.createQueue('webhook.deliver', { retryLimit: 3, expireInSeconds: 300 })
      await b.createQueue('report.export', { retryLimit: 2, expireInSeconds: 600 }) // docs/22 §10
      await b.createQueue('trajectory.timer', { retryLimit: 5, retryBackoff: true, expireInSeconds: 300 }) // docs/17 §14.3: затримка / закриття доступу
      await b.createQueue('usage.collect', { retryLimit: 2, expireInSeconds: 600 }) // docs/24 §4.4.1: потребление раз в сутки
      await b.createQueue('billing.limit_scan', { retryLimit: 2, expireInSeconds: 600 }) // docs/v2/35 §11: поднимает и гасит limit_notices
      // docs/v2/28 §11: две ночные задачи воронки кандидатов (PR-14)
      await b.createQueue('candidate.auto_archive', { retryLimit: 2, expireInSeconds: 600 })
      await b.createQueue('candidate.consent_sweep', { retryLimit: 2, expireInSeconds: 900 })
      // docs/v2/29 §11: публичный контур вакансии (PR-16) — истечение неподтверждённых
      // откликов и уборка журнала попыток
      await b.createQueue('vacancy.application_expire', { retryLimit: 2, expireInSeconds: 600 })
      await b.createQueue('vacancy.attempts_gc', { retryLimit: 2, expireInSeconds: 600 })
      // docs/21 Г-21.1: автоотмена заказов магазина с истёкшим резервом (+ сверка книги бонусов)
      await b.createQueue('shop.reserve_expire', { retryLimit: 2, expireInSeconds: 600 })
      // docs/v2/36 §11 (PR-24): карточки неактивных ответственных — следующему по маршрутизации
      await b.createQueue('content_issue.reassign_scan', { retryLimit: 2, expireInSeconds: 600 })
      // docs/v2/37 §11: учёт времени биениями (PR-21) — закрытие зависших сегментов и свёртка
      await b.createQueue('time.close_stale_sessions', { retryLimit: 2, expireInSeconds: 300 })
      await b.createQueue('time.rollup', { retryLimit: 2, expireInSeconds: 900 })
      // docs/v2/37 §11 (PR-19): срок проверки, возврат просроченных делегирований, отсутствия,
      // перебалансировка и суточная статистика проверяющих
      await b.createQueue('review.sla_scan', { retryLimit: 3, expireInSeconds: 600 })
      await b.createQueue('review.delegation_expire', { retryLimit: 3, expireInSeconds: 600 })
      await b.createQueue('review.absence_apply', { retryLimit: 2, expireInSeconds: 900 })
      await b.createQueue('review.rebalance', { retryLimit: 2, expireInSeconds: 900 })
      await b.createQueue('review.stats_rollup', { retryLimit: 2, expireInSeconds: 900 })
      // docs/v2/31 §11 (PR-25): эмбеддинг тела последней версии модуля — по событию публикации;
      // ночная сверка usage_count и is_stale с фактом
      await b.createQueue('library.embedding_refresh', { retryLimit: 3, retryBackoff: true, expireInSeconds: 300 })
      await b.createQueue('library.usage_recalc', { retryLimit: 2, expireInSeconds: 900 })
      // docs/v2/31 §11 (PR-26): «Критичне виправлення» — по событию публикации версии с is_hotfix;
      // еженедельный дайджест устаревших ссылок авторам треков и курсов
      await b.createQueue('library.hotfix_propagate', { retryLimit: 3, retryBackoff: true, expireInSeconds: 600 })
      await b.createQueue('library.stale_digest', { retryLimit: 2, expireInSeconds: 900 })
      // docs/v2/38 §11: две ночные задачи карточки человека (PR-32)
      await b.createQueue('notes.archive_scan', { retryLimit: 2, expireInSeconds: 900 })
      await b.createQueue('documents.expiry_scan', { retryLimit: 2, expireInSeconds: 900 })
      // docs/v2/38 §11 (PR-33): сдвиг сроков обязательных назначений с дней отсутствия
      await b.createQueue('absence.deadline_guard', { retryLimit: 2, expireInSeconds: 900 })
      // docs/v2/38 §11 (PR-34): лента активности — уборка событий старше 400 дней и секунды дня
      // из сегментов учёта времени в суточный агрегат
      await b.createQueue('activity.purge', { retryLimit: 2, expireInSeconds: 900 })
      await b.createQueue('activity.aggregate', { retryLimit: 2, expireInSeconds: 900 })
      // docs/v2/38 §11 (PR-35): індекс залученості — полный пересчёт раз в сутки, партиями по 500
      await b.createQueue('rating.recalc', { retryLimit: 2, expireInSeconds: 1800 })
      // docs/v2/34 §11 (PR-36): корзина хранилища и отложенные загрузки
      await b.createQueue('storage.purge', { retryLimit: 2, expireInSeconds: 900 })
      await b.createQueue('storage.pending_upload_retry', { retryLimit: 2, expireInSeconds: 600 })
      // docs/v2/37 §11 (PR-22): нормы времени — факт, флаг отклонения, уведомление автору
      await b.createQueue('time.norms_recalc', { retryLimit: 2, expireInSeconds: 1800 })
      // docs/v2/29 §11 (PR-17): публикация и генерация текста. `vacancy.publish_retry` —
      // повтор временной ошибки адаптера (§7.16, 1/5/25 мин задаёт startAfter при отправке,
      // а не расписание очереди); `vacancy.publication_health` и `vacancy.spam_watch` — сканы.
      await b.createQueue('vacancy.publish_retry', { retryLimit: 1, expireInSeconds: 300 })
      await b.createQueue('vacancy.publication_health', { retryLimit: 2, expireInSeconds: 600 })
      await b.createQueue('vacancy.spam_watch', { retryLimit: 2, expireInSeconds: 300 })
      // docs/v2/32 §11 (PR-31): применение импорта оргструктуры по запуску. Без повторов: упавший
      // импорт закрывается `failed` с письмом инициатору, дерево не тронуто (одна транзакция), а
      // повтор того же файла — осознанное действие человека, не очереди
      await b.createQueue('org.import_apply', { retryLimit: 0, expireInSeconds: 1800 })
      // docs/v2/30 §11 (PR-27): журнал ИИ-вызовов — ссылка на вход 90 дней, строка 400 дней
      await b.createQueue('ai.calls_cleanup', { retryLimit: 2, expireInSeconds: 900 })
      // docs/v2/30 §11 (PR-28): собеседование. Расшифровка и оценка — по событию; повторы после
      // отказа провайдера ставит сам сервис с отсрочкой (5/30 мин и 1/5/30 мин, §7.10, §7.12),
      // поэтому у очереди своих повторов нет — иначе попыток было бы больше, чем обещано.
      // `interview.reap` — каждые 15 минут: сутки без активности → `abandoned`
      await b.createQueue('interview.transcribe', { retryLimit: 0, expireInSeconds: 600 })
      await b.createQueue('interview.score', { retryLimit: 0, expireInSeconds: 600 })
      await b.createQueue('interview.reap', { retryLimit: 2, expireInSeconds: 600 })
      // docs/v2/30 §11 (PR-29): голос не живёт дольше срока — ежедневно 03:40, до корзины
      // хранилища (storage.purge, 04:00), по всем тенантам. Упавшее удаление объекта — падение
      // задачи и повтор, а не тишина
      await b.createQueue('interview.media_purge', { retryLimit: 2, retryDelay: 600, expireInSeconds: 1800 })
      // Підсумок кандидата: сборка по событию (собеседование обработано), авто-отправка по сроку —
      // каждые 10 минут, истечение ссылок — 03:50
      await b.createQueue('summary.build', { retryLimit: 2, retryBackoff: true, expireInSeconds: 600 })
      await b.createQueue('summary.auto_send', { retryLimit: 1, expireInSeconds: 600 })
      await b.createQueue('summary.expire', { retryLimit: 2, expireInSeconds: 600 })
      // Подсказка проверяющему — по событию сдачи; строки ещё может не быть (транзакция сдачи не
      // зафиксирована) — повтор через 20 с. Качество ИИ: выборка 06:00, метрика 06:30
      await b.createQueue('ai.review_hint', { retryLimit: 3, retryDelay: 20, expireInSeconds: 600 })
      await b.createQueue('ai.quality_sample', { retryLimit: 2, expireInSeconds: 900 })
      await b.createQueue('ai.metrics_rollup', { retryLimit: 2, expireInSeconds: 900 })
      // Расписания docs/06 §6.3; singletonKey не даёт наплодить дублей
      await b.schedule('attempt.expire', '*/5 * * * *', {}, { singletonKey: 'attempt.expire' })
      await b.schedule('notification.dispatch', '* * * * *', {}, { singletonKey: 'notification.dispatch' })
      await b.schedule('due.scan', '0 8 * * *', {}, { singletonKey: 'due.scan', tz: 'Europe/Kyiv' })
      await b.schedule('assignment.sync', '0 * * * *', {}, { singletonKey: 'assignment.sync' })
      await b.schedule('workshop.sla_scan', '*/5 * * * *', {}, { singletonKey: 'workshop.sla_scan' })
      await b.schedule('meetup.scan', '*/5 * * * *', {}, { singletonKey: 'meetup.scan' })
      await b.schedule('webhook.deliver', '* * * * *', {}, { singletonKey: 'webhook.deliver' })
      // Раз в час: собирает тех, у кого по своей таймзоне наступило 00:00 и сегодня ещё не собирали (docs/24 §4.4.1 п. 2)
      await b.schedule('usage.collect', '5 * * * *', {}, { singletonKey: 'usage.collect' })
      // Ежечасно: поднимает и гасит limit_notices, шлёт limit_warning / limit_exceeded
      // с дедупликацией по оси (docs/v2/35 §11, §8; решение docs/v2/44 В-16)
      await b.schedule('billing.limit_scan', '15 * * * *', {}, { singletonKey: 'billing.limit_scan' })
      // Воронка кандидатов (docs/v2/28 §11): архивация отказанных в 03:00, стирание ПД по
      // истёкшему согласию в 03:20 — по времени Киева, как и остальные суточные сканы
      await b.schedule('candidate.auto_archive', '0 3 * * *', {}, { singletonKey: 'candidate.auto_archive', tz: 'Europe/Kyiv' })
      await b.schedule('candidate.consent_sweep', '20 3 * * *', {}, { singletonKey: 'candidate.consent_sweep', tz: 'Europe/Kyiv' })
      // Публичный контур вакансии (docs/v2/29 §11): ежечасно — отклик без подтверждённого
      // кода старше суток уходит в `expired` и освобождает место, в 03:40 — уборка журнала
      // попыток старше 30 дней
      await b.schedule('vacancy.application_expire', '10 * * * *', {}, { singletonKey: 'vacancy.application_expire' })
      await b.schedule('vacancy.attempts_gc', '40 3 * * *', {}, { singletonKey: 'vacancy.attempts_gc', tz: 'Europe/Kyiv' })
      // Резерв магазина (docs/21 Г-21.1) — ежечасно: срок считается часами от заказа, а не днями,
      // и суточный проход держал бы бонусы и остаток до 23 лишних часов
      await b.schedule('shop.reserve_expire', '25 * * * *', {}, { singletonKey: 'shop.reserve_expire' })
      // Жалобы на материал (docs/v2/36 §11): уволенный ответственный не держит очередь — раз в сутки
      await b.schedule('content_issue.reassign_scan', '50 3 * * *', {}, { singletonKey: 'content_issue.reassign_scan', tz: 'Europe/Kyiv' })
      // Учёт времени (docs/v2/37 §11): сегменты без биений > 120 с — `stale` каждые 5 минут;
      // свёртка каждые 10 минут по окну в 2 часа и раз в сутки — по окну в 48 часов, чтобы
      // догнать всё, что частые прогоны пропустили, пока задача не работала (Р-21.18)
      await b.schedule('time.close_stale_sessions', '*/5 * * * *', {}, { singletonKey: 'time.close_stale_sessions' })
      await b.schedule('time.rollup', '*/10 * * * *', { windowMinutes: 120 }, { singletonKey: 'time.rollup', key: 'frequent' })
      await b.schedule('time.rollup', '40 4 * * *', { windowMinutes: 2880 }, { singletonKey: 'time.rollup.daily', key: 'daily', tz: 'Europe/Kyiv' })
      // Очередь проверки (docs/v2/37 §11): пороги SLA ежечасно, возврат делегирований каждые
      // 15 минут, отсутствия в 06:00 (и сразу при создании записи), перебалансировка в 07:00,
      // статистика за прошедшие сутки в 03:00 — суточные по времени Киева
      await b.schedule('review.sla_scan', '10 * * * *', {}, { singletonKey: 'review.sla_scan' })
      await b.schedule('review.delegation_expire', '*/15 * * * *', {}, { singletonKey: 'review.delegation_expire' })
      await b.schedule('review.absence_apply', '0 6 * * *', {}, { singletonKey: 'review.absence_apply', tz: 'Europe/Kyiv' })
      await b.schedule('review.rebalance', '0 7 * * *', {}, { singletonKey: 'review.rebalance', tz: 'Europe/Kyiv' })
      await b.schedule('review.stats_rollup', '40 3 * * *', {}, { singletonKey: 'review.stats_rollup', tz: 'Europe/Kyiv' })
      // Библиотека модулей (docs/v2/31 §11): сверка мест использования ежедневно в 03:20;
      // дайджест устаревших ссылок — по понедельникам в 09:00 (по времени Киева, как остальные сканы)
      await b.schedule('library.usage_recalc', '20 3 * * *', {}, { singletonKey: 'library.usage_recalc', tz: 'Europe/Kyiv' })
      await b.schedule('library.stale_digest', '0 9 * * 1', {}, { singletonKey: 'library.stale_digest', tz: 'Europe/Kyiv' })
      // Карточка человека (docs/v2/38 §11): архив заметок в 02:00, сроки документов в 06:00
      await b.schedule('notes.archive_scan', '0 2 * * *', {}, { singletonKey: 'notes.archive_scan', tz: 'Europe/Kyiv' })
      await b.schedule('documents.expiry_scan', '0 6 * * *', {}, { singletonKey: 'documents.expiry_scan', tz: 'Europe/Kyiv' })
      // Сроки и отсутствия (docs/v2/38 §11): в 05:30 — раньше напоминаний due.scan (08:00), чтобы
      // сдвинутый срок успел лечь до них
      await b.schedule('absence.deadline_guard', '30 5 * * *', {}, { singletonKey: 'absence.deadline_guard', tz: 'Europe/Kyiv' })
      // Лента активности (docs/v2/38 §11): события старше 400 дней — в 03:00, агрегат при этом
      // не трогается (критерий 12). Секунды дня — ежечасно по окну в 2 часа и раз в сутки по окну
      // в 48 часов: второй проход и есть «финальный пересчёт дня» §7.10 — догоняет поздно
      // закрытые сегменты и то, что частые прогоны пропустили (тот же приём, что у time.rollup)
      await b.schedule('activity.purge', '0 3 * * *', {}, { singletonKey: 'activity.purge', tz: 'Europe/Kyiv' })
      await b.schedule('activity.aggregate', '25 * * * *', { windowMinutes: 120 }, { singletonKey: 'activity.aggregate', key: 'hourly' })
      await b.schedule('activity.aggregate', '50 4 * * *', { windowMinutes: 2880 }, { singletonKey: 'activity.aggregate.daily', key: 'daily', tz: 'Europe/Kyiv' })
      // Індекс залученості (docs/v2/38 §7.2, §11): раз в сутки целиком из первичных данных — записей
      // на курс и суточного агрегата ленты; инкрементальных доначислений нет
      await b.schedule('rating.recalc', '0 4 * * *', {}, { singletonKey: 'rating.recalc', tz: 'Europe/Kyiv' })
      // Хранилище (docs/v2/34 §11): корзина с истёкшим сроком — в purged в 04:00 (объект в S3
      // остаётся до решения владельца продукта, docs/v2/44 §8); отложенные загрузки — каждые 15 минут
      await b.schedule('storage.purge', '0 4 * * *', {}, { singletonKey: 'storage.purge', tz: 'Europe/Kyiv' })
      await b.schedule('storage.pending_upload_retry', '*/15 * * * *', {}, { singletonKey: 'storage.pending_upload_retry' })
      // Нормы времени (docs/v2/37 §11): еженедельно, в ночь на воскресенье — медиана факта, флаг
      // отклонения и уведомление автору. Свёртка идёт каждые 10 минут, витрина к этому часу свежая
      await b.schedule('time.norms_recalc', '30 2 * * 0', {}, { singletonKey: 'time.norms_recalc', tz: 'Europe/Kyiv' })
      // Публикация и генерация текста (docs/v2/29 §11, PR-17): здоровье активных аккаунтов —
      // раз в 30 мин (§11 vacancy.publication_health), всплеск блокировок — раз в 10 мин (§7.8)
      await b.schedule('vacancy.publication_health', '*/30 * * * *', {}, { singletonKey: 'vacancy.publication_health' })
      await b.schedule('vacancy.spam_watch', '*/10 * * * *', {}, { singletonKey: 'vacancy.spam_watch' })
      await b.schedule('ai.calls_cleanup', '10 4 * * *', {}, { singletonKey: 'ai.calls_cleanup', tz: 'Europe/Kyiv' })
      await b.schedule('interview.reap', '*/15 * * * *', {}, { singletonKey: 'interview.reap' })
      await b.schedule('interview.media_purge', '40 3 * * *', {}, { singletonKey: 'interview.media_purge', tz: 'Europe/Kyiv' })
      await b.schedule('summary.auto_send', '*/10 * * * *', {}, { singletonKey: 'summary.auto_send' })
      await b.schedule('summary.expire', '50 3 * * *', {}, { singletonKey: 'summary.expire', tz: 'Europe/Kyiv' })
      await b.schedule('ai.quality_sample', '0 6 * * *', {}, { singletonKey: 'ai.quality_sample', tz: 'Europe/Kyiv' })
      await b.schedule('ai.metrics_rollup', '30 6 * * *', {}, { singletonKey: 'ai.metrics_rollup', tz: 'Europe/Kyiv' })
      return b
    })
  }
  return started
}

export async function enqueueMediaProcess(tenantId: string, mediaId: string): Promise<void> {
  const b = await getBoss()
  await b.send('media.process', { tenantId, mediaId }, { singletonKey: mediaId })
}

export async function enqueueCertificatePdf(tenantId: string, certificateId: string): Promise<void> {
  const b = await getBoss()
  await b.send('certificate.render_pdf', { tenantId, certificateId }, { singletonKey: `pdf:${certificateId}` })
}

export async function enqueueExpand(tenantId: string, assignmentId: string): Promise<void> {
  const b = await getBoss()
  await b.send('assignment.expand', { tenantId, assignmentId }, { singletonKey: `expand:${assignmentId}` })
}

export async function enqueueReportExport(tenantId: string, exportId: string) {
  const b = await getBoss()
  await b.send('report.export', { tenantId, exportId }, { singletonKey: `export:${exportId}` })
}

/** Таймер узла траектории (delay / stop_delay): задача стартует в `at`; обработчик — trajectories.fireTimer. */
export async function enqueueTrajectoryTimer(tenantId: string, stateId: string, at: Date): Promise<void> {
  const b = await getBoss()
  await b.send('trajectory.timer', { tenantId, stateId }, { singletonKey: `trajectory:${stateId}`, startAfter: at })
}

/** Повтор публикации после временной ошибки адаптера (docs/v2/29 §7.16): 1/5/25 мин через `startAfter`. */
export async function enqueuePublishRetry(tenantId: string, publicationId: string, delaySec: number): Promise<void> {
  const b = await getBoss()
  await b.send('vacancy.publish_retry', { tenantId, publicationId }, { singletonKey: `publish_retry:${publicationId}`, startAfter: delaySec })
}
