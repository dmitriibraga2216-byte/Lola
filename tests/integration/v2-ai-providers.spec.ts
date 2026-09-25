import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AI_CALL_REF_KINDS, AI_CALL_STATUSES, AI_DATA_REGIONS, AI_DRIVERS, AI_PROVIDER_RETENTIONS, AI_PURPOSES, AI_USAGE_AXES } from '../../shared/enums'

/**
 * PR-27 пакета `docs/v2` (`45-plan.md`): профили поставщика модели (`30-ai-interview.md` §3.2,
 * §7.7, §10) и схема миграции `0091_v2_ai_providers`.
 *
 * **Условие выхода PR-27 — сквозная проверка 18** (`42-stages-delta.md` §5): «провайдер с
 * `provider_retention='unknown'` не назначается на `transcribe` — попытка сохранить такую
 * конфигурацию отклоняется». Проверяется всеми путями, которыми её можно сохранить: созданием,
 * правкой срока, правкой роли, через цепочку запасных — и мимо сервиса, прямой записью в БД.
 */

process.env.ENCRYPTION_KEY ??= 'test-encryption-key'
process.env.SESSION_SECRET ??= 'test-session-secret'

const { listProviders, getProvider, createProvider, updateProvider } = await import('../../server/services/ai/providers')
const { DEFAULT_AI_PROVIDERS } = await import('../../server/db/tenantDefaults')

const admin = postgres(process.env.DATABASE_ADMIN_URL!, { max: 2, onnotice: () => {} })

const P = 'pr27p-'
let tenantId: string
let otherTenantId: string
let adminId: string
let foreignProviderId: string

const ctx = () => ({ tenantId, actorId: adminId })
type CreateInput = Parameters<typeof createProvider>[1]

function input(code: string, over: Partial<CreateInput> = {}): CreateInput {
  return {
    code: `${P}${code}`, name: `PR27 ${code}`, purpose: 'generate', driver: 'stub', modelName: 'stub-v1', params: {},
    dataRegion: 'eu', providerRetention: 'none', maxLatencyMs: 30_000, isActive: true, priority: 500, ...over,
  } as CreateInput
}

async function create(code: string, over: Partial<CreateInput> = {}) {
  const r = await createProvider(ctx(), input(code, over))
  expect(r.ok, JSON.stringify(r)).toBe(true)
  return r.ok ? r.provider : (null as never)
}

async function cleanup() {
  await admin`update ai_providers set fallback_provider_id = null where code like ${`${P}%`}`
  await admin`delete from tenant_secrets where tenant_id = ${tenantId} and provider = 'ai'`
  await admin`delete from ai_providers where code like ${`${P}%`}`
  await admin`delete from audit_log where tenant_id = ${tenantId} and action like 'ai.provider.%'`
}

async function platform(purpose: string) {
  return (await admin`select * from ai_providers where tenant_id = ${tenantId} and code = ${`platform-${purpose.replace('_', '-')}`}`)[0]!
}

beforeAll(async () => {
  tenantId = (await admin`select id from tenants where slug = 'kappi'`)[0]!.id as string
  adminId = (await admin`select id from users where tenant_id = ${tenantId} and phone = '+380661864742'`)[0]!.id as string
  const [other] = await admin`insert into tenants (slug, name) values ('test-ai-27p', 'Тест профілів ШІ')
    on conflict (slug) do update set name = excluded.name returning id`
  otherTenantId = other!.id as string
  await cleanup()
  const [foreign] = await admin`insert into ai_providers (tenant_id, code, name, purpose, driver, model_name, provider_retention)
    values (${otherTenantId}, 'pr27f-foreign', 'Чужий профіль', 'transcribe', 'stub', 'stub-v1', 'none')
    on conflict (tenant_id, code) do update set name = excluded.name returning id`
  foreignProviderId = foreign!.id as string
})

beforeEach(cleanup)

afterAll(async () => {
  await cleanup()
  // Профили платформы после теста — ровно как из посева: другие файлы работают на заглушке
  for (const [purpose, d] of Object.entries(DEFAULT_AI_PROVIDERS)) {
    await admin`update ai_providers set driver = 'stub', endpoint_url = null, model_name = ${d.modelName}, provider_retention = 'none',
      data_region = 'eu', is_active = true, priority = 100, fallback_provider_id = null, secret_ref = null, purpose = ${purpose}
      where tenant_id = ${tenantId} and code = ${d.code}`
  }
  await admin`delete from tenants where id = ${otherTenantId}`
  await admin.end()
})

