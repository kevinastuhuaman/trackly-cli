# Batch orchestration

Protocol 3.4 adds a server-owned Apply execution above immutable child batches.
The execution is the target-completion ledger; each child batch remains the
auditable browser-work unit. Protocol 3.3 fixed batches and protocol 3.2 single
runs remain recovery-only compatibility paths.

## Interpret the request

- “Fill/apply to the next N” means `complete_next_n_accessible`. Recover the
  active execution first or start one with target 1–20. Continue through its
  original recent-first Check Later snapshot until N forms are durably ready
  for manual review, the snapshot is exhausted, or the user stops it.
- “Inspect the next N records” means a fixed immutable batch of exactly those
  queue records. Never replenish or replace that inspection batch.
- A saved/check-later job is already approved. Neither mode rescans fit.

Call `trackly_get_active_apply_execution` before legacy active-batch recovery,
even when the fetched protocol reports accessible execution disabled. A
rollback may preserve an execution whose child batches are intentionally
hidden from legacy recovery. When disabled and one is active, recover it
read-only and permit only get or stop operations; never start, advance, or
record dispositions until the capability is enabled. When disabled and none
is active, continue through the fixed-batch compatibility path.
Never create a second execution because context or tabs were lost. Read
`response.progress` and `response.progress.nextAction`; never reconstruct execution progress from
chat, browser tabs, or a client-side queue.
If a new fill/apply request changes the target from the active execution,
explain the mismatch and obtain explicit confirmation. Then stop the old
execution with reason `target_changed`, refetch and verify its terminal state,
and only then start the new target. If the user asks to stop, stop it with
reason `user_requested` using the latest revision and a fresh idempotency key,
then refetch and verify `stopped` or `closed` before reporting completion.
The start call itself returns that authoritative funnel at `response.progress`
and its directive at `response.progress.nextAction`. Consume that response immediately before opening, claiming, or
mutating a browser surface; do not issue a blind advance or infer a first wave.
For start, active-recovery, and get responses, recover every entry in
`response.execution.unresolvedWaves` in ascending `waveOrder`. This list is the
authoritative browser-handoff set, including an older wave that still has a
draft, question, review, submission, or closure obligation after a newer
replacement wave was created. Use `response.execution.currentWave.batchId`
only as the latest scheduling identity when following `response.progress.nextAction`; it is not
the complete recovery set. For an advance response that creates a wave, use
its top-level `response.batchId`. Never guess across those response shapes. If
the applicable field is null or `unresolvedWaves` is empty, follow
`response.progress.nextAction` rather than guessing a prior batch.

## Parent execution and child waves

The execution freezes one original recent-first queue snapshot and ordering
version. Newly saved jobs wait for the next execution. Every continuation is a
new immutable child batch linked in wave order; never append, replace, reorder,
or expand a child batch. Only Trackly may advance to another wave, and only
after the current wave contains no unclassified `queued` or `inspecting`
member. Supply the actual current `browserSurface` on every advance so Trackly
schedules cached access hints only for that controller surface.

Use the authoritative funnel exactly as returned:
`target`, `durablyReviewReady`, `submitted`, `reservedReviewSlots`,
`currentlyFilling`, `awaitingAnswer`, `authParked`, `excluded`, `conflicted`,
`attempted`, `remainingCandidates`, `queueExhausted`, `targetReached`, and
`nextAction`.

An accessible draft awaiting an answer, legal choice, consent, or required
artifact reserves one target slot. Durable review-ready and submitted members
consume completed slots. Authentication, account creation, OTP, pre-form
CAPTCHA, static exclusions, manual-only forms, conflicts, revocations, and
unobservable pages consume no slots. `captcha_at_submit` may still reach review
because the user owns Submit. When a reservation is explicitly abandoned or
revoked, the backend releases it transactionally before selecting one
replacement. The agent never calculates replacement capacity.

