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

1. Reconcile the complete controller and user inventories.
2. Require every handed-off application tab to appear in the complete
   user-owned inventory as reachability proof.
3. Before claiming a tab is visible, focus or reveal that exact review tab
   through the adapter's documented presentation action and verify its
   documented visible state or exact user-visible handoff receipt. Inventory
   membership alone is never visibility proof.
4. Report the actual browser surface and any tab that could not be proven
   visible. Never convert controller ownership into a visibility claim.

If the host cannot provide a complete user inventory or an exact visibility
receipt, preserve the tab but say that visibility is unverified. Do not tell
the user to submit a form that has not been proven reachable from their
surface.

## Browser-session finalization safety

Treat browser-session finalization as destructive cleanup, not as a harmless
handoff marker. Immediately before the final browser action of every turn:

1. Reconcile the complete current controller-owned and user-owned inventory
   union with the local job/run/tab ledger. Refresh both inventories
   immediately before building the keep list; a controller-only refresh cannot
   prove that a handed-off user tab still exists.
2. Build an explicit keep entry for every currently live mapped application
   tab, including frozen-batch members and legacy single-run tabs:
   `{ tab, status: "handoff" }`.
3. When the host exposes `browser.tabs.finalize`, call
   `browser.tabs.finalize({ keep })` exactly once as the final browser action.
   If no documented session finalizer exists, invoke the adapter's documented
   per-tab durable-handoff primitive for every live application tab and verify
   an exact persistence receipt for each one. Never invoke an implicit
   close-all cleanup or an undocumented substitute.
4. Never finalize with an omitted, empty, partial, guessed, or stale keep list.
5. Do not use undocumented per-tab `finalize`, `markHandoff`, or
   `markDeliverable` calls. Use only the browser's documented session-level
   finalizer or documented per-tab durable-handoff contract.
6. Never finalize while creating or restoring tabs; wait until all form
   mutations and committed-state checks for that turn are complete.

A review-ready, inspecting, needs-input, or submitted-but-unreconciled
application tab always remains `handoff` while it is live. Omit a ledger tab
only after the complete inventory union proves it is absent and either the
user explicitly requested closure or the user confirms they closed it
directly. For an incomplete user-closed tab, preserve the member and enter the
missing-tab recovery flow on the next turn; never claim the unsaved draft
survived. Agent-initiated closure still requires the submitted/applied
close-proof gate.

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
