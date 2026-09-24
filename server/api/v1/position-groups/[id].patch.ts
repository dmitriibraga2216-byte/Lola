// Группы должностей (docs/v2/39 П-24.5): переименование и порядок; правило курсов группы пересобирается.
import handler from '../refs/[kind]/[id].patch'
import { aliasHandler } from '../../../utils/routeAlias'

export default aliasHandler(handler, { kind: 'position-groups' })
