import { z } from 'zod'
import { KEYSET_CURSOR_MAX, decodeKeyset } from '../domain/keyset'
import type { KeysetShape } from '../domain/keyset'

/**
 * Поле `cursor` списка с ключевым курсором (`shared/domain/keyset.ts`, docs/04-api.md §4.1).
 *
 * Курсор проверяется целиком уже здесь, на входе: битый, самодельный или курсор старого формата
 * даёт 400 `validation_failed`, а не первую страницу. Первая страница вместо следующей — это
 * дубли на экране «Показати ще» и бесконечный цикл у клиента, который листает до `null`.
 * Пустая строка (`?cursor=`) — то же, что курсора нет: первая страница.
 */
export function keysetCursorSchema(shape: KeysetShape) {
  return z.string().max(KEYSET_CURSOR_MAX).refine(c => c === '' || decodeKeyset(shape, c) !== null, {
    message: 'Курсор недійсний — оновіть список і гортайте спочатку',
  })
}
