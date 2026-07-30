# Review handoff

For one application, provide this compact block and stop only after the exact
review tab has documented visibility proof:

```text
Ready for your review — not submitted

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
the controlled browser visibly shows success. Record a provider receipt only
from the application surface itself; never search email or a mailbox. Hash the
proof locally and never send confirmation text, page text, receipt identifiers,
or URLs as evidence.

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
