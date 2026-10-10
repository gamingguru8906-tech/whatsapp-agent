// Assembles the rulebook from rules/*.json and applies the owner's review decisions (rules/review.json):
// approved wording edits ("overrides") and conflict decisions.
import shotgun from '../rules/shotgun.json' with { type: 'json' };
import yogas from '../rules/yogas.json' with { type: 'json' };
import planets from '../rules/planets.json' with { type: 'json' };
import professions from '../rules/professions.json' with { type: 'json' };
import remedies from '../rules/remedies.json' with { type: 'json' };
import personalYear from '../rules/personal-year.json' with { type: 'json' };
import conflicts from '../rules/conflicts.json' with { type: 'json' };
import method from '../rules/method.json' with { type: 'json' };
import keywords from '../rules/concern-keywords.json' with { type: 'json' };
import notFor from '../rules/not-for.json' with { type: 'json' };
import review from '../rules/review.json' with { type: 'json' };

export function applyReview(base, rv = { overrides: {}, conflicts: {} }) {
  const book = structuredClone(base);
  const overrides = rv.overrides ?? {};
  for (const set of [book.shotgun, book.yogas]) {
    for (const r of set.rules) if (overrides[r.id]?.story) r.story = { ...r.story, ...overrides[r.id].story };
  }
  for (const items of Object.values(book.personalYear.years)) {
    for (const it of items) if (overrides[it.id]?.text) it.text = overrides[it.id].text;
  }
  for (const c of book.conflicts.conflicts) {
    if (rv.conflicts?.[c.id] !== undefined) c.decision = rv.conflicts[c.id];
  }
  return book;
}

export const baseRulebook = { shotgun, yogas, planets, professions, remedies, personalYear, conflicts, method, keywords, notFor };
export const rulebook = applyReview(baseRulebook, review);
