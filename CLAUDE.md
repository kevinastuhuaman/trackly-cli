# trackly-cli

CLI + MCP server for the Trackly job tracker. Lets users search 128K+ jobs across 1,900+ companies from the terminal or through AI agents (Claude Code, Cursor) via MCP.

## Tech Stack

- **Runtime:** Node.js 20+ (pure JS, no build step, no TypeScript)
- **MCP SDK:** `@modelcontextprotocol/sdk` (stdio transport)
- **Validation:** `zod` (MCP tool input schemas)
- **Auth:** Google OAuth via local callback server, tokens stored in `~/.trackly/config.json`
- **API:** All requests go to `https://closeai.mba` (the backend, same as CLOSE AI)

## Backend Production Source Of Truth

After the 2026-06-30 Azure cutover, `https://closeai.mba` is served by Azure and
the live DB is Azure blue Postgres behind the backend/VNet. This CLI repo is a
consumer only; do not use AWS RDS, Render, old DB aliases, `ssh closeai-web`, or
direct SQL for live production claims, migrations, user exports, or company-add
decisions. Backend data checks belong in protected close-ai admin/report
endpoints, not this CLI repo.

## Directory Structure

```
bin/trackly          # CLI entrypoint (shebang script). All CLI commands + arg parser + main()
lib/agent.js         # Agent setup, doctor, private resume cache, and public skill installation
lib/client.js        # HTTP client: config loading, token refresh, apiRequest()
lib/formatters.js    # Terminal output: color(), outputJobs(), outputCompanies(), outputStats(), outputContacts(), outputReferralCampaign(), outputNetworkBrief()
mcp/server.js        # MCP server: 48 tools, launched via `trackly mcp`
contracts/           # Versioned hosted/local Trackly Apply MCP schema contract
skills/trackly-apply/  # Sanitized public browser-mechanics skill bundled with the CLI
scripts/             # Maintainer checks; the packaged audit verifier is the named exception
docs/trackly-tools.md  # MCP tool reference (for embedding in AI contexts)
server.json          # MCP Registry manifest (io.github.trackly-app/trackly)
```

## Key Commands

```bash
# No build step -- pure JS
node bin/trackly --help        # Run locally without installing
npm link                       # Symlink for local dev
```

There is a small Node test suite (`npm test`), but no linter and no build step. The package ships raw JS.

## How the MCP Server Works

1. User runs `trackly mcp` (or AI agent spawns it via stdio)
2. `bin/trackly` delegates to `mcp/server.js`
3. `mcp/server.js` creates an `McpServer` with 48 tools, connects via `StdioServerTransport`
4. Each tool calls `apiRequest()` from `lib/client.js` with a `trackly-mcp/<version>` User-Agent derived from `package.json`
5. CLI commands use `trackly-cli/<version>` User-Agent derived from `package.json` (separate channel attribution)

MCP setup for Claude Code:
```bash
claude mcp add --scope user trackly -- trackly mcp
```

The 48 MCP tools include the complete search, network, profile, and Trackly Apply set documented in `docs/trackly-tools.md`. Keep this count synchronized with `mcp/server.js`, `README.md`, and the docs-drift tests.

Job function values — **14 canonical values** that match backend `ALL_JOB_FUNCTIONS` at `granola-followup-app/src/routes/jobscout-filter-utils.ts:17-21`, the backend `job_function` DB column, and the local mirror `JOB_FUNCTIONS` in `mcp/server.js`: `product`, `engineering`, `design`, `data`, `marketing`, `sales`, `partnerships`, `finance`, `strategy`, `operations`, `people`, `legal`, `support`, `other`. `partnerships` is documented in CHANGELOG `0.2.1`; any doc still listing 13 values is stale. The MCP test at `test/mcp-schema.test.js` locks this local/backend mapping.

NOTE: `/ask` lives in the backend (`trackly-app/close-ai`) and historically emitted `product_management`/`data_science` style values that the `/jobs` handler could drop. Backend PR #112 (`https://github.com/trackly-app/close-ai/pull/112`) is the proposed fix to emit modern public names (`product`, `data`, etc.). Do not document that drift as fixed/live until that PR is merged and deployed.

## Publishing

Publishing is fully automated via GitHub Actions:
1. Bump the version in `package.json`, `package-lock.json`, and `server.json` (run `npm version <patch|minor> --no-git-tag-version` for the first two, then edit `server.json`) and add a CHANGELOG entry in a reviewed PR; merge the PR to `main`
2. `auto-release.yml` creates a GitHub Release from the version bump (for the Releases page)
3. `publish.yml` triggers on the same merge-to-main push (gated to version changes) and publishes to npm with provenance via **npm Trusted Publishing** (GitHub Actions OIDC, no token). It also publishes to the MCP Registry.

**Do not run `npm publish` locally.** No npm auth token is needed (OIDC). Manual fallback if a publish ever needs re-triggering: `gh workflow run publish.yml` (a PAT-authed dispatch fires the workflow; `GITHUB_TOKEN`-created Releases/tags do not).

## Merge Strategy

- Always use `gh pr merge --merge` (merge commits). NEVER `--squash`, NEVER `--rebase`.
- NEVER use `--delete-branch` — fails in Conductor worktrees and blocks the post-merge sync hook.
- GitHub auto-deletes remote branches via repo settings.

## API Endpoints Used

All requests hit `https://closeai.mba` (configurable via `~/.trackly/config.json`):

