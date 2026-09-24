import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * «Без новостей»: всё, что выполняется внутри `withoutNews()`, пишет данные как обычно, но не ставит
 * ни уведомлений, ни вебхуков — `enqueueNotification()` и `emitWebhook()` (две единственные точки
 * постановки) проверяют `newsSuppressed()` и молча ничего не делают.
 *
 * Нужно для закрытий, опоздавших больше чем на сутки (`attempt.expire`, docs/12 §7 п. 8): результат
 * обязан появиться, а пачка новостей недельной давности после простоя воркера — нет. Контекст живёт
 * в AsyncLocalStorage, поэтому глушит всю цепочку последствий закрытия (журнал заданий, бонусы,
 * этапы жизненного цикла, воронка кандидата), а не только прямые вызовы в `attempts.ts`.
 */
const scope = new AsyncLocalStorage<true>()

export function withoutNews<T>(fn: () => Promise<T>): Promise<T> {
  return scope.run(true, fn)
}

export function newsSuppressed(): boolean {
  return scope.getStore() === true
}
