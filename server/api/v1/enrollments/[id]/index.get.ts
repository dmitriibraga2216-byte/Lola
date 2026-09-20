// Алиас docs/04 §4.5: «GET /enrollments/:id» — состояние прохождения (дерево, прогресс).
// Сегодня — /learning/enrollments/:id (docs/28 «Spec 04»); :id совпадает, реэкспорт как есть.
export { default } from '../../learning/enrollments/[id]/index.get'
