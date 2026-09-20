import type { EventHandler, H3Event } from 'h3'

/**
 * Spec 04 (docs/04-api.md, docs/28 «Spec 04»): новые пути из ТЗ вводятся алиасами
 * поверх уже работающих обработчиков — без дублирования логики. Второй файл маршрута
 * реэкспортирует тот же `handler`, при необходимости подставляя параметры под имена,
 * которые ждёт исходный путь (например, `:itemId` эталона → `:lessonId` в коде).
 * Старые пути снимаются одним PR в конце R1 (docs/30 «Б», пункт 18).
 */
export function aliasHandler(
  handler: EventHandler,
  extraParams: Record<string, string | undefined> | ((event: H3Event) => Record<string, string | undefined>) = {},
): EventHandler {
  return defineEventHandler((event) => {
    const add = typeof extraParams === 'function' ? extraParams(event) : extraParams
    event.context.params = { ...(event.context.params ?? {}), ...add } as Record<string, string>
    return handler(event)
  })
}
