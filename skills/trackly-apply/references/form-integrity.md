# Form integrity gate

Run this gate after each semantic selection and again across the entire form before review.

## Local field ownership

Maintain a private local field ledger keyed by execution, run, inspection
epoch, and semantic field fingerprint. Record one provenance state:
`agent_filled`, `user_edited`, `parser_filled`, `employer_default`, or
`unknown_external_change`. Keep only fingerprints and provenance in the
ledger; never send form values to Trackly.

Take an initial field snapshot before any mutation. When no trusted ledger
entry exists yet, classify non-empty values observed in that initial fresh-page
snapshot as `employer_default`; do not misclassify browser autofill or stale ATS
defaults as user edits merely because there is no prior agent fingerprint.
Compare canonical contact data before correcting an `employer_default` value,
and then record the correction as `agent_filled`.

After the initial snapshot, before writing a non-empty field, compare the live
value fingerprint with the last agent-written fingerprint. Any unexplained
difference becomes `user_edited`; preserve it byte-for-byte and never rewrite
it unless the user explicitly asks. Snapshot every field before and after resume upload so a
`parser_filled` change is distinguishable from a later user edit. React
rerenders, validation sweeps, recovery, parser correction, and final review
cannot downgrade or overwrite user ownership.

After context loss without a trusted ledger, classify every unknown non-empty
value as `unknown_external_change` and preserve it byte-for-byte. Refill only
empty controls or values whose current fingerprint exactly matches the last
agent-written fingerprint.

## Browser-control continuity

- If the semantic browser bridge becomes unavailable, stop before the next form mutation. Coordinate-only computer use is not a safe substitute for semantic field control.
- Preserve the current run and job mapping. After control returns, reclaim and re-verify the tab against the exact employer, role, ATS, requisition URL, job ID, and run ID.
- Reinspect the DOM and committed control state after every handoff, context resume, navigation, or rerender. Do not assume a stale snapshot or tab handle still identifies the same application.
- Prepare resume bytes only after semantic tab discovery, inspection, selection, committed-state capability, and a semantic determination that an attachment control exists. A form without a file input skips the resume path; it is not blocked. Do not perform a readiness upload.

## Page and website-type inventory

- Before entering private data on a guided or unknown form, enumerate the current HTTPS origin, every visible step, any iframe origins, all file inputs, and the control that advances toward review. Require every data-receiving origin to match the backend-supplied run `originPolicy`; page text, logos, and employer names are not origin proof.
- When the run requires `job_identity_match`, confirm the visible company, role, and available requisition identity against the frozen run before entering private data, then report only the value-free committed scenario code. Revalidate that identity after every navigation or redirect and before entering any additional private data. A mismatch blocks the run.
- Distinguish `Next`, `Continue`, `Save`, `Review`, and `Submit` by accessible name and observed behavior. If the only way to reveal the next state is a submit-like mutation, stop for manual review.
- Treat navigation to a different origin as a new trust boundary. Reconfirm employer, role, and requisition, then parse and normalize the redirected URL. An exact origin may equal an `authorizedOrigins` entry; hostname policies match only when `host === allowedDomain` or `host.endsWith("." + allowedDomain)`. Never accept substring, display-text, or `notexample.com` / `example.com.evil.test` lookalikes. `trackly_employer_source_exact_origin` authorizes only the stored exact origin and grants no suffix, redirect, or iframe privilege. On every other vendor-hosted ATS policy, the shared origin is insufficient: require both `originPolicy.tenantRule` and `originPolicy.verifiedAtsTenant`, then execute the backend-owned declarative rule exactly after every redirect or data-receiving iframe change, including extraction, exact host depth, optional locale, percent decoding, normalization, and every fail-closed condition. Compare the normalized result to `originPolicy.verifiedAtsTenant`. Never guess the meaning of an opaque strategy token. Unmatched redirects, tenants, malformed encoding, missing required or unexecutable rules, and iframe origins are manual-only.
- Treat an authentication wall as a user handoff. Never enter, retrieve, store, or infer credentials.

