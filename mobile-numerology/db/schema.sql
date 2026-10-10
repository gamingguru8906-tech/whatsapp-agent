-- Leads from the free reading, in Kamala's database (same DATABASE_URL as the WhatsApp bot).
-- One row per unique (name, mobile, concern, date of birth): dedupe_key is sha256 of those four, normalised.
-- planned = up to 3 numbers, comma separated (first submission kept). mobile = 10 digits.
-- reading_summary = the reading's key points in the rulebook's words, for Kamala on WhatsApp.
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
  reading_summary TEXT       NOT NULL DEFAULT '',
  sheet_synced   BOOLEAN     NOT NULL DEFAULT false,
  sheet_attempts INTEGER     NOT NULL DEFAULT 0,
  sheet_error    TEXT
);

CREATE INDEX IF NOT EXISTS numerology_leads_unsynced ON numerology_leads (created_at) WHERE NOT sheet_synced;

CREATE INDEX IF NOT EXISTS numerology_leads_mobile ON numerology_leads (mobile);

ALTER TABLE numerology_leads ADD COLUMN IF NOT EXISTS reading_summary TEXT NOT NULL DEFAULT '';

-- What the visitor entered that the columns above do not hold (the watch details), for "My readings".
ALTER TABLE numerology_leads ADD COLUMN IF NOT EXISTS inputs JSONB;

-- Sign-in with WhatsApp: code shown on the page, sent as "LOGIN <code>" to Kamala, who marks it verified with the
-- sender's number. Only the SHA-256 of the browser's token is stored.
CREATE TABLE IF NOT EXISTS numerology_logins (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT        NOT NULL,
  token_hash  TEXT        NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ,
  phone       TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS numerology_logins_open_code ON numerology_logins (code) WHERE verified_at IS NULL;