// ── Миграция ────────────────────────────────────────────────────────────────────────────

describe('миграция 0092: ai_providers и ai_calls', () => {
  it('RLS enable + force и политика с using и with check у обеих таблиц', async () => {
    const rows = await admin`
      select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
             p.polqual is not null as has_using, p.polwithcheck is not null as has_check
        from pg_class c left join pg_policy p on p.polrelid = c.oid and p.polname = 'tenant_isolation'
       where c.relname in ('ai_providers', 'ai_calls') order by c.relname`
    expect(rows.map(r => r.relname)).toEqual(['ai_calls', 'ai_providers'])
    for (const r of rows) expect(r, String(r.relname)).toMatchObject({ enabled: true, forced: true, has_using: true, has_check: true })
  })

  it('перечни CHECK в БД совпадают с shared/enums (CLAUDE.md п. 13)', async () => {
    const def = async (name: string) => String((await admin`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`)[0]!.def)
    const values = (d: string) => [...d.matchAll(/'([a-z_]+)'::text/g)].map(m => m[1])
    expect(values(await def('ai_providers_purpose_chk'))).toEqual([...AI_PURPOSES])
    expect(values(await def('ai_calls_purpose_chk'))).toEqual([...AI_PURPOSES])
    expect(values(await def('ai_providers_driver_chk'))).toEqual([...AI_DRIVERS])
    expect(values(await def('ai_providers_retention_chk'))).toEqual([...AI_PROVIDER_RETENTIONS])
    expect(values(await def('ai_providers_region_chk'))).toEqual([...AI_DATA_REGIONS])
    expect(values(await def('ai_calls_status_chk'))).toEqual([...AI_CALL_STATUSES])
    expect(values(await def('ai_calls_ref_chk'))).toEqual([...AI_CALL_REF_KINDS])
    expect(values(await def('ai_calls_axis_chk'))).toEqual([...AI_USAGE_AXES])
  })

  it('журнал пишет request_context; списать может только успешный вызов с осью', async () => {
    const [col] = await admin`select data_type from information_schema.columns where table_name = 'ai_calls' and column_name = 'request_context'`
    expect(col?.data_type).toBe('jsonb')
    await expect(admin`insert into ai_calls (tenant_id, purpose, prompt_key, prompt_version, model_name, ref_kind, input_digest, status, billed)
      values (${tenantId}, 'generate', 'pr27p.x', 'v1', 'm', 'vacancy_generation', ${'b'.repeat(64)}, 'failed', true)`).rejects.toThrow(/ai_calls_billed_chk/)
    await expect(admin`insert into ai_calls (tenant_id, purpose, prompt_key, prompt_version, model_name, ref_kind, input_digest, status, billed)
      values (${tenantId}, 'embed', 'pr27p.x', 'v1', 'm', 'search_query', ${'b'.repeat(64)}, 'ok', true)`).rejects.toThrow(/ai_calls_billed_chk/)
  })
})

// ── Профили платформы ───────────────────────────────────────────────────────────────────

describe('профили платформы копируются тенанту строками (30 §3.2 [решение])', () => {
  it('по заглушке на роль: регион eu, у поставщика ничего не хранится, ключа нет', async () => {
    const list = await listProviders(ctx())
    const platformRows = list.filter(p => p.code.startsWith('platform-'))
    expect(platformRows.map(p => p.purpose).sort()).toEqual([...AI_PURPOSES].sort())
    for (const p of platformRows) expect(p).toMatchObject({ driver: 'stub', providerRetention: 'none', dataRegion: 'eu', hasOwnKey: false, isActive: true })
  })

  it('тенант без профилей получает их при первом обращении, повтор ничего не дублирует', async () => {
    await admin`delete from ai_providers where tenant_id = ${otherTenantId} and code like 'platform-%'`
    const [u] = await admin`insert into users (tenant_id, kind, full_name, phone) values (${otherTenantId}, 'employee', 'Адмін профілів', '+380679927101')
      on conflict (tenant_id, phone) do update set full_name = excluded.full_name returning id`
    const other = { tenantId: otherTenantId, actorId: u!.id as string }
    const first = await listProviders(other)
    const second = await listProviders(other)
    expect(first.filter(p => p.code.startsWith('platform-'))).toHaveLength(AI_PURPOSES.length)
    expect(second.map(p => p.id).sort()).toEqual(first.map(p => p.id).sort())
  })
})

