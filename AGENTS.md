# AGENTS.md - trackly-cli

Universal context for AI coding agents (Codex, Cursor, Copilot, Claude Code, Devin, Jules, etc.)

## Project Overview

- **Product:** Trackly CLI + MCP Server — terminal access to 170K+ jobs across 3,800+ companies
- **Stack:** Node.js 20+ / plain CommonJS JavaScript (no TypeScript, no build step)
- **Package:** `npm install -g trackly-cli` (public npm package)
- **Backend API:** https://closeai.mba (same as Close AI — do NOT modify the backend from this repo)
- **Backend production source of truth:** after the 2026-06-30 Azure cutover,
  `https://closeai.mba` is served by Azure and the live DB is Azure blue
  Postgres behind the backend/VNet. This CLI repo is a consumer only; do not use
  AWS RDS, Render, old DB aliases, `ssh closeai-web`, or direct SQL for live
  production claims, migrations, user exports, or company-add decisions.
- **Repo:** Public GitHub — `trackly-app/trackly-cli`

## Architecture

```
bin/trackly          # CLI entrypoint (shebang script). All commands + arg parser + main()
lib/client.js        # HTTP client: config loading, token refresh, apiRequest()
lib/formatters.js    # Terminal output: color(), outputJobs(), outputCompanies(), etc.
mcp/server.js        # MCP server entrypoint and search/network tools, launched via `trackly mcp`
mcp/apply-tools.js   # Trackly Apply MCP schemas, validators, and tool registration
docs/trackly-tools.md  # MCP tool reference (for embedding in AI agent contexts)
docs/solutions/       # documented solutions organized by category with searchable YAML frontmatter (module, tags, problem_type)
CONCEPTS.md           # shared domain vocabulary for entities, named processes, and status concepts
server.json          # MCP Registry manifest (io.github.trackly-app/trackly)
```

## Dev Commands

```bash
# No build step — pure JS
node bin/trackly --help        # Run locally without installing
npm link                       # Symlink for local dev
```

There is a small Node test suite (`npm test`), no linter, and no build step. The package ships raw JS.

## Publishing

Publishing is fully automated via GitHub Actions:
1. Bump version in `package.json` + `package-lock.json` + `server.json`, and add a CHANGELOG entry in a reviewed PR; merge the PR to `main`
2. `auto-release.yml` creates a GitHub Release from the version bump (Releases page only — its `GITHUB_TOKEN` Release/tag does NOT trigger publishing)
3. `publish.yml` triggers on the same merge-to-main push (gated to version changes) and publishes to npm with provenance via **npm Trusted Publishing** (GitHub Actions OIDC, no token needed). Trusted Publisher configured at npmjs.com for `trackly-app/trackly-cli` + `publish.yml` workflow. Manual fallback: `gh workflow run publish.yml`.

**Do not run `npm publish` locally.** Manual publishes from a laptop have no OIDC context and would ship without provenance (this is what created the v0.2.7 unattested-release gap). If a manual publish is ever absolutely required as a break-glass measure, document why on the next CHANGELOG entry and plan a cosmetic version bump immediately after to restore the attestation chain via CI.

### Coordinated Trackly Apply release gate

The standalone CLI CI validates its checked-in hosted-tool contract fixture with
`npm run test:contract-fixture`. Before merging any release that changes Trackly
Apply schemas, also run the cross-repository comparison against the final backend
candidate:

```bash
TRACKLY_BACKEND_DIR=/absolute/path/to/granola-followup-app npm run test:hosted-contract
```

This coordinated check belongs in the release evidence. Standalone CLI CI must
not depend on a sibling private checkout that does not exist on its runner.

## Key Patterns

### Auth
- Google OAuth via local callback server (127.0.0.1, OS-assigned ephemeral port via `listen(0)` with a 1024-65535 guard, 5-min timeout, single SIGINT handler cleans up on Ctrl-C)
- Tokens stored in `~/.trackly/config.json` (file permissions 0600, directory 0700)
- On 401, `apiRequest()` tries one automatic refresh via `/api/auth/refresh` before failing
- `_isRetry` flag prevents infinite refresh loops

### MCP Server
- Search/network tools plus the versioned Trackly Apply tool set. Hosted/local Apply schemas must remain in contract parity; `trackly_prepare_resume` is local-only behavior and hosted MCP returns an explicit local-agent/manual-upload requirement.
- **Intentionally hosted-only:** `trackly_chat` is a backend agent for classic-UI surfaces, while CLI/MCP clients already are agents. `get_more_tools` is shared by hosted and local MCP as a value-free, structured capability-gap signal. This exact asymmetry is reviewed by the hosted-contract verifier; no other hosted-only tool is allowed.
- MCP User-Agent: `trackly-mcp/<version>` (from package.json)
- CLI User-Agent: `trackly-cli/<version>` (separate channel attribution)
- Flag validation is **command-level** (`COMMAND_FLAGS` in `bin/trackly`): it rejects unknown/wrong-command flags + typos (with a "did you mean" hint), but does not reject a flag that's valid on a sibling subcommand yet ignored by the handler (e.g. `api-key list --name foo`). Deliberate — subcommand-strict scoping would risk false-rejects, which are worse than a silently-ignored flag.

### Output Modes
- `--json` flag or non-TTY stdout triggers JSON output on all commands
- TTY gets formatted, colored output via `lib/formatters.js`

## API Endpoints Used

All requests hit `https://closeai.mba` (configurable via `~/.trackly/config.json`):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/jobscout/jobs` | List/filter jobs |
| GET | `/api/jobscout/jobs/:id` | Job detail |
| GET | `/api/jobscout/companies` | List companies |
| GET | `/api/jobscout/companies/search` | Semantic company search |
| GET | `/api/jobscout/me` | User stats and discovery preferences |
| PUT | `/api/jobscout/preferences` | Atomic discovery-preference updates |
| GET | `/api/jobscout/ask` | Natural language search (20/day limit) |
| POST | `/api/jobscout/tracker/jobs/:id/stage` | Update job tracker stage (applied/backlog/discarded) |
| POST | `/api/jobscout/companies/request` | Request a company be added (rate-limited) |
| POST | `/api/auth/api-key` | Create API key |
| GET | `/auth/google/cli` | OAuth login redirect |

## Common Pitfalls

1. **No build step.** This is plain CommonJS JS. Do not add TypeScript, ESM, or a bundler.
2. **Version is runtime-derived from `package.json`.** The `lib/client.js` and `mcp/server.js` files read version at runtime. Release-critical edits: `package.json` + `server.json`.
3. **Auth tokens at `~/.trackly/config.json`.** File permissions are 0600. Do not change.
4. **Keep dependencies minimal.** Direct runtime dependencies are
   `@modelcontextprotocol/sdk`, `@posthog/mcp`, `posthog-node`, `zod`, Hono, and
   exact `fast-uri` / `ip-address` / `qs` security pins that guarantee the SDK's
   audited patched resolution. PostHog is MCP-only and relays through Trackly's
   backend; no project key or numeric user ID is stored locally. HTTP uses raw
   `node:https`/`node:http`, and the local MCP transport remains stdio-only.
5. **The `ask` command has a 20/day rate limit** enforced server-side (429 response).
6. **Direct dependencies stay minimal.** The CLI uses the MCP SDK and Zod.
   Hono is declared directly to guarantee the audited patched resolution used
   by the SDK, but the local MCP transport is stdio-only and does not initialize
   an HTTP server.
7. **Do not modify the backend.** This repo is a consumer of the Close AI API. Backend changes go in the `granola-followup-app` repo.
