-- debts-2, D-007 (docs/28 Spec 11 «Версии», docs/33): назначение ресурса закрепляется за опубликованной
-- версией на момент выдачи. Колонка — существующая assignments.subject_version_id (= content_version_id
-- из docs/02; для курса там course_versions.id). Бэкфилл: активные назначения ресурсов без версии получают
-- текущую опубликованную (resources.published_version_id) — ту, что ученики и так читали до сих пор.
UPDATE assignments a
SET subject_version_id = r.published_version_id
FROM resources r
WHERE a.subject_type = 'resource'
  AND a.subject_id = r.id
  AND a.subject_version_id IS NULL
  AND r.published_version_id IS NOT NULL;
