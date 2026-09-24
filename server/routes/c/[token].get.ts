import { publicCertificate } from '../../services/certificates'
import { formatDate } from '../../../shared/domain/dateFormat'

/** Публичная проверка сертификата (docs/14 §5.5): без входа, noindex, только безопасные поля. */
export default defineEventHandler(async (event) => {
  setHeader(event, 'X-Robots-Tag', 'noindex')
  setHeader(event, 'Content-Type', 'text/html; charset=utf-8')
  const cert = await publicCertificate(getRouterParam(event, 'token')!)
  if (!cert) {
    setResponseStatus(event, 404)
    return page('Сертифікат не знайдено', '', 'coral')
  }
  const status = cert.revoked_at
    ? { text: 'Відкликаний', tone: 'coral' }
    : cert.valid_until && new Date(cert.valid_until) < new Date()
      ? { text: 'Термін дії закінчився', tone: 'muted' }
      : { text: 'Дійсний', tone: 'teal' }
  // Локаль відвідувача сторінка не знає (публічний токен, без сесії) — `public_certificate()`
  // не повертає ні users.locale, ні tenants.locale (docs/v2/46-progress.md: залишено боргом).
  // Дата йде через єдину утиліту з явним `uk`, щоб не хардкодити Intl-тег напряму.
  const fmt = (d: string | null) => d ? formatDate(d, 'uk', { day: 'numeric', month: 'long', year: 'numeric' }) : '—'
  return page(cert.number, `
    <p class="who">${esc(cert.full_name)}</p>
    <p class="course">${esc(cert.course_title ?? '')}</p>
    <dl>
      <dt>Видано</dt><dd>${fmt(cert.issued_at)}</dd>
      <dt>Дійсний до</dt><dd>${fmt(cert.valid_until)}</dd>
      ${cert.revoked_at ? `<dt>Відкликано</dt><dd>${fmt(cert.revoked_at)}</dd>` : ''}
      <dt>Організація</dt><dd>${esc(cert.tenant_name)}</dd>
    </dl>
  `, status.tone, status.text)
})

function esc(s: string) {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]!))
}

function page(number: string, body: string, tone: string, status = '') {
  return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Lola — ${esc(number)}</title>
<style>
body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#f0e7d7;color:#0c0f14;font-family:Nunito,'Trebuchet MS',sans-serif;padding:16px;box-sizing:border-box}
.card{background:#faf6ec;border:1px solid #d8cdb8;border-radius:36px;padding:32px;max-width:420px;width:100%;display:grid;gap:12px;text-align:center}
.brand{font-weight:900;font-size:2rem;margin:0}.num{color:#6b6154;font-size:.9rem;margin:0}
.badge{display:inline-block;justify-self:center;border-radius:999px;padding:4px 16px;font-weight:800}
.teal{background:#2bbfae;color:#06322d}.coral{background:#ff6b4a;color:#3b0f03}.muted{background:#e5dac4;color:#6b6154}
.who{font-weight:900;font-size:1.4rem;margin:8px 0 0}.course{margin:0;color:#6b6154}
dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;text-align:left;margin:12px 0 0;font-size:.9rem}dt{color:#a49b8c}dd{margin:0}
</style></head><body><div class="card"><h1 class="brand">Lola</h1><p class="num">${esc(number)}</p>${status ? `<span class="badge ${tone}">${esc(status)}</span>` : ''}${body}</div></body></html>`
}
