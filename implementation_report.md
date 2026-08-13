# Trackly Apply Cross-ATS Guided Mode — CLI and Skill

## Summary

- Bumped `trackly-cli` to `0.7.0`, the bundled Trackly Apply skill to `4.0.0`, and its minimum Apply protocol to `3.0.0`.
- Bumped the shared Apply MCP tool contract to `3.0.0`; committed-state evidence is now required on observation calls.
- Replaced the static three-provider boundary with backend-owned `full`, `best_effort`, `guided`, and `blocked` capabilities.
- Added constrained guided-mode instructions for enterprise and mid-market ATS forms. Unknown employer forms require a backend-authorized verified company domain; LinkedIn-hosted and unverified forms remain manual-only.
- Preserved the non-mutating browser readiness gate: semantic tab discovery, DOM inspection, semantic control interaction, file-input discovery, and committed-state verification happen before resume preparation; the real upload still waits for exact-file confirmation.
- Added exact employer/role/ATS/requisition/job/run tab binding and mandatory tab reclamation after handoffs or browser-control interruptions.
- Added explicit profile guidance for employer-scoped facts and consent, global relocation assistance and gender-identity wording, and ephemeral accuracy certifications.
- Added a reusable scenario-coverage reference and final handoff field that report only mechanics actually exercised per run.
- Extended local MCP observation metadata in parity with the hosted backend.

## Safety Properties

- Coordinate-only form filling is forbidden.
- Browser bridge loss preserves existing runs and tab mappings and stops before upload or mutation.
- Resume bytes are prepared only after semantic browser readiness, reducing proof expiry during browser setup.
- Accuracy and truthfulness certifications are reconfirmed per run and never persisted.
- Scenario observations exclude answer values, contact data, OTPs, and page text.
- Any non-null queue execution blocker stops before run creation, and every required scenario needs same-run passed/corrected evidence before review.
- Redirects and data-receiving iframe origins and ATS tenants must remain inside the backend-issued origin policy. The skill executes the backend's declarative extraction, exact-host-depth, locale, decoding, normalization, and fail-closed semantics without maintaining its own ATS tenant parser.
- Custom employer forms never reuse the shared `generic_web_form` provider answer scope.
- Frozen batches still preserve exact job-to-run-to-tab mappings and always stop before Submit.

## Verification

- Full CLI suite: 157 passed.
- Shared backend/CLI contract files are byte-identical.
- `npm pack --dry-run` includes the cross-ATS playbook and produces the expected `0.7.0` package contents.
- `git diff --check` — passed.

## Rollout

- Merge and release the backend and CLI changes together so protocol, hosted MCP, local MCP, and bundled skill stay aligned.
- Existing managed 3.x skills become stale and are upgraded by `trackly agent setup` to `4.0.0`; protocol `compatibleSkillMajor: 4` prevents older clients and pre-3.0 runs from entering guided execution.
- No npm publish, production deployment, application submission, or job-state mutation was performed in this implementation task.

---

# Controlled-access rollout guidance — CLI and local MCP

## Outcome

- Google OAuth now renders a specific limited-rollout response when the backend
  returns an invitation denial, while preserving the callback CSRF check.
- CLI API calls and local MCP tools normalize every structured invitation and
  access-capacity failure to the same actionable guidance and early-access URL.
- Unauthenticated help distinguishes existing-member OAuth/API-key options
  from the private-invite path for new members.
- README and MCP tool documentation describe the controlled rollout without
  implying that repeated sign-in or API-key creation can bypass enrollment.

## Verification

- Full Node test suite: 173 passed, 0 failed.
- Local MCP stdio smoke and CLI help smoke: passed.
- `git diff --check`: passed.

No package version was bumped and no npm publish was run; release remains a
separate reviewed merge-to-main action.

---

# Trackly MCP Analytics Spike — Implementation Report

> Historical spike analysis. The production implementation report appended
> below supersedes the spike-only rollout status and unresolved gates.

**Date:** August 8, 2026 (PDT)

**Repository:** `trackly-app/trackly-cli`

**Branch:** `codex/mcp-analytics-spike`

**Worktree:** isolated feature worktree

## Verdict

PostHog MCP Analytics would materially improve Trackly's operator visibility. The strongest new signals are per-user and per-session tool journeys, exact tool schemas seen by agents, agent-supplied intent, MCP client/runtime attribution, missing-capability reports, sanitized failures, and selected non-sensitive job-search inputs/results.

