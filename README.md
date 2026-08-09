[![npm](https://img.shields.io/npm/v/trackly-cli.svg)](https://www.npmjs.com/package/trackly-cli)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node 20.20+ or 22.22+](https://img.shields.io/badge/node-20.20%2B%20%7C%2022.22%2B-brightgreen.svg)](https://nodejs.org/)
[![MCP Server](https://img.shields.io/badge/MCP-Server-blue.svg)](https://modelcontextprotocol.io/)

# trackly-cli

The only job tracking CLI built for AI agents.

Search 170,000+ jobs across 3,800+ companies and 40+ ATS types. Track applications, get AI-powered recommendations, and manage your job search -- from the terminal or through Claude, ChatGPT, Cursor, and other MCP-compatible AI agents.

## Two ways to connect

### 🚀 Option 1: One-click in Claude co-work, Claude Desktop, ChatGPT (no install)

Use Trackly directly inside your AI — zero config:

1. Open Settings → Connectors → **Add custom connector**
2. URL: `https://mcp.usetrackly.app/api/mcp`
3. Click **Add** → sign in with Google → done

**[Full setup guide with screenshots →](https://usetrackly.app/connector)**

Works in: Claude co-work (web), Claude Desktop, ChatGPT Connectors, and any MCP client that supports remote/streamable-http connectors.

### 💻 Option 2: CLI install (for Cursor, Windsurf, or terminal use)

```bash
npm install -g trackly-cli    # may need: sudo npm install -g trackly-cli
trackly login
trackly jobs --function product
```

> **Prerequisites:** [Node.js 20.20+ or 22.22+](https://nodejs.org/) (LTS recommended). On macOS with the official `.pkg` installer, global npm installs may require `sudo`.

## At a Glance

3,800+ companies | 170K+ jobs | 40+ ATS types | CLI + MCP | 49 local MCP tools

## CLI Commands

```bash
trackly jobs                          # List jobs
trackly jobs --remote                 # Filter remote jobs (sets usStates=REMOTE)
trackly jobs --region us              # Filter by region (us, non_us, all, or a region tag: europe, canada, remote, ...)
trackly jobs --job-type internship    # Filter by employment type (full_time, internship, all)
trackly jobs --work-arrangement hybrid,remote  # Filter by work arrangement independently
trackly jobs --function product       # Filter by function
trackly jobs --company 243            # Filter by company ID
trackly job 1234                      # Get job details
trackly jobs 1234                     # Alias for job details
trackly companies                     # List companies
trackly companies search "fintech"    # Semantic company search
trackly search "fintech"              # Alias for semantic company search
trackly stats                         # Show metrics
trackly status                        # Alias for stats
trackly preferences                   # Show discovery preferences and experience limits
trackly preferences experience product=2 strategy=5  # Replace role-specific limits
trackly preferences experience clear # Turn role-specific experience filtering off
trackly apply 1234                    # Mark as applied
trackly save 1234                     # Save a job
trackly dismiss 1234                  # Dismiss a job
trackly ask "PM jobs in SF"           # Natural language search (20/day)
trackly contacts "Stripe"             # Search contacts at a company
trackly brief 1234                    # Get network brief for a job
trackly referral start 1234           # Start a referral campaign
trackly referral status 1234          # Check referral campaign status
trackly company-brief 243             # Get company brief (--refresh to regenerate)
trackly company-workspace 243         # Full company workspace view
trackly request-company "eBay"        # Request a company be added (--url, --notes optional)
trackly api-key create                # Generate API key
trackly api-key list                  # List API keys
trackly config                        # Show current CLI config
trackly config --api-key trk_xxx      # Save an API key for future commands
trackly version                       # Show installed version
trackly whoami                        # Show current user
trackly logout                        # Clear credentials
trackly agent setup --client both    # Install Trackly Apply for Codex + Claude Code
trackly agent doctor                 # Verify setup, profile, resume, and compatibility
trackly agent diagnose-path /path/to/upload.pdf --errno ENOSPC --json  # Diagnose one exact local path
```

Add `--json` to any command for JSON output. Use `--api-key <key>` or `--base-url <url>` as one-off global flags when needed.

`trackly preferences --json` returns only `success`, `experienceFilterV2Available`, and `preferences`. The availability flag controls whether this client may edit role-specific limits; it does not claim that feed or alert enforcement is active. Every update checks that flag and the latest preference revision before writing.

## MCP Server Setup

### Hosted (Claude co-work, Claude Desktop, ChatGPT)

No install. In your AI tool, open **Settings → Connectors → Add custom connector** and enter:

```text
https://mcp.usetrackly.app/api/mcp
```

Sign in with Google when prompted. [Full visual guide →](https://usetrackly.app/connector)

### Local (CLI via stdio, for Cursor / Windsurf / Claude Code)

For agent-assisted form filling on macOS, install the public skill and local MCP together:

```bash
trackly agent setup --client codex    # or claude / both
trackly agent doctor
```

The skill uses the profile and default resume in your Trackly account, asks only missing questions, fills user-approved saved jobs, and always stops before Submit. “Fill the next N” continues through the original recent-first Check Later snapshot until N unauthenticated forms are durably ready for your manual review; authentication walls and exclusions are reported separately and do not consume the target. An explicit “inspect the next N records” request still uses one fixed immutable batch. Support is fetched from Trackly at the start of every run: Greenhouse is full, Ashby and Lever are best effort, and 27 additional named ATS/provider classes use constrained guided mode. Employer-hosted unknown forms run only when Trackly binds them to a verified company domain. LinkedIn-hosted forms and unverified origins remain manual-only; a separately stored external application URL is evaluated under its own ATS and origin policy.

Guided mode is deliberately fail-closed. The agent stops on credential entry, OTP/email verification, CAPTCHA/human verification, an unexpected employer or origin, a submit-only transition, or any field whose committed state cannot be observed. `trackly agent doctor` checks the local skill, MCP registration, protocol compatibility, declared browser/computer-use configuration, profile completeness, and default-resume metadata. Live semantic browser capability and the exact resume bytes are verified at the start of a real run.

#### Claude Code one-liner

```bash
claude mcp add --scope user trackly -- trackly mcp
```

Or equivalently:

```bash
claude mcp add-json --scope user trackly '{"command":"trackly","args":["mcp"]}'
```

#### Claude Code manual config

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "trackly": {
      "command": "trackly",
      "args": ["mcp"]
    }
  }
}
```

#### Cursor / Windsurf

Add to `.cursor/mcp.json` or `~/.cursor/mcp.json` (same schema works for Windsurf):

```json
{
  "mcpServers": {
    "trackly": {
      "command": "trackly",
      "args": ["mcp"]
    }
  }
}
```

Then use natural language in any of these clients:

- "Find me PM jobs at fintech companies"
- "What remote engineering roles are available?"
- "Mark job 1234 as applied"

## MCP Tools Reference

| Tool | Description |
|------|-------------|
| trackly_search_jobs | Search and filter jobs by function, company, region, employment type, work arrangement, and status |
| trackly_get_job | Get full details for a specific job |
| trackly_search_companies | Semantic company search |
| trackly_list_companies | List all tracked companies |
| trackly_get_stats | Job tracker metrics and status counts |
| trackly_get_preferences | Read bounded discovery preferences, edit availability, and save revision |
| trackly_update_experience_limits | Atomically replace role-specific limits on a job's stated minimum years |
| trackly_update_status | Mark jobs as applied, saved, or dismissed |
| trackly_ask | Natural language job search (20/day) |
| trackly_get_job_brief | Get network brief for a job (company signal, top contact, actions) |
| trackly_contacts_at_company | Search contacts at a specific company |
| trackly_get_company_workspace | Full company workspace (jobs, contacts, hiring managers, campaigns) |
| trackly_request_company | Request a company be added to Trackly (rate-limited to 5 pending) |
| trackly_get_apply_queue | Get user-approved jobs ready for execution |
| trackly_get_application_profile | Get versioned profile answers and provenance |
| trackly_get_profile_onboarding | Get schema plus missing questions |
| trackly_update_application_profile | Save scoped answers with optimistic concurrency; revoking sensitive storage takes a two-step confirmation |
| trackly_start_apply_execution | Start a target-counted accessible Apply execution |
| trackly_get_active_apply_execution | Recover the active execution before legacy batch recovery |
| trackly_get_apply_execution | Read the authoritative progress funnel and immutable child waves |
| trackly_get_apply_execution_snapshot | Fetch a compact bounded projection for current execution members and required profile keys |
| trackly_resume_parked_apply_member | Explicitly resume one parked member for a fresh non-mutating access probe |
| trackly_approve_apply_execution_resume | Approve one exact resume identity for an unchanged execution snapshot |
| trackly_advance_apply_execution | Transactionally create the next eligible immutable wave |
| trackly_record_apply_execution_dispositions | Record typed, value-free access classifications |
| trackly_stop_apply_execution | Stop an execution without changing saved-job state |
| trackly_create_apply_batch | Freeze an exact recent-first approved batch |
| trackly_cancel_apply_batch | Retire a legacy fixed batch after explicit user confirmation |
| trackly_get_active_apply_batch | Recover the newest unexpired active batch after context loss |
| trackly_get_apply_batch | Read frozen membership with opaque pagination |
| trackly_claim_apply_batch | Acquire or renew a batch mutation lease |
| trackly_checkpoint_apply_batch | Bulk-record redacted inspection checkpoints and human actions |
| trackly_bind_apply_surface | Bind an initial or recovered browser surface to the existing run and exact requisition URL |
| trackly_record_apply_surface_evidence | Record current-epoch inventory, missing-tab, close-receipt, and post-close absence evidence |
| trackly_record_apply_submission_evidence | Record redacted submit-request, success-page, user-confirmation, or provider-receipt evidence |
| trackly_approve_apply_batch_resume | Approve one exact default resume for the current frozen run set |
| trackly_certify_apply_batch_truth | Certify final answer and wording fingerprints after every other review-readiness gate |
| trackly_start_apply_run | Start or reuse a manual-submit browser run |
| trackly_get_apply_evidence | Get aggregate, value-free beta evidence and release readiness |
| trackly_get_apply_protocol | Get current workflow and compatibility rules |
| trackly_report_apply_observation | Send redacted ATS mechanics feedback |
| trackly_lint_application_text | Locally lint application writing and return only value-free violations plus a draft hash |
| trackly_diagnose_local_path | Locally diagnose the exact implicated filesystem path without deleting files |
| trackly_report_apply_observations | Bulk-send up to 20 leased, batch-bound redacted observations |
| trackly_record_application_outcome | Record review or confirmed submission outcome |
| trackly_record_application_outcomes | Bulk-record up to 20 leased batch outcomes with per-member conflicts |
| trackly_prepare_resume | Prepare a private expiring resume file for upload |
| trackly_verify_prepared_resume | Recheck the confirmed resume immediately before attachment |
| get_more_tools | Report a missing capability so Trackly can improve its MCP surface |

## Authentication

### Option 1: Google OAuth (recommended)

```bash
trackly login
```

Opens your browser for Google sign-in. Tokens are stored locally at `~/.trackly/config.json`.

Trackly is currently opening new memberships through a limited, invite-based
rollout. Existing members can keep using OAuth and API keys normally. If a new
account is not yet eligible, the CLI returns an invitation-specific message
instead of suggesting repeated login attempts; request a future seat at
[usetrackly.app/early-access](https://usetrackly.app/early-access).

### Option 2: API Key

Existing members can use an API key for firewalls, headless servers, or CI:

1. Sign in at [usetrackly.app](https://usetrackly.app)
2. Go to **Settings → API Keys → Create**
3. Save the key:

```bash
trackly config --api-key trk_xxxxxxxxxxxxxxxxxxxx
```

Or pass it per-command:

```bash
trackly --api-key trk_xxxxxxxxxxxxxxxxxxxx jobs --json
```

Or set it as an environment variable:

```bash
export TRACKLY_API_KEY=trk_xxxxxxxxxxxxxxxxxxxx
trackly jobs
```

### Generate a key from the CLI

If you're already logged in via OAuth, you can create a key without visiting the web app:

```bash
trackly api-key create --name "my-script"
trackly api-key list
```

### Other config

```bash
trackly config --clear-api-key           # Clear stored API key
trackly config --base-url http://127.0.0.1:3000  # Point at a different backend
```

## Comparison

| Feature | CLI | Web App | Public API |
|---------|-----|---------|------------|
| Job search + filters | Yes | Yes | Yes |
| Apply/save/dismiss | Yes | Yes | Yes |
| AI-powered search | Yes (trackly ask) | Yes | Yes |
| MCP integration | Yes (49 local tools) | -- | -- |
| Browser required | No | Yes | No |
| Best for | Terminal + AI agents | Visual browsing | Custom integrations |

Web: [usetrackly.app](https://usetrackly.app) | API docs: [usetrackly.app/developers](https://usetrackly.app/developers)

## Frequently Asked Questions

**How do I track job applications from the terminal?**

Install trackly-cli (`npm install -g trackly-cli`), authenticate with `trackly login` or configure an API key, then use `trackly jobs` to browse openings and `trackly apply <id>` to mark applications. All data syncs with the Trackly web app at usetrackly.app.

**What MCP servers exist for job searching?**

trackly-cli includes a built-in MCP server with 49 tools: 48 Trackly job-search and application tools plus `get_more_tools`, which lets agents report a missing capability. Run `trackly mcp` or use `trackly agent setup --client claude`.

MCP usage analytics are on by default and relay through Trackly so the free
service can be debugged and improved. They exclude résumé text, profile answers,
demographic or work-authorization answers, and application notes. Turn off future
collection with **Share usage analytics** in Account Settings. Operators may also
disable local MCP instrumentation with `TRACKLY_MCP_ANALYTICS_DISABLED=1` (or
`TRACKLY_MCP_ANALYTICS_ENABLED=0`); the account setting remains authoritative
for authenticated backend capture.

**How do I use Claude Code for job hunting?**

Add trackly as an MCP server in Claude Code. Then ask questions naturally: "Find PM jobs at fintech companies in SF", "What companies are hiring for engineering?", or "Mark job 1234 as applied." Claude will use trackly's MCP tools to search and manage your applications.

**What are the best CLI tools for job search?**

trackly-cli is the first dedicated job tracking CLI. It provides direct terminal access to 170,000+ job postings across 3,800+ companies, with filters for job function, location, and work modality. It also integrates with AI agents via the Model Context Protocol (MCP).

## Security

- OAuth tokens stored in `~/.trackly/config.json` with 0600 permissions
- API keys can be stored in the same config file or passed per-command
- OAuth callback bound to 127.0.0.1 only
- Authenticated requests require HTTPS unless you are pointing at localhost
- HTTP requests time out instead of hanging indefinitely
- CSRF protection on login flow
- See [SECURITY.md](SECURITY.md) for vulnerability reporting

## License

MIT -- see [LICENSE](LICENSE)
