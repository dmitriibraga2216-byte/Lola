import { describe, expect, it } from 'vitest'
import { renderCertificatePdf } from '../../server/services/certificatePdf'
import { business, httpRequests, registry, routeLabel, timedJob } from '../../server/utils/metrics'

describe('PDF сертификата (docs/14 §7.5)', () => {
  it('рендерит валидный PDF с кириллицей и номером', async () => {
    const buf = await renderCertificatePdf({ number: 'LO-2026-000042', fullName: 'Кухар Тестовий', courseTitle: 'Гарячий цех: піца', tenantName: 'Каппі', issuedAt: new Date('2026-09-19'), validUntil: new Date('2027-09-19'), score: '92.50', publicUrl: 'https://app.lola.ua/c/abc' })
    expect(buf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(5_000) // подмножество шрифта встроено
    expect(buf.toString('latin1')).toContain('/Title')
  })
})

describe('метрики Prometheus (docs/06 §6.7)', () => {
  it('routeLabel схлопывает id и токены', () => {
    expect(routeLabel('/api/v1/meetups/f419dabb-4ac7-4ab5-b43b-9801b4543983/qr?x=1')).toBe('/api/v1/meetups/:id/qr')
    expect(routeLabel('/c/AbCdEfGhIjKlMnOpQrStUvWxYz0123')).toBe('/c/:token')
  })
  it('timedJob считает результат и длительность, реестр отдаёт текст', async () => {
    await timedJob('test.job', async () => 1)
    await expect(timedJob('test.job', async () => { throw new Error('x') })).rejects.toThrow()
    httpRequests.inc({ method: 'GET', route: '/api/v1/x', status: '200' })
    business.inc({ event: 'attempt_started' })
    const text = await registry.metrics()
    expect(text).toContain('lola_jobs_total{job="test.job",result="ok"} 1')
    expect(text).toContain('lola_jobs_total{job="test.job",result="failed"} 1')
    expect(text).toContain('lola_job_duration_seconds_bucket')
    expect(text).toContain('lola_business_events_total{event="attempt_started"}')
    expect(text).toContain('lola_http_requests_total{method="GET",route="/api/v1/x",status="200"}')
  })
})
