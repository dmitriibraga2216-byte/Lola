ALTER TABLE "meetup_sessions" ADD COLUMN "external_event_id" text;--> statement-breakpoint
ALTER TABLE "meetup_sessions" ADD COLUMN "external_meeting_id" text;--> statement-breakpoint
-- docs/33 D-029: перенос одноразових карток meetup|webinar на модель сесій (docs/28 Spec 18) —
-- по одній сесії на кожну стару картку без жодної сесії, реєстрації і облік перегляду вебінару
-- переносяться разом з нею; сама картка не змінюється (лишається архівом останнього стану,
-- CLAUDE.md п. 5 — руками в БД не лізли, тільки міграцією).
WITH candidates AS (
  SELECT m.id AS meetup_id, m.tenant_id, m.starts_at, m.ends_at, m.timezone, m.location_id, m.room, m.address,
         m.trainer_ids, m.capacity, m.waitlist_enabled, m.enroll_deadline_hours, m.cancel_deadline_hours,
         m.attendance_mode, m.qr_secret, m.status, m.cancel_reason, m.external_event_id, m.created_by,
         w.provider AS w_provider, w.join_url AS w_join_url, w.host_url AS w_host_url, w.external_meeting_id AS w_external_meeting_id
  FROM meetups m
  LEFT JOIN webinars w ON w.meetup_id = m.id
  WHERE m.kind IN ('meetup', 'webinar')
    AND m.status IN ('planned', 'ongoing', 'finished', 'cancelled')
    AND NOT EXISTS (SELECT 1 FROM meetup_sessions s WHERE s.meetup_id = m.id)
),
ins AS (
  INSERT INTO meetup_sessions (
    tenant_id, meetup_id, task_id, starts_at, ends_at, timezone, location_id, room, address, trainer_ids,
    join_url, host_url, provider, capacity, waitlist_enabled, enroll_deadline_hours, cancel_deadline_hours,
    attendance_mode, qr_secret, status, cancel_reason, external_event_id, external_meeting_id, created_by
  )
  SELECT tenant_id, meetup_id, NULL::uuid, starts_at, ends_at, timezone, location_id, room, address, trainer_ids,
         w_join_url, w_host_url, w_provider, capacity, waitlist_enabled, enroll_deadline_hours, cancel_deadline_hours,
         attendance_mode, qr_secret, status, cancel_reason, external_event_id, w_external_meeting_id, created_by
  FROM candidates
  RETURNING id, meetup_id, tenant_id, starts_at, ends_at
)
INSERT INTO meetup_session_registrations (
  tenant_id, session_id, user_id, status, registered_at, registered_by, waitlist_position,
  checked_in_at, check_in_method, checked_in_by, cancel_reason, guests_count, enrollment_id, lesson_id,
  seconds_watched, watch_pct
)
SELECT ins.tenant_id, ins.id, r.user_id, r.status, r.registered_at, r.registered_by, r.waitlist_position,
       r.checked_in_at, r.check_in_method, r.checked_in_by, r.cancel_reason, r.guests_count, r.enrollment_id, r.lesson_id,
       COALESCE(wp.minutes, 0) * 60 AS seconds_watched,
       CASE WHEN wp.minutes IS NOT NULL
         THEN round((wp.minutes * 60)::numeric / GREATEST(1, EXTRACT(EPOCH FROM (ins.ends_at - ins.starts_at))) * 100, 2)
       END AS watch_pct
FROM ins
JOIN meetup_registrations r ON r.meetup_id = ins.meetup_id
LEFT JOIN webinars w2 ON w2.meetup_id = ins.meetup_id
LEFT JOIN webinar_participations wp ON wp.webinar_id = w2.id AND wp.user_id = r.user_id
ON CONFLICT (session_id, user_id) DO NOTHING;