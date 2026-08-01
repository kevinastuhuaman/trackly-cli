# Browser lifecycle and recovery

Keep business identity in Trackly and host-specific browser identity local.
Every live tab belongs to exactly one frozen job and existing application run.
Never infer identity from window position, a transient tab number, or title text
alone.

## Local tab ledger

Maintain a local job ID -> run ID -> tab record containing the raw tab
identifiers, browser surface, normalized requisition URL, binding hash,
ownership state, and inspection epoch. Raw tab identifiers never go to the
Trackly backend. If the host persists the ledger, store it in a private
mode `0600` file and remove it when the batch expires.

For the optional inbox receipt preflight, also keep value-free state keyed
by the exact batch ID: `not_offered`, `declined`, `unavailable`,
`consented_pending`, or `completed`. This state and its batch-scoped consent
never go to Trackly. On recovery, do not repeat `declined`, `unavailable`, or
`completed`. When an opted-in user explicitly pauses to connect an inbox, keep
`consented_pending`; use `unavailable` only when the user continues without the
optional check. Resume `consented_pending` only for the same verified batch after
the user re-selects or confirms the exact inbox connector and account. Never
substitute the client's current default mailbox. Keep `consented_pending` until
there are no positive matches or every positive match is durably recorded and,
when submission authority exists, reconciled. If the ledger state is absent
before any inbox search or form mutation, make a fresh offer and never infer
consent or completion. Remove this state when the batch expires.

Backend observations contain only a value-free binding hash, inspection epoch,
ownership state, lifecycle/action codes, and timestamps. Never send the URL,
tab title, employer, role, page text, credentials, or answer values as browser
metadata.

## Reconciliation

Before resuming, handing off, or closing a tab:

1. Request every complete controller-owned inventory the host can enumerate.
2. Request every complete user-owned inventory the host can enumerate.
3. Normalize and reconcile their union against the local ledger.
4. Treat an inventory as authoritative only when the adapter explicitly says
   it is complete. Omission from an incomplete or single-surface inventory is
   not proof that a tab is gone.
5. Reclaim a matching tab only after employer, role, requisition, HTTPS origin,
   ATS tenant when applicable, run ID, and browser binding all revalidate.

For every initial tab and every recovery, call `trackly_bind_apply_surface`
with the existing frozen member and run. Use `initial_binding` for the first
surface and `recovery_binding` after a missing tab or handoff. The returned URL
is the only URL recovery may open. Treat its returned member version and
inspection epoch as authoritative; do not reuse evidence from the prior epoch.

The Sola failure mode is the regression model: a handed-off tab can disappear
from the controller inventory while remaining visible in the user inventory.
Never make a closure claim from one inventory surface.

## Close proof

For a submitted application, do not begin tab closure until Trackly has
durably reconciled both the batch member to `submitted` and the saved job to
`applied_confirmed`. A success page or explicit user confirmation authorizes
the outcome write; it does not prove that the write committed. On a conflict,
keep the tab visible while the agent refreshes and performs the one documented
idempotent replay. If reconciliation still fails, leave the tab open and
report a control-plane defect.

`closed_verified` requires all of the following for the current inspection
epoch:

- the adapter declares both available controller and user inventories complete;
- the exact bound tab receives an explicit close receipt; and
- the tab is absent from the complete post-close union.

Record these facts separately with `trackly_record_apply_surface_evidence`:
`surface_inventory_reconciled`, `surface_close_receipt`, and
`surface_post_close_absent`. A post-close absence event is invalid unless it
explicitly covers the complete controller+user union. The backend, not the
agent's prose, derives `closed_verified` from all three current-epoch facts.

If the close request succeeds but a complete union is unavailable or still
contains the tab, the agent must not claim `closed_verified`; record
`closure_unverified`. If no mapped tab is found before a verified close,
record `missing`. Close evidence from an earlier inspection epoch cannot
satisfy the current closure gate.

Do not close a review-ready tab merely to reduce clutter. Preserve it for the
user's manual Submit unless the user closes it or explicitly asks the agent to
close it.

## User-visible handoff receipt

Opening or restoring a controller tab is not proof that the user can see it.
Before saying that a form is open, visible, ready for review, or preserved:

1. Use the reachability proof supported by the preservation path selected at
   readiness:
   - For the session-finalizer path, reconcile the complete controller and user
     inventories and require the handed-off tab to appear in the complete
     user-owned inventory.
   - For the per-tab durable-handoff path, an exact current tab-bound
     user-visible handoff receipt is alternative reachability proof; do not
     require inventories that this path explicitly permits to be unavailable.
