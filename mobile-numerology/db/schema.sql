-- Leads from the free reading, in Kamala's database (same DATABASE_URL as the WhatsApp bot).
-- One row per unique (name, mobile, concern, date of birth): dedupe_key is sha256 of those four, normalised.
-- planned = up to 3 numbers, comma separated (first submission kept). mobile = 10 digits.
-- You do not need to run this: the Worker creates the table itself on the first lead (see db/schema.js,
-- which must stay identical; a test checks). Running it by hand in the Neon SQL editor is also safe.
CREATE TABLE IF NOT EXISTS numerology_leads (
  id             BIGSERIAL PRIMARY KEY,
  dedupe_key     TEXT        NOT NULL UNIQUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  name           TEXT        NOT NULL,
  mobile         TEXT        NOT NULL,
  dob            DATE        NOT NULL,
  concern        TEXT        NOT NULL,
  planned        TEXT        NOT NULL DEFAULT '',
  consent        BOOLEAN     NOT NULL,
  wa_opt_in      BOOLEAN     NOT NULL DEFAULT false,
  sheet_synced   BOOLEAN     NOT NULL DEFAULT false,
  sheet_attempts INTEGER     NOT NULL DEFAULT 0,
  sheet_error    TEXT
);

CREATE INDEX IF NOT EXISTS numerology_leads_unsynced ON numerology_leads (created_at) WHERE NOT sheet_synced;
