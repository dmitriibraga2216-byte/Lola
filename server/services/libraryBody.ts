import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { lessons } from '../db/schema'
import type { TenantTx } from '../utils/withTenant'

/**
 * Материал — тело библиотечного модуля (`docs/v2/31` §3.1 в редакции PR-25).
 *
 * Блоки модуля живут в `resources` (черновик) и `resource_versions` (снимки версий), потому что
 * у урока своего тела нет. Такой материал — внутренность модуля, а не самостоятельный ресурс:
 * его жизнь (правка, публикация версии, архив, удаление) ведёт только сервис библиотеки,
 * иначе правка «Використання хімії» в библиотеке ресурсов прошла бы мимо прав `library.*`,
 * мимо версий и мимо реестра мест. Поэтому списки и ручки ресурсов его не видят.
 *
 * Признак — существующая связь, а не новая колонка: материал принадлежит модулю, если на
 * него ссылается урок с владельцем-модулем (`lessons.library_module_id`). Статус у такого
 * материала всегда `draft`, поэтому каталог, поиск базы знаний, просмотр учеником и
 * `addLesson(resourceId)` (все требуют `published`) его и так не пропускают.
 */
export function notLibraryBody(resourceId: AnyPgColumn | SQL): SQL {
  return sql`not exists (select 1 from lessons lb where lb.item_type = 'resource' and lb.item_id = ${resourceId} and lb.library_module_id is not null)`
}

/**
 * Тот же признак для одной строки: материал — тело модуля. Нужен там, где тело всё-таки
 * читается — учеником по назначению узла-ссылки, закреплённому за снимком версии (П-17,
 * `resources.ts#viewResource`).
 */
export async function isLibraryBody(tx: TenantTx, resourceId: string): Promise<boolean> {
  const [row] = await tx.select({ id: lessons.id }).from(lessons)
    .where(and(eq(lessons.itemType, 'resource'), eq(lessons.itemId, resourceId), isNotNull(lessons.libraryModuleId)))
    .limit(1)
  return !!row
}
