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
      await b.createQueue('assignment.sync', { retryLimit: 3, expireInSeconds: 900 })
      await b.createQueue('assignment.expand', { retryLimit: 5, retryBackoff: true, expireInSeconds: 900 })
      await b.createQueue('workshop.sla_scan', { retryLimit: 3, expireInSeconds: 600 })
      await b.createQueue('meetup.scan', { retryLimit: 3, expireInSeconds: 600 })
      await b.createQueue('certificate.render_pdf', { retryLimit: 3, expireInSeconds: 120 })
      await b.createQueue('webhook.deliver', { retryLimit: 3, expireInSeconds: 300 })
      await b.createQueue('report.export', { retryLimit: 2, expireInSeconds: 600 }) // docs/22 §10
      // Расписания docs/06 §6.3; singletonKey не даёт наплодить дублей
      await b.schedule('attempt.expire', '*/5 * * * *', {}, { singletonKey: 'attempt.expire' })
      await b.schedule('notification.dispatch', '* * * * *', {}, { singletonKey: 'notification.dispatch' })
      await b.schedule('due.scan', '0 8 * * *', {}, { singletonKey: 'due.scan', tz: 'Europe/Kyiv' })
      await b.schedule('assignment.sync', '0 * * * *', {}, { singletonKey: 'assignment.sync' })
      await b.schedule('workshop.sla_scan', '*/5 * * * *', {}, { singletonKey: 'workshop.sla_scan' })
      await b.schedule('meetup.scan', '*/5 * * * *', {}, { singletonKey: 'meetup.scan' })
      await b.schedule('webhook.deliver', '* * * * *', {}, { singletonKey: 'webhook.deliver' })
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
