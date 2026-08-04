# Answer compounding

Use this workflow whenever the user supplies, corrects, or confirms an answer
that could be reused. Its goal is one fast, auditable save instead of repeated
questions and piecemeal profile writes.

## Resolve before writing

1. Collect all newly supplied answers from the current question packet.
2. Fetch the current profile schema and the smallest relevant profile
   projection once. Include `provider`, `company`, and `jurisdiction` when that
   context is known and required. Include `corporateFamily` only when Trackly
   itself supplied a stable `cf_...` family ID. Never derive one from employer
   names, logos, page text, parent-company knowledge, or search results.
3. Map each answer to an exposed canonical key and permitted scope. Never call
   a field missing merely because it was absent from the compact execution
   snapshot; contextual fields require a targeted profile fetch.
4. Classify every answer as exactly one of:
   - `saved`: a canonical field exists and this run changed it;
   - `already_matched`: the canonical field already contains the same state and
     value at the resolved scope;
   - `schema_missing`: no canonical field can represent the answer after the
     live schema audit;
   - `run_only_contextual`: the answer is intentionally per-run, such as the
     final truthfulness certification, and must not enter the reusable profile.
5. Ask scope only when the user's wording and the schema do not determine it.
   “Always” means global only for fields whose schema permits global scope.

## One write and one verification

- Send all `saved` changes in one `trackly_update_application_profile` call
  with the latest `expectedRevision`. Do not write `already_matched` entries
  and do not manufacture a revision change for a no-op.
- If the bulk write returns an ambiguous transport failure or HTTP 5xx, refetch
  the same projection before retrying. The first request may have committed.
  Retry only the still-unapplied changes with a fresh expected revision.
- Refetch once after the write and verify every `saved` and `already_matched`
  entry at its exact scope. Do not perform a fetch after each answer.
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
- Prior interview with the employer:
  `employment.previously_interviewed_at_employer` at `company` scope.
- Employment, contracting, consulting, temporary work, or similar engagement
  with an employer's corporate family:
  `employment.previously_engaged_with_corporate_family` at
  `corporate_family` scope only when Trackly supplied a stable `cf_...` ID,
  paired with
  `employment.corporate_family_engagement_types_checked` at the same scope.
  Reuse a negative answer only when the new question is no broader than the
  recorded relationship types. Without a Trackly-issued family ID, save both
  fields at the exact `company` scope and never reuse them for affiliates.
- Employer candidate-AI policy acknowledgement:
  `consent.candidate_ai_guidance_acknowledged` at `company` scope. Send the
  exact policy question or published version as `questionLabel`; Trackly returns
  its fingerprint. Reconfirm when the current fingerprint cannot be proven to
  match; the acknowledgement is not broad AI consent.
- Consumer hardware, IoT, or retail experience level and supporting summary:
  the two global `employment.consumer_hardware_iot_retail_experience_*` fields.
- Residential city and EEO sexual orientation remain their existing canonical
  fields. Audit them before declaring a schema gap.
