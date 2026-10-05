# Veshannastro WhatsApp funnel: 9:16 promo plan

Status: waiting on your specifications. Only a pipeline test has been rendered so far.
Made with the onetake skill (`.claude/skills/onetake`).

## What the film shows (taken from the code)

| step | what happens | what's on screen (real output of the bot) |
|---|---|---|
| 1 · Lead arrives | Instagram / Click-to-WhatsApp ad or website button; the source is tagged silently (`Ref: IG-DIWALI`, `AD-…`) | the first "Hi" |
| 2 · Kamala answers | instant, warm Hinglish reply | chat bubbles, "typing…" |
| 3 · Picks a service | interactive list "Veshannastro Services ✨" → category → service with price | WhatsApp list sheet |
| 4 · Details | only what that service needs: name, DOB (+ birth time and place for kundli, palm photos for palmistry), email; slot rule picks a valid time | short Q&A |
| 5 · Pays | proforma invoice PDF + Razorpay payment link | document bubble, link |
| 6 · Booked | payment verified → paid invoice `VA/26-27/10-001`, Google Meet link, calendar event, Kamala's thank-you voice note | receipt PDF, Meet link, voice note |
| 7 · Before the call | check-in, reminder 30 min before | reminder message |
| 8 · Owner side | hot-lead alert, "📅 You have a consultation", Google Sheets CRM, `/analytics`, purchase reported to Meta | owner alerts, Sheet |
| (+) Phone Kamala | answers calls by voice, sends the payment link on WhatsApp | call screen |

## Format

- **1080 × 1920, 30 fps drafts.** A 2-second test rendered in 37 s on this machine, so a 20-second draft takes about 6 minutes.
  The final is 1080 × 1920 at 60 fps (enough for Reels, Status and Shorts), or 2160 × 3840 if you want 4K. Final renders take several times longer; I'll give you an estimate before starting one.
- **Safe zones.** Keep text clear of the top ~250 px, the bottom ~420 px (~670 px if it runs as a paid
  ad) and ~65 px at the sides, where Instagram and YouTube overlay their buttons and captions.
- **Assume it plays muted.** Reels autoplay without sound, so the on-screen words have to tell the story by themselves and the first second has to hook.

## Three concepts. You pick one.

