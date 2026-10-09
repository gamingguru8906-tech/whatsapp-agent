# Veshannastro Mobile Numerology (free web tool)

Rule-based mobile-number reading. No AI at runtime: every line shown to a visitor comes from a rule in
`rules/`, and every rule cites a slide or transcript line in `sources/`.

- `sources/` — the numerologists' material, saved verbatim (P01 = SRK PDF, T01–T03 = transcripts)
- `rules/` — the rulebook built from the sources (reviewed and approved by the owner)
- `engine/` — pure, deterministic calculation (no dependencies)
- `worker/` — Cloudflare Worker: the site, `POST /api/reading`, lead storage (Neon + Google Sheet, no duplicates)
- `web/` — the website (React + Tailwind, light theme, owner's brand tokens)
- `apps-script/` — the Google Sheet script; `db/schema.sql` — the database table
- `DEPLOY.md` — going live, step by step

- `AUDIT.md` — how every rule is checked against the sources (`npm test` runs it)
- `RULEBOOK_REVIEW.md` — the full rulebook as a table
