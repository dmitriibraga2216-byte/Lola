// Алиас docs/04 §4.11: слияние двух значений справочника (docs/28 «Spec 04»).
import handler from '../refs/[kind]/merge.post'
import { aliasHandler } from '../../../utils/routeAlias'

export default aliasHandler(handler, { kind: 'locations' })
