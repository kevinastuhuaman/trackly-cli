# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.10.2] - 2026-08-01

### Changed

- `trackly_update_application_profile` now forwards the full request —
  including `sensitiveRevocationConfirmToken` — to the backend, which owns
  the sensitive-storage revocation guard at the service layer (close-ai
  #1294). The local pre-flight guard is removed so no client-side copy can
  drift or be bypassed by version skew; the service's 409 challenge is
  relayed verbatim.

## [0.10.1] - 2026-08-01

### Added

- `trackly_update_application_profile` now requires explicit two-step
  confirmation (contract 3.4.0) before revoking sensitive-storage consent,
  which permanently deletes all stored sensitive and restricted answers.
  The first call saves nothing and returns a challenge listing the affected
  keys; nothing is deleted until the confirmation token is echoed back.

## [0.10.0] - 2026-08-01

### Added

- Trackly Apply skill 4.2.7 offers a one-time, batch-scoped duplicate-receipt
  check through a user's separately connected agent inbox. Trackly remains
  mailbox-blind, connector availability is never treated as consent, and
  declining or lacking a connector never blocks application work.
- Inbox receipt matches remain local and may produce only the existing redacted
  provider-receipt evidence. A receipt still cannot authorize submission or an
  Applied status without a success page or explicit user confirmation.

### Fixed

- Recovered batch members with an existing run now rebind that exact run instead
  of starting again. Inbox setup pauses, failed searches, and unconfirmed receipt
  matches also retain explicit local recovery states so optional receipt checks
  cannot trigger late searches or duplicate form mutation.

## [0.9.5] - 2026-07-31

### Fixed

- Trackly Apply skill 4.2.6 and MCP contract 3.3.3 now advertise the narrow
  legacy repair path correctly: a protocol 3.3.1 run may reconcile only from
  retained current-epoch explicit user-confirmation evidence. Passive
  success-page repair remains limited to protocol 3.3.2 or newer.

## [0.9.4] - 2026-07-31

### Fixed

- Align the local Trackly MCP server with Apply contract 3.3.2 so agents can
  safely use the backend's idempotent manual-submission reconciliation path.

## [0.9.3] - 2026-07-31

### Fixed

- Trackly Apply skill 4.2.5 treats current-epoch explicit user confirmation as
  authoritative for protocol 3.3.2 stale-projection repair, while preserving
  stronger stored success-page evidence and the manual-submit boundary.
- Prior-submission receipts are reconciled before browser mutation, and
  accessible frozen-batch members are handled before credential-gated members
  without changing the server-owned batch membership or order.

## [0.9.2] - 2026-07-30

### Fixed

- Trackly Apply skill 4.2.4 preserves the complete live application-tab set
  through browser-session finalization and requires user-visible handoff proof
  before claiming a review form is open.
- Education and employment history are entered newest-first, and intentionally
  blank current employment is no longer confused with the most recent employer.
- With backend apply protocol 3.3.2 or newer, current-epoch success-page
  receipts are reconciled without fabricating a retroactive review checkpoint
  when Trackly's run projection is stale.

## [0.9.1] - 2026-07-29

### Fixed

- Trackly Apply skill 4.2.3 now records the literal `review_ready` outcome and
  verifies `awaiting_manual_submit` before handing forms to the user. After a
  manual submission, it records the separate literal `submitted` outcome.
- Local MCP prompts and tool descriptions now expose the same ordered
  reconciliation contract, preventing split member/run state from stranding a
  confirmed application.

## [0.9.0] - 2026-07-29

### Changed

- Raised the minimum supported runtime to Node.js 20. This pre-1.0 minor
  release makes the compatibility boundary explicit.
- Trackly Apply skill 4.2.2 treats submission outcome reconciliation as a
  durable commit gate before closing confirmation tabs or claiming a job moved
  to Applied.
- Added one-retry frozen-member start recovery, explicit control-plane failure
  routing, and a complete-known-fields comparison before review.
- Added live-beta ATS mechanics for Greenhouse file/select controls, Ashby
  binary and repeatable education controls, and HiBob two-step attachments.
- Upgraded the MCP SDK and pinned the advisory-fixed Hono Node adapter. The CLI
  now requires supported Node.js 20+ and ships with zero npm audit exceptions.

## [0.8.1] - 2026-07-24

### Added

- Trackly Apply skill 4.2.1 and protocol 3.3.1 freeze recent-first batches before
  browser work, inspect the full batch before asking one grouped set of
  questions, and preserve member/run identity across interruptions.
- Added exact batch resume approval, late truth certification, browser-surface
  reconciliation, missing-tab recovery, and typed redacted submission evidence.
- Hosted and local MCP expose the same versioned batch contract; hosted MCP
  retains the documented local-file exception for resume preparation.

### Security

- Added an exact-shape npm audit gate for the temporarily unreachable
  `GHSA-frvp-7c67-39w9` transitive advisory. CI rejects every additional
  advisory or change to its severity, affected range, or dependency path, and
  real stdio initialization verifies that Trackly never loads the affected
  HTTP/static-file code.
- Added a packed-consumer smoke test so release validation executes the CLI
  from the actual npm tarball rather than only from the repository checkout.

## [0.7.3] - 2026-07-22

### Added

- `trackly preferences` and the local MCP tools `trackly_get_preferences` and `trackly_update_experience_limits` expose bounded role-specific experience preferences with canonical job functions and clear inclusive wording.

### Fixed

- Preference updates require the server capability flag and an exact safe revision, preventing unavailable or stale clients from overwriting newer choices. Preference output no longer implies that saved limits are already enforced.

## [0.7.2] - 2026-07-20

### Fixed

- Trackly Apply skill 4.1.1 no longer recreates the obsolete company-ownership timestamp gate. Protocol 3.2 can authorize the exact HTTPS origin of a job ingested directly from an employer careers source while still failing closed on redirects, iframe origin changes, unknown sources, aggregators, and explicit ATS tenant contradictions.
- Browser identity checks now require the run-bound company and role, plus the requisition identifier when the stored job URL exposes one, before private profile data is entered.

## [0.7.1] - 2026-07-17

### Added

- `trackly agent evidence` and `trackly_get_apply_evidence` expose an authenticated, aggregate beta report without contact values, answers, addresses, page text, or local paths.
- Trackly Apply skill 4.1 records committed `critical_contact_integrity` and `manual_submit_boundary` proof before every review-ready outcome.

### Changed

- Apply protocol/tool contract 3.1 distinguishes required onboarding completeness from optional reusable coverage and employer-specific contextual questions.
- `hono` is now a direct `^4.12.30` dependency, guaranteeing the patched runtime for every npm consumer instead of relying on a package-local override.

## [0.7.0] - 2026-07-16

### Added

- Bundled Trackly Apply skill 4.0.0 consumes the backend-owned ATS capability and origin catalog, enabling constrained guided mode across named enterprise and mid-market ATS providers while keeping LinkedIn-hosted and unverified employer forms manual-only.
- Provider capabilities now carry required integrity scenarios, risks, and explicit stop conditions instead of a binary supported/unsupported claim.

### Changed

- Agent doctor now requires Apply protocol 3.0.0 and skill major 4 for the breaking cross-ATS guided-mode contract.
- The versioned Apply MCP tool contract is now 3.0.0. `trackly_report_apply_observation.metadata.committed` is required, so older observation callers must update before using CLI 0.7.0.
- Guided runs stop before start on any queue blocker, validate redirects and data-receiving iframes against backend-authorized origins, and require every backend-published integrity scenario before review.
- Unknown employer forms never share provider-scoped answers across companies.

## [0.6.4] - 2026-07-16

### Added

- Trackly Apply now gates resume preparation on semantic browser readiness, binds every application tab to its exact job and run, and reclaims the mapping after handoffs or browser-control interruptions.
- Application profile schema 1.3 adds safely scoped answers for prior employer work, close relationships at an employer, relocation assistance, gender-identity wording, and optional future-opportunity data retention.
- Redacted per-run scenario coverage records which browser, resume, semantic-control, validation, consent, and handoff mechanics were actually exercised.

### Fixed

- Coordinate-only browser interaction can no longer substitute for observable semantic form control.
- Accuracy and truthfulness certifications remain per-run attestations and are never persisted as reusable profile answers.
- Bundled Trackly Apply skill 3.0.0 and tool contract 2.1.0 enforce a breaking compatibility gate so older 2.x skills stop before the stronger browser harness runs.

## [0.6.3] - 2026-07-15

### Added

- Trackly Apply can calibrate free-text application answers from optional, private voice samples and style preferences stored in the user's Trackly profile. The bundled anti-slop gate is self-contained, avoids em dashes by default, and does not require a separate Humanizer skill.
- Explicit next-N batching freezes the approved job set and preserves each job, run, browser tab, and resume-integrity proof through `review_ready` without submitting.

### Fixed

- Boolean ATS controls are selected and verified by semantic value rather than option order, preventing `Yes` answers such as age eligibility from being committed as `No`.
- Missing education months remain unknown until the user confirms them; browser defaults are never accepted as profile truth.
- Contradictory ATS states such as an initial “already applied” message are reconciled against the exact requisition before recording the final outcome.
- Optional controls without validation errors no longer fail the required-field integrity gate after a correct committed selection.
- Bundled Trackly Apply skill 2.2.0 includes the stronger semantic, batching, education-date, ATS-reconciliation, and writing-integrity rules.

## [0.6.2] - 2026-07-15

### Fixed

- Trackly Apply now treats consent to a background check after advancement as explicit reusable consent. Unknown answers are asked before form selection, saved at the user's chosen scope, and never inferred from unrelated privacy, demographic, recruiting-data, criminal-record, professional-reference, or general application consent.
- Bundled Trackly Apply skill 2.1.0 recognizes the canonical `consent.background_check_if_advanced` profile field while remaining compatible with the 2.x application protocol.

## [0.6.1] - 2026-07-14

### Fixed

- Prepared resumes preserve the exact user-facing filename supplied by Trackly, while unique cache identifiers remain private parent-directory names and never appear in employer upload chips.
- Prepared-resume results require visual confirmation bound to the exact SHA-256, application run, and expiring local file before upload. The bundled skill directs agents to preview the exact bytes and always display the exact local path.
- Expired-resume cleanup supports the nested private cache layout safely, including concurrent cleanup by multiple Trackly processes.
- A local pre-attach verifier validates a signed prepare-issued proof, recomputes the confirmed resume fingerprint, validates its run and expiration, and locks the exact file read-only immediately before browser attachment.
- Removed the retired `applying` status from the final CLI help surface.
- Bundled Trackly Apply skill 2.0.0 and tool contract 2.0.0 make the run-bound exact-file confirmation gate an explicit breaking safety upgrade.

## [0.6.0] - 2026-07-14

### Added

- `trackly jobs --work-arrangement remote,hybrid` filters by the first-class work-arrangement dimension independently from region and employment type. Canonical values are `remote`, `hybrid`, `in_person`, and `unspecified`.
- Local MCP `trackly_search_jobs` accepts the typed `workArrangements` array with the same independent, multi-select semantics as Trackly Web, iOS, and macOS. Natural-language `trackly_ask` uses the backend's matching work-arrangement mapping.

## [0.5.2] - 2026-07-14

### Fixed

- Canonical `maintenance_mode` responses now retain HTTP/service status, retry time, ETA, and request ID across REST requests, OAuth refresh, resume downloads, human/JSON CLI output, and local MCP errors; `planned_maintenance` remains a compatibility alias only.
- Maintenance no longer clears valid OAuth credentials or triggers a blind retry. Trackly Apply now waits, refetches protocol/profile state, and resumes the existing browser run without creating a duplicate or clicking Submit.
- The bundled Trackly Apply skill is versioned `1.0.1`, so `agent doctor` marks pre-maintenance `1.0.0` installs stale and `agent setup` replaces them with the new recovery rules.

## [0.5.1] - 2026-07-13

### Fixed

- Claude agent setup now recovers when stale config metadata references Trackly but Claude's user-scoped MCP registry already removed it, while preserving every other removal failure.

## [0.5.0] - 2026-07-13

### Added

- Public, sanitized `trackly-apply` skill for Codex and Claude Code on macOS. It fetches profile and browser rules from Trackly, fills only user-approved queued applications, verifies committed form state, and always stops before Submit.
- `trackly agent setup --client codex|claude|both` installs one canonical skill copy and registers the local MCP server. `trackly agent doctor` checks authentication, client registration, skill/protocol compatibility, profile completeness, default resume, permissions, and cache cleanup.
- Nine Trackly Apply MCP tools for queue execution, versioned profile onboarding, scoped answer updates, run outcomes, redacted observations, and secure local resume preparation.
- Local default-resume caching with mode-0600 files, SHA-256/type validation, and two-hour expiry cleanup.

### Security

- The public skill contains no user profile, resume, address, answers, application logs, or absolute personal paths. OTP and human-verification values are never stored, and submission remains manual.

## [0.4.2] - 2026-06-14

### Fixed

- **Automated npm publishing now actually triggers itself.** `auto-release.yml` creates the GitHub Release/tag with `GITHUB_TOKEN`, which (per GitHub's recursion-prevention rule) does **not** fire `publish.yml`'s `release:`/`push: tags` events — so v0.4.0 and v0.4.1 each required a manual Release recreate to reach npm. `publish.yml` now also triggers on the merge-to-main `push` (a PAT-created event that reliably fires), gated to actual version bumps, and publishing still runs from `publish.yml` so npm Trusted Publishing's OIDC subject is unchanged. Added a `workflow_dispatch` trigger as a manual fallback (`gh workflow run publish.yml`).

## [0.4.1] - 2026-06-14

### Added

- **`NO_COLOR` / `FORCE_COLOR` support.** Color output now follows the [no-color.org](https://no-color.org/) convention — `NO_COLOR` (present and non-empty) disables ANSI color, `FORCE_COLOR` (set and not `0`/`false`) forces it on, otherwise color is used only on a TTY. Error output keys on stderr's TTY-ness. Makes the CLI a better citizen in logs, CI, and pipelines.
- **`config` rejects contradictory flags.** `trackly config --api-key … --clear-api-key` (and the `--base-url`/`--clear-base-url` pair) now error instead of silently letting one win.

### Changed

- **Login uses an OS-assigned ephemeral callback port** (`listen(0)`) with a 1024–65535 guard, replacing the fixed 19847–20846 range and its retry loop — eliminates the rare port-collision failure. Ctrl-C during login now closes the callback server cleanly via a single, properly-removed SIGINT handler.

## [0.4.0] - 2026-06-14

### Fixed

- **Concurrent token refresh could silently log you out mid-session.** In the long-lived MCP server, simultaneous tool calls that each hit a 401 would each fire `POST /api/auth/refresh` in parallel. The backend rotates the refresh token on use, so the second in-flight refresh sent a now-stale token, got a 4xx, and cleared the stored OAuth credentials — logging the user out even though the first refresh had succeeded. Refreshes are now coalesced (single-flight) within a process, so concurrent 401s share one refresh and both retry with the freshly-rotated token. (Note: this does not coordinate across multiple separate `trackly` processes sharing `~/.trackly/config.json`.)
- **Unexpected HTTP redirects are now surfaced as clear errors.** `apiRequest` previously treated any `<400` status as success, so a 3xx response would resolve with the redirect headers as bogus data. 3xx is now rejected with an explicit "Unexpected redirect" message.
- **Unreadable config now gives an actionable error.** A `~/.trackly/config.json` that exists but isn't readable (EACCES/EPERM) now reports "Trackly config is not readable … Check file permissions" instead of a generic error.
- **Invalid `--base-url` values report a clear message** ("Invalid base URL: …") at both the global-flag and `config` call sites.
- Non-JSON API error responses now always carry a usable `message` for diagnostics.

### Added

- **Typo and wrong-command flag detection.** Mistyped or misplaced flags (e.g. `trackly jobs --regoin us`, or `trackly jobs --url x`) are now rejected with a "did you mean …?" suggestion instead of being silently ignored — which previously returned, for example, an unfiltered job feed that looked filtered. Deprecated `--location`/`--modality` still get their richer migration messages. `--help`/`--version` are unaffected.

### Tests

- New end-to-end CLI integration suite (flag → query-param/body mapping, deprecation + conflict guards, unknown-flag rejection, `--json` output), formatter unit tests, a concurrent-refresh test, a 3xx test, and an EACCES test. Shared test helpers extracted to `test/helpers.js`.

## [0.3.2] - 2026-05-27

### Fixed

- **CI: explicit `npm install -g npm@11` step added before publish.** v0.3.0 and v0.3.1 publish attempts both failed with `ENEEDAUTH` because Node 22.22.3 (what `setup-node@v5.0.0` installs) ships npm **10.9.8** by default, which has NO OIDC Trusted Publishing code path. The PR #36 / #38 Trusted Publishing wiring was correct (npm dashboard configured, .npmrc auth-line stripping working, `id-token: write` permission set) but blocked at the CLI level. PR #39 adds an explicit npm upgrade step pinned to `npm@11` plus a runtime gate (`npm --version` ≥ 11.5.1) so future npm releases that downgrade or break the OIDC path fail loudly instead of silently shipping unattested. With npm 11.5.1+ in place, OIDC token exchange activates and the publish authenticates without `NODE_AUTH_TOKEN`.

## [0.3.1] - 2026-05-27

### Fixed

- **CI publish failed at v0.3.0 with HTTP 404; OIDC token exchange was skipped.** PR #36's R1 fix stripped the stale `_authToken=` line from `~/.npmrc`, but `actions/setup-node` writes its `.npmrc` to the path in `$NPM_CONFIG_USERCONFIG` (`/home/runner/work/_temp/.npmrc` on GitHub-hosted runners) — NOT `~/.npmrc`. The actually-read file still had the empty `_authToken=` line, which tricked npm into skipping the OIDC token exchange. The Publish run signed a provenance statement (sigstore logIndex=1645376188) but the npm tarball PUT returned 404 because no auth header was sent. v0.3.1 retargets the strip step at `$NPM_CONFIG_USERCONFIG` and adds an explicit `NODE_AUTH_TOKEN: ""` at the publish step to clear any setup-node-injected job-level value. v0.3.0 GitHub release was deleted (never reached npm); the git tag remains in history. All v0.3.0 user-facing content (request-company command + MCP tool + Trusted Publishing) ships in v0.3.1.

## [0.3.0] - 2026-05-27

### Added

- **`trackly request-company <name>` CLI command + `trackly_request_company` MCP tool** (PR #32). Lets users request that a company be added to Trackly's tracked companies — useful when the company they care about isn't in `trackly_search_companies` / `trackly_list_companies` results yet. CLI: `trackly request-company "eBay" --url https://careers.ebay.com --notes "MBA hiring page"`. MCP tool follows the same shape (`companyName`, optional `companyUrl`, optional `notes`). Rate-limited to 5 pending requests per user. Closes the parity gap with TracklyWeb / TracklyApp / TracklyMac which already had this UI. Total MCP tool count: 10 → 11.

### Security

- **CI: npm publish migrated to Trusted Publishing** (PR #36, closes #7). Removed `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` from `publish.yml`. npm now authenticates via GitHub Actions OIDC token (`id-token: write` permission already set at the job level). Eliminates the 90-day npm-token expiry class of failure that hit v0.1.11 (Apr 11, 2026) and v0.2.7 (May 20, 2026 — manual laptop publish bypass). Provenance attestations continue to land via the `--provenance` flag.
- **CI: Node bumped to 22 in publish.yml** (PR #36 R1). Trusted Publishing OIDC requires npm CLI 11.5.1+, which ships with Node 22.14+. Node 20 ships npm 10.x with no OIDC publish-auth path. Other workflows stay on Node 20 (they don't publish). Caught by Cursor Bugbot HIGH on R0 — without R1 the next release would have failed at `npm publish` with `ENEEDAUTH`.
- **CI: `.npmrc` auth-line cleanup step added before publish** (PR #36 R1). `actions/setup-node` with `registry-url` writes `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` to `~/.npmrc`. With `NODE_AUTH_TOKEN` unset, the empty value tricks npm into thinking auth is configured and skipping the OIDC token exchange. `sed`-strips the stale line so OIDC activates. Documented at `actions/setup-node#1551`.
- **`qs` transitive dependency advisory patched** (PR #33). GHSA-q8mj-m7cp-5q26 (CVSS 5.3 DoS in `qs.stringify` with `encodeValuesOnly` + null/undefined in comma arrays). Lockfile-only update; `qs@6.15.2` is above the vulnerable range 6.11.1-6.15.1. `npm audit` now reports 0 vulnerabilities at all severity levels.

### Maintenance

- **GitHub Actions: bumped `actions/checkout` v4 → v5.0.1 and `actions/setup-node` v4 → v5.0.0** across all 7 workflow files (PR #33). Node 24 runtime is the default for actions after June 2 2026; the new SHAs work on Node 24. Pinned by commit SHA per the existing supply-chain hardening policy.
- **`social-preview.png` committed to repo root** (PR #33). 1456×720 OpenGraph / Twitter card for the GitHub repo + npm package page. Untracked in working tree since March 7.
- **`AGENTS.md` updated** to reflect the Trusted Publishing path + a stronger warning against manual laptop publishes referencing the v0.2.7 unattested-release gap.

## [0.2.8] - 2026-05-23

### Fixed

- **CI provenance attestation restored for v0.2.7.** `trackly-cli@0.2.7`'s npm release lacks a provenance attestation (`npm view trackly-cli@0.2.7 dist.attestations` returns empty) because the package was published manually from a laptop after the CI Publish workflow's first attempt failed on a pre-rotation NPM_TOKEN (issue #29). NPM_TOKEN was rotated to Automation type in the v0.2.7 cycle, but the workflow re-run hit `E403 EPUBLISHCONFLICT` since the version was already on npm. v0.2.8 is a no-code-change release whose sole purpose is to ship a clean attested tarball via the CI path. Verifies the rotated token works.

  **Correction (2026-05-26):** Earlier wording of this entry claimed v0.2.5 and v0.2.6 were also unattested, but that's wrong. Both shipped with SLSA v1 provenance via CI Node 20.20.2 — the npm publish step succeeded; only the downstream MCP Registry publish step failed in those releases (see "CI: MCP Registry publish step was failing" in the v0.2.6 entry). Only v0.2.7 has `dist.attestations` empty.

## [0.2.7] - 2026-05-20

### Fixed

- **`trackly_search_jobs(companyId)` returned 0 for any company without PM-classified roles.** The MCP URL builder dropped the `jobFunction` query param entirely when the caller omitted `function`. Backend (`granola-followup-app/src/routes/jobscout.ts:3473-3478`) then fell through to a legacy boolean filter defaulting to `j.is_pm_role = TRUE`. Surfaced 2026-05-20 on two unrelated freshly-activated companies — Cahoot (id=3349, smartrecruiters, 5 jobs none PM) and Iterative Health (id=3350, greenhouse, 46 jobs none PM) — both returning `total: 0` from `search_jobs` despite having jobs in the DB. Fixed in [PR #27](https://github.com/trackly-app/trackly-cli/pull/27): when `params.function` is undefined, send `jobFunction` as the full 14-item canonical function list. This triggers the backend's `isAllJobFunctionsSelection` all-roles short-circuit at `jobscout.ts:3461`. Added regression test in `test/mcp-schema.test.js` that textually asserts both the new defaulting expression AND absence of the old buggy `if (params.function !== undefined) qs.set(...)` pattern (including the braced/multi-line form, per Copilot R1 feedback).

## [0.2.6] - 2026-05-13

### Changed

- **MCP Registry namespace migrated from `io.github.kevinastuhuaman/trackly` → `io.github.trackly-app/trackly`.** The `trackly-cli` repo and its 7 sibling Trackly repos (TracklyApp, TracklyMac, TracklyWeb, close-ai, homebrew-trackly, trackly-cli-video, TracklyAndroid) moved from Kevin's personal GitHub account to the `trackly-app` GitHub Organization on 2026-05-13. The organization structure allowed trusted collaborators to hold explicit repository roles (impossible on user-owned repos — see `github-user-repo-permission-limits` memory). The MCP Registry derives publish permissions from the repo's GitHub owner via OIDC, so the namespace must reflect the new owner. **Existing installs at the old namespace continue working — the old MCP Registry entry remains active, and the npm package itself is unchanged.** New installs from Claude Code/Cursor/Codex will resolve `io.github.trackly-app/trackly` going forward. The old entry will be flagged as `deprecated` with a status message pointing to the new namespace.
- **Repository URL updated** in `package.json` + `server.json` from `github.com/kevinastuhuaman/trackly-cli` → `github.com/trackly-app/trackly-cli`. GitHub redirects keep old `git clone` and API calls working indefinitely, but downstream tooling should use the canonical URL.

### Fixed

- **CI: MCP Registry publish step was failing.** v0.2.5's release auto-published to npm but the MCP Registry sync step (in `publish.yml`) failed at `mcp-publisher login github-oidc` with `failed to validate OIDC token: invalid audience: expected https://registry.modelcontextprotocol.io, got [mcp-registry]`. Upstream `mcp-publisher` v1.7.6 (Apr 30, 2026) bound the OIDC token exchange to a per-deployment audience, fixing this. Bumped pin from v1.6.0 → v1.7.8 in both `publish.yml` and `publish-mcp-registry.yml`, with the matching SHA256 (`48230dbec85bd88a0d42977ef533cddda23235f0db4331b9263ce53b432cb75c`) verified from the upstream `registry_1.7.8_checksums.txt`. Future releases will sync to MCP Registry again.

## [0.2.5] - 2026-05-06

### Fixed

- **Setup-guide URL was 404.** Since v0.2.0, README + `docs/trackly-tools.md` linked users to `https://usetrackly.app/connect` for the visual co-work setup guide, but the page on TracklyWeb was published at `/connector` (singular). Anyone clicking the link from npm or GitHub hit a hard 404. Both references corrected to `/connector` (the canonical, live URL — already linked from `usetrackly.app/cli` and `usetrackly.app` footer).

## [0.2.4] - 2026-04-20

### Security

- **CI: all `uses:` actions pinned to commit SHA** across `auto-release.yml`, `ci.yml`, `docs-drift.yml`, `publish.yml`, `publish-mcp-registry.yml`. Previously `@v4` tags could be re-pointed upstream to a malicious commit without our repo seeing the change. `claude.yml` and `claude-code-review.yml` were already SHA-pinned.
- **CI: added `permissions: contents: read`** as the default for `ci.yml` and `docs-drift.yml`. Publish + auto-release workflows continue to opt into `contents: write` / `id-token: write` at the job level explicitly.
- **`@claude` workflows: added `github.actor` + `author_association` allowlist.** Previously any GitHub user could comment `@claude` on an issue/PR and trigger an agent run that holds AWS Bedrock credentials. Now gated on `kevinastuhuaman` OR `OWNER`/`MEMBER`/`COLLABORATOR` association. Same gate applied to `claude-code-review.yml` (fork PRs from unknown authors no longer auto-run Claude with production secrets).
- **HTTP client: 10 MB response-body cap** in `lib/client.js`. A malicious or misconfigured `TRACKLY_BASE_URL` can no longer stream unbounded data and OOM the long-lived MCP process. Destroyed-request errors are reported to the caller.
- **`/ask` response: `jobsUrl` path allowlist** (regex: `/^\/api\/(v1|jobscout)\/jobs(\?|$)/`). `normalizeEndpoint` already blocked cross-origin fetches, but a compromised backend could still emit a same-origin path like `/api/admin/secret-dump` that the CLI/MCP would fetch with the user's Authorization header. Both `bin/trackly:cmdAsk` and `mcp/server.js:trackly_ask` now refuse any `jobsUrl` outside the allowlist, and the MCP tool strips the refused URL from its return payload so the client doesn't receive it either.

## [0.2.3] - 2026-04-20

### Security

- **Supply chain: pinned `mcp-publisher` download + SHA256 verification in publish workflows.** Previously `.github/workflows/publish.yml` and `publish-mcp-registry.yml` piped `releases/latest` straight through `tar xz`, running any upstream-compromised binary inside a workflow that held OIDC + `NPM_TOKEN`. Now pinned to `v1.6.0` with SHA256 `2de4ac3b…405d42`.
- **Supply chain: npm publish now runs with `--provenance`.** README/CLAUDE.md claimed provenance attestations were active since 0.1.1, but `npm view trackly-cli@0.2.2 dist.attestations` was empty — docs shipped ahead of reality. The publish workflow now sets `--provenance` AND verifies the attestation landed on the registry (post-publish smoke), so a degraded provenance pipeline fails the release instead of silently shipping an unattested tarball.
- **Dependency CVEs: regenerated `package-lock.json` to pull `hono@4.12.14` + `@hono/node-server@1.19.14`.** Closes GHSA-92pp-h63x-v22m (middleware bypass via repeated slashes) and GHSA-26pp-8wgv-hjvm (cookie name validation). Both were moderate; neither was reachable at runtime because trackly-cli uses stdio MCP not HTTP, but `npm audit` now reports 0 vulnerabilities.
- **Token storage: atomic config write.** `saveConfig` now writes to `~/.trackly/config.json.tmp.<pid>` (mode 0600) and `fs.renameSync`s into place. A crash or SIGKILL mid-write no longer leaves a truncated config that silently loses auth.
- **Token storage: clear dead refresh tokens instead of retrying forever.** `refreshAccessToken` now calls `clearConfig()` on 400/401/403 from `/api/auth/refresh`, so an invalidated session doesn't trigger a doomed refresh attempt on every subsequent 401. Transient network errors (no `status`) still leave the token in place.
- **Secret hygiene: `--api-key` on command line now warns + scrubs argv.** The flag value is visible in `ps auxww` to local users and lands in shell history. The CLI now prints a one-line stderr warning (silenceable with `TRACKLY_NO_WARN=1`) and replaces the value in `process.argv` with `***` to defeat in-process leaks (e.g. an MCP tool accidentally logging `process.argv`). The `ps` vector itself is lost the moment the process starts — use `TRACKLY_API_KEY` env var or `trackly config --api-key` to avoid it entirely.

## [0.2.2] - 2026-04-20

### Fixed

- **CRITICAL: `trackly apply` / `save` / `dismiss` status updates returned HTTP 404.** Backend retired the old `/api/jobscout-tracker/status` endpoint in favor of `/api/jobscout/tracker/jobs/:id/stage` with stage mapping (`applied → applied`, `saved → backlog`, `dismissed → discarded`). CLI and local MCP now POST to the new endpoint with the correct stage value. On versions up to and including `0.2.1`, these commands hit the removed path and the backend returned a 404 HTML error — the tracker state was never updated server-side, even though the CLI exit code and (non-JSON) output did not make the failure obvious.
- **MCP sort enum drift** — `0.2.1` was published with the pre-PR-#17 code (Auto-Release only fires on version bumps; the sort fix merged but no bump triggered). This release actually ships `SORT_VALUES=['newest','match']` in the published tarball.

### Added

- `test/mcp-schema.test.js` regression test for the status-endpoint drift: asserts neither `bin/trackly` nor `mcp/server.js` contain a live `apiRequest('POST', ...)` to `/api/jobscout-tracker/status`, and both define the stage mapping.

## [0.2.1] - 2026-04-19

### Fixed

- **CLI query param mapping** — `cmdJobs` now correctly maps `--region` to `locationFilter`, `--job-type` to `jobModality` instead of the old `location`/`modality` that the backend ignored. Deprecated `--location` / `--modality` flags are explicitly rejected with migration hints (previously they silently passed through and were ignored).
- **CLI response fields** — `outputJobs` and `cmdJob` now read the real camelCase fields (`companyName`, `jobUrl`, `postedAt`, `firstSeenAt`, `description`, `totalJobCount`) instead of the snake_case names that never existed in production. `trackly job <id>` and `trackly jobs` now render all columns correctly instead of rendering blanks.
- **MCP `trackly_search_jobs` schema** — added missing `partnerships` to the function enum (14 canonical values now). `locationFilter` uses a 3-branch union matching the real backend parser (scalar specials, scalar region tag, array of region tags). `jobModality` values are `full_time | internship | all` (backend reality) instead of the old `remote | hybrid | onsite` (which the backend silently ignored). New explicit `remote` boolean param for the common remote-filter case. `status` values now match the real backend allowlist.
- **MCP schema `['us', 'europe']` leak** — the array branch of `locationFilter` no longer accepts `'us'` (which would cause the backend to silently drop the other entries). Zod rejects the invalid mix up front.
- **Docs** — `docs/trackly-tools.md` and `README.md` reflect the new flag surface; old examples claiming `--modality remote` are gone.

### Added

- New CLI flags: `--region <tag>`, `--job-type <full_time|internship|all>`, `--remote` boolean shorthand for `usStates=REMOTE`.
- `trackly jobs <id> --location us` now routes through cmdJobs so the deprecated-flag migration error fires (previously silently routed to cmdJob and dropped the filter).

## [0.1.10] - 2026-03-13

### Changed

- CI audit level upgraded from `moderate` to `high` (stops transitive false positives)
- Added Slack notification to #trackly-critical on CI failure
- Strict API key validation — rejects invalid keys immediately instead of warn-and-save
- Documented function enum mismatch gotcha in CLAUDE.md

## [0.1.9] - 2026-03-13

### Fixed

- README: `product_management` → `product` to match actual DB column values
- README: "7 MCP tools" → "10 MCP tools", added 3 missing tools to reference table
- CLI error message: "trackly applied" → "trackly apply"
- Added `--company` flag to CLI examples and docs/trackly-tools.md

## [0.1.8] - 2026-03-13

### Fixed

- **Critical:** jobFunction enum values in MCP now match DB (`product` not `product_management`) — filters were silently returning 0 results
- CLI parameter mapping: `function` → `jobFunction`, `keywords` → `search`
- Security: upgraded hono to fix prototype pollution (GHSA-v8w9-8mx6-g223)

### Added

- `--company` flag to CLI jobs command for company ID filtering

## [0.1.7] - 2026-03-12

### Added

- `companyId` filter on `trackly_search_jobs` MCP tool

### Fixed

- MCP `function` parameter now correctly maps to backend `jobFunction`
- MCP `keywords` parameter now correctly maps to backend `search`

## [0.1.6] - 2026-03-12

### Added

- `trackly contacts` — list/search contacts at companies
- `trackly brief` — get network brief for a job
- `trackly referral start/status` — start and check referral campaigns
- `trackly company-brief` (with `--refresh` flag) and `trackly company-workspace` commands
- `trackly_get_job_brief`, `trackly_contacts_at_company`, `trackly_get_company_workspace` MCP tools
- Funding series and valuation displayed in CLI job output

### Changed

- CLI onboarding improved: 3 auth options (OAuth, config, env var), login timeout 2→5 min, API key fallback on failure, retry up to 3 ports

## [0.1.5] - 2026-03-10

### Changed

- OAuth callback server hardened
- CSRF state parameter added to OAuth flow
- SSRF prevention on ask results
- Refresh token retry guard
- HTTPS enforcement for token refresh
- Zod validation for all MCP inputs

## [0.1.4] - 2026-03-08

### Added

- Implemented API key usage in the CLI via `--api-key`, `TRACKLY_API_KEY`, and `trackly config --api-key`
- Added `trackly config`, `trackly version`, `trackly status`, and `trackly companies search <query>` command support
- Added request timeout handling, manifest regression tests, CLI parser tests, and MCP startup smoke tests

### Changed

- MCP registry manifest now launches the package with the `mcp` subcommand and includes website metadata
- CLI and public docs now match the actual command surface and auth flows
- Authenticated requests now require HTTPS unless the target is localhost
- Browser login flow now opens URLs without shell interpolation

## [0.1.3] - 2026-03-07

### Changed
- Differentiated User-Agent headers: CLI sends `trackly-cli/0.1.3`, MCP sends `trackly-mcp/0.1.3`
- Enables server-side channel attribution for discovery metrics

## [0.1.2] - 2026-03-07

### Added

- Published to Official MCP Registry as `io.github.kevinastuhuaman/trackly`
- Added `mcpName` field to package.json for registry verification

## [0.1.1] - 2026-03-07

### Added

- SECURITY.md with vulnerability reporting policy and token storage documentation
- LICENSE file (MIT)
- CI/CD workflows for automated testing and npm publishing with provenance
- CHANGELOG.md following Keep a Changelog format
- FUNDING.yml for GitHub Sponsors

### Changed

- Enhanced npm package.json metadata (keywords, repository, homepage, funding)
- README rewritten with badges, feature comparison table, and GEO optimization
- MCP server input validation hardened with z.enum and limits

## [0.1.0] - 2026-03-07

### Added

- Initial release
- 14 CLI commands for job application tracking
- 7 MCP tools for AI assistant integration
- Google OAuth login flow
- API key management
- Natural language job search