**A · One bubble becomes the booking.**
A single green chat bubble is the whole film. Kamala answers it, then the bubble opens into the services list. The chosen row
stretches into the details card (name · DOB · time · place), and the card folds into the invoice PDF. The Pay button fills into the payment tick,
the tick rolls into the calendar slot, and the slot becomes the play button of Kamala's voice note. At the end, the waveform settles into
the line under the wordmark.
- Hook (0–1 s): an empty tall frame; at 11:47 PM a bubble pops in at the bottom and its ticks turn blue.
- Link between beats: the bubble shape itself changes into each next thing; the camera rides it up the tall frame.
- Rules out: phone mock-ups, screen-to-screen swaps, cross-fading cards.
- Look: colours taken from your screenshots (WhatsApp beige + green, plus the brand's saffron) via
  `look.py from-shot`; the fallback is the **paper** preset.

**B · One dive from the night sky to a booked call.**
The film opens on a tall night sky. One star brightens: it is the unread dot of a new lead. The camera dives into it:
the star becomes the chat's online dot, then the payment tick, then the dot on the Meet link. Then it pulls back out to the sky, where tonight's
paid bookings now form a constellation.
- Hook: a dark frame and one star flaring. A tall sky suits 9:16.
- Link between beats: scale. Each level sits inside the one before it, and the camera never cuts.
- Rules out: a flat tour of the UI; any hard cut except the end card.
- Look: the **dusk** preset (near-black violet, one warm yellow subject). It reads as astrology without zodiac clip-art.

**C · The funnel falls through the night.**
The tall frame is a shaft of time, from 11:47 PM at the top to 7:02 AM at the bottom. The lead's message drops, and
everything it hits starts the next step: reply → services → details → payment link → payment → invoice → Meet link. The last one lands on
Shashank ji's phone at dawn: "📅 You have a consultation".
- Hook: a bubble falls into the frame and strikes something.
- Link between beats: cause. Every collision starts the next beat; gravity runs down the 9:16 frame and the camera follows it down.
- Rules out: anything that appears without being hit.
- Look: made for this film. The background shifts from midnight indigo to saffron dawn as the shaft descends; that colour shift is the film's one transition.

Which to pick: **A** reads most clearly with the sound off, so it suits ads aimed at clients. **B** is the most cinematic and the most "brand".
**C** sells "it works while you sleep", which is strongest if the audience is other business owners.

## Draft beat sheet for A, 20 s (rewritten once you pick)

Bracketed copy is a placeholder. Every claim and number on screen will come from you or from the bot's real output.

| t (s) | beat | moves | still | carries into next |
|---|---|---|---|---|
| 0.0–1.0 | hook | the "Hi 🙏" bubble pops in, ticks turn blue | ground | the bubble |
| 1.0–3.2 | Kamala answers | "typing…" then the reply grows out of the bubble's edge | the lead's bubble | the reply bubble |
| 3.2–4.1 | 3 word hits, 0.3 s each | [your three words] land with squash | the chat | the last word drops into the reply |
| 4.1–6.5 | services | the reply opens into the services list; a finger taps one row | the list's other rows | the tapped row |
| 6.5–8.5 | details | the row stretches into the details card; fields fill one by one | the card frame | the card |
| 8.5–10.9 | **hold** | the card folds into the invoice PDF bubble, then everything stops; near silence | everything | the Pay button |
| 10.9–11.4 | pay (hit) | the button fills and the payment tick snaps in | the PDF | the tick |
| 11.4–13.0 | booked | the tick rolls into the calendar slot; the Meet link drops in | the slot | the slot |
| 13.0–15.5 | thank-you | the slot becomes the voice note's play button; the waveform plays | the chat | the waveform |
| 15.5–16.4 | burst: 3 hard cuts | invoice no. · Meet link · owner alert "📅 You have a consultation" | — | the waveform line |
| 16.4–20.0 | end card | the waveform flattens into the line under the wordmark; [CTA]; hold | everything | — |

The rhythm checks out: the shortest shot (0.3 s) and the longest (2.4 s) differ by 8× (the skill asks for at least 4×). There is one near-silent hold before
the payment hit, one burst of hard cuts, and every other boundary hands something on to the next beat.

## What I need from you

1. **Audience and goal:** an ad that gets clients to message Veshannastro, or a showcase of the funnel itself, to sell
   it or show it to other businesses?
2. **Length and where it goes:** 15 / 20 / 30 s; Reels, Shorts, WhatsApp Status, or a paid ad?
3. **On-screen language:** Hinglish (as Kamala texts), Hindi, or English.
4. **Sound:** music only, or a voice-over too?
5. **Real material** (anonymised): screenshots of a real chat with Kamala, the services list, a proforma invoice PDF, the
   payment-confirmed message with the Meet link, the voice note and an owner alert. Also tell me which service and price to show.
6. **Brand:** logo, colours, fonts, Shashank ji's photo (yes or no), and the CTA (number, link or a `Ref:` code to track the video).
7. **A reference reel** whose feel you like. This is optional but recommended: I measure its stillness, cuts and easing first.

## Notes

- The bot currently charges ₹1 as a gateway test and says so in its messages. The film will show the real price and the
  regular paid-booking messages, never the test wording.
- In a version aimed at clients, Kamala appears as "our assistant on WhatsApp". The film won't claim she is a person.
- The chat will be rebuilt to look like WhatsApp but without WhatsApp's logo, unless you want Meta's official "Chat on WhatsApp"
  button, used per their brand rules.
- The skill's built-in voice (Kokoro) only speaks English and Japanese. A Hindi or Hinglish voice-over would need Sarvam (already
  in this repo's config; needs `SARVAM_API_KEY`) or your own recording.
- Music will be royalty-free unless you supply a track you have the rights to.

## Once the specs arrive

1. Measure the reference clip, if you send one.
2. You pick a concept and a look.
3. Write the real beat sheet.
4. Rebuild the chat UI in HTML from your screenshots and check it side by side against them.
5. Build the video at 1080 × 1920 from the skill's move library, then check stills and the beat-to-beat links.
6. Render a draft (about 6 min for 20 s), add sound, run the skill's quality checks, then show it to you.
7. Render the final after you approve the draft.
