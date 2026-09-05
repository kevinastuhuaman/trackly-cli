---
title: Bind access-review approval to validated proposal receipts
date: 2026-09-05
category: integration-issues
module: Trackly Apply access-review facade
problem_type: integration_bug
component: mcp_facade
symptoms:
  - An empty access-review proposal could pass the client response schema and reach approval handling
  - A follow-up proposal returned after approval was not retained for the next hash-bound continuation
  - Equivalent accessKnowledge objects with different key order were rejected as mismatched
  - Computed instance members could evade the hosted runtime-method shadow check
root_cause: missing_validation
resolution_type: code_fix
severity: major
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

The response schemas accepted an empty `proposedWave` or `accessProposal`, even
though an access-review continuation requires a concrete member set. After an
approval returned another `nextAction: access_review`, the new proposal was not
cached, so the next exact approval was rejected locally. Matching nested
`accessKnowledge` values by raw JSON text also made harmless object key order
look like a changed receipt. Finally, the hosted verifier selected runtime class
members before rejecting computed keys, allowing a computed member to shadow the
reviewed method without being inspected.

## Root cause

The implementation treated each response branch independently. Schema presence
checks did not encode nonempty review membership, the approval cache handled
only the first proposal, and identity comparison relied on serialization order.
The verifier's member lookup likewise happened before its computed-key guard.

## Solution

- Require at least one member in access-review proposal and wave arrays.
- Validate ordinary active-execution envelopes with the active-state metadata
  without forcing a proposal onto non-review progress responses.
- Canonicalize nested `accessKnowledge` objects by key before comparing the
  simple and rich proposal representations.
- Cache a newly returned access-review proposal after a successful approval so
  the next continuation uses its current revision, ordered IDs, and hash.
- Reject all computed instance members before selecting the hosted runtime
  method, with fixtures for computed methods and fields.
- Keep the local and adapted Apply skills explicit about
  `accessProposal.approvalHash`, and distinguish creation `jobId` values from
  the discovered `defermentId` required to clear a deferment.

## Verification

`npm test` passes all 518 tests. `npm run test:hosted-contract` passes the
checked-in 3.8.1 hosted fixture. The backend-coupled reviewer-auth check needs
`TRACKLY_BACKEND_DIR`; its explicit missing-backend mode was run in this
CLI-only workspace.

## Prevention

When an access-review response shape changes, update the executed schema,
response cache lifecycle, identity comparison, hosted verifier, both skill
surfaces, and regression fixtures together. Treat server-provided proposal
identity and hashes as the only approval authority.
