import { createHash } from 'node:crypto'
import type { AiDriver, AiPurpose, AiProviderRetention, AiUsageAxis } from '../../../shared/enums'

/**
 * Правила шлюза модели без базы и сети (`docs/v2/30` §3.2, §7.7, §7.12, §7.18; `docs/v2/35`
 * §7.1, §7.7; план `45` PR-27). Всё, что здесь, — чистые функции: их проверяет unit-тест, а
 * `gateway.ts` и `providers.ts` только применяют.
 */

// ── Роль профиля → ось тарифа ───────────────────────────────────────────────────────────

/**
 * Как роль списывает операцию оси:
 * - `per_call` — каждый успешный вызов = 1 операция (`35` §7.1: генерация, ИИ-сверка);
 * - `per_session` — операция резервируется один раз при старте сессии (`30` §7.12 [решение]),
 *   вызовы внутри сессии (расшифровка, оценка, Підсумок, их повторы) не тарифицируются;
 * - `none` — вне тарифа: вызов пишется в журнал, но ни одной оси не принадлежит.
 */
export type AiChargeMode = 'per_call' | 'per_session' | 'none'

export interface AiPurposeMeter {
  axis: AiUsageAxis | null
  charge: AiChargeMode
}

/**
 * Одна таблица на все роли: какой оси принадлежит вызов и как он её тратит. Жёсткость оси и
 * «что вместо» при исчерпании — не здесь, а в `AXIS_METER` (`usageCounters.ts`, PR-09): у оси
 * одно поведение, сколько бы ролей в неё ни писало.
 *
 * `embed` — `[решение]` PR-27: эмбеддинг — индекс поиска, а не функция ИИ, которую тенант
 * покупает. Отнести его к `ai_generate_ops` значило бы брать с тенанта деньги за наш поиск и
 * гасить поиск по библиотеке исчерпанием генерации, хотя `35` §7.4 поиск не блокирует нигде.
 * Вызов остаётся в `ai_calls` — со стоимостью и токенами для отчёта `30` §9.5.
 */
export const AI_PURPOSE_METER: Record<AiPurpose, AiPurposeMeter> = {
  generate: { axis: 'ai_generate_ops', charge: 'per_call' },
  review_hint: { axis: 'ai_review_ops', charge: 'per_call' },
  transcribe: { axis: 'ai_interview_ops', charge: 'per_session' },
  interview_score: { axis: 'ai_interview_ops', charge: 'per_session' },
  summary: { axis: 'ai_interview_ops', charge: 'per_session' },
  embed: { axis: null, charge: 'none' },
}

// ── Доступность ИИ по подписке ──────────────────────────────────────────────────────────

export type AiUnavailableReason = 'expired' | 'off' | 'readonly' | 'suspended'

export interface AiSubscription {
  status: 'trial' | 'active' | 'grace' | 'readonly' | 'suspended'
  aiStatus: 'active' | 'expired' | 'off'
}

/**
 * Почему новая тарифицируемая ИИ-операция сейчас невозможна (`null` — возможна).
 * `35` §7.7 п. 4: ИИ истёк при действующем тарифе — генерация, ИИ-собеседование, ИИ-сверка
 * отключаются; `ai_status = 'off'` — ИИ выключен оператором (§4); §7.8 п. 4: в `readonly`
 * запрещены вызовы ИИ; `suspended` — простор остановлен целиком (`25` §8).
 *
 * Спрашивается **при начале операции**: у `per_call` — на каждом вызове, у `per_session` — при
 * резерве сессии. Начатое собеседование доводится до конца и тогда, когда ИИ истёк посреди
 * него (`35` §12), поэтому вызовы внутри сессии сюда не ходят. Роль вне тарифа (`embed`) не
 * спрашивается вовсе: поиск — «просмотр своих данных», он разрешён и в `readonly`.
 */
export function aiUnavailable(sub: AiSubscription): AiUnavailableReason | null {
  if (sub.status === 'suspended') return 'suspended'
  if (sub.status === 'readonly') return 'readonly'
  if (sub.aiStatus === 'expired') return 'expired'
  if (sub.aiStatus === 'off') return 'off'
  return null
}

// ── Дайджест и ключ идемпотентности ─────────────────────────────────────────────────────

/** JSON с ключами объектов по алфавиту: один и тот же вход даёт одну и ту же строку. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null'
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).filter(k => o[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

/** `ai_calls.input_digest` / `output_digest`: доказывает «модель видела ровно это» (`30` §3.2). */
export function digestOf(v: unknown): string {
  return sha256Hex(canonicalJson(v))
}

export interface IdempotencyParts {
  tenantId: string
  refKind: string
  refId: string
  promptKey: string
  promptVersion: string
  tryNo: number
}

/**
 * `Idempotency-Key` вызова (`30` §7.18): `sha256(tenant_id, ref_kind, ref_id, prompt_key,
 * prompt_version, try_no)`. `prompt_key` — сверх формулы документа (пометка в `30` §7.18): без
 * него два разных промпта одной версии над одной сущностью делили бы один сохранённый ответ.
 */
