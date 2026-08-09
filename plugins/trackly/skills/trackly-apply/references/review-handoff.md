# Review handoff

The handoff is valid only when the live application is visibly complete and the final Submit control remains untouched.

## Required checks

- Employer, role, requisition when available, and current origin still match the approved work packet.
- Every visible required field has a committed value and no visible validation error.
- Known optional answers were not silently omitted.
- Contact values are exact, with no duplicates or concatenation.
- Conditional and consent fields reflect only confirmed answers.
- Any manually attached resume has the filename the user visibly confirmed. When trackly supplied verifiable artifact proof, it also matches the exact artifact the user approved.
- Free text passed deterministic lint and every claim is supported.
- The manual-submit boundary is visible and was not activated.

## User-facing handoff

Show the employer and role, the exact browser tab or surface, unresolved items if any, the resume filename when attached, and the checks that passed. Ask for truthfulness confirmation only for the exact complete application currently shown. For a manual resume upload, separately ask the user to confirm that the visible filename is their intended attachment; the filename check does not bind or attest the browser-local bytes.

Call `trackly_certify_review_ready` with the exact current binding and value-free fingerprints described in [lifecycle-contract.md](lifecycle-contract.md). It atomically persists the review checkpoint, truth certification, and review-ready outcome. Any manual resume upload remains unbound and unattested. After certification succeeds, leave the tab at review and tell the user that they—not trackly—must submit. Do not describe review-ready as submitted.

After manual submission, call `trackly_reconcile_manual_submission` with the exact current binding and matching typed confirmation evidence described in [lifecycle-contract.md](lifecycle-contract.md). Reconcile only from a visible success state or the user's explicit confirmation. Preserve the confirmation surface until a fresh work response proves the durable submitted state.
