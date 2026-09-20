// Алиас docs/04 §4.11: «CRUD /position-levels» — справочник.
// Сегодня — общий /refs/:kind (docs/28 «Spec 04»); kind подставляется явно.
import handler from '../refs/[kind].get'
import { aliasHandler } from '../../../utils/routeAlias'

export default aliasHandler(handler, { kind: 'position-levels' })
