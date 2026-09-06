---
title: Bind access-review approval to validated proposal receipts
date: 2026-09-05
last_updated: 2026-09-05
category: integration-issues
module: Trackly Apply access-review facade
problem_type: integration_issue
component: mcp_facade
symptoms:
  - A compact backend proposal could be rejected because the client required display identity fields in both projections
  - Active execution recovery could reject the backend's enabled metadata or expose access_review without its proposal
  - An empty access-review proposal could pass the client response schema and reach approval handling
  - Follow-up proposal caching and key-order-sensitive accessKnowledge comparisons could reject a valid continuation
  - The deferment list reused the execution-wave cap instead of naming the backend's active-deferment limit
root_cause: missing_validation
resolution_type: code_fix
severity: high
related_components: [api_layer, contract_verifier, documentation]
tags: [trackly-apply, access-review, proposal-receipt, zod, hosted-contract, fail-closed]
---

# Bind access-review approval to validated proposal receipts

## Problem

The CLI receives an immutable access-review proposal before it can advance an
Apply execution. Approval must remain bound to that exact server receipt across
the response validator, the local cache, the hosted contract verifier, and the
agent-facing skill instructions.

## Symptoms

The deployed 3.8.x backend uses a compact local `proposedWave` array and keeps
the rich approval receipt in `accessProposal.members`. The client previously
required company, title, provider, and URL fields in both projections, so a real
response failed before approval. The active endpoint also returns `enabled`,
`active`, and `preserved`, while a pending access review is hydrated by the
detail endpoint rather than inlined. The response schemas accepted an empty
`proposedWave` or `accessProposal` without checking its counts. An access-review
continuation normally requires a concrete member set, while the all-deferred
case legitimately has no members and must be recognized by zero available
candidates plus a positive deferred count. Exact recovery can also be blocked
by a user deferment with zero members even when available candidates remain;
that `recovery_blocked_by_user_deferment` rationale is a safe stop/clear path.
Older 3.8.0 responses may omit the
optional deferment mapping, so those receipts remain a safe stop/expiry state
until a refreshed response supplies exact IDs. After an approval returned another
`nextAction: access_review`, the new proposal was not cached, so the next exact
approval was rejected locally. Matching nested `accessKnowledge` values by raw
JSON text also made harmless object key order look like a changed receipt.
Finally, the hosted verifier selected runtime class members before rejecting
computed keys, allowing a computed member to shadow the reviewed method without
being inspected.

## Root cause

The implementation treated each response branch independently. Schema presence
checks did not encode nonempty review membership or compact-vs-rich projection
parity, active recovery did not account for the endpoint's two-step shape, the
approval cache handled only the first proposal, and identity comparison relied
on serialization order. The verifier's member lookup likewise happened before
its computed-key guard.

## What Didn't Work

A single proposal-response model could not safely cover start, per-execution
reads, active recovery, and advance because those endpoints return different
identity and metadata envelopes. Passing responses through raw exposed
unmodelled fields, while forcing every active response through the access-review
schema rejected ordinary and preserved-terminal recovery. Caching only the
first proposal, clearing replay state on every refresh, and leaving proposal
bindings unbounded broke either exact retry behavior or long-running process
memory safety. Raw JSON serialization made receipt equality depend on object-key
order. Reusing the execution-wave limit for deferment discovery happened to
match the backend's current limit of 20, but concealed a separate contract that
could drift independently.

## Solution

- Accept the deployed compact local projection and the optional complete future
  display identity projection, while keeping the rich receipt's immutable
  fields required and matching both projections by ordered job ID and
  `accessKnowledge`.
- Strictly validate start, advance, and active execution envelopes, preserve
  `enabled`/`active`/`preserved`, and hydrate a pending access review from the
  detail endpoint only when execution revision and `nextAction` still match.
- Require a nonempty member set for normal access-review proposals, while
  accepting the bounded all-deferred shape with zero available candidates and at
  least one deferred candidate. Also accept an empty
  `recovery_blocked_by_user_deferment` receipt when at least one candidate is
  deferred. Validate optional deferment mappings when supplied; a legacy
  response without mappings cannot authorize a clear action.
- Validate progress candidate counts against the access proposal counts while
  the response is still an `access_review`; after approval, the proposal is a
  historical receipt and progress is allowed to reflect the newly created wave.
- Canonicalize nested `accessKnowledge` objects by key before comparing the
  simple and rich proposal representations.
- Cache a newly returned access-review proposal after a successful approval so
  the next continuation uses its current revision, ordered IDs, and hash. Bound
  pending and replayable proposal bindings with oldest-entry eviction so an
  abandoned execution cannot retain process memory indefinitely.
- Reject all computed instance members before selecting the hosted runtime
  method, with fixtures for computed methods and fields.
- Keep the local and adapted Apply skills explicit about
  `accessProposal.approvalHash`, and distinguish creation `jobId` values from
  the discovered `defermentId` required to clear a deferment.
- Validate deferment discovery against the backend's dedicated active-deferment
  limit rather than coupling it to the numerically equal execution-wave limit.

## Why This Works

Each endpoint is parsed through its own strict envelope before its response is
returned or cached. An access-review continuation must contain both the compact
proposal and rich receipt, and the validator binds their ordered job IDs,
contiguous member positions, frozen access knowledge, counts, and approval hash.
Start and active recovery hydrate the detail endpoint only when execution ID,
revision, and next action still match, preventing a stale detail response from
authorizing work. Separate bounded pending and replay caches preserve exact
same-key idempotency while rejecting a new key or evicting abandoned execution
state. Canonical object comparison removes serialization-order dependence, and
the separately named deferment limit prevents unrelated contract constants from
being coupled accidentally.

## Verification

PR #135 merged as `e97309a07a8afdc6eb62b28f4313c538699c72e5`.
Its CI passed 520 tests and the checked-in contract-fixture run passed 81 tests.

Backend PR `#1769` merged as `254e1c6fc3f98e2f3aa8c6492702e9b9480ca22e`
(head `4c4dab848b1068b1bd9290b14f8d278ec643aca6`) on 2026-09-05 14:00 PDT.
Production `https://closeai.mba/api/first-test` reports `build_sha`
`d5a9abf3e12fb384d50ec998d83a2370725ae3e7`, which contains that merge, and
every hosted path the CLI locks is byte-identical between the two commits.
Protected migration 507 completed on 2026-09-06 07:13 PDT
(`providerDefermentsReady: true` on an idempotent rerun after the first request
outlived the Cloudflare proxy timeout). The hosted contract fixture was
recaptured from `254e1c6fc3`, and
`TRACKLY_BACKEND_DIR=<clean checkout at 254e1c6fc3> npm run test:hosted-contract`
passes with Apply 3.8.1 and the 21-tool public facade at 1.0.0.

Still pending: npm publication of 0.18.1 through the merge of PR #136, and the
backend rollout switch `TRACKLY_APPLY_ACCESS_KNOWLEDGE_ROLLOUT`, which is unset
in production, so the live protocol still advertises the 3.7.x window; that
activation is a backend rollout decision outside this repository.

## Prevention

When an access-review response shape changes, update the executed schema,
response cache lifecycle, identity comparison, hosted verifier, both skill
surfaces, and regression fixtures together. Treat server-provided proposal
identity and hashes as the only approval authority.
