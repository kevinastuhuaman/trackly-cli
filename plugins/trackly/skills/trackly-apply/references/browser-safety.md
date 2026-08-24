# Browser safety

Contact and address values come only from the current requested canonical
profile projection. Conversation, screenshots, parser output, autocomplete,
and cached values are not authority. Verify rendered live, framework/native, or
accessibility state after events settle; a static `value` attribute is not
proof. Normalize masked phone digits and country code before comparing them to
the canonical value, and require an exact autocomplete option to be committed.

## Readiness gate

Before entering private data, require all of the following:

- The work packet is current and authorizes form mutation.
- The URL is HTTPS.
- The visible employer and role match the approved job.
- The browser opened only the frozen `navigation.requisitionUrl`; the current
  origin and any policy-required ATS tenant match its server-verified policy.
  An exact-origin employer policy requires the exact listed origin, not a tenant.
- After every redirect and for every application iframe, the origin and any
  policy-required ATS tenant were revalidated against that same frozen policy.
- Browser and accessibility state agree on the committed controls.
- A verified end-to-end tab and unsaved-draft preservation path exists before any mutation: either the documented session finalizer plus complete current controller-owned and user-owned inventories for an explicit keep list, or a documented per-tab durable-handoff primitive with an exact verifiable persistence receipt for every target tab.

Stop when any identity, origin, or preservation check is ambiguous. A logo, page title, substring match, familiar visual design, stale tab inventory, or unverified handoff claim is not sufficient authorization.

## Browser-turn preservation

Before ending every browser turn, reconcile the complete current inventory of live bound application tabs. Pass every one to the documented session finalizer in an explicit keep entry with `status: handoff`, or invoke the documented per-tab durable handoff for every live tab and verify each exact persistence receipt. Never end a browser turn after an omitted, empty, partial, inferred, stale, or unverified keep/handoff operation. Preserve every tab and draft until the user submits or explicitly asks to close it.

## Field integrity

- Inventory the entire form before mutation and again before review. Give every
  visible control one committed or typed-exception accounting row; the row
  count must equal the visible inventory and known omissions must be zero.
- Preserve user edits byte-for-byte unless the user explicitly asks for a rewrite.
- Use semantic labels for selects, radios, and checkboxes; never choose by index or proximity.
- Verify email and phone values exactly and reject duplicate or concatenated values.
- Treat missing date precision as unknown. Ask instead of choosing a default month or day.
- Reconcile all canonical education entries and position-level employment
  records in reverse chronological order. Promotions remain separate records;
  never flatten them into one employer row or invent missing date precision.
- Keep employer-specific, provider-specific, and global answers in their correct scopes.
- Never interpret one consent as permission for a different consent.

## Resume integrity

Prepare a resume only after finding a real attachment control. When trackly returns `requiresLocalAgentOrManualUpload`, ask the user to attach it, verify only the filename visibly committed on the employer page, and never claim an artifact identity, preview, or hash exists. When trackly supplies a verifiable artifact identity and safe preview, bind approval to that exact artifact, let the user inspect it, verify it immediately before upload, and confirm the displayed filename after attachment. In both paths, recheck parser-sensitive fields and prove during the final sweep that the attachment is still present. Never expose an internal cache identifier to the employer.

## Challenges and final boundary

Do not solve or bypass CAPTCHA, OTP, email verification, credentials, or account creation. Preserve the page for the user. The final Submit control is always a manual boundary, even when the user previously approved filling the application.
