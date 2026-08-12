# Apply lifecycle contract

The public facade owns one resumable, batch-bound lifecycle. Do not recreate it from lower-level mutations.

## Readiness and missing profile facts

Each readiness section is independently usable only when its matching `availability` flag is true. Never render an unavailable section as saved state. `queue.pageCount` counts only the returned page; when `queue.hasMore` is true, that count is a lower bound rather than the full approved queue.

`trackly_get_apply_readiness` returns `profile.missingRequired` and `profile.availableFields` as at most 100 `{ key, label }` records each. In both, `key` is a canonical profile-catalog key and `label` is its public schema label. `missingRequired` identifies absent required facts; `availableFields` is the sorted intersection of resolved saved profile fields and the canonical schema. Both intentionally contain no answer value, option value, contact detail, resume identity, or sensitive metadata.

Ask the user only for the returned missing facts. Save a fact with `trackly_save_application_answers` only after the user confirms its value and scope, then refetch readiness. A standard-only save requires profile write permission; a request containing any sensitive key additionally requires sensitive write permission. Never turn a label, model guess, employer-page value, or one-time truthfulness attestation into a reusable profile answer.

After bound work reveals which canonical facts its forms need, intersect those keys with `profile.availableFields`. Request only that minimal intersection through the snapshot `profileKeys` field on `trackly_get_apply_work`. The facade strictly projects the result to those requested keys, reduces resume data to availability booleans, and returns each member's bounded frozen requisition identity plus server-verified origin and ATS-tenant policy in `navigation`. A request containing any sensitive key additionally requires sensitive read permission. Never request all available fields, and never infer a saved answer from its key or label.

## Establish bound work

Call `trackly_start_or_resume_apply` with `target`, a fresh `idempotencyKey`, and the active `browserSurface`. On a successful response with `targetMismatch=false`, the backend has started or resumed the execution and prepared and claimed its current wave. Use only the returned `executionId`, `revision`, `batchId`, `memberIds`, and `nextAction`.

The authenticated facade derives, owns, and renews the stable private batch lease on every work and mutation path. No public tool accepts or returns a lease token. Never request, infer, persist, display, or send one in an observation, certification, or reconciliation call.

If `targetMismatch=true`, preserve the active execution and follow `nextAction`; never restart it to force a new target. For `nextAction: use_active_target`, call `trackly_start_or_resume_apply` again with the returned `activeTarget`, the same browser surface, and a fresh idempotency key. Do not reuse the rejected target or idempotency key. If `nextAction` is `restart_after_reauthorization`, the active execution belongs to an earlier OAuth grant: do not read, claim, or mutate its work. Explain the boundary and obtain explicit user confirmation, then call `trackly_stop_apply` with the returned execution ID and revision and `reasonCode: execution_restarted`. Verify the stopped state before calling `trackly_start_or_resume_apply` again with a fresh idempotency key. Never adopt an execution across grants.

Never call a snapshot with empty `memberIds`. For `nextAction: advance_or_refresh`, call `trackly_get_apply_work` with the returned execution ID and no `snapshot`, then obey its authoritative next action or terminal state. Stop on any other empty-binding result rather than inventing work.

With nonempty `memberIds`, first fetch a value-free packet with `trackly_get_apply_work` using the returned execution ID and a snapshot whose member IDs and browser surface exactly match the returned binding, omitting `profileKeys`. Use its form requirements to choose the minimal necessary saved keys from readiness, then refetch the same bounded snapshot with only those keys in `profileKeys`. These calls atomically renew the facade-owned private lease, so their scope and annotation intentionally treat them as mutations even though the lease stays hidden.

Before the first browser mutation for each member, call `trackly_report_apply_progress` with `operation: bind_surface`, its current value-free member/run/version/epoch binding, the controlled browser surface, adapter code, verified browser-binding hash, and a fresh idempotency key. Continue only when the binding receipt matches the member, run, version, and inspection epoch. Use `initial_binding` normally and `recovery_binding` only when recovering an existing surface. Every bulk observation call also needs its own fresh idempotency key.

Before any private form data, call `trackly_get_job` for every distinct `jobId` in the bound snapshot. Open only the member's frozen `navigation.requisitionUrl` and require `originPolicy.authorized: true`. Compare the live page with the frozen company, title, requisition URL, verified ATS provider and tenant, authorized origins, allowed host suffixes, and tenant rule; do not infer any identity field. Revalidate origin and tenant after every redirect and for every application iframe. Missing navigation, an unverified policy, or any identity/origin/tenant mismatch is a hard stop.

Resume a parked member only after an explicit user request bound to that exact member. Call `trackly_report_apply_progress` with `operation: resume_parked`, the current execution/member identifiers and revision, controlled browser surface, literal `explicitUserResume: true`, and a fresh idempotency key. Treat the idempotent receipt's revision, member version, inspection epoch, mutability, allowed operations, and fresh-probe requirement as authoritative. Never infer or automatically resume parked work.

When an authorized `advance` succeeds, use its returned `batchId`, prepared `memberIds`, and `nextAction` as the authoritative next-wave receipt. Never reconstruct or guess the next wave from earlier state.

## Atomically certify review readiness

`trackly_certify_review_ready` is the only public transition from a filled bound member to durable review-ready state. Use the current values returned by trackly for:

- `runId`, `batchId`, `memberId`, `inspectionEpoch`, and `expectedMemberVersion`
- a fresh `idempotencyKey`
- `knownFieldsCommitted: true` only after every known field is visibly committed
- `explicitUserTruthConfirmed: true` only after the user confirms this exact complete application
- `answerSnapshotHash` for the value-free bound answer snapshot
- `wordingFingerprint` for the exact certification wording shown to the user
- literal `resumeDependency: not_applicable`, including when the user manually uploaded a resume

The backend reads the current membership hash, profile revision, run set, expiry, and private lease inside the same transaction, then atomically persists the review checkpoint, truth certification, and `review_ready` outcome. A manually uploaded resume is browser-local, unbound, and not attested by trackly; its visible filename check is part of the user handoff, not the certification. Do not send server-owned internals, resume IDs, filenames, paths, contents, download URLs, or answer values. Do not report success unless the response proves the durable review-ready state.

## Atomically reconcile a manual submission

After the user—not the agent—activates Submit, call `trackly_reconcile_manual_submission` with the current `runId`, `batchId`, `memberId`, `expectedMemberVersion`, positive browser-bound `inspectionEpoch`, `browserBindingHash`, a value-free `evidenceFingerprint`, and a fresh `idempotencyKey`. The facade resolves the private lease from the authenticated binding.

Use `confirmation: success_page` only when the bound browser surface visibly shows the submission success state. Use `confirmation: user_confirmation` with `explicitUserConfirmed: true` only when the user explicitly confirms that they submitted. The backend atomically records typed confirmation evidence and the submitted outcome. Keep the confirmation surface open and refetch the bound work until trackly returns its durable submitted state.

Never reconcile from an intent to submit, a click attempt, navigation alone, an email draft, or model inference. Never activate Submit, add referral behavior, or claim submission from a partial mutation.

## Maintenance pacing

On a canonical maintenance response, preserve every bound browser tab and stop mutations. Wait until the server's advertised retry time or estimated return time before a single `trackly_get_apply_work` refetch; never tight-poll, refetch early, create replacement work, or replay an uncertain mutation. When no retry time is advertised, stop and ask the user to resume later.
