// Workflow-contract test for the quota-fallback runner routing (PR #119).
// The fork gate below is the security boundary that keeps stranger fork-PR
// code off the persistent AWS bridge runners (trackly-cli is public); this
// test exists so a future workflow edit cannot silently weaken or drop it.
// Mirrors close-ai src/__tests__/ci-runner-boundary.test.ts and TracklyWeb
// src/lib/analytics/deploy-env.test.ts.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const workflows = (name) =>
  fs.readFileSync(
    path.join(__dirname, "..", ".github", "workflows", name),
    "utf8",
  );

const FORK_GATE =
  "github.event.pull_request.head.repo.full_name == github.repository";
// ci.yml / docs-drift.yml also run on push-to-main (trusted), so they route
// non-PR events to the bridge too; claude-code-review.yml is PR-only.
const ROUTED_WITH_PUSH =
  `runs-on: \${{ (github.event_name != 'pull_request' || ${FORK_GATE}) && vars.CI_RUNNER_LINUX || 'ubuntu-latest' }}`;
const ROUTED_PR_ONLY =
  `runs-on: \${{ ${FORK_GATE} && vars.CI_RUNNER_LINUX || 'ubuntu-latest' }}`;

test("PR-facing Linux jobs use the fork-gated quota-fallback routing", () => {
  const expected = {
    "ci.yml": ROUTED_WITH_PUSH,
    "docs-drift.yml": ROUTED_WITH_PUSH,
    "claude-code-review.yml": ROUTED_PR_ONLY,
  };
  for (const [file, routed] of Object.entries(expected)) {
    const text = workflows(file);
    assert.ok(text.includes(routed), `${file} must contain the exact gated runs-on expression`);
    assert.ok(!/runs-on:.*(?:self-hosted|trackly-ci)/.test(text), `${file} must not hardcode a self-hosted label`);
  }
});

test("credential-bearing release workflows never route to shared runners", () => {
  for (const file of ["publish.yml", "auto-release.yml", "publish-mcp-registry.yml"]) {
    const text = workflows(file);
    assert.ok(!text.includes("vars.CI_RUNNER_LINUX"), `${file} must not use CI_RUNNER_LINUX (holds npm/release credentials)`);
  }
});
