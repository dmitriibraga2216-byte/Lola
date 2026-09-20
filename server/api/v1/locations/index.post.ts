// Алиас docs/04 §4.11: «CRUD /locations» (docs/28 «Spec 04»).
import handler from '../refs/[kind].post'
import { aliasHandler } from '../../../utils/routeAlias'

export default aliasHandler(handler, { kind: 'locations' })
