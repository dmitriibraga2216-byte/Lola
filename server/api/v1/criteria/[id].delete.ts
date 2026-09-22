// Алиас docs/04 §4.13: «DELETE /criteria/:id». Реальный обработчик живёт под /assessment/criteria/:id
// (Spec 20 переименовал справочник), но сам маршрут по форме идентичен — :id совпадает по имени,
// реэкспорт без изменений (docs/33 D-064, `debts-final-b`).
export { default } from '../assessment/criteria/[id]/index.delete'
