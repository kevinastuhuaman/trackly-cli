# Performance and value-free telemetry

Improve speed only by reusing structure and batching requests. Never weaken
identity, consent, committed-control, preservation, or Submit-boundary gates.

## Value-free schema cache

Cache only normalized control fingerprints, semantic labels, control types,
requiredness, conditional dependencies, provider/tenant/template identity,
interaction strategy, commit-verification strategy, parser/rerender risk flags,
and cache version/expiry.

Never cache raw answers, contact values, demographic values, resume text or
paths, credentials, URLs, or employer-form free text.

Invalidate on a profile revision, form schema fingerprint, inspection epoch,
meaningful wording change, provider/tenant mismatch, or cache expiry. A cache hit
skips structural rediscovery only; reread and verify every committed live value.

## Batch resolver and template grouping

- Fetch the current profile once per stable revision and request only keys
  required by visible forms.
- Resolve a shared question once only when scope, expected type, employer,
  office, jurisdiction, and wording semantics all match.
- Group same-tenant forms with identical normalized control fingerprints into
  one structural fill plan.
- Apply that plan independently to every exact run and tab. Keep requisition
  identity, provenance, committed-value verification, and browser bindings
  separate.
- Deduplicate missing questions, not committed-control receipts.
- Preserve bounded bulk dispositions, observations, checkpoints, and outcomes.
  After a bulk 5xx, refetch before deciding whether to retry or split.

## Events

Emit these only when the current protocol or analytics surface explicitly
supports them:

- `apply_probe_stage_reached`
- `apply_access_disposition_committed`
- `apply_member_run_start_conflict`
- `apply_form_schema_cache_hit`
- `apply_form_schema_cache_miss`
- `apply_profile_resolution_completed`
- `apply_known_field_omitted`
- `apply_control_commit_corrected`
- `apply_resume_parser_repair`
- `apply_question_packet_generated`
- `apply_free_text_humanized`
- `apply_handoff_receipt_committed`
- `apply_submission_evidence_committed`
- `apply_outcome_reconciled`
- `apply_tab_closed_verified`

Use only provider/support level, scenario code, opaque execution/member/run IDs,
inspection epoch/version, cache hit or miss, phase elapsed time, typed error code,
and counts by resolver class. Never include raw labels, answers, URLs, names,
emails, phone numbers, resume paths, demographics, or free-text content. Never
invent an event or field that the active protocol does not expose.