2. Before claiming a tab is visible, focus or reveal that exact review tab
   through the adapter's documented presentation action and verify its
   documented visible state or exact current tab-bound user-visible handoff
   receipt. Inventory membership alone is never visibility proof.
3. Report the actual browser surface and any tab that could not be proven
   visible. Never convert controller ownership into a visibility claim.

If the selected path can provide neither its required reachability proof nor
an exact visibility receipt, preserve the tab but say that visibility is
unverified. Do not tell the user to submit a form that has not been proven
reachable from their surface.

## Browser-session finalization safety

Treat browser-session finalization as destructive cleanup, not as a harmless
handoff marker. Immediately before ending every browser turn:

1. Determine the currently live mapped application tabs from the local ledger,
   including frozen-batch members and legacy single-run tabs. If there are no
   live mapped application tabs, skip both session finalization and per-tab
   handoff; never call a finalizer with an empty keep list.
2. Use only the end-to-end preservation path selected at browser readiness:
   - For the documented session-finalizer path, refresh and reconcile the
     complete current controller-owned and user-owned inventory union
     immediately before building an explicit `{ tab, status: "handoff" }` keep
     entry for every live mapped application tab. A controller-only refresh
     cannot prove that a handed-off user tab still exists. Then call
     `browser.tabs.finalize({ keep })` exactly once as the final browser action.
   - For the documented per-tab durable-handoff path, do not require an
     unavailable complete inventory union. Invoke the primitive for every live
     application tab mapped in the ledger and verify an exact persistence
     receipt for each one.
   The mere presence of a finalizer must never override the verified per-tab
   fallback. Never invoke an implicit close-all cleanup or an undocumented
   substitute.
3. Never finalize with an omitted, empty, partial, guessed, or stale keep list.
4. Do not use undocumented per-tab `finalize`, `markHandoff`, or
   `markDeliverable` calls. Use only the browser's documented session-level
   finalizer or documented per-tab durable-handoff contract.
5. Never finalize while creating or restoring tabs; wait until all form
   mutations and committed-state checks for that turn are complete.

A review-ready, inspecting, needs-input, or submitted-but-unreconciled
application tab always remains `handoff` while it is live. Omit a ledger tab
after the user explicitly requests closure, or the user confirms they closed it
directly, and the selected path provides definitive absence proof: either the
complete inventory union proves the tab absent, or the per-tab adapter returns
an exact current tab-bound user-side closure/absence receipt. Without that
proof, preserve the member and enter missing-tab recovery on the next turn;
never claim the unsaved draft survived. Agent-initiated closure still requires
the submitted/applied close-proof gate.

Determine which durable preservation mechanism the adapter supports during
the browser readiness gate and prove that mechanism is usable end to end. A
session-finalizer path is ready only when the adapter can also enumerate a
complete current controller-owned and user-owned inventory union for its keep
list. If complete inventory access is unavailable, use only a documented
per-tab durable-handoff primitive whose exact persistence receipt can be
verified for every target tab. If neither complete finalizer path nor verified
per-tab path is available, stop before mutating the form or entering private
data. A no-op is not a preservation mechanism because temporary agent-created
tabs may disappear at turn end.

If finalization returns ambiguously or any expected tab disappears, stop all
form mutation. Because the finalizer must remain the turn's last browser
action and must not be rerun, defer inventory recovery to the next turn. On
that next turn, reconcile both controller and user inventories, preserve every
remaining tab, and report any loss immediately. Never claim the tabs are
visible or the drafts are preserved until the complete user-visible inventory
proves it.

## Missing-tab recovery

When an incomplete member's tab is missing:

1. Preserve the frozen member and reuse the existing run. Never create a
   replacement run for browser recovery.
2. Call `trackly_bind_apply_surface` with `recovery_binding`; reopen only its
   exact backend-stored requisition URL. Do not use search,
   company careers navigation, redirects remembered from chat, or an invented
   URL.
3. Revalidate HTTPS origin, ATS tenant policy, employer, role, requisition, and
   job identity before entering private data.
4. Increment the browser inspection epoch and bind the recovered tab. Evidence
   from an earlier inspection epoch cannot satisfy the current review gate.
5. Reinventory the whole form. Do not claim that unsaved ATS draft state
   survived a crash, user close, or handoff.
6. Refill only verified canonical answers and rerun every applicable integrity
   gate. If the page shows a changed success URL or submission state,
   revalidate the exact requisition before recording any outcome and never
   activate Submit again.

If the recovered origin or identity differs, semantic controls are
unobservable, or access is blocked by credentials or a pre-form challenge,
stop private-data mutation and create the appropriate human action. Continue
the other frozen batch members.
