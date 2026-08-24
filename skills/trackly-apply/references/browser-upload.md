# Browser upload

Resume approval proves the content the user authorized. Attachment proof proves
that the browser committed that exact file. Neither fact substitutes for the
other.

## Capability gate

Before opening a file chooser, require the active browser adapter to advertise
all five capabilities: semantic control discovery, chooser arming, file
attachment, committed-filename inspection, and parser-field recheck. If any is
missing, fail closed before opening the chooser and hand the upload to the user. Never
navigate to a `file://` URL or paste a local path into an ordinary text field.

When the user performs that handoff upload, keep it explicitly manual,
browser-local, and unbound. Record `resumeAudit.mode: manual_unbound`,
`approval: passed`, `preAttachVerification: not_applicable`, and
`attachmentCommit: user_confirmed` only for this genuine manual path; do not use
those values for an agent-performed upload or a failed verifier. Before
continuing, require `passed` filename verification and parser recheck, then
prove during the `passed` final sweep that the attachment and filename persist.

Perform these stages in exact order:

1. identify the exact semantic Resume or CV control;
2. arm the file chooser before clicking that control;
3. prove the chooser opened;
4. run `trackly_verify_prepared_resume`, then immediately attach that verified
   file through the adapter's documented file-setting primitive;
5. verify the employer-facing filename committed;
6. recheck every contact, employment, education, and other field that resume
   parsing may have changed; and
7. during the final sweep, prove the attachment is still committed and the
   visible filename remains the approved employer-facing filename.

Pass only the value-free stage outcomes to
`trackly_validate_apply_resume_upload`. Do not pass a filename, local path,
resume hash, form value, URL, page text, or tab identifier. Claim attachment
success only when it returns `safeToClaimAttachment: true`. Record the six
audited outcomes separately: approval, pre-attach verification, attachment
commit, filename verification, parser recheck, and final-sweep persistence. A
single upload-success boolean cannot replace this chain.

Stable failure codes include capability unavailable, ambiguous control,
chooser timeout, chooser opened without a commit, missing or expired file,
file-setting failure, uncommitted filename, unexpected file navigation,
unsettled parser, and parser-field regression. A failure is a handoff or retry
decision, never permission to guess another control or weaken verification.

Snapshot field provenance immediately before upload. Mark parser changes as
`parser_filled`; preserve a later user edit byte-for-byte. After ledger loss,
preserve every unknown non-empty value. Never let parser rechecks or the final
required-field sweep overwrite user-owned or unknown external values.

The employer-facing filename must remain the user's confirmed filename.
Random cache identifiers may appear only in private parent directories.