Record live probe results through
`trackly_record_apply_execution_dispositions`. Use only the typed,
value-free classifications: `accessible`, `authentication_required`,
`account_creation_required`, `otp_required`, `captcha_before_form`,
`captcha_at_submit`, `manual_only`, and `unknown_unobservable`. Every public
disposition is a `live_probe` and must include the exact current-wave `jobId`,
`batchId`, `memberId`, `runId`, `expectedMemberVersion`,
`expectedInspectionEpoch`, and `browserSurface`. These optimistic member bindings reject observations from a
superseded browser inspection after recovery. Cache hints and static-policy
classifications are server-owned scheduling concepts: the agent cannot submit
or synthesize them. They may prioritize a probe, but they never authorize
private-data entry or replace a fresh live minimal, non-mutating probe. A
redirect or contradictory observation invalidates any stale scheduling hint on
the server; report only the newly observed live disposition bound to the exact
current run.

## Freeze before browser work

For a fixed inspection request, create one server-frozen batch before opening
or mutating application forms. For accessible execution, Trackly creates each
child wave from the original snapshot before browser work.
Use the backend order exactly: active jobs first, then `savedAt` descending,
then job ID ascending. Never replace, rescore, or expand frozen membership
because a form is difficult or another job looks easier. A job saved after the
snapshot belongs only to a future batch.

Static planning keeps an inactive posting, insecure URL, or protocol-declared
manual-only job in frozen membership with a non-executable exclusion reason.
Never replenish or replace it inside that child batch. The parent execution may
select another unattempted candidate in a later wave. Credentials, CAPTCHA
placement, attachment controls, semantic observability, and review reachability
are browser findings; they do not change membership. If the user removes or
discards a frozen member, stop before its next private-data mutation.

Read large batches through opaque continuation tokens. Do not recreate ordering
or pagination in the prompt.

## Backend tool sequence

For an execution request:

1. call `trackly_get_active_apply_execution`;
2. resume it or start one `complete_next_n_accessible` execution; on recovery,
   reclaim every `execution.unresolvedWaves` entry in ascending `waveOrder`,
   then consume the response's authoritative `progress` and `nextAction`. For a
   new execution, consume the start response's authoritative `progress` and
   `nextAction` before any advance;
3. follow that `nextAction` and page/claim only the returned child batch;
4. classify all current-wave members and persist dispositions;
5. bring accessible members through the ordinary batch integrity and review
   gates; and
6. refetch progress, then call `trackly_advance_apply_execution` only when the
   current wave has no unclassified member.

For an explicit fixed inspection request or legacy recovery:

1. call `trackly_get_active_apply_batch` before any create call;
2. resume the returned active batch, or, only when none exists, call
   `trackly_create_apply_batch` once with the requested size and a fresh
   idempotency key;
3. page only that batch with `trackly_get_apply_batch`;
4. acquire or renew ownership with `trackly_claim_apply_batch`;
5. start or reuse each run with the complete batch/member/lease binding; and
6. send browser findings in groups of at most 20 through
   `trackly_checkpoint_apply_batch`.

Do not recreate a batch after maintenance. Refetch the existing batch, reclaim
its lease with the latest revision, and resume its existing run bindings.
When a bound run start returns a transport failure, a non-access HTTP 5xx
response, or an error explicitly marked `retryable: true`, refetch and renew,
then retry the same complete binding once. Classify the retry response
independently with the same rules. Route `maintenance_mode` or the legacy
`planned_maintenance` alias from either attempt through maintenance recovery.
Surface controlled-access/request errors marked `retryable: false` and every
other HTTP 4xx response unchanged, including when returned by the retry. Only a
second transport failure, non-access HTTP 5xx response, or explicitly
retryable error becomes `backend_run_start_unavailable` while siblings
continue. Do not checkpoint this condition: no run ID exists yet, and the
checkpoint contract requires one. The unchanged frozen member is the durable
resume point. Never detach that member into a legacy single run.

### Request budget

