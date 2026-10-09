# Source audit (2026-10-09)

The owner approved every rule and asked for one check: every rule comes from the sources they gave, and nothing
comes from Claude. This is how that was checked, and what changed as a result.

## How it is checked (automatically, on every `npm test`)

| Check | Script | Result |
|---|---|---|
| Every rule's quote exists word for word in `sources/` | `npm run lint:rules` | 255 / 255 rules |
| Every PDF quote also exists in the PDF's own text layer (not just in our transcription) | one-off `pdftotext` check | 214 / 214 quote parts |
| Every yoga's present / absent digits match the grid diagram on its slide | `npm run audit` | 47 / 47 diagrams |
| Every shot-gun line, profession line (with its codes), remedy and planet on the slides has a rule | `npm run audit` | 37, 14, 9, 9 — none missing |
| Every word and number a visitor reads appears in that rule's own source passage, or is a paraphrase checked by hand and listed in `rules/audit-reviewed.json` | `npm run audit` | passes; an invented test phrase ("crorepati by 40") is rejected |
| The PDF's own examples work: Rajiv Gandhi 20/8/1944 → Moon-Saturn-Rahu; Sania Mirza 15/11/1986 → 1-6-5-8 Raj Yog; all personal-year examples in T01 and T03 | `npm test` | pass |

The reviewed paraphrases are spelling and word forms only (Govt → government, FORGEIN → foreign, DIABITIES →
diabetes, favorable → favourable), connecting words, and condensed lists. Any new word in the site wording that is not
in its source and not on that list fails the build.

## Wording that came from Claude, now removed

| Rule | Was (Claude's addition) | Now (source) |
|---|---|---|
| SG-34, SG-68 | "…so your health needs care" | removed |
| PY7-T01-d | "Please also consult a doctor" inside the rule | removed (the site-wide health note remains) |
| PY4-T01-g | "a full chart reading needs your time and place of birth" | T01's words: Rahu's house (1st/5th favourable; 12th, Shatabhisha, Swati difficult); know your chart, nakshatra and Moon sign; ask an astrologer |
| YG-P-178 | "a sharp tongue" | "a black tongue" (as on slide 26) |
| YG-P-284 | "little control over speech when angry"; "The source also links…" | "No control over speech when aggressive"; "Chances of death by accident" |
| SG-23 | "…as much as you hope" | "a lack of response from your child" |
| SG-69 | "…outside your commitment" | "involvement with the opposite sex" |
| SG-26 | "strong attraction" | "attraction" |
| SG-78 | "feel low… at times" | "may get depressed" |
| SG-24 | "success becomes harder" | "without patience, success does not come" |
| SG-48, YG-C-78, YG-C-84, YG-L-584 | "weaker / less fulfilling sexual life" | "lack of (good) sexual life" |
| SG-15 | "shubh (auspicious)" | "Shubha Yoga" |
| SG-16 | "phases with no income" | "no income at the time of speaking" |
| SG-56 | "hesitate to ask for money you are owed" | "unable to ask for money" |
| PL-3 | "respectful to all" | "gives respect to people of low class" |
| PY2-T01-a, PY7-T01-a, PY9-T03-e | "helps you most", "a little", "truly" | removed |

## Source guidance that had been missed, now added (each with its exact quote)

- **PY1-T01-h** (T01): a poorly placed Sun linked with reputation problems or job loss; conflict with elders or father as its sign.
- **PY6-T01-h** (T01): the signs of a "negative Venus".
- **PY9-T01-j** (T01): measurable physical goals when no sports facility is available.
- **PY-ALL-4** (T01): use and practice matter more than changing official documents.
- **PY-ALL-5** (T01): to improve a business, a well-lit place on a clean street, no basements, no speculative work (shown only when the concern is about work or business).
- **PY-ALL-6, PY-ALL-7** (T02): wake early, plan the day, master one skill; listen, speak kindly, be honest, avoid rudeness.
- The reasons the speakers give were added to their advice: PY1-T03-f, PY2-T01-c, PY2-T03-a, PY2-T03-c, PY3-T01-d, PY5-T01-c, PY6-T03-h, PY7-T03-e, PY9-T03-d.

## Left out on purpose

| What | Where | Why |
|---|---|---|
| Advice given to one named viewer (Canada, IVF, government job, exam, specific birth dates, business ideas for one person) | T01 | Personal to that viewer, not a rule. The birth-date examples are used as tests. |
| 2025 universal-year habits, Sensex / gold / defence / Zomato / India forecasts, defence-sector stock tip | T03 | Tied to 2025, or financial predictions. |
| Programmes, WhatsApp groups, crystal shop, phone numbers, Dubai meetings | T01, T02, P01 | Promotion, not guidance. |
| Combinations 127, 1271, 361, 581, numbers 16 and 42; repeated / missing numbers; "reducing a repeated number" | T02 | The transcript names them but never says what they mean or which number they apply to. |
| Kiran Bedi, Rajiv Gandhi, Sania Mirza | P01 | Example people, not shown on the site; two are used as tests. |
| "Friendly number" (birth number 4 remedy) | P01 | Not defined in any source. |

## Still open before launch

Two places where the transcripts disagree need the owner's choice (`rules/conflicts.json`). Until then the site shows
neither side, and `npm run lint:rules:strict` fails:

- Personal Year 9 colours: T01 says avoid black, T03 lists black as recommended.
- Personal Year 8 outlook: T01 says possible job loss, T03 says opportunities to earn.
