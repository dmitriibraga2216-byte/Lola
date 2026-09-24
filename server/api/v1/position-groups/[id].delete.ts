// Группы должностей (docs/v2/39 П-24.5): удалить можно только пустую группу (409 in_use).
import handler from '../refs/[kind]/[id].delete'
import { aliasHandler } from '../../../utils/routeAlias'

export default aliasHandler(handler, { kind: 'position-groups' })