For a failure-free new 20-member batch, keep planning, initial binding, evidence,
two bulk checkpoints, resume approval, truth certification, outcomes, and the
final batch refresh within 52 non-resume MCP/HTTP requests: one active-batch
lookup, one create, one page, one claim, 20 run starts, 20 surface bindings, one
`trackly_report_apply_observations` call before resume preparation, a second
bulk observation call for final scenario coverage, two bulk checkpoints, one
resume approval, one truth certification, one
`trackly_record_application_outcomes` call, and one final refresh. An existing
active batch omits the create call. Do not replace bulk observations,
checkpoints, or outcomes with per-member requests. Resume download and exact
local verification are excluded from this count. Optional external inbox
connector traffic is also excluded because it never reaches Trackly's MCP or
HTTP API; bound it separately to one connector capability check plus at most one
initial query and one identity-refinement query per executable member (`1 + 2E`,
where `E` cannot exceed 20). Stop when the bounded query is exhausted and never
expand to an unbounded mailbox search. Each member that encounters
the one permitted retryable bound-start failure receives exactly three
additional recovery calls: refetch the active batch, renew its lease, and retry
the same binding. Therefore the bounded contingency budget is `52 + (3 * R)`,
where `R` is the number of affected members and cannot exceed 20. Maintenance
recovery is paced by the advertised window and is tracked separately.

Each verified prior-submission duplicate reconciled during preflight receives
seven additional calls after its baseline run start and surface binding: one
provider-receipt evidence write, one success-page or explicit-user-confirmation
evidence write, one submitted-outcome write, one durable-state refetch, and the
three separate close-proof evidence writes. Therefore a batch containing both
retryable start recovery and reconciled duplicates uses the bounded budget
`52 + (3 * R) + (7 * D) + C`, where `D` is the number of reconciled duplicates,
and `C` is the number of positive matches durably recorded and then explicitly
cleared by the user without reconciliation. Each cleared match adds exactly one
provider-receipt evidence write; `D + C` cannot exceed 20. Never spend the
duplicate allowance without the normal
success-page or explicit-user-confirmation authority, and never omit the
durable refetch or three-part close proof merely to remain under budget.

## Ownership and replay safety

Acquire the renewable lease before browser mutation. Each mutation supplies
only the guards exposed by its tool schema: lease token when the schema exposes
it, optimistic version when the schema exposes it, inspection epoch when the
schema exposes it, and idempotency key when the schema exposes it. Never invent
or attach an uncontracted guard.

Renew before expiry and stop mutation if ownership is lost. For operations
documented as idempotent, a same-key, same-payload replay returns the documented
recovery result. For `trackly_advance_apply_execution`, that recovery result
contains current authoritative progress and the current execution revision,
not a stale copy of the first response. A same key with a different payload is a conflict (`409`), never
permission to retry under a new run. Do not blindly retry a mutation without an
idempotency key after an ambiguous response; recover through the documented
read or lookup operation first. Reclaiming a browser tab increments the
inspection epoch; earlier-epoch review, attachment, certification, or close
evidence cannot satisfy the current gate.

## First pass

Process every frozen member even when another needs user input:

1. Create or reuse its bound application run.
2. Reclaim or open its exact stored requisition URL and validate origin and job
   identity.
3. Inventory the accessible form.
4. Fill and verify every known field before checkpointing an unknown.
5. Record typed human actions and continue to the next frozen member.

Recoverable actions keep the run in `needs_input`. Group the first interruption
into one grouped first-pass packet organized by company, role, run, and action
type. After answers reveal conditional fields, send a delta packet containing
only newly revealed items.

Action records contain only value-free type, stage, blocking scope,
continuation flags, status, and redacted fingerprints. Credentials, OTPs,
CAPTCHA answers, raw question text, and private answer values never enter
Trackly observations.

Each checkpoint includes the expected member version, unchanged current
inspection epoch in both epoch fields, lease token, one to 25 typed actions, the shared
known-fields-committed flag, optional packet phase, and its own idempotency key.
Each action carries its continuation flag and optional redacted field
fingerprint. All actions in one checkpoint share one member lifecycle. The
member version advances once, but only a browser bind or reclaim may advance the
inspection epoch. Never add raw labels, options, answers, or page text to this
packet.

Use `packetPhase: first_pass` while inventorying the frozen set. Use
`packetPhase: delta` only for a conditional question or action that became
visible after the first grouped packet. A per-member conflict does not cancel
successful siblings; refresh only the conflicted member before retrying it.
When the user has completed or answered a prior human action, include its exact
server-returned ID in `resolvedActionIds` on the next checkpoint for that same
member and current inspection epoch. Never infer, fabricate, or resolve an
action from another member; an unknown or stale action ID must conflict.

