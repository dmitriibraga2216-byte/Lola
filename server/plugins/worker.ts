import { getBoss } from '../services/queue'
import { timedJob } from '../utils/metrics'
import { processMedia, type MediaProcessJob } from '../jobs/mediaProcess'
import { dueScanTenant } from '../jobs/dueScanTenant'
import { candidateAutoArchiveTenant, candidateConsentSweepTenant } from '../jobs/candidateScan'
import { vacancyApplicationExpireTenant, vacancyAttemptsGcTenant } from '../jobs/vacancyApplyScan'
import { shopReserveExpireTenant } from '../jobs/shopReserveExpire'
import { absenceBalanceScan, absenceDeadlineGuard, documentsExpiryScan, documentsMissingScan, notesArchiveScanTenant, notesSensitiveScreen } from '../jobs/personRecordsScan'
import {
  vacancyPublicationExpiryTenant, vacancyPublicationHealthTenant, vacancyRemoveExternalJob, vacancySpamWatchTenant,
  vacancyStatsRollupJob, vacancySubscriberNotifyJob,
} from '../jobs/vacancyPublish'
import { attemptPublish } from '../services/vacancyPublications'
import { expireStaleAttempts, tenantsWithActiveAttempts } from '../services/attempts'
import { dispatchNotifications, tenantsWithQueued } from '../services/notifications'
import { expandAssignment, syncAssignments } from '../services/assignments'
import { workshopSlaScan } from '../services/workshops'
import { deliverPending, tenantsWithPendingWebhooks } from '../services/webhooks'
import { ensureFirstAdmin } from '../services/platform'
import { recruitingTenantIds } from '../services/modules'
import { enqueueForTenant, runPerTenant, workByTenant } from '../services/tenantQueue'
import { activeTenantIds } from '../services/tenantResolve'

/**
 * Воркер фоновых задач внутри процесса приложения (dev и старт).
 * На проде выносится в отдельный контейнер `worker` (docs/26 §26.4) —
 * этот плагин выключается переменной WORKER_ENABLED=0.
 *
 * Изоляция по тенантам (docs/25 §5): задачи с сущностью несут `tenantId` и идут через `workByTenant`
 * (статус тенанта, лимит активных задач); сканы по расписанию раскладываются `runPerTenant` —
 * круг round-robin с квотой на тенанта, падение одного тенанта не трогает остальных, приостановленные пропускаются.
 * `due.scan` — планировщик: ставит `due.scan.tenant` на каждый работающий тенант.
 */
