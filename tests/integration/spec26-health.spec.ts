import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeEvent } from './_nitroGlobals'

/** docs/26 §26.12 п. 5: `/health` — версия и коммит; `/ready` краснеет, если БД или MinIO недоступны. */

const saved = { ...process.env }
afterEach(() => {
  process.env.APP_VERSION = saved.APP_VERSION
  process.env.APP_COMMIT = saved.APP_COMMIT
  process.env.S3_ENDPOINT = saved.S3_ENDPOINT
  if (saved.APP_VERSION === undefined) delete process.env.APP_VERSION
  if (saved.APP_COMMIT === undefined) delete process.env.APP_COMMIT
  if (saved.S3_ENDPOINT === undefined) delete process.env.S3_ENDPOINT
  vi.doUnmock('../../server/db/client')
  vi.resetModules()
})

describe('docs/26 §26.12 п. 5: /health и /ready', () => {
  it('/health отдаёт версию и хеш коммита из окружения сборки', async () => {
    process.env.APP_VERSION = 'v1.2.3'
    process.env.APP_COMMIT = 'abc1234'
    const { default: health } = await import('../../server/routes/health.get')
    expect(await (health as (e: unknown) => unknown)(makeEvent({ path: '/health' }))).toEqual({ status: 'ok', version: 'v1.2.3', commit: 'abc1234' })
  })

  it('/ready: БД доступна, MinIO не настроен — 200 ready', async () => {
    delete process.env.S3_ENDPOINT
    const { default: ready } = await import('../../server/routes/ready.get')
    const event = makeEvent({ path: '/ready' })
    expect(await (ready as (e: unknown) => unknown)(event)).toEqual({ status: 'ready', checks: { db: 'ok' } })
    expect(event._status).toBe(200)
  })

  it('/ready: MinIO недоступен — 503, в проверках s3 = fail', async () => {
    process.env.S3_ENDPOINT = 'http://127.0.0.1:1' // порт, на котором никто не слушает
    const { default: ready } = await import('../../server/routes/ready.get')
    const event = makeEvent({ path: '/ready' })
    expect(await (ready as (e: unknown) => unknown)(event)).toEqual({ status: 'not_ready', checks: { db: 'ok', s3: 'fail' } })
    expect(event._status).toBe(503)
  })

  it('/ready: БД недоступна — 503, в проверках db = fail', async () => {
    delete process.env.S3_ENDPOINT
    vi.resetModules()
    vi.doMock('../../server/db/client', () => ({ db: { execute: async () => { throw new Error('connect ECONNREFUSED') } } }))
    const { default: ready } = await import('../../server/routes/ready.get')
    const event = makeEvent({ path: '/ready' })
    expect(await (ready as (e: unknown) => unknown)(event)).toEqual({ status: 'not_ready', checks: { db: 'fail' } })
    expect(event._status).toBe(503)
  })
})
