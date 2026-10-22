-- 0006_series_start.sql: the date a series' recurrence is counted from (its RRULE DTSTART).
--
-- INTERVAL=2 ("every other month") and COUNT mean nothing without an anchor, so every series
-- needs one. NOT NULL with no default: no deployment holds series rows yet, and if one ever
-- does, this file must fail loudly rather than invent a first date.

ALTER TABLE event_series ADD COLUMN starts_on date NOT NULL;

COMMENT ON COLUMN event_series.starts_on IS
  'The first date of the series: the anchor its recurrence counts periods, INTERVAL and COUNT from.';
