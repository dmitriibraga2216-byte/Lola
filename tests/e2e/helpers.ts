import type { APIRequestContext, Page } from '@playwright/test'
import postgres from 'postgres'

export const ADMIN_PHONE = '+380661864742'
export const EMPLOYEE_PHONE = '+380670000003'
export const MENTOR_PHONE = '+380670000002'

const admin = postgres(process.env.DATABASE_ADMIN_URL ?? 'postgres://lola:lola_dev@localhost:5432/lola', { max: 1, onnotice: () => {} })

/** Сброс OTP-лимитов между сценариями — они честно считают попытки. */
export async function resetOtp() {
  await admin`delete from rate_limits where key like 'otp:%'`
  // Объявления с обязательным прочтением блокируют весь кабинет — не должны оставаться от других прогонов/ручных проверок
  await admin`update notices set status = 'archived' where status = 'published' and title not like 'E2E-%'`
  await admin`delete from otp_codes where phone in (${ADMIN_PHONE}, ${EMPLOYEE_PHONE}, ${MENTOR_PHONE})`
}

export async function cleanupCourses(titlePrefix: string) {
  const ids = (await admin`select id from courses where title like ${`${titlePrefix}%`}`).map(r => r.id as string)
  if (!ids.length) return
  await admin`delete from certificates where course_id in ${admin(ids)}`
  await admin`delete from enrollments where subject_id in ${admin(ids)}`
  await admin`delete from assignments where subject_id in ${admin(ids)}`
  await admin`delete from resources where id in (select l.item_id from lessons l join modules m on m.id = l.module_id join course_versions v on v.id = m.course_version_id where l.item_type = 'resource' and v.course_id in ${admin(ids)})`
  await admin`delete from courses where id in ${admin(ids)}`
}


/** Вход через UI: телефон → код (из ответа API при OTP_DEBUG=1) → главная. */
export async function loginViaUi(page: Page, phone: string) {
  await page.goto('/login')
  const responsePromise = page.waitForResponse(r => r.url().includes('/auth/otp/request') && r.ok())
  await page.getByPlaceholder('__ ___ __ __').fill(phone.replace('+380', ''))
  await page.getByRole('button', { name: /Отримати код/ }).click()
  const res = await responsePromise
  const { data } = await res.json() as { data: { devCode: string } }
  // Шесть ячеек кода — один скрытый input; шесть цифр отправляются сами
  await page.getByLabel('Введіть код').fill(data.devCode)
  await page.waitForURL(u => !u.pathname.startsWith('/login'))
}

/** Вход через API для подготовки данных (быстрее UI). Возвращает контекст с cookie и CSRF. */
export async function apiLogin(request: APIRequestContext, phone: string): Promise<{ csrf: string }> {
  const req = await request.post('/api/v1/auth/otp/request', { data: { phone } })
  const { data } = await req.json() as { data: { devCode: string } }
  await request.post('/api/v1/auth/otp/verify', { data: { phone, code: data.devCode } })
  const cookies = await request.storageState()
  const csrf = cookies.cookies.find(c => c.name === 'lola_csrf')?.value ?? ''
  return { csrf }
}

export async function api<T>(request: APIRequestContext, csrf: string, method: 'get' | 'post' | 'patch' | 'put' | 'delete', path: string, data?: unknown): Promise<T> {
  const res = await request[method](`/api/v1${path}`, { data, headers: { 'x-csrf-token': csrf } })
  const json = await res.json() as { data?: T, error?: { message: string } }
  if (!res.ok()) throw new Error(`${method.toUpperCase()} ${path} → ${res.status()}: ${json.error?.message}`)
  return json.data as T
}
