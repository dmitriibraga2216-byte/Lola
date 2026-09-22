// Алиас docs/04 §4.11: «PATCH /tests/:id/questions/:id» — правка вопроса.
// Реальный обработчик — /questions/:id (тест в пути не нужен, вопрос живёт в банке вопросов).
// :questionId эталона подставляется под :id, который читает исходный обработчик (docs/33 D-064, `debts-final-b`).
import handler from '../../../questions/[id]/index.patch'
import { aliasHandler } from '../../../../../utils/routeAlias'

export default aliasHandler(handler, event => ({ id: event.context.params?.questionId }))
