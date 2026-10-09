// The numerology_leads table in Kamala's database. The Worker runs these itself the first time a lead arrives
// (worker/store.js), so no manual SQL is needed. db/schema.sql holds the same statements for anyone who prefers
// to run them by hand; a test keeps the two identical.
export const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS numerology_leads (
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
)`,
  `CREATE INDEX IF NOT EXISTS numerology_leads_unsynced ON numerology_leads (created_at) WHERE NOT sheet_synced`
];
