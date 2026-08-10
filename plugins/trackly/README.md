# trackly

The trackly plugin package for ChatGPT and Codex.

**Hero feature:** trackly Apply

trackly finds openings as they appear. You decide what to pursue. trackly Apply fills approved applications for your review. You submit manually.

## What is included

- Real-time job and company search through the authenticated trackly MCP facade.
- A public, safety-preserving `trackly-apply` skill for filling user-approved applications.
- A resumable lifecycle contract: minimal missing-profile labels, batch-bound work, atomic review certification, and evidence-bound manual-submission reconciliation.
- Facade-owned private batch leases that are never exposed to the model.
- Manual resume uploads remain browser-local, unbound, and unattested.
- A derived vector of the approved white trackly arrow mark on black. It is not claimed to be byte- or pixel-identical to the source PNG; Kevin approved the exact packaged SVG bytes recorded in `assets/brand-source.json` for the OpenAI listing.
- Submission fixtures covering expected and out-of-scope behavior.

An account is required. The current trackly tool is free and unlimited. The initial launch is US-first.

## Safety boundary

The plugin may fill an approved application and prepare it for review. It never activates the final Submit control. Only the user submits an application.

## Connection

`.mcp.json` connects to the dedicated public plugin facade:

`https://mcp.usetrackly.app/api/plugin/trackly/mcp`

The legacy trackly MCP endpoint is intentionally not used by this package.

## OpenAI submission

The OpenAI listing is created as a new **With MCP** draft in the
[OpenAI Platform plugin portal](https://platform.openai.com/plugins). The portal
scans the production MCP facade directly; this package does not invent or bind a
ChatGPT developer-mode app ID, so `.app.json` remains intentionally absent.
`.mcp.json` continues to describe the remote MCP connection used by the packaged
Codex plugin. See [RELEASE-GATES.md](RELEASE-GATES.md).
