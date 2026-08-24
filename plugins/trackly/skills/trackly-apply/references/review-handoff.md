# Review handoff

The handoff is valid only when the live application is visibly complete and the final Submit control remains untouched.

Every update reports three independent lines: **Employer application state**
(what the live form shows), **Trackly state** (execution, member, and job), and
**Browser state** (presence, preservation, visibility, or verified closure).
No state in one system implies a state in another. A preserved or
controller-owned tab with visibility unverified must be labeled that way and
must not be presented as ready for the user's Submit action.
Verified visibility must remain bound to the exact browser-binding hash and a
value-free visible-inventory or durable-handoff evidence fingerprint; a boolean
claim alone is not proof.

## Required checks

- Employer, role, requisition when available, and current origin still match the approved work packet.
- Every visible required field has a committed value and no visible validation error.
- Known optional answers were not silently omitted.
- Contact values are exact, with no duplicates or concatenation.
- Conditional and consent fields reflect only confirmed answers.
- Any manually attached resume has the filename the user visibly confirmed. When trackly supplied verifiable artifact proof, it also matches the exact artifact the user approved.
- Free text passed deterministic lint and every claim is supported.
- The manual-submit boundary is visible and was not activated.
- Every bound review tab is included in the browser session's verified preservation or durable-handoff receipt.
- The exact review tab is visibly reachable to the user, or an exact user-visible handoff receipt proves how to reach it. Inventory membership alone is not visibility proof.

## User-facing handoff

Show the employer and role, the exact browser tab or surface, its verified preservation receipt and user-visible reachability proof, unresolved items if any, the resume filename when attached, and the checks that passed. Ask for truthfulness confirmation only for the exact complete application currently shown. For a manual resume upload, separately ask the user to confirm that the visible filename is their intended attachment; the filename check does not bind or attest the browser-local bytes. If preservation or user-visible reachability is unverified, preserve the tab, mark visibility unverified, and do not tell the user to submit until the exact tab is reclaimed and visibly proven.

Call `trackly_certify_review_ready` with the exact current binding and value-free fingerprints described in [lifecycle-contract.md](lifecycle-contract.md). It atomically persists the review checkpoint, truth certification, and review-ready outcome. Any manual resume upload remains unbound and unattested. Certification of one member is not permission to stop: certify every ready mutable member in the current bound wave, refetching after each mutation and obeying authoritative blockers and allowed operations. Before manual submission, after every currently ready member has durable review-ready certification, leave only those certified tabs at review and tell the user that they—not trackly—must submit. Do not describe review-ready as submitted.

After manual submission, call `trackly_reconcile_manual_submission` with the exact current binding and matching typed confirmation evidence described in [lifecycle-contract.md](lifecycle-contract.md). Reconcile only from a visible success state or the user's explicit confirmation. Preserve each confirmation surface until a fresh work response proves the durable submitted state, then exclude that reconciled member from any later review handoff while continuing through every remaining ready sibling. Process every ready member in the bound wave; never abandon ready siblings because one member certified or reconciled. Never tell the user to submit an already reconciled member.
