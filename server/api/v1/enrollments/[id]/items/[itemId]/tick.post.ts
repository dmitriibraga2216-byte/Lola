// Алиас docs/04 §4.5: «POST /enrollments/:id/items/:itemId/tick».
// Сегодня — /learning/enrollments/:id/lessons/:lessonId/tick (см. текст `04` §4.5, docs/28 «Spec 04»).
// :itemId эталона подставляется под :lessonId, который читает исходный обработчик.
import handler from '../../../../learning/enrollments/[id]/lessons/[lessonId]/tick.post'
import { aliasHandler } from '../../../../../../utils/routeAlias'

export default aliasHandler(handler, event => ({ lessonId: event.context.params?.itemId }))
