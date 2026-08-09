# Release gates

The package may be tested locally before these gates are complete. It must not be submitted to OpenAI or published publicly until every gate is satisfied.

## Registered MCP binding

- Register `https://mcp.usetrackly.app/api/plugin/trackly/mcp` in ChatGPT developer mode.
- Copy the real technical ID returned by ChatGPT. Do not invent or pre-allocate an ID.
- Add `.app.json` with the supported `{"apps":{"trackly":{"id":"…"}}}` shape.
- Add `"apps": "./.app.json"` to `.codex-plugin/plugin.json`.
- Keep `.mcp.json` as the Codex remote MCP connection; `.app.json` binds the separately registered ChatGPT app identity, so neither replaces the other.
- Re-run plugin validation and the repository test suite.

## Product verification

- Require an unauthenticated HTTP 200 response from `https://usetrackly.app/plugins/trackly` and verify its logo, support, privacy, and terms links before submission.
- Run `TRACKLY_BACKEND_DIR=/absolute/path/to/granola-followup-app npm run test:hosted-contract` against the exact backend release candidate and require the executable plugin catalog to match the locked 18-tool allowlist.
- Execute all five positive and three negative `listing/submission-tests.json` fixtures with the synthetic reviewer account. Preserve the result shapes, tool sequence, manual-resume filename confirmation, and forbidden-action evidence for the submission packet.
- Compare `assets/trackly-appicon.svg` side by side with the approved `TracklyWeb/public/brand/trackly-appicon.png` source. The SVG is a derived approximation, not a byte- or pixel-identical copy. Kevin must explicitly approve the exact packaged SVG before submission, or replace it with the exact approved PNG bytes and update the manifest and provenance.
- Verify the full search-to-review flow in ChatGPT Work on desktop.
- Verify the full search-to-review flow in Codex desktop.
- Include at least one application whose form requires the user-approved resume artifact.
- Confirm the final Submit control remains untouched in every run.

## Submission control

- Kevin must approve the exact listing, packaged logo asset, privacy and terms URLs, test cases, scanned tool metadata, and production MCP URL before submission.
- OpenAI submission is a separate action from publication.
- After OpenAI approval, ask Kevin again before selecting Publish.
