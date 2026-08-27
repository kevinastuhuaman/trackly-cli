# Deterministic answer resolution

After inventorying a visible employer form and before asking the user or
writing a control, map each visible question to an exact requested profile key
and expected type. Profile onboarding before an employer form exists uses the
canonical keys and public labels returned by readiness instead. Classify each
visible form question as `exact_profile`,
`safe_derivation`, `supported_draft`, `missing_fact`, `live_consent`, or
`forbidden_inference`. Fill only the first three; group only currently visible
unresolved needs for the user.

Before asking, query every applicable typed scope from narrowest to broadest:
run-only live choice, exact question and version, exact office, jurisdiction,
company, provider, then global. Reuse only a value whose canonical intent,
input type, sensitivity, question version, and permitted scope match. Narrower
answers override broader ones, and no answer moves to a broader scope without
explicit user confirmation. Ontology aliases or semantic retrieval may suggest
an intent but never authorize an answer; ambiguity fails closed. Keep only
value-free per-scope counts and fingerprints in operational receipts.

The current bounded profile projection is reusable authority. Conversation,
screenshots, parser output, autocomplete, and cached form values are not.
Parser output may suggest a mapping but never overrides canonical profile or a
user-edited value. Ordinary application names use canonical first/last-name
casing. A government-ID legal name requires its explicit restricted key.

Keep the frozen batch profile revision as the audit baseline while resolving
visible answers from the current authorized bounded projection. A newly saved
scoped answer may appear in that projection without changing the frozen
baseline number; this is expected, not permission to use stale data or bypass
the current work receipt's certification rules.

Employment status outranks legacy columns. Under `not_employed`, current
company/title are non-authoritative. Commit boolean No, an exact not-employed
option, or an intentionally blank optional current-employer text control; ask
only when a required control has no truthful representation. Prior-employer
questions use explicit most-recent-employer keys. Ambiguous status fails closed.

Interpret experience wording semantically: minimum brackets test the lower
bound, exact bands test both bounds, and “no more than” is a ceiling. Never
derive specialized-domain years from total PM tenure. Validate input types:
years require a number, Yes/No requires a boolean, English C2 is a CEFR value,
and SQL proficiency uses its own enum. Never coerce a mismatch.

Direct employment does not prove affiliate, contractor, family, friendship,
or referral status. Privacy notices, marketing, retention, arbitration,
background checks, recording, workplace policies, and truth certification are
separate decisions; truth certification is per run.

Region authorization is distinct from country authorization. Only explicit
membership in the confirmed region ontology can derive Yes; absence remains
unknown and must never become No or a country-scoped answer.

Commute willingness and cadence are exact employer-office facts. Resolve them
only from an `office` scope that combines the backend company ID with the
specific office identity; another office at the same employer remains unknown.

A visible employer accuracy checkbox is resolved as live consent before its
review-ready checkpoint. The separate Trackly truth certification happens
afterward for the exact durable review-ready member set.

For supported free text, use only canonical facts and job facts, make gaps
explicit, follow the writing reference, and retain final user truth review.
