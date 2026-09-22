// Алиас docs/04 §4.8: «PATCH /courses/:id/items/:id» — элемент плана курса.
// Код и `docs/28` называют его «уроком»; реальный обработчик — /lessons/:id (курс в пути не нужен).
// :itemId эталона подставляется под :id, который читает исходный обработчик (docs/33 D-064, `debts-final-b`).
import handler from '../../../lessons/[id]/index.patch'
import { aliasHandler } from '../../../../../utils/routeAlias'

export default aliasHandler(handler, event => ({ id: event.context.params?.itemId }))
