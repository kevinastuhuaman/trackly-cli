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
answer. If the user declines or does not opt in, skip the check and continue
the batch normally. Do not install or
connect an inbox integration without the user's separate request. When the
user opts in but no connector is callable, give client-appropriate setup
guidance and continue the current batch unless the user explicitly asks to
pause for setup. If the user pauses, keep `consented_pending`; after setup,
resume only after the user re-selects or confirms the exact connector and
account for this batch. Use `unavailable` only when no connector is callable
and the user chooses to continue without the optional check.

Record only the value-free preflight state in the private local batch ledger:
`not_offered`, `declined`, `unavailable`, `search_failed`,
`consented_pending`, or `completed`.
Never send this state or its batch-scoped consent to Trackly. On recovery, do
not repeat a `declined`, `unavailable`, `search_failed`, or `completed`
preflight. A setup-paused opt-in remains `consented_pending`, not `unavailable`.
Resume a
`consented_pending` search only after verifying the exact same batch ID and
asking the user to re-select or confirm the exact inbox connector and account.
Never use a current client default or another connected mailbox as a substitute.
If the local state is absent before any inbox search or form mutation, make a
fresh offer; never infer consent or completion.

Set `completed` only after the bounded search finds no positive matches or every
positive match among executable members has been durably recorded against the
exact member and run and has an explicit disposition. Without a visible success
page or explicit submission confirmation, keep the matched member free of form
mutation and keep `consented_pending` while asking whether the exact application
was submitted. A user-confirmed submission follows reconciliation; an explicit
user statement that it was not submitted, or an explicit instruction to continue
this exact application, records only a value-free local `cleared_by_user`
disposition before browser work. Never treat durable receipt recording alone as
permission to refill or mutate the matched member. Scope both search and
completion to executable frozen
members without a static exclusion. Skip retained inactive, insecure-URL, or
protocol-declared manual-only members; they do not block `completed`, and the
agent must never create a forbidden run merely to record a receipt. When
submission authority also exists, finish its documented outcome reconciliation
before completion. If an executable member's positive match still exists only
in session memory or any durable recording/reconciliation step fails, keep
`consented_pending`, preserve that member without form mutation, and continue
unaffected siblings.

## Search minimally

Use only the Gmail, Outlook, or other agent-side inbox connector the user chose
for this batch. Never inspect another unrelated private-data source. Search the
smallest bounded window that can identify the frozen batch:

1. Prefer the exact requisition ID when one is known, but always combine it
   with the same employer or verified ATS tenant/sender identity. A bare
   requisition identifier is not globally unique and is never sufficient.
2. Otherwise combine employer and exact or near-exact role with a bounded
   pre-batch lookback that can contain a prior submission. Use the job's known
   posting-to-freeze interval. If no trustworthy posting timestamp exists, ask
   the user to select a historical range; never silently search the whole
   mailbox. If the user does not select one, skip receipt discovery for that
   member and continue the application normally.
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

- Exact requisition identity plus the same employer or verified ATS
  tenant/sender identity is strong duplicate evidence. A bare requisition ID
  is not.
- Without a requisition ID, require the same employer, exact or near-exact
  role, a timestamp inside the approved pre-batch lookback, and the user's
  explicit confirmation that the receipt belongs to that batch member.
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

Failure to search, connect, or match optional receipt evidence is not a
browser-work blocker. If a bounded connector query fails before exhaustion,
do not leave a late `consented_pending` search that could run after form
mutation: report the failure, set local state to terminal `search_failed`, and
continue unaffected browser work. Preserve any evidence already supplied by
the user and continue the batch normally. If a verified duplicate also has the required
success page or explicit submission confirmation, preserve that member without
form mutation when redacted receipt recording or outcome reconciliation fails.
Retry only the documented idempotent reconciliation path and continue
unaffected siblings; never reopen or refill the preserved member.
