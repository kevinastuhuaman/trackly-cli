# Application writing integrity

Use this reference for free-text questions such as "Why this company?", motivation, or experience summaries.

## Calibrate once

- Read `writing.voice_sample` and `writing.style_instructions` from the resolved Trackly profile. A voice sample is learned from free-text answers the user actually approved, not requested as an onboarding prerequisite.
- These fields never block an application run when they are unknown. The user can continue with the plain default style for the current run or use saved style instructions; asking the user to paste a sample is a fallback only when they explicitly want to calibrate before a completed run provides approved text.
- Only after durable submitted/applied reconciliation, offer once to save one to three of the user's approved free-text answers as the global `writing.voice_sample`. Show which answers would be included, require an explicit yes, and save nothing on silence or ambiguity. Because the field is sensitive, make the offer only with active sensitive-storage consent; otherwise ask for consent first or skip it. If the user chooses to decline a voice sample, save `writing.voice_sample` with state `declined` at global scope and no answer text so the offer is not repeated. The user may also choose intentionally blank style instructions.
- Treat the sample and preferences as private user data. Never copy them into the public skill, logs, observations, or another user's defaults.
- A separate humanizer or writing skill may be used when available, but it is optional. This gate remains authoritative and self-contained.

## Draft from evidence

1. Answer the exact question using only canonical profile facts, resume evidence, and specific facts visible in the job posting.
2. Lead with the concrete overlap between the user's experience and the role. Avoid generic company praise or unsupported enthusiasm.
3. Prefer one or two specific proofs over a broad inventory of strengths. Never invent an achievement, employer, skill, or motivation.
4. Keep the response proportionate to the form. Short questions should receive short answers.

## Match the user's voice

- Match the sample's register, sentence length, paragraph breaks, first-person usage, punctuation, and level of informality.
- Honor explicit style instructions over generic defaults.
- Preserve readable quirks and personality. Do not polish every sentence into the same formal register.
- When no sample is available, default to plain first-person language, short paragraphs, and concrete evidence.

## Anti-slop gate

Before entering the response:

1. Remove generic praise, inflated claims, vague transitions, boilerplate conclusions, and chatbot phrases.
2. Rewrite `not just X, but Y`, ornamental rule-of-three lists, and dangling `-ing` clauses unless the user's sample clearly uses them naturally.
3. Resolve `writing.em_dash_policy`; unanswered defaults to `forbid`. Build the complete local claim-reference packet and set `claimsComplete: true` only after checking the whole draft. Call `trackly_lint_application_text` and treat its deterministic lint as a blocking gate. Missing claim metadata is a failure, even for an apparently claim-free draft. Never enter text with a failed lint result. `allow_if_voice_sample` requires explicit saved evidence that the approved sample uses that punctuation.
4. Vary sentence length and structure. Avoid a sequence of equally sized, equally formal sentences.
5. Prefer active verbs, concrete nouns, real numbers, and named examples already supported by the profile.
6. Read the answer aloud. If it sounds like a press release, generic cover letter, or assistant response, rewrite it.
7. When a voice sample exists, compare the final response with it for rhythm and register. When the sample was declined or remains unknown for the current run, use the saved style instructions or plain default instead. In every case, confirm each factual claim again.

## Strategically useful optional questions

When `writing.optional_question_policy` permits it, answer a strategically useful optional motivation, experience, product, or role-overlap question when every fact is supported. Optional does not mean skip. Leave demographic, consent, legal, compensation, and employer-relationship questions unanswered when their canonical value is unknown. Group those unknowns into the consolidated question packet.

Before entering any answer, supply value-free claim fingerprints and evidence-reference codes to the local linter. It returns only a draft hash, length, policy, and violation codes. It never echoes or sends the draft to Trackly.