export default defineNitroPlugin(async () => {
  if (process.env.WORKER_ENABLED === '0') return

  await ensureFirstAdmin().catch(err => console.error('ensureFirstAdmin', err))

  try {
    const boss = await getBoss()
    // Каждая задача — с метриками длительности и результата (docs/06 §6.7)
    const work = <T = object>(name: string, fn: (jobs: { data: T }[]) => Promise<unknown>) =>
      boss.work<T>(name, jobs => timedJob(name, () => fn(jobs as { data: T }[])))
    const perTenant = <T extends { tenantId: string }>(name: string, fn: (data: T) => Promise<unknown>) =>
      workByTenant<T>(boss, name, fn, run => timedJob(name, run))

    await perTenant<MediaProcessJob>('media.process', data => processMedia(data))
    await perTenant<{ tenantId: string, exportId: string }>('report.export', async (data) => {
      const { runExport } = await import('../services/reportExports')
      await runExport(data.exportId, data.tenantId)
    })
    // PDF сертификата (docs/14 §7.5) — фоном после выдачи
    await perTenant<{ tenantId: string, certificateId: string }>('certificate.render_pdf', async (data) => {
      const { renderAndStore } = await import('../services/certificatePdf')
      await renderAndStore(data.tenantId, data.certificateId)
    })
    await perTenant<{ tenantId: string, stateId: string }>('trajectory.timer', async (data) => {
      const { fireTimer } = await import('../services/trajectories')
      await fireTimer(data.tenantId, data.stateId)
    })
    await perTenant<{ tenantId: string, assignmentId: string }>('assignment.expand', data => expandAssignment(data.tenantId, data.assignmentId))
    // docs/v2/32 §11 `org.import_apply` (PR-31): импорт оргструктуры — весь файл одной транзакцией
    await perTenant<{ tenantId: string, jobId: string }>('org.import_apply', async (data) => {
      const { applyOrgImport } = await import('../services/orgImport')
      const r = await applyOrgImport(data.tenantId, data.jobId)
      if (r) console.log(`[org.import_apply] ${data.tenantId}:`, r)
    })
    // Удаление тенанта через 30 дней после команды оператора (docs/25 §8); обработчик сам проверяет срок и статус
    await work<{ tenantId: string }>('tenant.purge', async (jobs) => {
      const { runTenantPurge } = await import('../services/platformTenants')
      for (const j of jobs) {
        const r = await runTenantPurge(j.data.tenantId)
        console.log(`[tenant.purge] ${j.data.tenantId}:`, r.purged ? r.report : r.reason)
      }
    })

    await work('attempt.expire', () => runPerTenant('attempt.expire', async (tenantId) => {
      const s = await expireStaleAttempts(tenantId)
      // docs/12 §7 п. 8: опоздавшие больше чем на сутки закрываются без уведомлений и вебхуков
      if (s.closed) console.log(`[attempt.expire] ${tenantId}: закрыто ${s.closed}, из них тихо ${s.quiet}`)
    }, tenantsWithActiveAttempts))
    // docs/25 §14 п. 8: квота на тенанта за круг — 5000 уведомлений одного не задерживают 5 другого
    await work('notification.dispatch', () => runPerTenant('notification.dispatch', async (tenantId, quota) => {
      const s = await dispatchNotifications(tenantId, quota)
      if (s.sent || s.failed) console.log(`[notification.dispatch] ${tenantId}:`, s)
    }, tenantsWithQueued))
    await work('usage.collect', async () => {
      const { collectUsageDue } = await import('../services/usage')
      const n = await collectUsageDue()
      if (n) console.log(`[usage.collect] собрано: ${n}`)
    })
    // docs/v2/35 §11: ежечасно поднимает и гасит limit_notices по всем одиннадцати осям —
    // в том числе гасит те, где место освободилось и операциями оси никто не трогает
    await work('billing.limit_scan', async () => {
      const { limitScanAll } = await import('../services/limitNotices')
      const n = await limitScanAll()
      if (n) console.log(`[billing.limit_scan] поднято предупреждений: ${n}`)
    })
    // docs/v2/35 §11, §13 к. 5: `paid_until` прошёл — grace, `grace_until` прошёл — только чтение.
    // Даты ведёт оператор вручную (решение по вопросу 17, docs/v2/44 В-21), статус опускается сам
    await work('billing.grace_scan', () => runPerTenant('billing.grace_scan', async (tenantId) => {
      const { graceScan } = await import('../services/subscriptionStatus')
      const steps = await graceScan(tenantId)
      if (steps.length) console.log(`[billing.grace_scan] ${tenantId}:`, steps.map(s => `${s.from}→${s.to}`).join(', '))
    }))
    // docs/v2/35 §11, §7.6: назначенный переход вниз — с первого дня нового периода; `blocked` старше 30 дней — отмена
    await work('billing.plan_change_apply', () => runPerTenant('billing.plan_change_apply', async (tenantId) => {
      const { applyScheduledPlanChanges } = await import('../services/planChange')
      const r = await applyScheduledPlanChanges(tenantId)
      if (r.applied || r.blocked || r.expired) console.log(`[billing.plan_change_apply] ${tenantId}:`, r)
    }))
    // docs/v2/28 §11: воронка кандидатов — только у тенантов с включённым рекрутингом
    // (`tenants.candidates_enabled`). Круг строится по ним, а не по всем активным: у
    // остальных кандидатов нет вовсе, и проход по ним — пустая работа каждую ночь.
    await work('candidate.auto_archive', () => runPerTenant('candidate.auto_archive', async (tenantId) => {
      const n = await candidateAutoArchiveTenant(tenantId)
      if (n) console.log(`[candidate.auto_archive] ${tenantId}: заархивировано ${n}`)
    }, recruitingTenantIds))
    await work('candidate.consent_sweep', () => runPerTenant('candidate.consent_sweep', async (tenantId) => {
      const s = await candidateConsentSweepTenant(tenantId)
      if (s.erased || s.warned || s.stale) console.log(`[candidate.consent_sweep] ${tenantId}:`, s)
    }, recruitingTenantIds))
    // docs/v2/29 §11 (PR-16): публичный контур вакансии. Круг — тенанты с включённым
    // рекрутингом: у остальных вакансий нет вовсе, и проход по ним — пустая работа.
    await work('vacancy.application_expire', () => runPerTenant('vacancy.application_expire', async (tenantId) => {
      const n = await vacancyApplicationExpireTenant(tenantId)
      if (n) console.log(`[vacancy.application_expire] ${tenantId}: прострочено ${n}`)
    }, recruitingTenantIds))
    await work('vacancy.attempts_gc', () => runPerTenant('vacancy.attempts_gc', async (tenantId) => {
      const n = await vacancyAttemptsGcTenant(tenantId)
      if (n) console.log(`[vacancy.attempts_gc] ${tenantId}: прибрано ${n}`)
    }, recruitingTenantIds))
    // docs/21 Г-21.1: автоотмена просроченного резерва магазина с возвратом бонусов и остатка
    await work('shop.reserve_expire', () => runPerTenant('shop.reserve_expire', async (tenantId) => {
      const s = await shopReserveExpireTenant(tenantId)
      if (s.expired || s.drift) console.log(`[shop.reserve_expire] ${tenantId}:`, s)
    }))
    // docs/v2/31 §11: эмбеддинг тела последней версии — после публикации версии (батч 20;
    // без moduleId — все модули с пустым вектором или вектором другой модели)
    await perTenant<{ tenantId: string, moduleId?: string }>('library.embedding_refresh', async (data) => {
      const { refreshLibraryEmbeddings } = await import('../services/library')
      await refreshLibraryEmbeddings(data.tenantId, data.moduleId ? [data.moduleId] : undefined)
    })
    await work('library.usage_recalc', () => runPerTenant('library.usage_recalc', async (tenantId) => {
      const { usageRecalc } = await import('../services/libraryUsages')
      const s = await usageRecalc(tenantId)
      if (s.detached || s.staleFixed || s.countsFixed) console.log(`[library.usage_recalc] ${tenantId}:`, s)
    }))
    // docs/v2/31 §7.4, §11 (PR-26): «Критичне виправлення» — места с hotfix_auto без людей в
    // процессе переключаются на хотфикс, авторам — library_hotfix_applied / library_hotfix_blocked
    await perTenant<{ tenantId: string, moduleId: string, versionId: string }>('library.hotfix_propagate', async (data) => {
      const { propagateHotfix } = await import('../services/libraryUsages')
      const s = await propagateHotfix(data.tenantId, data.moduleId, data.versionId)
      if (s.applied || s.blocked) console.log(`[library.hotfix_propagate] ${data.tenantId}:`, s)
    })
    await work('library.stale_digest', () => runPerTenant('library.stale_digest', async (tenantId) => {
      const { staleDigest } = await import('../services/libraryUsages')
      const s = await staleDigest(tenantId)
      if (s.authors) console.log(`[library.stale_digest] ${tenantId}:`, s)
    }))
    // docs/v2/31 §11: следы оборванных транзакций (только отчёт) и вывод из оборота версий,
    // которые никто не закрепляет дольше 90 дней
    await work('library.orphan_scan', () => runPerTenant('library.orphan_scan', async (tenantId) => {
      const { libraryOrphanScan } = await import('../services/libraryReports')
      const r = await libraryOrphanScan(tenantId)
      if (r.found) console.log(`[library.orphan_scan] ${tenantId}: знайдено ${r.found}`)
    }))
    await work('library.version_retire', () => runPerTenant('library.version_retire', async (tenantId) => {
      const { libraryVersionRetire } = await import('../services/libraryReports')
      const r = await libraryVersionRetire(tenantId)
      if (r.retired) console.log(`[library.version_retire] ${tenantId}: виведено ${r.retired}`)
    }))
    // docs/v2/38 §11: карточка человека — архив заметок по сроку хранения (§7.6) и сроки
    // документов с уведомлениями человеку, руководителю точки и HR (§4, §8)
    await work('notes.archive_scan', () => runPerTenant('notes.archive_scan', async (tenantId) => {
      const n = await notesArchiveScanTenant(tenantId)
      if (n) console.log(`[notes.archive_scan] ${tenantId}: в архиве ${n}`)
    }))
    await work('documents.expiry_scan', () => runPerTenant('documents.expiry_scan', async (tenantId) => {
      const s = await documentsExpiryScan(tenantId)
      if (s.expiring || s.expired || s.notified) console.log(`[documents.expiry_scan] ${tenantId}:`, s)
    }))
    // docs/v2/38 §7.14, §11 (PR-33): срок обязательного назначения не стоит на днях отсутствия
    await work('absence.deadline_guard', () => runPerTenant('absence.deadline_guard', async (tenantId) => {
      const n = await absenceDeadlineGuard(tenantId)
      if (n) console.log(`[absence.deadline_guard] ${tenantId}: перенесено строків ${n}`)
    }))
    // docs/v2/38 §8, §11 (person-card-tails): отрицательный остаток отсутствий, недостающие
    // обязательные документы, еженедельная переборка заметок по словарю скрина §7.5
    await work('absence.balance_scan', () => runPerTenant('absence.balance_scan', async (tenantId) => {
      const s = await absenceBalanceScan(tenantId)
      if (s.negative) console.log(`[absence.balance_scan] ${tenantId}:`, s)
    }))
    await work('documents.missing_scan', () => runPerTenant('documents.missing_scan', async (tenantId) => {
      const s = await documentsMissingScan(tenantId)
      if (s.missing) console.log(`[documents.missing_scan] ${tenantId}:`, s)
    }))
    await work('notes.sensitive_screen', () => runPerTenant('notes.sensitive_screen', async (tenantId) => {
      const s = await notesSensitiveScreen(tenantId)
      if (s.flagged) console.log(`[notes.sensitive_screen] ${tenantId}:`, s)
    }))
    // docs/v2/38 §11 (PR-34): лента активности. Круг — по всем работающим тенантам
    // (`activeTenantIds`, таблица tenants без RLS), каждый тенант — внутри withTenant()
    await work('activity.purge', () => runPerTenant('activity.purge', async (tenantId) => {
      const { purgeActivity } = await import('../services/activity')
      const n = await purgeActivity(tenantId)
      if (n) console.log(`[activity.purge] ${tenantId}: удалено ${n}`)
    }))
    await work<{ windowMinutes?: number }>('activity.aggregate', jobs => runPerTenant('activity.aggregate', async (tenantId) => {
      const { aggregateActivitySeconds } = await import('../services/activity')
      const s = await aggregateActivitySeconds(tenantId, { windowMinutes: jobs[0]?.data?.windowMinutes })
      if (s.days) console.log(`[activity.aggregate] ${tenantId}: дней ${s.days}`)
    }))
    // docs/v2/38 §7.2, §11 (PR-35): індекс залученості — полный пересчёт тенанта партиями по 500,
    // каждая партия — своя транзакция withTenant(); уволенным значение не пересчитывается
    await work('rating.recalc', () => runPerTenant('rating.recalc', async (tenantId) => {
      const { recalcTenantEngagement } = await import('../services/engagementIndex')
      const s = await recalcTenantEngagement(tenantId)
      if (s.people) console.log(`[rating.recalc] ${tenantId}:`, s)
    }))
    // docs/v2/38 §7.2 (person-card-tails): ретро-расчёт — по запуску администратора, один тенант
    await perTenant<{ tenantId: string }>('rating.backfill', async (data) => {
      const { backfillTenantEngagement } = await import('../services/engagementIndex')
      console.log(`[rating.backfill] ${data.tenantId}:`, await backfillTenantEngagement(data.tenantId))
    })
    // docs/v2/29 §11 (PR-17): публикация и генерация текста. Ретрай — по событию на строку
    // публикации (`enqueuePublishRetry`), здоровье аккаунтов и всплеск — сканы по тенантам.
    await perTenant<{ tenantId: string, publicationId: string }>('vacancy.publish_retry', data => attemptPublish(data.tenantId, data.publicationId))
    await work('vacancy.publication_health', () => runPerTenant('vacancy.publication_health', async (tenantId) => {
      const n = await vacancyPublicationHealthTenant(tenantId)
      if (n) console.log(`[vacancy.publication_health] ${tenantId}: перевірено акаунтів ${n}`)
    }, recruitingTenantIds))
    await work('vacancy.spam_watch', () => runPerTenant('vacancy.spam_watch', async (tenantId) => {
      const n = await vacancySpamWatchTenant(tenantId)
      if (n) console.log(`[vacancy.spam_watch] ${tenantId}: посилено вакансій ${n}`)
    }, recruitingTenantIds))
    // docs/v2/44 §18 (cross-cutting-tails): объявление платформы — одна задача на публикацию,
    // рассылка кругом по работающим тенантам, адресацию проверяет каждый тенант своим withTenant()
    await work<{ announcementId: string }>('platform_announcement.notify', async (jobs) => {
      const { notifyAnnouncementTenant } = await import('../services/platformAnnouncements')
      for (const j of jobs) await runPerTenant('platform_announcement.notify', tenantId => notifyAnnouncementTenant(tenantId, j.data.announcementId))
    })
    await work('oauth.states_cleanup', () => runPerTenant('oauth.states_cleanup', async (tenantId) => {
      const { cleanupStates } = await import('../services/oauth')
      const n = await cleanupStates(tenantId)
      if (n) console.log(`[oauth.states_cleanup] ${tenantId}: видалено ${n}`)
    }))
    await work('idempotency.purge', () => runPerTenant('idempotency.purge', async (tenantId) => {
      const { purgeIdempotencyKeys } = await import('../services/idempotency')
      const n = await purgeIdempotencyKeys(tenantId)
      if (n) console.log(`[idempotency.purge] ${tenantId}: видалено ${n}`)
    }))
    // docs/v2/29 §11 (vacancies-tails): снятие с площадок и письма подписавшимся — по событию
    // на вакансию; срок объявлений и свёртка публичной страницы — сканы по тенантам рекрутинга.
    await perTenant<{ tenantId: string, vacancyId: string }>('vacancy.remove_external', async (data) => {
      const r = await vacancyRemoveExternalJob(data.tenantId, data.vacancyId)
      if (r.removed) console.log(`[vacancy.remove_external] ${data.tenantId}: знято ${r.removed}`)
    })
    await perTenant<{ tenantId: string, vacancyId: string }>('vacancy.subscriber_notify', async (data) => {
      const r = await vacancySubscriberNotifyJob(data.tenantId, data.vacancyId)
      if (r.sent || r.skipped) console.log(`[vacancy.subscriber_notify] ${data.tenantId}:`, r)
    })
    await work('vacancy.publication_expiry', () => runPerTenant('vacancy.publication_expiry', async (tenantId) => {
      const r = await vacancyPublicationExpiryTenant(tenantId)
      if (r.expired || r.warned) console.log(`[vacancy.publication_expiry] ${tenantId}:`, r)
    }, recruitingTenantIds))
    await work('vacancy.stats_rollup', () => runPerTenant('vacancy.stats_rollup', async (tenantId) => {
      await vacancyStatsRollupJob(tenantId)
    }, recruitingTenantIds))
    // docs/v2/30 §11 (PR-27): журнал ИИ-вызовов — ссылка на вход в S3 живёт 90 дней, строка — 400
    await work('ai.calls_cleanup', () => runPerTenant('ai.calls_cleanup', async (tenantId) => {
      const { aiCallsCleanup } = await import('../services/ai/calls')
      const r = await aiCallsCleanup(tenantId)
      if (r.rows || r.inputRefs) console.log(`[ai.calls_cleanup] ${tenantId}: рядків ${r.rows}, посилань на вхід ${r.inputRefs}`)
    }))
    // docs/v2/30 §11 (PR-28): ИИ-собеседование — расшифровка реплики и оценка сессии по событию
    // (задача несёт tenantId, обработчик открывает withTenant сам), брошенные сессии — круг по
    // тенантам с включённым рекрутингом: у остальных собеседований нет
    await perTenant<{ tenantId: string, turnId: string, tryNo?: number }>('interview.transcribe', async (data) => {
      const { transcribeTurn } = await import('../services/interview/pipeline')
      await transcribeTurn(data.tenantId, data.turnId, data.tryNo ?? 1)
    })
    await perTenant<{ tenantId: string, sessionId: string, tryNo?: number }>('interview.score', async (data) => {
      const { scoreSession } = await import('../services/interview/pipeline')
      await scoreSession(data.tenantId, data.sessionId, data.tryNo ?? 1)
    })
    await work('interview.reap', () => runPerTenant('interview.reap', async (tenantId) => {
      const { reapSessions } = await import('../services/interview/pipeline')
      const r = await reapSessions(tenantId)
      if (r.abandoned) console.log(`[interview.reap] ${tenantId}: брошено ${r.abandoned}`)
    }, recruitingTenantIds))
    // docs/v2/30 §7.7, §11 (PR-29): голос не живёт дольше срока. Обход — **все** тенанты, и
    // приостановленные тоже: срок записи — обещание кандидату, а не политика хранения тенанта
    // (`allTenantIds`), поэтому не `runPerTenant`, который их пропускает. Каждый тенант — своя
    // транзакция withTenant(); неудача удаления объекта одного тенанта не держит остальных, но
    // в конце круга задача падает и уходит в повтор — ошибка S3 не глушится
    await work('interview.media_purge', async () => {
      const { interviewMediaPurge } = await import('../services/interview/mediaPurge')
      const { allTenantIds } = await import('../services/tenantResolve')
      const failed: string[] = []
      for (const tenantId of await allTenantIds()) {
        try {
          const r = await interviewMediaPurge(tenantId)
          if (r.termed || r.purged) console.log(`[interview.media_purge] ${tenantId}: строк ${r.termed}, видалено ${r.purged}`)
        }
        catch (err) {
          console.error(`[interview.media_purge] ${tenantId}:`, err)
          failed.push(tenantId)
        }
      }
      if (failed.length) throw new Error(`interview.media_purge: не видалено голос у ${failed.length} тенант(ах): ${failed.join(', ')}`)
    })
    // Підсумок кандидата (docs/v2/30 §11, PR-29): сборка по событию, авто-отправка и истечение — кругами
    await perTenant<{ tenantId: string, candidateId: string }>('summary.build', async (data) => {
      const { buildOnInterviewDone } = await import('../services/candidateSummaries')
      await buildOnInterviewDone(data.tenantId, data.candidateId)
    })
    await work('summary.auto_send', () => runPerTenant('summary.auto_send', async (tenantId) => {
      const { summaryAutoSendScan } = await import('../services/candidateSummaries')
      const r = await summaryAutoSendScan(tenantId)
      if (r.built || r.scheduled || r.sent || r.skipped.length) console.log(`[summary.auto_send] ${tenantId}:`, r)
    }, recruitingTenantIds))
    await work('summary.expire', () => runPerTenant('summary.expire', async (tenantId) => {
      const { summaryExpire } = await import('../services/candidateSummaries')
      const n = await summaryExpire(tenantId)
      if (n) console.log(`[summary.expire] ${tenantId}: закінчилось посилань ${n}`)
    }))
    // Подсказка проверяющему (docs/v2/30 §7.13): строки ещё нет — транзакция сдачи не
    // зафиксирована или откатилась; исключение отдаёт задачу в повтор очереди
    await perTenant<{ tenantId: string, hintId: string }>('ai.review_hint', async (data) => {
      const { buildReviewHint } = await import('../services/reviewHints')
      const r = await buildReviewHint(data.tenantId, data.hintId)
      if (r === 'missing') throw new Error(`ai.review_hint: підказки ${data.hintId} ще немає`)
    })
    // Качество ИИ (docs/v2/30 §7.16, §11): ежедневная выборка и метрика расхождения
    await work('ai.quality_sample', () => runPerTenant('ai.quality_sample', async (tenantId) => {
      const { sampleQuality } = await import('../services/aiQuality')
      const r = await sampleQuality(tenantId)
      if (r.scores || r.hints) console.log(`[ai.quality_sample] ${tenantId}:`, r)
    }))
    await work('ai.metrics_rollup', () => runPerTenant('ai.metrics_rollup', async (tenantId) => {
      const { qualityRollup } = await import('../services/aiQuality')
      const r = await qualityRollup(tenantId)
      if (r.some(m => m.degraded)) console.log(`[ai.metrics_rollup] ${tenantId}:`, r.filter(m => m.degraded))
    }))
    // Планировщик: due.scan → N задач due.scan.tenant (docs/25 §5), одна на тенанта в день
    await work('due.scan', async () => {
      const day = new Date().toISOString().slice(0, 10)
      for (const tenantId of await activeTenantIds()) {
        await enqueueForTenant('due.scan.tenant', tenantId, { day }, { singletonKey: `due.scan:${tenantId}:${day}` })
      }
    })
    await perTenant<{ tenantId: string, day: string }>('due.scan.tenant', data => dueScanTenant(data.tenantId))
    // Сводные отчёты по расписанию (docs/03 §3.26) — проверка раз в час вместе с assignment.sync
    await work('assignment.sync', async () => {
      const { scheduledReportsScan } = await import('../services/reportBuilder')
      const { recalcGroups } = await import('../services/groups')
      const { escalationScan } = await import('../services/notifications')
      const { telegramHealth } = await import('../services/telegram')
      const { trajectoryScan } = await import('../services/trajectories')
      await telegramHealth() // docs/23 §10 telegram.health
      await runPerTenant('assignment.sync', async (tenantId) => {
        const n = await scheduledReportsScan(tenantId)
        if (n) console.log(`[report.scheduled] ${tenantId}: ${n}`)
        const g = await recalcGroups(tenantId) // docs/16 §11 groups.recalc — до раскрытия аудиторий
        const esc = await escalationScan(tenantId) // docs/23 §6.6 notification.escalate
        if (esc) console.log(`[notification.escalate] ${tenantId}: ${esc}`)
        if (g) console.log(`[groups.recalc] ${tenantId}: ${g}`)
        const s = await syncAssignments(tenantId)
        if (s) console.log(`[assignment.sync] ${tenantId}: +${s}`)
        // docs/33 D-026: подстраховка таймеров pg-boss траєкторій раз на добу давала запізнення до доби —
        // переведено на щогодинний скан разом з іншими assignment.sync-завданнями
        const tr = await trajectoryScan(tenantId)
        if (tr.opened || tr.fired) console.log(`[trajectory.scan] ${tenantId}:`, tr)
      })
    })
    // Занятия (docs/18 §11): статусы planned→ongoing→finished, неявки, напоминания за сутки/час.
    // docs/33 D-029: картки без сесій (kind=event, немігровані) веде meetups.ts; картки з сесіями — meetupSessions.ts
    await work('meetup.scan', async () => {
      const { reminderScan, statusScan } = await import('../services/meetups')
      const { reminderScan: sessionReminderScan, statusScan: sessionStatusScan } = await import('../services/meetupSessions')
      const { publishScan } = await import('../services/news')
      await runPerTenant('meetup.scan', async (tenantId) => {
        const p = await publishScan(tenantId) // docs/21 §11
        if (p.published || p.unpublished) console.log(`[news.publish_scan] ${tenantId}:`, p)
        const s = await statusScan(tenantId)
        const r = await reminderScan(tenantId)
        if (s.started || s.finished || r) console.log(`[meetup.scan] ${tenantId}:`, { ...s, reminded: r })
        const ss = await sessionStatusScan(tenantId)
        const sr = await sessionReminderScan(tenantId)
        if (ss.started || ss.finished || sr) console.log(`[meetup_session.scan] ${tenantId}:`, { ...ss, reminded: sr })
      })
    })
    // Учёт времени биениями (docs/v2/37 §11, PR-21). Круг — по всем работающим тенантам
    // (`activeTenantIds`, таблица tenants без RLS): выборка «тенанты с открытыми сегментами»
    // вне withTenant под app_user вернула бы пусто — RLS не видит строк без контекста тенанта.
    await work('time.close_stale_sessions', () => runPerTenant('time.close_stale_sessions', async (tenantId) => {
      const { closeStaleSessions } = await import('../services/learningTime')
      const n = await closeStaleSessions(tenantId)
      if (n) console.log(`[time.close_stale_sessions] ${tenantId}: закрыто ${n}`)
    }))
    await work<{ windowMinutes?: number }>('time.rollup', jobs => runPerTenant('time.rollup', async (tenantId) => {
      const { rollupTenant } = await import('../services/learningTimeRollup')
      const s = await rollupTenant(tenantId, { windowMinutes: jobs[0]?.data?.windowMinutes })
      if (s.totals || s.lessonProgress || s.attempts || s.submissions || s.queueItems) console.log(`[time.rollup] ${tenantId}:`, s)
    }))
    // Уборка сегментов старше 400 дней (docs/v2/37 §11, Р-T1): суммы переносятся в витрину,
    // ни одна посчитанная цифра не меняется; круг — по `activeTenantIds`, как у свёртки
    await work('time.purge_sessions', () => runPerTenant('time.purge_sessions', async (tenantId) => {
      const { purgeLearningTimeSessions } = await import('../services/learningTimeRollup')
      const s = await purgeLearningTimeSessions(tenantId)
      if (s.segments) console.log(`[time.purge_sessions] ${tenantId}:`, s)
    }))
    // Нормы времени (docs/v2/37 §11, PR-22): тот же круг по `activeTenantIds` — выборка
    // «тенанты с нормами» вне withTenant под app_user вернула бы пусто (RLS)
    await work('time.norms_recalc', () => runPerTenant('time.norms_recalc', async (tenantId) => {
      const { recalcNorms } = await import('../services/timeNorms')
      const s = await recalcNorms(tenantId)
      if (s.written || s.notified) console.log(`[time.norms_recalc] ${tenantId}:`, s)
    }))
    await work('workshop.sla_scan', () => runPerTenant('workshop.sla_scan', async (tenantId) => {
      const s = await workshopSlaScan(tenantId)
      if (s.released || s.breached || s.expired) console.log(`[workshop.sla_scan] ${tenantId}:`, s)
    }))
    // docs/v2/36 §11 `content_issue.reassign_scan`: открытые жалобы уволенного или
    // заблокированного ответственного уходят следующему по маршрутизации §7.5
    await work('content_issue.reassign_scan', () => runPerTenant('content_issue.reassign_scan', async (tenantId) => {
      const { reassignScan } = await import('../services/contentIssueRouting')
      const n = await reassignScan(tenantId)
      if (n) console.log(`[content_issue.reassign_scan] ${tenantId}: переназначено ${n}`)
    }))
    // docs/v2/36 §7.6, §11 `content_issue.sla_scan`: просрочка 1/3/7 дней и переназначение
    await work('content_issue.sla_scan', () => runPerTenant('content_issue.sla_scan', async (tenantId) => {
      const { contentIssueSlaScan } = await import('../services/contentIssueSla')
      const s = await contentIssueSlaScan(tenantId)
      if (s.reminded || s.escalated || s.reassigned) console.log(`[content_issue.sla_scan] ${tenantId}:`, s)
    }))
    // Очередь проверки (docs/v2/37 §11, PR-19). Каждая задача — круг по тенантам: падение
    // одного не трогает остальных, приостановленные пропускаются.
    await work('review.sla_scan', () => runPerTenant('review.sla_scan', async (tenantId) => {
      const { reviewSlaScan } = await import('../services/reviewSla')
      const s = await reviewSlaScan(tenantId)
      if (s.warned || s.breached || s.escalated) console.log(`[review.sla_scan] ${tenantId}:`, s)
    }))
    await work('review.delegation_expire', () => runPerTenant('review.delegation_expire', async (tenantId) => {
      const { expireDelegations } = await import('../services/reviewDelegation')
      const n = await expireDelegations(tenantId)
      if (n) console.log(`[review.delegation_expire] ${tenantId}: повернуто ${n}`)
    }))
    await work('review.absence_apply', () => runPerTenant('review.absence_apply', async (tenantId) => {
      const { applyAbsences } = await import('../services/reviewWorkload')
      const n = await applyAbsences(tenantId)
      if (n) console.log(`[review.absence_apply] ${tenantId}: перекинуто ${n}`)
    }))
    await work('review.rebalance', () => runPerTenant('review.rebalance', async (tenantId) => {
      const { rebalanceTenant } = await import('../services/reviewRouting')
      const n = await rebalanceTenant(tenantId)
      if (n) console.log(`[review.rebalance] ${tenantId}: призначено ${n}`)
    }))
    await work('review.stats_rollup', () => runPerTenant('review.stats_rollup', async (tenantId) => {
      const { reviewStatsRollup } = await import('../services/reviewSla')
      await reviewStatsRollup(tenantId)
    }))
    // Хранилище (docs/v2/34 §11, PR-36). Приостановленные тенанты пропускает сам круг
    // runPerTenant — у клиента, который не может возразить, данные не чистятся (§12).
    await work('storage.purge', () => runPerTenant('storage.purge', async (tenantId) => {
      const { purgeDue } = await import('../services/storage')
      const r = await purgeDue(tenantId)
      if (r.purged) console.log(`[storage.purge] ${tenantId}:`, r)
    }))
    await work('storage.pending_upload_retry', () => runPerTenant('storage.pending_upload_retry', async (tenantId) => {
      const { pendingUploadRetry } = await import('../services/storagePending')
      const r = await pendingUploadRetry(tenantId)
      if (r.granted || r.abandoned) console.log(`[storage.pending_upload_retry] ${tenantId}:`, r)
    }))
    // docs/v2/34 §11: политики, сироты и сверка с бакетом — всухую, отчёт в audit_log (docs/v2/44
    // §11 Р-S1). Ошибка листинга бакета не глушится: круг доходит до конца, затем задача падает
    // и уходит в повтор
    await work('storage.retention_scan', () => runPerTenant('storage.retention_scan', async (tenantId) => {
      const { retentionScan } = await import('../services/storageScans')
      const r = await retentionScan(tenantId)
      if (r.total.files) console.log(`[storage.retention_scan] ${tenantId}: всухую ${r.total.files} файлів`)
    }))
    await work('storage.orphan_scan', () => runPerTenant('storage.orphan_scan', async (tenantId) => {
      const { orphanScan } = await import('../services/storageScans')
      const r = await orphanScan(tenantId)
      if (r.found) console.log(`[storage.orphan_scan] ${tenantId}: всухую ${r.found} файлів без посилань`)
    }))
    await work('storage.object_reconcile', async () => {
      const s = await runPerTenant('storage.object_reconcile', async (tenantId) => {
        const { objectReconcile } = await import('../services/storageScans')
        const r = await objectReconcile(tenantId)
        if (r.unregistered.files || r.missing.files) console.log(`[storage.object_reconcile] ${tenantId}:`, { unregistered: r.unregistered.files, missing: r.missing.files })
      })
      if (s.failed) throw new Error(`storage.object_reconcile: не звірено ${s.failed} тенант(ів): ${Object.keys(s.errors).join(', ')}`)
    })
    // docs/v2/32 §11: снимок дерева в 03:00 по поясу тенанта при изменениях и чистка снимков
    await work('org.daily_snapshot', () => runPerTenant('org.daily_snapshot', async (tenantId) => {
      const { dailySnapshot } = await import('../services/orgJobs')
      const r = await dailySnapshot(tenantId)
      if (r.taken) console.log(`[org.daily_snapshot] ${tenantId}: вузлів ${r.nodeCount}`)
    }))
    await work('org.snapshot_cleanup', () => runPerTenant('org.snapshot_cleanup', async (tenantId) => {
      const { snapshotCleanup } = await import('../services/orgJobs')
      const r = await snapshotCleanup(tenantId)
      if (r.expired || r.dailyOverflow) console.log(`[org.snapshot_cleanup] ${tenantId}:`, r)
    }))
    await work('storage.quota_warn', () => runPerTenant('storage.quota_warn', async (tenantId) => {
      const { quotaWarn } = await import('../services/storageScans')
      const r = await quotaWarn(tenantId)
      if (r.sent) console.log(`[storage.quota_warn] ${tenantId}:`, r)
    }))
    await work('webhook.deliver', () => runPerTenant('webhook.deliver', async (tenantId) => {
      const s = await deliverPending(tenantId)
      if (s.delivered || s.failed) console.log(`[webhook.deliver] ${tenantId}:`, s)
    }, tenantsWithPendingWebhooks))
  }
  catch (err) {
    console.error('Воркер не стартовал (очередь недоступна):', err)
  }
})
