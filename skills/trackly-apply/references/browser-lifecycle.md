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
