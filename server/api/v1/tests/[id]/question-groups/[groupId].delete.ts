// Алиас docs/04 §4.11: «DELETE /tests/:id/question-groups/:id» — группа вопросов теста.
// Реальный обработчик — /question-groups/:id (тест в пути не нужен, группа сама знает свой quizId).
// :groupId эталона подставляется под :id, который читает исходный обработчик (docs/33 D-064, `debts-final-b`).
import handler from '../../../question-groups/[id].delete'
import { aliasHandler } from '../../../../../utils/routeAlias'

export default aliasHandler(handler, event => ({ id: event.context.params?.groupId }))
