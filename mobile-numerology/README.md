# Veshannastro Mobile Numerology (free web tool)

Rule-based mobile-number reading. No AI at runtime: every line shown to a visitor comes from a rule in
`rules/`, and every rule cites a slide or transcript line in `sources/`.

- `sources/` — the numerologists' material, saved verbatim (P01 = SRK PDF, T01–T03 = transcripts)
- `rules/` — the rulebook built from the sources (reviewed and approved by the owner)
- `engine/` — pure, deterministic calculation (no dependencies)

Plan and decisions: see `RULEBOOK_REVIEW.md` once generated.
