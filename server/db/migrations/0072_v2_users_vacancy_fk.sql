-- docs/v2/45-plan.md PR-15 (вторая миграция) · docs/v2/44-decisions.md В-13 ·
-- docs/v2/28-recruiting-candidates.md §3.2 · docs/v2/40-data-model-delta.md §5 (развязка «0013»).
--
-- **Миграция-развязка.** Цикл «кандидаты ↔ вакансии» настоящий:
--   users.vacancy_id → vacancies(id) → vacancies.recruiter_id → users(id).
-- Порядка создания таблиц, снимающего его, не существует, а `deferrable initially deferred`
-- не помогает: это про момент проверки внутри транзакции (DML), тогда как проблема здесь —
-- порядок создания объектов (DDL). Поэтому В-13 выбирает единственный оставшийся вариант:
-- колонка заводится без ключа в миграции своей таблицы, а ключ добавляется отдельной
-- миграцией после того, как обе таблицы существуют. Две миграции, не одна.
--
-- Второй ключ той же пары — `users_candidate_status_id_fk` — уже стоит с 0064_v2_candidates:
-- там `candidate_statuses` создавалась в том же файле выше `alter table users`, цикл DDL
-- снимался порядком внутри файла, и держать колонку без ссылочной целостности до этой
-- миграции было бы окном без всякой пользы. После этого файла оба ключа цикла 28 ↔ 29 стоят
-- по именам из В-13 — это и проверяет девятый контрактный тест
-- `tests/integration/deferred-fk.spec.ts`.
--
-- `on delete set null`, не `cascade`: удаление вакансии не должно уносить кандидата.
-- Человек, откликнувшийся на снятую вакансию, остаётся в воронке — иначе закрытие вакансии
-- стирало бы людей, о которых рекрутер ещё принимает решение (`29` §4, `28` §12.3).

ALTER TABLE "users" ADD COLUMN "vacancy_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_vacancy_id_fk" FOREIGN KEY ("vacancy_id") REFERENCES "public"."vacancies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Частичный индекс: вакансия бывает только у кандидата (`28` §3.2 DDL). Полный индекс по той
-- же паре рядом не нужен — выборок «сотрудники по вакансии» не существует и не появится.
CREATE INDEX "idx_users_tenant_vacancy" ON "users" USING btree ("tenant_id","vacancy_id") WHERE kind = 'candidate';
