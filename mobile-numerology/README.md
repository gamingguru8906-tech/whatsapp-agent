# Veshannastro Mobile Numerology (free web tool)

Rule-based mobile-number reading. No AI at runtime: every line shown to a visitor comes from a rule in
`rules/`, and every rule cites a slide or transcript line in `sources/`.

- `sources/` — the numerologists' material, saved verbatim (P01 = SRK PDF, T01–T03 = transcripts)
- `rules/` — the rulebook built from the sources (reviewed and approved by the owner)
- `engine/` — pure, deterministic calculation (no dependencies)
- `worker/` — Cloudflare Worker: the site, `POST /api/reading`, lead storage (no duplicates) in Kamala's database
  (table `numerology_leads`) and Kamala's CRM Sheet ("Numerology Leads" tab). Only the data is shared with Kamala;
  the code stays separate. Kamala shows these leads to the owner with `/numerology`.
- `web/` — the website (React + Tailwind, light theme, owner's brand tokens)
- `apps-script/` — an extra file for Kamala's Apps Script project (the "Numerology Leads" tab); `db/` — the table,
  which the Worker creates itself on the first lead
- `DEPLOY.md` — going live, step by step

- `AUDIT.md` — how every rule is checked against the sources (`npm test` runs it)
- `RULEBOOK_REVIEW.md` — the full rulebook as a table