export function idempotencyKey(p: IdempotencyParts): string {
  return sha256Hex([p.tenantId, p.refKind, p.refId, p.promptKey, p.promptVersion, String(p.tryNo)].join('\u001F'))
}

// ── Профили: срок хранения у поставщика и цепочка запасных ──────────────────────────────

/**
 * Сквозная проверка 18 (`42` §5, `30` §7.7): голос нельзя отдавать туда, где неизвестен срок
 * хранения. То же условие держит CHECK `ai_providers_transcribe_retention_chk`.
 */
export function retentionForbidden(p: { purpose: AiPurpose, providerRetention: AiProviderRetention }): boolean {
  return p.purpose === 'transcribe' && p.providerRetention === 'unknown'
}

export interface ProfileNode {
  id: string
  purpose: AiPurpose
  fallbackProviderId: string | null
}

export type FallbackViolation = 'fallback_self' | 'fallback_not_found' | 'fallback_purpose' | 'fallback_cycle' | 'fallback_depth'

/** Глубина цепочки запасных: основной профиль и не больше двух запасных за ним (`30` §3.2). */
export const AI_FALLBACK_MAX_DEPTH = 2

/**
 * Проверка графа запасных после правки одного профиля. Граф тенанта до правки был корректным,
 * поэтому любое нарушение после неё — следствие правки; проверяется весь граф, он маленький.
 *
 * Правила: не сам на себя; запасной существует у этого же тенанта (чужой под RLS не виден);
 * **та же роль** — расшифровка уходит только в расшифровку, значит запасной профиль `transcribe`
 * тоже не может иметь неизвестный срок хранения (`[решение]` PR-27: иначе сквозная проверка 18
 * обходилась бы одним переключением на запасной); без циклов; не больше двух переходов.
 */
export function fallbackViolation(profiles: readonly ProfileNode[], changed: ProfileNode): FallbackViolation | null {
  if (changed.fallbackProviderId && changed.fallbackProviderId === changed.id) return 'fallback_self'
  const byId = new Map(profiles.map(p => [p.id, p]))
  byId.set(changed.id, changed)
  if (changed.fallbackProviderId && !byId.has(changed.fallbackProviderId)) return 'fallback_not_found'
  for (const p of byId.values()) {
    if (!p.fallbackProviderId) continue
    const target = byId.get(p.fallbackProviderId)
    if (target && target.purpose !== p.purpose) return 'fallback_purpose'
  }
  for (const start of byId.values()) {
    const seen = new Set<string>([start.id])
    let hops = 0
    let cur = start
    while (cur.fallbackProviderId) {
      const next = byId.get(cur.fallbackProviderId)
      if (!next) break
      if (seen.has(next.id)) return 'fallback_cycle'
      seen.add(next.id)
      hops++
      if (hops > AI_FALLBACK_MAX_DEPTH) return 'fallback_depth'
      cur = next
    }
  }
  return null
}

export interface ChainProfile extends ProfileNode {
  isActive: boolean
  priority: number
  code: string
  driver: AiDriver
}

/**
 * Цепочка профилей на вызов: основной — активный профиль роли с наименьшим `priority` (при
 * равенстве — по коду), за ним его запасные по `fallback_provider_id`, не дальше двух переходов.
 * Выключенный запасной пропускается, но переход засчитывается: цепочка настраивается целиком,
 * и выключение звена не должно удлинять её сверх `30` §3.2.
 */
export function buildChain<T extends ChainProfile>(profiles: readonly T[], purpose: AiPurpose): T[] {
  const primary = profiles
    .filter(p => p.purpose === purpose && p.isActive)
    .sort((a, b) => a.priority - b.priority || a.code.localeCompare(b.code))[0]
  if (!primary) return []
  const byId = new Map(profiles.map(p => [p.id, p]))
  const chain: T[] = [primary]
  const seen = new Set<string>([primary.id])
  let cur: T = primary
  for (let hop = 0; hop < AI_FALLBACK_MAX_DEPTH && cur.fallbackProviderId; hop++) {
    const next = byId.get(cur.fallbackProviderId)
    if (!next || seen.has(next.id) || next.purpose !== purpose) break
    seen.add(next.id)
    if (next.isActive) chain.push(next)
    cur = next
  }
  return chain
}

// ── Адрес провайдера ────────────────────────────────────────────────────────────────────

/** Базовый адрес без хвостового `/`: `https://api.example.com/v1/` и `…/v1` — один адрес. */
export function normalizeEndpoint(url: string | null | undefined): string | null {
  const s = (url ?? '').trim().replace(/\/+$/, '')
  return s || null
}

const PRIVATE_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|\[?f[cd][0-9a-f]{2}:.*|\[?fe80:.*)$/i

/**
 * Адрес, который тенант вправе вписать в свой профиль: только `https` и не внутренняя сеть.
 * Сервер ходит по этому адресу сам — адрес внутренней сети превратил бы форму профиля в
 * сканер нашей инфраструктуры (SSRF). Профиль на внутреннем адресе (свой сервер модели
 * платформы) заводит оператор платформы, а не форма тенанта.
 */
export function endpointAllowed(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  }
  catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password) return false
  return !PRIVATE_HOST.test(u.hostname)
}
