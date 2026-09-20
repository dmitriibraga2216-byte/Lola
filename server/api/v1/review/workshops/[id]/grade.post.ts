// Алиас docs/04 §4.7: «POST /review/workshops/:id/grade» — решение по сдаче практикума.
// Сегодня — /review/submissions/:id/grade (docs/28 «Spec 04»); :id совпадает, реэкспорт как есть.
export { default } from '../../submissions/[id]/grade.post'
