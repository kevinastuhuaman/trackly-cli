# Apply lifecycle contract

The public facade owns one resumable, batch-bound lifecycle. Do not recreate it from lower-level mutations.

## Readiness and missing profile facts

`trackly_get_apply_readiness` returns `profile.missingRequired` as at most 100 `{ key, label }` records. `key` is a canonical profile-catalog key and `label` is its public schema label. The response intentionally contains no answer value, option value, contact detail, resume identity, or sensitive metadata.

Ask the user only for the returned missing facts. Save a fact with `trackly_save_application_answers` only after the user confirms its value and scope, then refetch readiness. Never turn a label, model guess, employer-page value, or one-time truthfulness attestation into a reusable profile answer.

## Establish bound work

Call `trackly_start_or_resume_apply` with `target`, a fresh `idempotencyKey`, and the active `browserSurface`. On a successful response with `targetMismatch=false`, the backend has started or resumed the execution and prepared and claimed its current wave. Use only the returned `executionId`, `revision`, `batchId`, `memberIds`, and `nextAction`.

The authenticated facade derives, owns, and renews the stable private batch lease on every work and mutation path. No public tool accepts or returns a lease token. Never request, infer, persist, display, or send one in an observation, certification, or reconciliation call.

If `targetMismatch=true`, preserve the active execution and follow `nextAction`; never restart it to force a new target. If `nextAction` is `restart_after_reauthorization`, the active execution belongs to an earlier OAuth grant: do not read, claim, or mutate its work. Explain the boundary and obtain explicit user confirmation, then call `trackly_stop_apply` with the returned execution ID and revision and `reasonCode: execution_restarted`. Verify the stopped state before calling `trackly_start_or_resume_apply` again with a fresh idempotency key. Never adopt an execution across grants.

If no member IDs are returned for another reason, follow `nextAction` rather than inventing work. Fetch the packet with `trackly_get_apply_work` using the returned execution ID and a snapshot whose member IDs and browser surface exactly match the returned binding. This call atomically renews the facade-owned private lease, so its scope and annotation intentionally treat it as a mutation even though the lease stays hidden.

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
