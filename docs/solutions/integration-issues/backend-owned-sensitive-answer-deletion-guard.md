---
title: Keep destructive confirmation guards at the mutation boundary
date: 2026-08-28
category: integration-issues
module: Trackly Apply sensitive revocation
problem_type: security_issue
component: service_layer
symptoms:
  - A stale trackly-cli 0.10.0 MCP server could revoke sensitive-storage consent without presenting the new confirmation challenge
  - The backend accepted an unconfirmed destructive request because confirmation was enforced only by caller-side tool handlers
  - The bypass deleted 33 encrypted application-profile answers before a recovery archive existed
root_cause: missing_validation
resolution_type: code_fix
severity: critical
related_components: [assistant, api_layer]
tags: [trackly-apply, sensitive-revocation, destructive-action, version-skew, backend-authority, mcp, data-loss]
---

# Keep destructive confirmation guards at the mutation boundary

## Problem

Sensitive-answer deletion originally used a two-step confirmation guard in the hosted and local MCP callers. That protected only clients running the new code. During verification, a stale local MCP server running trackly-cli 0.10.0 sent an unconfirmed revocation request directly to the backend, which accepted it and permanently deleted 33 encrypted answers before a recovery archive existed.

This was a trust-boundary failure, not merely a missed client upgrade. Any old, alternate, or defective caller could omit a caller-owned safety check while still reaching the destructive service operation.

## Symptoms

- A destructive request from an older installed client bypassed the newly shipped caller-side guard. The incident transcript records the resulting loss of 33 encrypted answers; [trackly-cli PR #90](https://github.com/trackly-app/trackly-cli/pull/90) independently records stale CLI 0.10.0 as the failure mode.
- The superseded implementation in [trackly-cli PR #89](https://github.com/trackly-app/trackly-cli/pull/89) computed the affected-key inventory and confirmation token in the client before sending the mutation.
- Review found that a deterministic caller-computed token was an interaction speed bump, not a server-enforced consent boundary: an automated caller could derive or echo it without proving that a person saw the affected keys.

## What Didn't Work

The first implementation mirrored safety logic into local and hosted MCP handlers. The client recognized a revocation, fetched a profile, computed a challenge, and withheld the API request until the supplied token matched.

That implementation could be thoroughly tested and still fail globally. A previously installed client had neither the preflight read nor the challenge branch, and the backend could not distinguish its unconfirmed request from an approved one. Duplicating the guard also forced callers to mirror the deletion predicate, token rules, revision behavior, and error shape. Those copies could drift independently from the mutation they were meant to protect.

Adding more checks to every caller would not close the version-skew hole. Compatibility checks may make obsolete clients inconvenient to use, but they are not an authorization boundary for a reachable backend endpoint.

## Solution

Move the mandatory challenge-and-confirm invariant to the backend operation that performs the deletion, then keep MCP callers as thin protocol adapters. The backend implementation is outside this repository; internal/private [close-ai PR #1296](https://github.com/trackly-app/close-ai/pull/1296) and public [trackly-cli PR #90](https://github.com/trackly-app/trackly-cli/pull/90) record the service-authoritative design.

The current CLI publishes `sensitiveRevocationConfirmToken` in the tool schema and forwards the complete request to the application-profile endpoint:

```js
wrapTool(async (params) => {
  return applyApiRequest(
    'PATCH',
    '/api/jobscout/application-profile',
    params,
    false,
    false,
    MCP_USER_AGENT,
  );
}, 'Failed to update application profile')
```

The handler does not compute, strip, or validate its own copy of the guard (`mcp/apply-tools.js`). The MCP error mapper preserves the service's structured HTTP 409 challenge (`mcp/server.js`). The regression test in `test/mcp-schema.test.js` verifies that the CLI publishes the token field, relays the service challenge, forwards the confirmed token, and leaves ordinary opt-in as a single service round trip.

PRs #89 and #90 are both merged into the default branch. PR #89 is important history because it demonstrates why the caller-owned design was insufficient; PR #90 is the corrective CLI design.

## Why This Works

Every backend-classified agent caller, including stale CLI and MCP versions, must cross the backend mutation boundary. A stale agent client may have a worse experience or be unable to complete a newer flow, but it cannot make the backend omit its own destructive-operation check. First-party UI clients intentionally retain their own single-call confirmation flows.

The separation also removes semantic duplication. The backend owns the authoritative deletion decision, confirmation validity, revision binding, archive behavior, and mutation. MCP owns discoverability and transport: publish the token field, explain the two-step interaction, preserve the full request, and relay the service response.

Internal/private [close-ai issue #1314](https://github.com/trackly-app/close-ai/issues/1314) remains administratively open, but current backend main appears to satisfy its scoped-inventory acceptance criteria through merged internal/private [close-ai PR #1369](https://github.com/trackly-app/close-ai/pull/1369): the service inventories sensitive and restricted rows across scopes, serializes scope identity into `affectedKeys`, and uses the same user-and-sensitivity predicate for archival and deletion. Close the issue only after confirming the fix is deployed and behaviorally verified; an open tracker alone is not evidence of a current functional gap.

## Prevention

- Treat destructive confirmation as a backend invariant and enforce it in the authoritative operation or transaction that changes the data.
- Keep first-party dialogs and MCP challenge descriptions for user understanding, but never count them as the only protection.
- Make callers forward the full confirmed request, and test the exact service-bound body.
- Relay authoritative conflict payloads without regenerating the decision in the caller.
- Test across the real trust boundary. A caller-only test proves the newest caller behaves correctly; it cannot prove an older caller is safe.
- During coordinated releases, deploy and verify the server guard before removing caller-side defense in depth.
- For every destructive control, ask what happens when the request comes from last month's client. If safety depends on that client running new code, the invariant is in the wrong layer.

## Related Issues

- [trackly-cli PR #89](https://github.com/trackly-app/trackly-cli/pull/89) — initial caller-owned guard, retained as the superseded attempt
- [trackly-cli PR #90](https://github.com/trackly-app/trackly-cli/pull/90) — thin caller relay and service-authoritative correction
- Internal/private [close-ai PR #1296](https://github.com/trackly-app/close-ai/pull/1296) — backend enforcement recorded by the coordinated fix
- Internal/private [close-ai issue #1314](https://github.com/trackly-app/close-ai/issues/1314) and [close-ai PR #1369](https://github.com/trackly-app/close-ai/pull/1369) — tracker still open; current main contains the scoped-inventory fix pending deployment/behavior confirmation
- [Durable exact recovery after browser state loss](durable-exact-recovery-after-browser-state-loss.md) — related Trackly Apply authority-boundary learning
