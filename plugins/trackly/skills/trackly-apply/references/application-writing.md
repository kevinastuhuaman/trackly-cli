# Application writing

Draft application text only from facts supported by the user's confirmed profile, resume artifact, or the current job record.

When policy permits a strategically useful optional prompt and all facts are
supported, do not leave it blank. Draft it, expose unsupported gaps instead of
inventing facts, check the user's voice and length rules, commit it, and reread
the live control before truth review.

Before entering a draft:

1. Identify every factual claim in the draft.
2. Bind each claim to a confirmed source.
3. Remove or ask about any unsupported claim.
4. Verify every claim against the user-approved facts and role details before linting. Keep the complete draft local; never silently send it or a multi-field packet to trackly.
5. Remote lint is optional. For one non-sensitive field only, show the user the exact field label and exact text revision that would be processed, explain that `trackly_lint_application_text` processes it transiently in memory without logging, storing, or echoing the text, and obtain explicit approval for that exact field text. Approval does not carry to another field or revision. After approval, call the tool with exactly one `items` entry and no claim references, contact data, legal or immigration answers, credentials, demographic data, compensation data, or other sensitive content.
6. If the user declines, does not answer, or gives ambiguous approval, do not call remote lint. Apply local required/minimum/maximum-length checks, inspect unsupported claims locally, and hand the field to the user for manual review.
7. Enter the draft only after the approved remote lint passes or the local/manual fallback is complete.

Never invent motivation, metrics, dates, responsibilities, credentials, relationships, or eligibility. Keep the user's voice and requested length. Do not use a writing preference from one user as a default for another.
