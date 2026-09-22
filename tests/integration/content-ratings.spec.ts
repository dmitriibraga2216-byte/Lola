import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const { rateContent, unrateContent, ratingAggregate } = await import('../../server/services/contentRatings')
const { createResource } = await import('../../server/services/resources')
const { createArticle } = await import('../../server/services/knowledge')

/**
 * D-015/D-042 (докс/33): «Оцінок: N» на картці ресурсу і статті бази знань — звезда 1–5,
 * один голос на людину, повторна оцінка правит свій же голос. RLS перевіряється отдельно
 * (rls.spec.ts находит content_ratings в списке таблиц с tenant_id).
 */
const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 1, onnotice: () => {} })

let tenantId: string
let adminId: string
let mentorId: string
let learnerId: string
const resourceIds: string[] = []
const articleIds: string[] = []

beforeAll(async () => {
  const [t] = await admin`select id from tenants where slug = 'kappi'`
  tenantId = t!.id as string
  const pick = async (phone: string) => (await admin`select id from users where tenant_id = ${tenantId} and phone = ${phone}`)[0]!.id as string
  adminId = await pick('+380661864742')
  mentorId = await pick('+380670000002')
  learnerId = await pick('+380670000003')
})

afterAll(async () => {
  if (resourceIds.length) {
    await admin`delete from content_ratings where content_type = 'resource' and content_id in ${admin(resourceIds)}`
    await admin`delete from resources where id in ${admin(resourceIds)}`
  }
  if (articleIds.length) {
    await admin`delete from content_ratings where content_type = 'knowledge_article' and content_id in ${admin(articleIds)}`
    await admin`delete from knowledge_articles where id in ${admin(articleIds)}`
  }
  await admin.end()
})

const ctx = () => ({ tenantId, actorId: adminId })
const mentor = () => ({ tenantId, actorId: mentorId })
const learner = () => ({ tenantId, actorId: learnerId })

describe('content_ratings: оценка ресурса и статьи (докс/33 D-042)', () => {
  it('resource: агрегат считает count/average, повторная оценка правит свою', async () => {
    const r = await createResource(ctx(), { title: 'Оцінюваний ресурс', kind: 'article', language: 'uk', tags: [], categoryIds: [], allowPrint: true, body: [{ id: 'b1', type: 'text', html: '<p>Текст</p>' }] })
    resourceIds.push(r.id)

    expect(await ratingAggregate(ctx(), 'resource', r.id)).toEqual({ count: 0, average: null, myValue: null })

    const a1 = await rateContent(mentor(), { contentType: 'resource', contentId: r.id, value: 4 })
    expect(a1).toMatchObject({ count: 1, average: 4, myValue: 4 })

    const a2 = await rateContent(learner(), { contentType: 'resource', contentId: r.id, value: 2 })
    expect(a2).toMatchObject({ count: 2, average: 3 })

    // Повторна оцінка того ж читача — upsert, не другий голос
    const a3 = await rateContent(mentor(), { contentType: 'resource', contentId: r.id, value: 5 })
    expect(a3).toMatchObject({ count: 2, average: 3.5, myValue: 5 })

    const a4 = await unrateContent(mentor(), { contentType: 'resource', contentId: r.id })
    expect(a4).toMatchObject({ count: 1, average: 2, myValue: null })
  })

  it('knowledge_article: своя оценка не видна другому читателю', async () => {
    const a = await createArticle(ctx(), { title: 'Оцінювана стаття', body: [{ id: 'b1', type: 'text', html: '<p>Текст</p>' }] })
    articleIds.push(a.id)
    await rateContent(learner(), { contentType: 'knowledge_article', contentId: a.id, value: 3 })
    const asLearner = await ratingAggregate(learner(), 'knowledge_article', a.id)
    const asMentor = await ratingAggregate(mentor(), 'knowledge_article', a.id)
    expect(asLearner).toMatchObject({ count: 1, average: 3, myValue: 3 })
    expect(asMentor).toMatchObject({ count: 1, average: 3, myValue: null })
  })

  it('неіснуючий матеріал — rateContent повертає null', async () => {
    expect(await rateContent(learner(), { contentType: 'resource', contentId: '00000000-0000-0000-0000-000000000000', value: 5 })).toBeNull()
  })
})
