import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * PR debts-7 (docs/33): D-061 (бекофіл requested_at для старих заявок на навчання, міграція
 * 0047). D-062 закрито в tests/integration/spec10-catalog.spec.ts (фолбек маршрутизації
 * коментарів), D-044 — у tests/integration/spec21-hub.spec.ts (дайджест дня народження на
 * точку), D-046 — існуючі tests/integration/reports-scope.spec.ts і hub.spec.ts (людина у
 * конструкторі звітів тепер резолвиться каркасом reportFrame.ts).
 */

const Pr = await import('../../server/services/programs')
const { listLearningRequests } = await import('../../server/services/learningRequests')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })
let tenantId: string, adminId: string, learnerId: string
const programIds: string[] = []
const userIds: string[] = []
const ctx = () => ({ tenantId, actorId: adminId })

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  const phone = `+38067${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
  const [u] = await admin`insert into users (tenant_id, phone, full_name, status, hired_at) values (${tenantId}, ${phone}, 'Заявник Легасі', 'active', current_date) returning id`
  learnerId = u!.id as string
  userIds.push(learnerId)
})

afterAll(async () => {
  if (programIds.length) await admin`delete from program_enrollments where program_id in ${admin(programIds)}`
  if (programIds.length) await admin`delete from programs where id in ${admin(programIds)}`
  if (userIds.length) await admin`delete from users where id in ${admin(userIds)}`
  await admin.end()
})

describe('docs/33 D-061 — бекофіл requested_at для старих заявок (міграція 0047)', () => {
  it('легасі-рядок program_enrollments (status=not_assigned, requested_at=null) отримує requested_at і з\'являється у черзі рішень', async () => {
    const p = await Pr.createProgram(ctx(), { title: `Легасі програма ${Date.now()}` })
    programIds.push(p.id)

    // Імітація стану до того, як шлях заявки почав гарантовано писати requested_at
    // (докс/28 Spec 10 відк. (2)): рядок status=not_assigned без requested_at.
    const createdAt = new Date(Date.now() - 30 * 86_400_000)
    const [row] = await admin`insert into program_enrollments (tenant_id, program_id, user_id, status, source, created_at, updated_at)
      values (${tenantId}, ${p.id}, ${learnerId}, 'not_assigned', 'catalog', ${createdAt.toISOString()}, ${createdAt.toISOString()}) returning id`
    const enrollmentId = row!.id as string
    expect((await admin`select requested_at from program_enrollments where id = ${enrollmentId}`)[0]!.requested_at).toBeNull()

    // До бекофілу заявку не видно (той самий фільтр, що й у GET /manage/catalog/requests)
    expect((await listLearningRequests(ctx(), 'trajectories')).some(r => r.id === enrollmentId)).toBe(false)

    // Той самий SQL, що й у міграції 0047 (data-only, idempotent)
    await admin`UPDATE program_enrollments SET requested_at = created_at WHERE status = 'not_assigned' AND requested_at IS NULL`

    const after = (await admin`select requested_at from program_enrollments where id = ${enrollmentId}`)[0]!
    expect(new Date(after.requested_at as string).toISOString()).toBe(createdAt.toISOString())

    const found = (await listLearningRequests(ctx(), 'trajectories')).find(r => r.id === enrollmentId)
    expect(found).toMatchObject({ kind: 'program', userId: learnerId, status: 'pending' })
  })

  it('рядки з уже заповненим requested_at або іншим статусом бекофіл не чіпає', async () => {
    const p1 = await Pr.createProgram(ctx(), { title: `Не легасі програма A ${Date.now()}` })
    const p2 = await Pr.createProgram(ctx(), { title: `Не легасі програма B ${Date.now()}` })
    programIds.push(p1.id, p2.id)
    const explicit = new Date('2020-01-01T00:00:00Z')
    const [withDate] = await admin`insert into program_enrollments (tenant_id, program_id, user_id, status, source, requested_at)
      values (${tenantId}, ${p1.id}, ${learnerId}, 'not_assigned', 'catalog', ${explicit.toISOString()}) returning id`
    const [notStarted] = await admin`insert into program_enrollments (tenant_id, program_id, user_id, status, source)
      values (${tenantId}, ${p2.id}, ${learnerId}, 'not_started', 'manual') returning id`

    await admin`UPDATE program_enrollments SET requested_at = created_at WHERE status = 'not_assigned' AND requested_at IS NULL`

    expect(new Date((await admin`select requested_at from program_enrollments where id = ${withDate!.id}`)[0]!.requested_at as string).toISOString()).toBe(explicit.toISOString())
    expect((await admin`select requested_at from program_enrollments where id = ${notStarted!.id}`)[0]!.requested_at).toBeNull()
  })
})
