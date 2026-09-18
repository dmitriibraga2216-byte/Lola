import { sql } from 'drizzle-orm'
import { db } from '../db/client'

/** Транзакция Drizzle с выставленным контекстом тенанта. */
export type TenantTx = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Единственный разрешённый способ обратиться к БД (см. CLAUDE.md, правило 2).
 *
 * Открывает транзакцию и выставляет `app.tenant_id` / `app.user_id` через
 * `set_config(..., true)` — значения живут только внутри транзакции, RLS-политики
 * читают их через `current_setting('app.tenant_id', true)`.
 */
export async function withTenant<T>(
  tenantId: string,
  userId: string | null,
  fn: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select set_config('app.tenant_id', ${tenantId}, true),
             set_config('app.user_id', ${userId ?? ''}, true)
    `)
    return fn(tx)
  })
}
