// Алиас docs/04 §4.8: «CRUD /courses/:id/sections» — раздел плана курса.
// Код и `docs/28` называют его «модулем»; путь `sections` не заведён (docs/28 «Spec 11»).
// :id совпадает по имени с исходным маршрутом — реэкспорт без изменений (spec-04-routes).
export { default } from './modules.post'