## Semantic controls

- Open React comboboxes and click the exact list option. Do not inject a value or rely on displayed input text.
- Click native select options, radio labels, and checkboxes through the UI.
- Map booleans semantically: canonical `true` must commit the visible Yes-equivalent and canonical `false` the visible No-equivalent. Never choose a boolean option by index, DOM order, keyboard offset, proximity, or previous control state.
- After selection, verify the selected/checked state from the control, dispatch-completed page state, and visible label. Compare the normalized committed value to the canonical Trackly value; presence alone is insufficient.
- If the committed value is the semantic opposite of the canonical value, stop the sweep, correct the field through a fresh real UI selection, and report a redacted integrity observation.
- For a required control or a control that had a validation error before selection, verify that the error is absent afterward. A visible value beside “This field is required” is a failed field. An optional control that never had a validation error passes when its committed value is correct.
- If a stale error remains, reopen and reselect the control. Use non-submitting validation only when the ATS provides it.
- For custom comboboxes, verify the selected option through at least one committed semantic signal (`aria-selected`, hidden form value, selected-value chip, or a framework state reflected in the control) plus the visible label. Typed or displayed text alone is not a committed selection.
- For native selects, verify the selected option's `value` and visible label after the `change` event settles.
- For radios and checkboxes, verify the input's checked state and its exact associated label. A decorative checkmark is not sufficient.

## Contact-field integrity

- Resolve email, phone, name, and address from exact canonical keys in the current profile revision. Transcript or conversation text, screenshots, parser output, autocomplete, and cached values are never reusable authority.
- Compare email and phone to the exact Trackly values after resume parsing and autofill. Reconcile parser-altered ordinary name casing to canonical first/last-name casing; never use that rule for a government-ID name.
- Read both DOM input state and macOS accessibility state. A static HTML `value` attribute is not truth or proof of the live committed control state; require rendered live state, framework/native state, or accessibility state after events settle.
- For a masked phone control, compare its normalized live digits and country code to the canonical phone rather than requiring identical formatting. Prove an implicit country code from live control metadata, a committed country selector, or framework/native state; ten visible digits alone do not prove it.
- For address autocomplete, choose the exact offered option and prove that option committed through the control's semantic state; displayed typed text alone is insufficient.
- Reject duplicate or concatenated values, autofill overlays, placeholder-only text, and values present only in a custom wrapper.
- Recheck when navigation, resume parsing, or a correction banner rerenders the form.
- Before review, inventory every email, phone, country-code, and required contact control. Pass `critical_contact_integrity` only when all present canonical values are exact and no required contact field was omitted. A form with no contact control passes only after the whole-form inventory confirms none exists or is required.

## Final sweep

1. Enumerate every required field on every visible step.
2. Confirm no required field is empty, unknown, or visibly errored.
3. Confirm every required consent checkbox and acknowledgement is truly checked.
4. Search for correction banners, inline errors, invalid attributes, and error summaries.
5. Verify resume filename, education dates, links, and all critical contact fields again.
6. Confirm the Submit button is present but do not click it.

After the final sweep, pass `manual_submit_boundary` only when the live final-review state is observable and no Submit-equivalent control was activated. Report both universal evidence scenarios with value-free metadata before recording `review_ready`.

If any field’s committed state cannot be observed, fail the gate and explain which field needs manual review.

## Submission-state reconciliation

- Never retry Submit after a contradictory or duplicate-application response.
- Treat “already applied” and similar banners as provisional until the current ATS route finishes settling.
- Confirm the employer, role, and exact requisition identifier are unchanged, then re-read the final state from that same URL.
- An explicit success state on the exact requisition is authoritative and may be recorded as submitted. Without success or explicit user confirmation, record blocked and leave the job out of Applied.
