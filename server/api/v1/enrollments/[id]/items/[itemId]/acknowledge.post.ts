// Алиас docs/04 §4.5: «POST /enrollments/:id/items/:itemId/acknowledge» (docs/28 «Spec 04»).
import handler from '../../../../learning/enrollments/[id]/lessons/[lessonId]/acknowledge.post'
import { aliasHandler } from '../../../../../../utils/routeAlias'

export default aliasHandler(handler, event => ({ lessonId: event.context.params?.itemId }))
