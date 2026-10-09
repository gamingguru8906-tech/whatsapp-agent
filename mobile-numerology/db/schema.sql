-- Leads from the free reading. One row per unique (name, mobile, concern, date of birth).
-- Run once in the Neon SQL editor (or psql) before the first deploy.
CREATE TABLE IF NOT EXISTS numerology_leads (
  id             BIGSERIAL PRIMARY KEY,
  dedupe_key     TEXT        NOT NULL UNIQUE,  -- sha256 of normalised name|mobile|concern|dob
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  name           TEXT        NOT NULL,
  mobile         TEXT        NOT NULL,         -- 10 digits
  dob            DATE        NOT NULL,
  concern        TEXT        NOT NULL,
  planned        TEXT        NOT NULL DEFAULT '', -- up to 3 numbers, comma separated (first submission kept)
  consent        BOOLEAN     NOT NULL,
  wa_opt_in      BOOLEAN     NOT NULL DEFAULT false,
  sheet_synced   BOOLEAN     NOT NULL DEFAULT false,
  sheet_attempts INTEGER     NOT NULL DEFAULT 0,
  sheet_error    TEXT
);

CREATE INDEX IF NOT EXISTS numerology_leads_unsynced ON numerology_leads (created_at) WHERE NOT sheet_synced;
