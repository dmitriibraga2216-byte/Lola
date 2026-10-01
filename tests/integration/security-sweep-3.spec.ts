import http from 'node:http'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Регрессия security-sweep-3 (docs/v2/46-progress.md, «Аудит безопасности»): исходящие запросы на адреса,
 * которые вписывает тенант. До исправления вебхук доставлялся на внутренний адрес, а ответ сервиса
 * внутренней сети показывался тенанту в журнале доставок.
 */

const { createEndpoint, updateEndpoint } = await import('../../server/services/webhooks')
const G = await import('../../server/services/netGuard')
const { endpointAllowed } = await import('../../server/services/ai/policy')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, port: number
const ctx = () => ({ tenantId, actorId: adminId })
const server = http.createServer((req, res) => {
  if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('Location', 'http://127.0.0.1:1/secret'); res.end(); return }
  res.end('INTERNAL')
})

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => { port = (server.address() as { port: number }).port; r() }))
})

afterAll(async () => {
  G.setNetGuardAllowPrivate(false)
  server.close()
  await admin.end()
})

describe('вебхук: адрес внутренней сети не принимается и не вызывается', () => {
  it('создание и правка с внутренним адресом — url_not_allowed', async () => {
    for (const url of ['https://169.254.169.254/latest/meta-data', 'https://minio/x', 'https://[::ffff:a9fe:a9fe]/x', 'http://example.com/hook', `https://127.0.0.1:${8000}/x`]) {
      expect(await createEndpoint(ctx(), { url, events: ['user.created'] }), url).toEqual({ ok: false, code: 'url_not_allowed' })
    }
    expect(await updateEndpoint(ctx(), '00000000-0000-4000-8000-000000000000', { url: 'https://10.0.0.5/x' })).toBe('url_not_allowed')
  })

  it('доставка на внутренний адрес обрывается до соединения', async () => {
    await expect(G.postExternal(`http://127.0.0.1:${port}/`, {}, '{}')).rejects.toBeInstanceOf(G.PrivateDestinationError)
  })

  it('редирект не выполняется: 3xx — это ответ', async () => {
    G.setNetGuardAllowPrivate(true)
    const r = await G.postExternal(`http://127.0.0.1:${port}/redirect`, {}, '{}')
    G.setNetGuardAllowPrivate(false)
    expect(r.status).toBe(302)
    expect(r.text).not.toContain('INTERNAL')
  })
})

describe('диапазоны и имена', () => {
  it('внутренние адреса, в т. ч. IPv4 внутри IPv6', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:a9fe:a9fe']) {
      expect(G.isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) expect(G.isPrivateAddress(ip), ip).toBe(false)
  })

  it('профиль модели: имена сервисов docker и IPv6-формы внутренних адресов не проходят', () => {
    for (const bad of ['https://minio/v1', 'https://postgres:5432/v1', 'https://[::ffff:169.254.169.254]/v1', 'https://0x7f000001/v1']) {
      expect(endpointAllowed(bad), bad).toBe(false)
    }
    expect(endpointAllowed('https://api.example.com/v1')).toBe(true)
  })
})