- `GET /api/jobscout/jobs` -- List/filter jobs
- `GET /api/jobscout/jobs/:id` -- Job detail
- `GET /api/jobscout/companies` -- List companies
- `GET /api/jobscout/companies/search` -- Semantic company search
- `GET /api/jobscout/me` -- User stats and discovery preferences
- `PUT /api/jobscout/preferences` -- Atomic discovery-preference updates
- `GET /api/jobscout/ask` -- Natural language search (20/day limit)
- `POST /api/jobscout/companies/request` -- Request a company be added (rate-limited, 5 pending max)
- `POST /api/jobscout/tracker/jobs/:id/stage` -- Update job tracker stage (`applied`/`backlog`/`discarded`; CLI maps apply/save/dismiss)
- `GET /api/jobscout/apply/queue` -- Get the user's approved application queue (`trackly_get_apply_queue`)
- `GET /api/jobscout/application-profile` -- Get the versioned application profile (`trackly_get_application_profile`)
- `GET /api/jobscout/application-profile/schema` -- Get profile fields and onboarding questions (`trackly_get_profile_onboarding`)
- `PATCH /api/jobscout/application-profile` -- Update profile answers with optimistic concurrency (`trackly_update_application_profile`)
- `POST /api/jobscout/apply/executions` -- Start a server-owned accessible execution (`trackly_start_apply_execution`)
- `GET /api/jobscout/apply/executions/active` -- Recover the active accessible execution (`trackly_get_active_apply_execution`)
- `GET /api/jobscout/apply/executions/:executionId` -- Read authoritative execution progress (`trackly_get_apply_execution`)
- `POST /api/jobscout/apply/executions/:executionId/advance` -- Select the next immutable child wave (`trackly_advance_apply_execution`)
- `POST /api/jobscout/apply/executions/:executionId/dispositions` -- Record bound value-free probe classifications (`trackly_record_apply_execution_dispositions`)
- `POST /api/jobscout/apply/executions/:executionId/stop` -- Stop an active execution idempotently (`trackly_stop_apply_execution`)
- `POST /api/jobscout/apply/batches/:batchId/cancel` -- Retire a legacy fixed batch after explicit user confirmation (`trackly_cancel_apply_batch`)
- `POST /api/jobscout/apply/runs` -- Start an agent-assisted application run (`trackly_start_apply_run`)
- `GET /api/jobscout/apply/protocol` -- Get the versioned browser workflow (`trackly_get_apply_protocol`)
- `POST /api/jobscout/apply/observations` -- Report a redacted ATS observation (`trackly_report_apply_observation`)
- `POST /api/jobscout/apply/runs/:runId/outcome` -- Record review or submission outcome (`trackly_record_application_outcome`)
- `GET /api/jobscout/application-profile/default-resume` -- Download the default resume into the private local cache (`trackly_prepare_resume`)
- `POST /api/auth/api-key` -- Create API key
- `GET /api/auth/api-keys` -- List API keys
- `GET /api/auth/user` -- Current user info
- `POST /api/auth/refresh` -- Token refresh
- `GET /api/network/people` -- List/search contacts
- `POST /api/network/jobs/:id/referral-campaign` -- Start referral campaign
- `GET /api/network/jobs/:id/referral-campaign` -- Get referral campaign status
- `GET /api/jobscout/jobs/:id/network-brief` -- Get network brief for a job
- `GET /api/network/companies/:id/brief` -- Get company brief
- `POST /api/network/companies/:id/brief/refresh` -- Refresh/generate company brief
- `GET /api/network/companies/:id/workspace` -- Get company workspace (jobs, contacts, campaigns)
- `GET /auth/google/cli` -- OAuth login redirect

## Gotchas

1. **Version is runtime-derived from `package.json`.** Release-critical version edits are `package.json` and `server.json`. `lib/client.js` and `mcp/server.js` read `version` from `package.json` at runtime.
2. **No build step.** This is plain CommonJS JS. Do not add TypeScript, ESM, or a bundler.
3. **Auth tokens at `~/.trackly/config.json`.** File permissions are 0600, directory is 0700. Do not change this.
4. **OAuth callback binds to 127.0.0.1 only.** Port is OS-assigned (ephemeral via `listen(0)`, validated to 1024-65535 — the backend's accepted range). 5-minute timeout. A single `cmdLogin`-scoped SIGINT handler closes the callback server on Ctrl-C.
5. **`--json` flag or non-TTY stdout** triggers JSON output mode on all commands.
6. **The `ask` command has a 20/day rate limit** enforced server-side (429 response).
7. **Keep dependencies minimal.** Direct runtime dependencies are
   `@modelcontextprotocol/sdk`, `zod`, and a direct Hono declaration that
   guarantees the SDK's audited patched resolution. The local MCP transport
   remains stdio-only; do not add or initialize an HTTP server. The CLI HTTP
   client uses raw `node:https`/`node:http`.
8. **Token refresh is automatic.** On 401, `apiRequest()` tries one refresh via `/api/auth/refresh` before failing. The `_isRetry` flag prevents infinite loops.
9. **`/ask` backend drift is tracked outside this repo.** The CLI and MCP use DB-backed job function values directly. Backend PR #112 (`trackly-app/close-ai`) tracks the `/ask` prompt/URL migration to those same public values; verify production before claiming `/ask` round-trips are fixed.
