# Answer compounding

Use this workflow whenever the user supplies, corrects, or confirms an answer
that could be reused. Its goal is one fast, auditable save instead of repeated
questions and piecemeal profile writes.

## Resolve before writing

1. Collect all newly supplied answers from the current question packet.
2. Fetch the current profile schema and the smallest relevant profile
   projection once. Include `provider`, `company`, `jurisdiction`, and `office`
   when that context is known and required. An office scope value is the exact
   backend company ID plus a stable office identity, for example
   `42:waltham-ma`; never derive it from a display name alone. Corporate-family reuse is unavailable until
   Trackly has an authoritative company-family registry; never derive a family
   identity from names, logos, page text, parent-company knowledge, or search.
3. Map each answer to an exposed canonical key and permitted scope. Never call
   a field missing merely because it was absent from the compact execution
   snapshot; contextual fields require a targeted profile fetch.
4. Validate the expected input type before mapping or writing. “Whole number”
   requires a number, and “Yes or No” requires a boolean. A mismatch remains
   unresolved and returns to the grouped packet; never coerce a boolean into
   years, a proficiency label into a language level, or vice versa.
5. Classify every answer as exactly one of:
   - `saved`: a canonical field exists and this run changed it;
   - `already_matched`: the canonical field already contains the same state and
     value at the resolved scope;
   - `schema_missing`: no canonical field can represent the answer after the
     live schema audit;
   - `run_only_contextual`: the answer is intentionally per-run, such as the
     final truthfulness certification, and must not enter the reusable profile.
6. Ask scope only when the user's wording and the schema do not determine it.
   “Always” means global only for fields whose schema permits global scope.

Compound a reusable gap only when a visible form requires it. Defer optional
profile gaps that no current visible application needs; do not turn the full
schema into an onboarding questionnaire.

## One write and one verification

- Send all `saved` changes in one `trackly_update_application_profile` call
  with the latest `expectedRevision`. Do not write `already_matched` entries
  and do not manufacture a revision change for a no-op.
- If the bulk write returns an ambiguous transport failure or HTTP 5xx, refetch
  the same projection before retrying. The first request may have committed.
  Retry only the still-unapplied changes with a fresh expected revision.
- Refetch once after the write and verify every reusable `saved` and
  `already_matched` entry at its exact scope. Do not perform a fetch after each
  answer. Policy acknowledgements are the exception: they are audit-only, not
  reusable answers. Verify their company scope and `questionFingerprint` when
  the backend exposes that metadata, never require a reusable state or value,
  and retain the ask-again behavior described below.
- Keep restricted values out of mechanics observations and progress messages.

## Required receipt

Before truth certification or a review-ready checkpoint, show a compact answer
receipt. It may name the question or canonical key and scope, but should redact
restricted values unless the user needs them for review.

```text
Answer sync
- saved: <field> (<scope>)
- already in Trackly: <field> (<scope>)
- schema gap: <plain-language field need>
- this application only: <attestation or contextual decision>
```

Every answer supplied in the packet must appear exactly once in the receipt.
An unreceipted reusable answer blocks review handoff. A `schema_missing` answer
may be used locally for the current form, but never PATCH an invented key or
claim that Trackly learned it.

## Current contextual routing

- Country-specific work authorization:
  `authorization.legally_authorized_by_country` at `jurisdiction` scope.
- Employer-office commute willingness and cadence:
  `location.commute_willing`, `location.commute_days_per_week`, and
  `location.commute_commitment` at exact `office` scope. Never reuse an answer
  for another office of the same company.
- Prior interview with the employer:
  `employment.previously_interviewed_at_employer` at `company` scope.
- Employment, contracting, consulting, temporary work, or similar engagement
  with an employer's corporate family:
  `employment.previously_engaged_with_corporate_family` at exact `company`
  scope, paired with `employment.corporate_family_engagement_types_checked`
  at the same scope.
  Reuse a negative answer only when the new question is no broader than the
  recorded relationship types and concerns the same company. Never reuse these
  fields for affiliates.
- Employer candidate-AI policy acknowledgement:
  `consent.candidate_ai_guidance_acknowledged` at `company` scope. Send the
  exact policy question or published version as `questionLabel`. Treat this as
  `run_only_contextual` for answer reuse and ask again: Trackly may retain the
  prior company-scoped fingerprint for audit, but no client may reuse it until
  the backend can prove a match. A write receipt or refetch verifies only the
  company scope and `questionFingerprint`; a redacted, unknown, or absent
  reusable value is expected and must not block truth certification or review.
- Named applicant privacy-notice routing:
  `consent.named_applicant_privacy_notice_acknowledgement_policy` is a global
  routing policy, not consent to unseen text. `acknowledge_named_notice_only`
  permits only a visible, unbundled named applicant notice; `ask` remains a
  live question. Marketing, retention, arbitration, background-check,
  recording, AI, and data-sharing choices stay separate.
- Interview recording or transcription consent and workplace-policy
  acknowledgement: use `consent.interview_recording` and
  `consent.workplace_policy_acknowledgement` only at exact company scope with
  the current policy question or version as `questionLabel`. Both are
  `run_only_contextual`: retain the fingerprint for audit, ask again, and never
  require a reusable returned value during the verification refetch.
- Consumer hardware, IoT, or retail experience level and supporting summary:
  the two global `employment.consumer_hardware_iot_retail_experience_*` fields.
- Residential city and EEO sexual orientation remain their existing canonical
  fields. Audit them before declaring a schema gap.
