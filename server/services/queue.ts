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
      return b
    })
  }
  return started
}

export async function enqueueMediaProcess(tenantId: string, mediaId: string): Promise<void> {
  const b = await getBoss()
  await b.send('media.process', { tenantId, mediaId }, { singletonKey: mediaId })
}