Trackly is small enough that 100% capture of eligible MCP traffic is the right initial setting. Production validation should use all authenticated MCP users rather than a founder-only cohort, which would be sparse and unrepresentative.

The current worktree is an executable, test-covered spike. It is intentionally **not ready to merge, publish, or enable for users**. The production rollout first needs a cross-repository contract amendment, a backend-owned identity/opt-out response, a stronger free-text privacy gate, and a decision on the PostHog package's stricter Node requirement.

## Visibility gained

| Question | New evidence |
| --- | --- |
| Which clients use Trackly? | MCP client name/version plus protocol version |
| What was an agent trying to do? | Optional, agent-supplied `context`, captured as MCP intent |
| Which tools work or fail? | Tool, duration, outcome, sanitized exception, and session |
| What did the agent actually see? | Exact tools/list schema and descriptions for that session/release |
| Where is Trackly missing functionality? | PostHog's `get_more_tools` missing-capability tool |
| Are problems isolated or systemic? | Identified user, session, package/runtime, OS, and architecture slices |
| Did a deployed fix work? | Before/after production traces for the same targeted behavior |

Aggregate dashboards remain useful, but they are derived views. The source telemetry should remain queryable at the identified user/session/tool level for debugging and autonomous improvement.

## Product decisions encoded in the spike

- MCP-only scope; ordinary CLI commands are unchanged.
- Default-on when a PostHog project token is configured, with immediate local disable controls.
- 100% eligible capture; no sampling in this spike.
- Optional agent intent on every existing Trackly MCP tool, without breaking calls that omit it. The new `get_more_tools` capability requires context because the requested capability is its payload.
- `get_more_tools` is advertised for missing-capability reporting.
- Pre-auth initialize and tool-discovery lifecycle events are captured anonymously when no identity is available.
- Runtime envelope includes MCP client/version, protocol version, Trackly package version, Node version, operating system, and CPU architecture.
- Exceptions and stack traces are sanitized before capture.
- Analytics initialization, capture, and shutdown are fail-open. A telemetry failure cannot fail an MCP tool call.
- Shutdown flush is bounded to two seconds.
- Event envelope carries `channel=mcp`, `contract_version=3`, environment, app/build version, and runtime metadata.

## Privacy boundary in the spike

Rich payloads are allowlisted only for:

- `trackly_search_jobs`
- `trackly_get_job`
- `trackly_search_companies`
- `trackly_list_companies`
- `trackly_ask`
- `get_more_tools`

All other tools retain structural telemetry—tool name, client, session, duration, outcome, and sanitized failure—but drop parameters, responses, and agent intent. This protects Apply, profile, account, and contact workflows while still exposing reliability.

The sanitizer recursively removes credentials and the four user-defined sensitive categories:

- résumé text/content
- profile answers
- demographic and work-authorization answers
- application notes/text

It also scrubs email-shaped values, Trackly/PostHog tokens, local usernames/paths, hostname, username, and IP properties.

### Unresolved privacy risk

Key-based redaction cannot prove that arbitrary free text is non-sensitive. An agent could paste résumé content into a generic `query`, `keywords`, or `context` string without labeling it as résumé text. The context instruction tells agents not to do this, but instructions are not a hard privacy boundary.

Therefore synthetic adversarial redaction tests are a mandatory production gate, and production rich capture needs either:

1. a deterministic structured-content allowlist that never sends open-ended free text, or
2. a separately reviewed classifier/redaction service with fail-closed behavior for uncertain content.

Until that gate exists, the current sanitizer is suitable for a spike but not for the promise that sensitive content never reaches analytics.

## Existing Trackly contract and roadmap

The canonical `close-ai/docs/analytics/CONTRACT.md` currently says:

- ordinary product event properties are content-free;
- authenticated identity is backend-owned (`distinct_id = String(users.id)`);
- verified email/name may be PostHog person properties, but may not be copied into events;
- the CLI/MCP should have no local analytics SDK or cached numeric user ID;
- event retention is 12 months and session-replay retention is 30 days;
- access is limited to Trackly and its service providers;
- `users.analytics_opt_out` is the user-wide control.

The rich MCP analytics contract amendment is explicitly approved. It still must land in the canonical contract and event catalog before production CLI code merges.

Relevant active work as of August 8, 2026:

- `close-ai` issue #1378 is the cross-platform analytics program.
- `trackly-cli` issue #101 currently scopes MCP analytics to bounded client-name forwarding and explicitly prohibits commands, arguments, prompts, and user content. It must be amended or superseded.
- `trackly-cli` issue #48 covers graceful MCP shutdown and makes the bounded telemetry flush especially relevant.
- Draft PR #100 is active Apply recovery work and overlaps package/version surfaces. This spike avoids version/release changes, but a future production PR must rebase and review overlap.

## Production identity and opt-out dependency

The spike accepts a static `TRACKLY_MCP_ANALYTICS_DISTINCT_ID` only for local execution. That is not the production design.

Production should obtain an ephemeral, server-authoritative analytics context after authenticated API use:

- `distinct_id = String(users.id)`;
- verified identity person properties allowed by the canonical contract;
- `analytics_opt_out` from `users.analytics_opt_out`;
- no numeric user ID persisted in Trackly CLI config;
- opt-out stops future capture immediately;
- already-captured analytics events expire under the 12-month event-retention
  policy unless account/deletion handling requires earlier removal; session
  replay data expires after 30 days.

Anonymous initialize/tool-discovery events should remain anonymous before authentication, then use normal PostHog identity merging once the backend context becomes available and the account has not opted out.

The user-facing control remains a simple Account Settings toggle labeled **Share usage analytics**. Policy updates can be posted on the dated policy pages; no proactive email or in-app notice is required by the settled product direction.

## Package and runtime impact

Pinned dependencies:

- `@posthog/mcp@0.11.0`
- `posthog-node@5.48.1`

Measured installed footprint of `@posthog/mcp`, `posthog-node`, `@posthog/core`, and `@posthog/types`: approximately **4.97 MB**. The publishable package contents grow by approximately **14.5 KB unpacked** before compression.

Important compatibility finding: both PostHog packages declare Node `^20.20.0 || >=22.22.0`, while Trackly currently declares Node `>=20`. The spike ran successfully on Node `22.15.0`, but that runtime is outside the vendor-supported range and npm warns about it. A production release must choose one of:

- raise Trackly's Node floor;
- wait for a compatible PostHog release;
- use a smaller direct capture adapter while preserving the MCP instrumentation semantics.

The analytics dependency is lazy-loaded only after configuration passes, so normal MCP startup remains unaffected while the spike is disabled.

## Validation completed

The focused suite proves:

- default-on/configured and explicit-disable behavior;
- disabled mode does not load or mutate PostHog;
- instrumentation runs only after all 48 source tools are registered;
- sensitive fields are redacted from rich job-search events;
- Apply/profile payloads and intent are omitted entirely;
- verified allowlisted person identity remains visible while identity is removed from ordinary event properties;
- secrets and local paths are removed from exceptions;
- optional context advertisement and handler-side context stripping;
- `get_more_tools` advertisement;
- contract/runtime envelope on both tool and identify events;
- capture and instrumentation failures do not fail tools;
- transport close starts bounded analytics shutdown.

Repository-wide verification is green: **299 tests passed**, the package-lock and published shrinkwrap are byte-identical, `npm pack --dry-run` includes the analytics module, `git diff --check` passes, and the registry-backed npm security audit reports no vulnerabilities or temporary exceptions.

No real production-user MCP traces were collected during the spike. The package
had not been published or deployed, so production validation begins only after
the gates below are complete.

## Recommended rollout sequence

1. Amend the canonical analytics contract/catalog and the #1378/#101 roadmap to authorize the exact MCP rich-content boundary.
2. Add the backend-owned analytics identity plus `analytics_opt_out` response, and the Account Settings toggle.
3. Resolve the Node compatibility decision.
4. Add adversarial free-text privacy tests and fail closed whenever classification is uncertain.
5. Verify PostHog console controls: 12-month event retention, 30-day replay
   retention, restricted operator access, DPA, product caps, and 80% event/error alerts.
6. Publish behind an emergency kill switch, enable for 100% of eligible authenticated MCP users, and retain anonymous pre-auth lifecycle traces.
7. Prove both network delivery and PostHog ingestion using a unique correlation ID, then inspect all-user production traces rather than a founder-only sample.
8. Create dashboards for tool adoption, client mix, latency/error rates, missing capabilities, intent clusters, and version/runtime regressions.
9. Enable the autonomous improvement loop only after telemetry quality is proven.

## Autonomous improvement loop