// ── Сквозная проверка 18 ────────────────────────────────────────────────────────────────

describe('сквозная проверка 18: расшифровка не назначается провайдеру с неизвестным сроком хранения (42 §5, 30 §7.7)', () => {
  it('создание профиля transcribe + unknown отклоняется, строки нет', async () => {
    const r = await createProvider(ctx(), input('t-unknown', { purpose: 'transcribe', providerRetention: 'unknown' }))
    expect(r).toEqual({ ok: false, code: 'retention_unknown' })
    expect(await admin`select id from ai_providers where code = ${`${P}t-unknown`}`).toHaveLength(0)
  })

  it('правка срока у профиля расшифровки на unknown отклоняется, профиль не изменился', async () => {
    const before = await platform('transcribe')
    const r = await updateProvider(ctx(), before.id as string, { providerRetention: 'unknown' })
    expect(r).toEqual({ ok: false, code: 'retention_unknown' })
    expect((await platform('transcribe')).provider_retention).toBe(before.provider_retention)
  })

  it('перевод профиля с unknown в роль расшифровки отклоняется', async () => {
    const gen = await create('gen-unknown', { providerRetention: 'unknown' })
    expect(await updateProvider(ctx(), gen.id, { purpose: 'transcribe' })).toEqual({ ok: false, code: 'retention_unknown' })
    expect((await getProvider(ctx(), gen.id))!.purpose).toBe('generate')
  })

  it('обойти через запасной нельзя: запасной у расшифровки — только расшифровка', async () => {
    const other = await create('gen-spare', { providerRetention: 'unknown' })
    const main = await create('t-main', { purpose: 'transcribe', providerRetention: 'ephemeral' })
    expect(await updateProvider(ctx(), main.id, { fallbackProviderId: other.id })).toEqual({ ok: false, code: 'fallback_purpose' })
    // Запасной той же роли — годится, и он сам обязан иметь известный срок
    const spare = await create('t-spare', { purpose: 'transcribe', providerRetention: 'none' })
    expect((await updateProvider(ctx(), main.id, { fallbackProviderId: spare.id })).ok).toBe(true)
    expect(await updateProvider(ctx(), spare.id, { providerRetention: 'unknown' })).toEqual({ ok: false, code: 'retention_unknown' })
  })

  it('мимо сервиса запись отклоняет сама таблица', async () => {
    await expect(admin`insert into ai_providers (tenant_id, code, name, purpose, driver, model_name, provider_retention)
      values (${tenantId}, ${`${P}raw`}, 'Напряму', 'transcribe', 'stub', 'm', 'unknown')`).rejects.toThrow(/ai_providers_transcribe_retention_chk/)
    const t = await platform('transcribe')
    await expect(admin`update ai_providers set provider_retention = 'unknown' where id = ${t.id}`).rejects.toThrow(/ai_providers_transcribe_retention_chk/)
    // Значение по умолчанию колонки — `unknown`: профиль расшифровки без явного срока не создаётся вовсе
    await expect(admin`insert into ai_providers (tenant_id, code, name, purpose, driver, model_name)
      values (${tenantId}, ${`${P}raw2`}, 'Без строку', 'transcribe', 'stub', 'm')`).rejects.toThrow(/ai_providers_transcribe_retention_chk/)
  })
})

// ── Остальные правила профиля ───────────────────────────────────────────────────────────

describe('цепочка запасных (30 §3.2: не сам на себя, глубина ≤ 2, та же роль)', () => {
  it('сам на себя, чужой тенант, цикл и третий переход — отклоняются', async () => {
    const a = await create('a')
    const b = await create('b')
    const c = await create('c')
    const d = await create('d')
    expect(await updateProvider(ctx(), a.id, { fallbackProviderId: a.id })).toEqual({ ok: false, code: 'fallback_self' })
    expect(await updateProvider(ctx(), a.id, { fallbackProviderId: foreignProviderId })).toEqual({ ok: false, code: 'fallback_not_found' })
    expect((await updateProvider(ctx(), a.id, { fallbackProviderId: b.id })).ok).toBe(true)
    expect((await updateProvider(ctx(), b.id, { fallbackProviderId: c.id })).ok).toBe(true)
    expect(await updateProvider(ctx(), c.id, { fallbackProviderId: a.id })).toEqual({ ok: false, code: 'fallback_cycle' })
    expect(await updateProvider(ctx(), c.id, { fallbackProviderId: d.id })).toEqual({ ok: false, code: 'fallback_depth' })
  })
})

