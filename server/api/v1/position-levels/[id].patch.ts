// Алиас docs/04 §4.11: «CRUD /position-levels» (docs/28 «Spec 04»). :id совпадает по имени.
import handler from '../refs/[kind]/[id].patch'
import { aliasHandler } from '../../../utils/routeAlias'

export default aliasHandler(handler, { kind: 'position-levels' })
