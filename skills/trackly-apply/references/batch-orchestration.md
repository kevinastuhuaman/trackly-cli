# Batch orchestration

Use the backend batch contract whenever the user asks for multiple queued jobs.
The batch is an execution ledger, not a fit-ranking exercise.

## Freeze before browser work

Create one server-frozen batch before opening or mutating application forms.
Use the backend order exactly: active jobs first, then `savedAt` descending,
then job ID ascending. Never replace, rescore, or expand frozen membership
because a form is difficult or another job looks easier. A job saved after the
snapshot belongs only to a future batch.

Static exclusions may remove an inactive posting, insecure URL, or
protocol-declared manual-only job. Credentials, CAPTCHA placement, attachment
controls, semantic observability, and review reachability are browser findings;
they do not change membership. If the user removes or discards a frozen member,
stop before its next private-data mutation.

Read large batches through opaque continuation tokens. Do not recreate ordering
or pagination in the prompt.

## Backend tool sequence

For a new multi-job request:

1. call `trackly_create_apply_batch` once with the requested size and a fresh
   idempotency key;
2. page only that batch with `trackly_get_apply_batch`;
3. acquire or renew ownership with `trackly_claim_apply_batch`;
4. start or reuse each run with the complete batch/member/lease binding; and
5. send browser findings in groups of at most 20 through
   `trackly_checkpoint_apply_batch`.

Do not recreate a batch after maintenance. Refetch the existing batch, reclaim
its lease with the latest revision, and resume its existing run bindings.

## Ownership and replay safety

Acquire the renewable lease before browser mutation. Every batch or member
mutation supplies:

- the lease token;
- the current optimistic batch/member version;
- the current inspection epoch; and
- a unique idempotency key.

Renew before expiry and stop mutation if ownership is lost. A same-key,
same-payload replay returns the original result. A same key with a different
payload is a conflict (`409`), never permission to retry under a new run.
Reclaiming a browser tab increments the inspection epoch; earlier-epoch review,
attachment, certification, or close evidence cannot satisfy the current gate.

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

Each checkpoint includes the expected member version, prior inspection epoch,
new inspection epoch, lease token, typed action code, continuation flag,
known-fields-committed flag, optional redacted field fingerprint, packet phase,
and its own idempotency key. Never add raw labels, options, answers, or page
text to this packet.

Use `packetPhase: first_pass` while inventorying the frozen set. Use
`packetPhase: delta` only for a conditional question or action that became
visible after the first grouped packet. A per-member conflict does not cancel
successful siblings; refresh only the conflicted member before retrying it.

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

Truth certification is late. Ask only after final answers and any conditional
wording are known. Bind it to the run set, answer snapshot, wording
fingerprints, profile revision, resume hash, inspection epochs, and expiry.
It is ephemeral evidence and never a reusable profile answer.

A membership, profile revision, resume hash, answer snapshot, certification
wording, or inspection epoch change invalidates the affected approval or
attestation. Recompute and ask again only for the invalidated scope.

## Finish

Bring every accessible member to `review_ready`, preserving each browser tab
for manual submission. Members with actions remain frozen and resumable. Report
one compact table mapping job ID, run ID, browser surface/tab label, ATS, state,
actions, and evidence status. Raw tab identifiers stay local.

Never submit a member. After manual submission, mark Applied only from an
observable success page or explicit user confirmation, then reconcile tab
closure separately using the browser-lifecycle gate.