describe('адрес, регион, свой ключ (30 §3.2)', () => {
  it('сетевой драйвер без адреса и адрес внутренней сети отклоняются', async () => {
    expect(await createProvider(ctx(), input('no-url', { driver: 'openai_compatible' }))).toEqual({ ok: false, code: 'endpoint_required' })
    expect(await createProvider(ctx(), input('lan', { driver: 'openai_compatible', endpointUrl: 'https://10.1.2.3/v1' }))).toEqual({ ok: false, code: 'endpoint_invalid' })
    expect(await createProvider(ctx(), input('http', { driver: 'openai_compatible', endpointUrl: 'http://api.example.test/v1' }))).toEqual({ ok: false, code: 'endpoint_invalid' })
  })

  it('адрес, вписанный оператором, не перепроверяется при правке другого поля', async () => {
    const p = await create('op-url', { driver: 'openai_compatible', endpointUrl: 'https://api.example.test/v1' })
    await admin`update ai_providers set endpoint_url = 'http://llm.internal:8000/v1' where id = ${p.id}`
    expect((await updateProvider(ctx(), p.id, { name: 'PR27 перейменовано' })).ok).toBe(true)
    expect(await updateProvider(ctx(), p.id, { endpointUrl: 'http://llm.internal:9000/v1' })).toEqual({ ok: false, code: 'endpoint_invalid' })
  })

  it('регион other — только с комментарием, и он уходит в audit_log', async () => {
    const p = await create('region')
    expect(await updateProvider(ctx(), p.id, { dataRegion: 'other' })).toEqual({ ok: false, code: 'region_comment_required' })
    expect((await updateProvider(ctx(), p.id, { dataRegion: 'other', regionComment: 'Модель доступна лише в регіоні США' })).ok).toBe(true)
    const [log] = await admin`select actor_id, after from audit_log where action = 'ai.provider.region_other' and entity_id = ${p.id}`
    expect(log).toMatchObject({ actor_id: adminId, after: { comment: 'Модель доступна лише в регіоні США' } })
    // Повторная правка уже «другого» региона комментария не требует
    expect((await updateProvider(ctx(), p.id, { priority: 400 })).ok).toBe(true)
  })

  it('свой ключ: только зашифрованной строкой tenant_secrets, в ответе и журнале — лишь признак', async () => {
    const key = 'sk-pr27-tenant-secret-value'
    const p = await create('keyed', { driver: 'openai_compatible', endpointUrl: 'https://api.example.test/v1', apiKey: key })
    expect(p.hasOwnKey).toBe(true)
    expect(JSON.stringify(p)).not.toContain(key)
    const [secret] = await admin`select provider, key, value_encrypted from tenant_secrets where tenant_id = ${tenantId} and key = ${`ai_provider:${p.id}`}`
    expect(secret).toMatchObject({ provider: 'ai' })
    expect(Buffer.from(secret!.value_encrypted as Uint8Array).toString('utf8')).not.toContain(key)
    const logs = await admin`select before, after from audit_log where entity_id = ${p.id}`
    expect(JSON.stringify(logs)).not.toContain(key)

    const dropped = await updateProvider(ctx(), p.id, { apiKey: null })
    expect(dropped.ok && dropped.provider.hasOwnKey).toBe(false)
    expect(await admin`select id from tenant_secrets where tenant_id = ${tenantId} and key = ${`ai_provider:${p.id}`}`).toHaveLength(0)
  })

  it('код профиля уникален в тенанте', async () => {
    await create('dup')
    expect(await createProvider(ctx(), input('dup'))).toEqual({ ok: false, code: 'code_taken' })
  })
})

describe('изоляция тенанта (CLAUDE.md п. 1, 15)', () => {
  it('чужой профиль не виден и не правится — как будто его нет', async () => {
    expect(await getProvider(ctx(), foreignProviderId)).toBeNull()
    expect(await updateProvider(ctx(), foreignProviderId, { name: 'Захоплено' })).toEqual({ ok: false, code: 'not_found' })
    expect((await listProviders(ctx())).some(p => p.id === foreignProviderId)).toBe(false)
    const [row] = await admin`select name from ai_providers where id = ${foreignProviderId}`
    expect(row!.name).toBe('Чужий профіль')
  })
})
