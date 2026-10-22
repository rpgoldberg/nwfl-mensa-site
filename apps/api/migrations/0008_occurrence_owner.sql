-- 0008_occurrence_owner.sql: who owns a one-off event (R3, P19).
--
-- An occurrence of a series belongs to the series' host office. A one-off event has no series,
-- so it records its own owning office: the office whose holders may edit or cancel it. NULL is
-- allowed (seeded events predate it); only the Admin may then change the event.

ALTER TABLE event_occurrence ADD COLUMN owner_office_id uuid REFERENCES office (id);
