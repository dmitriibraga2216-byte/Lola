-- docs/33 D-061: у /manage/catalog/requests заявка = запис зі status='not_assigned' і заповненим
-- requested_at (server/services/learningRequests.ts). Усі поточні шляхи створення такого запису
-- (requestEnrollment у learning.ts, catalog-заявка у programs.ts, requestTrajectory у trajectories.ts)
-- завжди пишуть requested_at разом зі статусом; єдине джерело розбіжності — записи, створені до
-- того, як ці шляхи стали це гарантувати (для program_enrollments це вже було закрито міграцією
-- 0026, тут — data-only бекофіл про всяк випадок і для enrollments/trajectory_enrollments,
-- якщо в проді лишились такі рядки). Дата — created_at запису, найближче наближення до моменту
-- подачі заявки; на статус і аудит не впливає, тільки на видимість у черзі рішень.
UPDATE "enrollments" SET "requested_at" = "created_at"
  WHERE "status" = 'not_assigned' AND "source" = 'catalog' AND "requested_at" IS NULL;--> statement-breakpoint
UPDATE "program_enrollments" SET "requested_at" = "created_at"
  WHERE "status" = 'not_assigned' AND "requested_at" IS NULL;--> statement-breakpoint
UPDATE "trajectory_enrollments" SET "requested_at" = "created_at"
  WHERE "status" = 'not_assigned' AND "requested_at" IS NULL;
