# Browser safety

## Readiness gate

Before entering private data, require all of the following:

- The work packet is current and authorizes form mutation.
- The URL is HTTPS.
- The visible employer and role match the approved job.
- The current origin and ATS tenant match the packet's allowed origin policy.
- Browser and accessibility state agree on the committed controls.

Stop when any identity or origin check is ambiguous. A logo, page title, substring match, or familiar visual design is not sufficient authorization.

## Field integrity

- Inventory the entire form before mutation and again before review.
- Preserve user edits byte-for-byte unless the user explicitly asks for a rewrite.
- Use semantic labels for selects, radios, and checkboxes; never choose by index or proximity.
- Verify email and phone values exactly and reject duplicate or concatenated values.
- Treat missing date precision as unknown. Ask instead of choosing a default month or day.
- Keep employer-specific, provider-specific, and global answers in their correct scopes.
- Never interpret one consent as permission for a different consent.

## Resume integrity

Prepare a resume only after finding a real attachment control. When trackly returns `requiresLocalAgentOrManualUpload`, ask the user to attach it, verify only the filename visibly committed on the employer page, and never claim an artifact identity, preview, or hash exists. When trackly supplies a verifiable artifact identity and safe preview, bind approval to that exact artifact, let the user inspect it, verify it immediately before upload, and confirm the displayed filename after attachment. Never expose an internal cache identifier to the employer.

## Challenges and final boundary

Do not solve or bypass CAPTCHA, OTP, email verification, credentials, or account creation. Preserve the page for the user. The final Submit control is always a manual boundary, even when the user previously approved filling the application.
