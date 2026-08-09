# Application writing

Draft application text only from facts supported by the user's confirmed profile, resume artifact, or the current job record.

Before entering a draft:

1. Identify every factual claim in the draft.
2. Bind each claim to a confirmed source.
3. Remove or ask about any unsupported claim.
4. Verify every claim against the user-approved facts and role details before linting. Call `trackly_lint_application_text` with the complete draft in its `items` input; the lint tool checks deterministic text constraints and does not receive claim references.
5. Enter the draft only after lint passes.

Never invent motivation, metrics, dates, responsibilities, credentials, relationships, or eligibility. Keep the user's voice and requested length. Do not use a writing preference from one user as a default for another.