## Challenge placement

An access CAPTCHA or verification wall that hides the semantic form must be
recorded before private data is entered. Create a human action and continue the
batch.

A submit-time CAPTCHA beside an otherwise complete final form stays
`review_ready` with an `at_submit` human action because the user owns Submit.
Never solve, store, or bypass the challenge. Reserve terminal `blocked` for an
unrecoverable trust or observability failure, not for an answer the user can
provide.

## Resume approval and truth

Resume approval is early and content-bound. It covers only immutable batch/run
membership, default-resume identity, exact content hash, user-facing filename,
size, profile revision, and expiry. Each upload still needs its own immediate
per-run local path proof for the exact bytes.

Exact local paths are user-visible local proof only and never leave the
machine. Content hashes may be sent only to authenticated Trackly resume
approval, prepared-resume verification, and truth-certification endpoints.
Never send either value to observations, application answers, analytics, logs,
or employer form fields.

Prepare the resume for every run that exposes a real Resume or CV control. Show
one consolidated proof with every run/path plus the shared resume identity,
filename, size, and SHA-256. After explicit user approval, call
`trackly_approve_apply_batch_resume` for the complete current run set. Reuse that
content approval only while every returned immutable dependency remains exact.
Ordinary checkpoints may advance member versions without invalidating approval
for unchanged resume bytes and run membership. Immediately before each
attachment, call `trackly_verify_prepared_resume` with that run's resume ID and
signed local proof.

Truth certification is late. Ask only after final answers and any conditional
wording are known. Bind it to the run set, answer snapshot, wording
fingerprints, profile revision, inspection epochs, and expiry. When at least
one form used a resume attachment, use `resumeDependency: approved` and bind
the exact approved resume identity. When no form in the batch exposes a resume
control, use `resumeDependency: not_applicable` with no resume ID or hash. It
is ephemeral evidence and never a reusable profile answer.

After all conditional questions and certification wording are visible, show one
final truthfulness prompt. Only after explicit user confirmation, compute the
value-free answer-snapshot and wording fingerprints and call
`trackly_certify_apply_batch_truth` for the exact complete subset that is
currently `review_ready`. Then call `trackly_record_application_outcomes` for
that certified subset; every item must use the literal
`outcome: review_ready`. Verify every recorded run returns
`awaiting_manual_submit` before handing the forms to the user. A `needs_input`
member does not block certification or handoff of ready siblings. Never certify
an arbitrary subset. When another member becomes ready later, obtain a fresh
certification for the then-current complete `review_ready` subset. Never place
the certification or its wording in the application profile.

A membership, profile revision, resume identity or hash, answer snapshot,
certification wording, or affected inspection epoch change invalidates the
affected approval or attestation. An ordinary member-version checkpoint does
not invalidate an unchanged resume-content approval. Recompute and ask again
only for the invalidated scope.

## Finish

Bring every accessible member to `review_ready`, preserving each browser tab
for manual submission. Certify, record, and hand off the exact current
`review_ready` subset without waiting for unrelated members. Members with
actions remain frozen and resumable, and require a fresh certification after
they later become ready. Report one compact table mapping job ID, run ID,
browser surface/tab label, ATS, state, actions, and evidence status. Raw tab
identifiers stay local.

Never submit a member. After manual submission, mark Applied only from an
observable success page or explicit user confirmation. Record the submit
request, success page or `user_confirmation`, and any provider receipt with
`trackly_record_apply_submission_evidence`; store only the redacted fingerprint
and typed source. Then use the separate literal `outcome: submitted`. The
outcome call is not complete until a fresh batch read shows member lifecycle
`submitted` and tracker state `applied_confirmed`.
Preserve the success tab during one documented idempotent conflict recovery;
if reconciliation remains unsuccessful, report the control-plane defect and
do not claim completion. Only then reconcile tab closure separately using the
browser-lifecycle gate. Submission, durable outcome, receipt, and closure never
substitute for one another.
