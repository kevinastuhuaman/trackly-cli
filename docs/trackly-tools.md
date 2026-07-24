## Trackly Job Tracker (MCP)

Trackly MCP server provides job search and tracking tools. Two ways to connect:

### Claude co-work, Claude Desktop, ChatGPT (hosted, no install)

In your AI tool, open **Settings → Connectors → Add custom connector**:

- URL: `https://mcp.usetrackly.app/api/mcp`
- Leave any optional OAuth fields empty — **Client ID**, **Client Secret**, **Authorization URL**, **Token URL** — Trackly uses OAuth 2.1 Dynamic Client Registration and will register the client automatically
- If the client UI uses different labels or requires you to continue past an OAuth section, keep those fields blank and proceed to sign in. Do not invent client credentials or endpoint URLs.

Sign in with Google when prompted. [Visual guide →](https://usetrackly.app/connector)

### Cursor, Windsurf, Claude Code (CLI via stdio)

Install and start the stdio server:

```bash
npm install -g trackly-cli
trackly mcp
```

#### Claude Code

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

Add to `.cursor/mcp.json` (same schema for Windsurf):

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

### Authentication

Use either interactive OAuth:

```bash
trackly login
```

Or an API key:

```bash
trackly config --api-key trk_xxxxxxxxxxxxxxxxxxxx
```

You can also pass `TRACKLY_API_KEY` as an environment variable for one-off runs.

Existing memberships work across the CLI and local MCP server. New memberships
are invite-only during the limited rollout; access errors link to
https://usetrackly.app/early-access instead of recommending repeated OAuth or
API-key creation attempts.

### Available Tools

- **trackly_search_jobs** — Search/filter jobs.
  - `function` (14 values): `product`, `engineering`, `design`, `data`, `marketing`, `sales`, `partnerships`, `finance`, `strategy`, `operations`, `people`, `legal`, `support`, `other`
  - `locationFilter`: pass ONE of
    - a single scalar: `us`, `non_us`, `all`, or a region tag (`europe`, `latam`, `middle_east`, `asia`, `africa`, `canada`, `oceania`, `remote`, `unknown`), OR
    - an array of region tags for multi-region (e.g. `["europe", "canada"]`). The array form excludes `us` — combining `us` with other tags in an array causes the backend to silently drop the others. To get "not US" use the scalar `non_us` alone.
  - `jobModality`: `full_time`, `internship`, `all` — employment type, NOT work arrangement.
  - `workArrangements`: one or more of `remote`, `hybrid`, `in_person`, `unspecified`. This is an independent axis and combines with region, employment type, and function filters.
  - `remote` (boolean): filter to remote jobs only. Maps to `usStates=REMOTE`.
  - `status`: your application pipeline state. Values: `new`, `applied_confirmed`, `check_later`, `not_interested`, `all`.
  - `sort`: `newest` (default) or `match` (highest match score first; requires a resume on file). Backend rejects the deprecated values `oldest` and `company` with HTTP 400.
  - `keywords`, `companyId`, `limit`, `offset`.
- **trackly_get_job** — Get full job details by ID
- **trackly_search_companies** — Semantic company search
- **trackly_list_companies** — List all tracked companies with job counts
- **trackly_get_stats** — Job tracker metrics dashboard
- **trackly_get_preferences** — Read a bounded preference response containing only `success`, `experienceFilterV2Available`, and the authenticated user's discovery `preferences`, including selected roles, saved role-specific limits, and the revision required for a safe update. Availability authorizes editing; it does not report feed or alert enforcement.
- **trackly_update_experience_limits** — Atomically replace the complete role-specific experience-limit map.
  - `experienceLimitsByJobFunction`: object whose keys are the 14 canonical job-function values and whose values are integer years from `0` through `60`. An empty object turns this filter off.
  - `expectedPreferenceRevision`: non-negative safe integer from the latest `trackly_get_preferences` result. A stale revision is rejected; refetch and reconcile with the user rather than retrying blindly.
  - The tool checks `experienceFilterV2Available` immediately before writing and refuses without a PUT unless it is exactly `true`.
  - When server-side enforcement is active, a job remains visible when its stated minimum is less than or equal to that role's limit. Jobs with no stated minimum remain visible.
- **trackly_update_status** — Mark a job as applied, saved, or dismissed
- **trackly_ask** — Natural language job search (20/day limit)
- **trackly_get_job_brief** — Get network brief for a job (company signal, top contact, actions)
- **trackly_contacts_at_company** — Search contacts at a specific company
- **trackly_get_company_workspace** — Get full company workspace (jobs, contacts, hiring managers, campaigns)
- **trackly_request_company** — Request that a company be added to Trackly's tracked companies. Rate-limited to 5 pending requests per user. Parameters: `companyName` (required), `companyUrl` (optional), `notes` (optional).
- **trackly_get_apply_queue** — Get user-approved check-later jobs in deterministic execution order.
- **trackly_get_application_profile** — Get the versioned, scoped application profile.
- **trackly_get_profile_onboarding** — Get backend-owned questions plus only missing/unconfirmed answers.
- **trackly_update_application_profile** — Save explicit answer states with optimistic concurrency and global/provider/company scope.
- **trackly_create_apply_batch** — Freeze an exact recent-first set of approved jobs with an idempotency key.
- **trackly_get_apply_batch** — Page a server-owned frozen batch without reordering or replacing members.
- **trackly_claim_apply_batch** — Acquire or renew the optimistic browser-mutation lease.
- **trackly_checkpoint_apply_batch** — Bulk-record up to 20 value-free inspection checkpoints, typed human actions, and per-member conflicts.
- **trackly_bind_apply_surface** — Bind an initial or recovered browser surface to the existing frozen member/run, increment its inspection epoch, and return the exact stored requisition URL.
- **trackly_record_apply_surface_evidence** — Record current-epoch, value-free inventory, missing-tab, close-receipt, post-close absence, or close-failure evidence.
- **trackly_approve_apply_batch_resume** — Approve one exact default-resume identity and content hash for the complete current frozen run set.
- **trackly_certify_apply_batch_truth** — Record an expiring late truthfulness certification over final answer and wording fingerprints for review-ready runs.
- **trackly_start_apply_run** — Start or reuse a manual-submit browser run, optionally bound to a frozen batch member.
- **trackly_get_apply_evidence** — Get the authenticated user's aggregate beta evidence and release gate without returning profile answers or contact values.
- **trackly_get_apply_protocol** — Get the current ATS support, browser integrity rules, and compatible skill version.
- **trackly_report_apply_observation** — Report redacted ATS mechanics and actual scenario coverage without answer values or page text.
- **trackly_record_application_outcome** — Record review readiness or a confirmed manual submission.
- **trackly_prepare_resume** — Local MCP only: materialize the default resume in a private, expiring mode-0600 cache and return filename, size, SHA-256, exact local path, and visual-confirmation metadata. Hosted MCP returns a manual/local-agent requirement.
- **trackly_verify_prepared_resume** — Local MCP only: immediately before attachment, recompute the user-confirmed resume hash and size, validate the exact path/run/expiration, and lock the file read-only. Any mismatch requires a fresh preview and confirmation.

Apply contract v3 intentionally gives this verifier different local and hosted schemas: local MCP receives the full proof needed to inspect the private file, while hosted MCP accepts only run and confirmation identifiers and returns the manual/local-agent requirement. Local paths and fingerprints are never sent to the hosted verifier. Version 3.1 also records universal value-free evidence for critical-contact integrity and the manual-submit boundary. Version 3.2 authorizes the exact stored HTTPS origin for jobs Trackly ingested from employer careers sources, without granting redirect, iframe, or hostname-suffix privileges.

### Maintenance behavior

REST, refresh, download, CLI, and local/hosted MCP surfaces use canonical `code: "maintenance_mode"`; older `planned_maintenance` responses are accepted only as a compatibility alias. Structured errors retain HTTP and service status, retry time, estimated return, and request ID without clearing valid credentials. Maintenance is resumable rather than retryable: wait for the advertised window, refetch the Apply protocol and profile, then resume the existing `agent_browser` run. Never create a duplicate run or click Submit.

> **Why no `trackly_chat` here (intentional, not drift):** the hosted connector exposes one extra tool, `trackly_chat`, that runs a backend agent over these same primitives. The local MCP client is already an agent, so `trackly_chat` remains deliberately hosted-only.

### Example Prompts

- "Find me PM jobs at fintech companies"
- "What remote engineering roles are available?"
- "Show me jobs at Stripe"
- "Mark job 1234 as applied"
- "Show my Trackly preferences, then set Product to up to 2 years and Strategy to up to 5 years"
- "Use Trackly Apply to fill my next saved application and stop before Submit"
