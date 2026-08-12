---
title: OpenAI MCP discovery probe failed as an OAuth scope error
date: 2026-08-11
category: integration-issues
module: Trackly hosted MCP
problem_type: integration_issue
component: authentication
symptoms:
  - OpenAI Platform reported "Tool scan failed: Insufficient OAuth scope"
  - OAuth consent and token exchange succeeded but the required MCP tool scan did not
root_cause: scope_issue
resolution_type: code_fix
severity: high
tags: [mcp, oauth, openai-platform, server-discover, compatibility]
---

# OpenAI MCP discovery probe failed as an OAuth scope error

## Problem

The OpenAI Platform could authenticate to Trackly but could not complete its mandatory MCP tool scan. The portal surfaced the failure as an OAuth scope problem, blocking submission even though the user had granted the requested Trackly scopes.

## Symptoms

- Consent completed and an access token was issued.
- The portal immediately reported `Tool scan failed: Insufficient OAuth scope`.
- Retrying with a different Trackly account did not help.
- The normal enterprise-domain OIDC warning was unrelated to this failure.

## What Didn't Work

- Repeating OAuth with another Google account did not change the result because the failure occurred after authentication, at the protocol-method authorization layer.
- Adding broader user-data scopes would have weakened the boundary without authorizing the actual protocol-control request.
- Treating the error as an OpenAI portal glitch was unsafe because the tool scan is a hard submission gate.

## Solution

OpenAI's current MCP client probes legacy servers with the exact JSON-RPC method `server/discover` before falling back to the initialization-based protocol. Trackly's strict scope gateway treated every unknown method as a scoped operation and returned HTTP 403, so the client interpreted a compatibility probe as an OAuth authorization failure.

The backend fix in `trackly-app/close-ai#1515` added only `server/discover` to the immutable scope-free protocol-method set. It did not add a tool or grant access to user data. The existing legacy SDK then returns JSON-RPC `-32601 Method not found`, which is the compatibility signal the OpenAI client needs to fall back to `initialize` and `tools/list`.

The CLI contract alignment in `trackly-app/trackly-cli#106` records the exact backend source and merge provenance, locks the scope-free set and middleware behavior, and verifies the hosted catalog without broadening tool scopes. The coordinated verifier also checks the published Apply schemas, including `truthCertificationInputSchema`, in `scripts/verify-hosted-contract.js`.

## Why This Works

HTTP 401/403 communicates an authentication or authorization failure, so a dual-era MCP client must not interpret it as protocol-version evidence. A JSON-RPC method-not-found response is safe legacy-server evidence: it reveals no user data and permits the client to negotiate the older supported protocol. Exact allowlisting preserves fail-closed behavior for every other unknown method and for all scoped tool calls.

## Prevention

- Classify protocol-control methods separately from tools and data operations.
- Keep the scope-free method set immutable, exact, and covered by negative tests for sibling and unknown method names.
- Test the real stateless HTTP path before initialization: `server/discover` must not return 401/403/5xx, then legacy `initialize` and `tools/list` must succeed.
- Keep source/merge provenance and semantic AST checks together so refreshing a whole-file hash cannot silently bless a security or schema drift.
- Treat portal scan success as an explicit release gate; do not infer it from local MCP success.

## Related Issues

- `trackly-app/close-ai#1515` — backend compatibility fix.
- `trackly-app/trackly-cli#106` — packaged contract and verifier alignment.
