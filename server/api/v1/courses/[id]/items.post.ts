// Алиас docs/04 §4.8: «CRUD /courses/:id/items» — элемент плана курса.
// Код и `docs/28` называют его «уроком»; путь `items` не заведён (docs/28 «Spec 11»).
// :id совпадает по имени с исходным маршрутом — реэкспорт без изменений (spec-04-routes).
export { default } from './lessons.post'
