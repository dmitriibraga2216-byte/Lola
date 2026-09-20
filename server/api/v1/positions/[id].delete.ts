// Алиас docs/04 §4.11: «CRUD /positions» (docs/28 «Spec 04»). :id совпадает по имени.
import handler from '../refs/[kind]/[id].delete'
import { aliasHandler } from '../../../utils/routeAlias'

export default aliasHandler(handler, { kind: 'positions' })
