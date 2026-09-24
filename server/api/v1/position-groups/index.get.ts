// Группы должностей (docs/v2/39 П-24.5, docs/04 §4.11): справочник поверх общего /refs/:kind.
import handler from '../refs/[kind].get'
import { aliasHandler } from '../../../utils/routeAlias'

export default aliasHandler(handler, { kind: 'position-groups' })
