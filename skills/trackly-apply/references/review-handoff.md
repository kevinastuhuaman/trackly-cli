# Review handoff

## Live progress receipt

Send this after every durable milestone and at least once every 60 seconds during active work:

```text
Current operation:
Last durable milestone:
User action now: wait / act
Next milestone / next update:
Delay source: browser / Trackly / ATS / user
Funnel: target=; ready=; submitted=; filling=; awaitingAnswer=; authParked=; excluded=; remaining=
```

Use the compact execution snapshot as authority. Give a bounded next-update estimate, not an invented overall completion time.

## Approval scope receipt

Before persisting a broad statement such as “always,” show which separate categories it will update: personal facts, consent choices, writing preferences, resume approval, and truthfulness certification. Never let approval of one category authorize another. Consolidate genuinely unknown questions into one packet after filling everything already known. Explain legal terms in plain language using the protocol glossary; do not expose internal action codes or routing labels.

For one application, provide this compact block and stop only after the exact
review tab has documented visibility proof:

```text
Ready for your review — not submitted

Trackly saved the verification state. The employer's live draft still exists
only in the open browser tab and may be lost if that tab is closed or reloaded.

Company / role:
ATS / URL:
Resume:
Resume visual confirmation: yes/no
Resume exact local path:
Resume fingerprint / size:
Resume confirmation run / expiration:
Critical contact values verified: yes/no
Authorization / sponsorship:
Compensation answer:
Education:
EEO / consent choices:
Custom answers:
Integrity sweep: pass/fail
Manual-submit boundary verified: yes/no
Actual scenario coverage:
Items requiring your attention:

Please review the live form and click Submit manually.
```

If the form reached its verified review state but the adapter cannot prove the
exact review tab visible or issue an exact user-visible handoff receipt, do not
use the block above and do not tell the user to submit. Preserve the tab and
use this separate block:

```text
Review state prepared — visibility not verified

Company / role:
ATS:
Resume:
Integrity sweep: pass/fail
Actual scenario coverage:
Recovery needed: reclaim and visibly reveal the exact review tab

Do not submit from this handoff. I must first prove the live review form is
visible on your browser surface.
```

For a frozen batch, first summarize unresolved human actions, then provide one
review block per run that reached `review_ready`. Continue processing other
members before presenting the first-pass handoff.

For an accessible execution, show the server-authoritative funnel before the
per-run review blocks: `target`, `durablyReviewReady`, `submitted`,
`reservedReviewSlots`, `currentlyFilling`, `awaitingAnswer`, `authParked`,
`excluded`, `conflicted`, `attempted`, `remainingCandidates`,
`queueExhausted`, `targetReached`, and `nextAction`. Do not infer these counts
from visible tabs. Authentication-gated and excluded jobs remain in Check Later
and are listed separately; they are not failed applications and do not consume
the target.

Use plain language around that funnel. Label `durablyReviewReady` as “verified
and waiting for your manual submission,” while retaining the exact server key
only in the authoritative count line. Never imply that Trackly stored the ATS
form contents or can recreate the employer draft.

## Grouped actions

Group recoverable actions in this order:

1. company;
2. role;
3. run;
4. action type.

Show the stage and what the user must do, without copying raw form questions or
private values into Trackly observations. Separate credentials, legal choices,
artifacts, and unknown reusable answers. Later handoffs contain only newly
revealed conditional deltas.

## Batch review table

Include one row per frozen member:

```text
Job ID | Run ID | Browser label | ATS | State | Human actions | Evidence
```

The browser label may help the user find a visible tab, but raw tab identifiers
stay local and out of Trackly. For each review-ready run, include its current
inspection epoch, resume-content approval status, per-run attachment proof,
truth certification status, required scenario coverage, and integrity result.
Submission evidence and closure evidence remain separate and are normally
empty until after the user's manual Submit.

After the user submits, record one typed `user_confirmation` only when the user
explicitly says they submitted. Prefer a current-epoch `success_page` proof when
the controlled browser visibly shows success. A provider receipt may come from
the application surface, evidence supplied by the user, or the explicitly
consented external-agent preflight in
[inbox-receipt-preflight.md](inbox-receipt-preflight.md). Trackly never accesses
the mailbox. Hash the proof locally and never send confirmation text, page text,
receipt identifiers, message metadata, or URLs as evidence.

After either success-page evidence or explicit confirmation, record
`submitted`, refetch, and require both member `submitted` and job
`applied_confirmed`. Only then may the saved cleanup preference authorize
closing the exact mapped tab. Verify controller/user inventory absence and
record closure evidence before finalizing the member. Tab closure never becomes
submission evidence.

Do not claim the batch is ready until every frozen member is either
`review_ready`, has an explicit resumable human action, is user-revoked, or has
a terminal trust/observability blocker.

Do not make ready siblings wait for an unresolved member. Hand off every
truth-certified `review_ready` subset as soon as it is durable, keep its tabs
open for manual submission, and list remaining human actions separately.
Members that become ready later require a new certification for the exact
then-current `review_ready` subset.

Do not include restricted answers in chat unless needed for the user’s review.
Never include credentials, an OTP, or a CAPTCHA response.
