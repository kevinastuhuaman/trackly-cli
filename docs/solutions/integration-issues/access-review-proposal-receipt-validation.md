---
title: Bind access-review approval to validated proposal receipts
date: 2026-09-05
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
  the next continuation uses its current revision, ordered IDs, and hash.
- Reject all computed instance members before selecting the hosted runtime
  method, with fixtures for computed methods and fields.
- Keep the local and adapted Apply skills explicit about
  `accessProposal.approvalHash`, and distinguish creation `jobId` values from
  the discovered `defermentId` required to clear a deferment.
- Validate deferment discovery against the backend's dedicated active-deferment
  limit rather than coupling it to the numerically equal execution-wave limit.

## Verification

`npm test` passes. `npm run test:hosted-contract` passes the checked-in 3.8.1
hosted fixture. The backend-coupled check must be rerun against
the exact coordinated backend release candidate before merge; current backend
`origin/main` is 3.8.0/job-company only. Its direct CLI compact projection
contains `jobId` and `accessKnowledge` and omits `memberPosition` and display
identity; the client therefore accepts that deployed shape while binding any
optional returned position to the rich receipt. Provider scope, richer identity,
and clear-to-fresh all-deferred recomputation remain pending in backend PR
#1769. The backend store's active-deferment limit is 20; the CLI now names and
tests that boundary independently from the execution-wave limit.

## Prevention

When an access-review response shape changes, update the executed schema,
response cache lifecycle, identity comparison, hosted verifier, both skill
surfaces, and regression fixtures together. Treat server-provided proposal
identity and hashes as the only approval authority.