The later loop may create evidence-backed GitHub issues and draft PRs, but never merge or deploy them automatically.

Suggested severity-aware triggers:

- **P0:** any suspected sensitive-content leak or analytics-induced MCP failure; one confirmed signal is enough.
- **P1:** tool/auth outage across multiple users or a sharp failure-rate regression.
- **P2:** repeated fingerprint across at least two users/sessions, or a missing-capability request repeated across sessions.
- **P3:** lower-volume usability or latency trend suitable for weekly review.

Each issue should carry redacted trace links, affected versions/clients, reproduction evidence, and a measurable recovery target. After a fix deploys, the issue remains open until production MCP telemetry shows that the targeted behavior improved.

## Final recommendation

Proceed toward production-wide MCP analytics. It is unusually high leverage for Trackly because agents hide much of the user journey from ordinary UI analytics, and the future autonomous maintenance loop needs trace-level evidence. Do not narrow validation to a founder-only sample. Do not ship the current spike unchanged: complete the identity/opt-out, contract, Node, and free-text privacy gates first.

---

# Trackly MCP Analytics — Production Implementation

**Date:** August 8, 2026 (PDT)

## Outcome

The CLI spike is now a production relay design. The local MCP server uses the
official PostHog MCP instrumentation package, but it never holds a PostHog
project key or a numeric Trackly user ID. It sends sanitized, fail-open events
to Trackly's API; the backend owns authenticated identity, account opt-out,
final redaction, sampling, and PostHog delivery.

Analytics are default-on for eligible MCP users and capture 100% of traffic at
the current scale. A server-side quota control can sample routine successes
while preserving failures and anomalous latency. The emergency CLI disable
switch remains available without changing normal MCP tool behavior.

## CLI boundary

- Anonymous pre-auth delivery is restricted to initialization, tool discovery,
  setup exceptions, and missing-capability lifecycle activity.
- Authenticated events use the existing Trackly credential only to call the
  Trackly relay. No auth refresh or analytics retry can delay a tool call.
- Every source tool accepts optional agent-supplied `context`; handlers receive
  the original schema after that context is removed.
- `get_more_tools` reports missing capability and intent.
- Rich payloads are limited to public job/company search, job retrieval,
  `trackly_ask`, and missing-capability events. Apply, profile, account, contact,
  resume, and application payloads remain structural only.
- Credentials, emails, local paths, IP/host/user properties, and the defined
  sensitive categories are scrubbed before the request leaves the process.
- Shutdown flushing is bounded to two seconds and capture errors are ignored.

## Backend dependency

Production use requires the companion backend schema and runtime changes:

- `users.analytics_opt_out` plus an immutable preference audit table;
- authenticated and anonymous relay routes with separate rate limits;
- backend-owned `distinct_id = String(users.id)` and anonymous alias merging;
- deterministic per-tool projection of non-sensitive arguments and selected
  public response fields;
- a second fail-closed sensitive-content gate for résumé text, profile answers,
  demographic/work-authorization answers, and application notes;
- 12-month event / 30-day session-replay retention disclosure and an Account
  Settings opt-out.

The CLI's local sanitizer is defense in depth. The backend is the authoritative
privacy and identity boundary, so a modified or older client cannot expand what
reaches analytics.

## Runtime compatibility

Pinned dependencies are `@posthog/mcp@0.11.0` and
`posthog-node@5.48.1`. Trackly's declared Node range is raised to the packages'
supported range: `^20.20.0 || >=22.22.0`.

## Verification

- Full CLI suite: 307 passed, 0 failed.
- Analytics-focused tests cover relay identity separation, anonymous event
  restrictions, default-on/disable behavior, sensitive redaction, optional
  context on all 48 source tools, missing-capability reporting, runtime
  metadata, fail-open capture, and bounded shutdown.
- Production PostHog credentials are absent from the package.
- No production trace was emitted from this worktree and no package was
  published or deployed.

## Release order

1. Review and merge the backend schema contract/migration.
2. Review and merge the web Account Settings toggle and policy disclosure.
3. Review and merge the backend runtime relay and privacy gates only after the
   disclosure is live.
4. Rebase this CLI branch onto those reviewed contracts, publish through the
   normal release workflow, then validate all eligible production MCP traffic.

The autonomous improvement loop may open severity-aware issues and draft PRs,
but it must never merge or deploy without separate authorization. Issues remain
open until production MCP telemetry demonstrates that the targeted behavior
improved.
