# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | Yes                |
| < 0.1   | No                 |

## Reporting a Vulnerability

If you discover a security vulnerability in trackly-cli, please report it
responsibly by emailing:

**hello@usetrackly.app**

Please include:

- A description of the vulnerability
- Steps to reproduce the issue
- The potential impact
- Any suggested fixes (optional)

### Response Timeline

- **72 hours**: Initial acknowledgment of your report
- **7 days**: Assessment and severity classification
- **30 days**: Target for fix and disclosure (depending on complexity)

We will coordinate disclosure with you and credit you in the advisory unless
you prefer to remain anonymous.

## Token Storage

trackly-cli stores authentication tokens in a local file at
`~/.trackly/config.json` with file permissions set to `0600` (owner read/write
only). This follows the same approach used by established CLI tools such as
`gh` (GitHub CLI), `aws-cli`, and `gcloud`.

If you configure an API key with `trackly config --api-key`, it is stored in
the same config file with the same file permissions. API keys can also be
passed via `TRACKLY_API_KEY` for one-off sessions.

Credentials are never logged, transmitted to third parties, or stored in
environment variables by default.

## Transport Security

trackly-cli refuses to send authentication credentials over insecure transport
unless the destination is localhost for local development.

## Dependency Audit Policy

CI retains `npm audit --audit-level=high` and also runs a stricter
allowlist-based audit gate. The temporary exception is limited to
[`GHSA-frvp-7c67-39w9`](https://github.com/advisories/GHSA-frvp-7c67-39w9),
which reaches Trackly through `@modelcontextprotocol/sdk` and
`@hono/node-server`.

Trackly's local MCP server uses the SDK's stdio transport. It does not load the
affected Windows `serveStatic` code, `@hono/node-server`, or Streamable HTTP
transport. Tests verify that boundary during a real MCP initialize and from
the packed CLI artifact. The audit gate permits only the advisory's exact
package, severity, affected range, and dependency path; any change fails CI
for review.

This exception is temporary and tracks the upstream SDK fix in
[modelcontextprotocol/typescript-sdk#2531](https://github.com/modelcontextprotocol/typescript-sdk/issues/2531).
It must be removed when the SDK upgrades or removes the affected adapter.

## Scope

### Security issues (please report)

- Authentication bypass or token leakage
- Command injection or arbitrary code execution
- Insecure file permissions on stored credentials
- Man-in-the-middle vulnerabilities in API communication
- Dependency vulnerabilities with a known exploit path

### Not security issues (please open a GitHub issue instead)

- Feature requests or usability improvements
- Bugs that do not have a security impact
- Documentation errors
- Performance issues
