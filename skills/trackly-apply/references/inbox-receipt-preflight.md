# Optional inbox receipt preflight

Use this preflight only to detect applications the user may already have
submitted. It is agent-side connector orchestration, not a Trackly mailbox
feature. Trackly remains mailbox-blind.

## Offer once per frozen batch

Before mutating the first application form, make one non-blocking offer:

> Optional duplicate check: Trackly never accesses your inbox. If you opt in
> for this batch, I can use a separately connected inbox tool to look for
> matching application receipts. If no inbox is connected, I can show you how
> to connect one in this agent. Otherwise I will continue normally.

Proceed only after explicit batch-scoped consent. Connector presence or
availability is not consent. Do not persist consent as a Trackly profile
answer. If the user declines, does not opt in, or has no callable inbox
connector, skip the check and continue the batch normally. Do not install or
connect an inbox integration without the user's separate request. When the
user opts in but no connector is callable, give client-appropriate setup
guidance and continue the current batch unless the user explicitly asks to
pause for setup.

## Search minimally

Use the user's chosen Gmail, Outlook, or other agent-side connector. Search the
smallest bounded window that can identify the frozen batch:

1. Prefer the exact requisition ID when one is known.
2. Otherwise combine employer, exact or near-exact role, and the known batch
   time window.
3. Read message metadata or summaries first. Read raw message content only when
   necessary to resolve the exact job identity.
4. Stop searching when every frozen member is classified or the bounded query
   is exhausted.

Raw message content, subject lines, sender and recipient addresses, message
IDs, receipt identifiers, URLs, and connector tokens stay local to the user's
agent session. Never send message IDs, email text, addresses, external
references, or URLs to Trackly. Never save mailbox credentials or connection
state in Trackly.

## Match conservatively

- Exact requisition identity is strong duplicate evidence.
- Without a requisition ID, require the same employer, exact or near-exact
  role, a timestamp inside the known batch window, and the user's explicit
  confirmation that the receipt belongs to that batch member.
- Same employer plus a materially different role is negative evidence for the
  current member. Keep the member and its tab.
- An ambiguous or missing match changes nothing. Continue the application.

A receipt alone never authorizes an Applied state. It proves job identity only.
Require a visible success page or explicit user confirmation that this exact
application was submitted before recording `submitted` and expecting
`applied_confirmed`.

## Record only redacted evidence

When the run and browser binding exist and the match is verified, locally hash
the typed receipt proof and record only `provider_receipt_detected` with source
`provider_receipt`. Do not use the receipt as outcome confirmation. Keep the
confirmation tab open until a refetch proves both the submitted member
lifecycle and the `applied_confirmed` job state.

Failure to search, connect, match, or record optional receipt evidence is not a
browser-work blocker. Preserve any evidence already supplied by the user and
continue the batch normally.
