// Алиас docs/04 §4.7: «POST /review/workshops/:id/claim» — взять сдачу практикума в работу.
// Сегодня — /review/submissions/:id/claim (docs/28 «Spec 04»); :id совпадает, реэкспорт как есть.
export { default } from '../../submissions/[id]/claim.post'
