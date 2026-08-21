# Operational checkpoints

Use this page as the run card. The detailed references define how to perform
each action; this page defines when a phase is allowed to advance.

## Invariant checklist

- Keep the latest explicit target as the hard target. An earlier target never
  returns after the user changes it. A smaller interim wave is not completion;
  continue replacements until the hard target is reached or the server proves
  queue exhaustion.
- Prove access to genuine applicant fields before counting a job as accessible.
- Show the exact jobs and require them to be approved before any form mutation.
  Approval to inspect or probe is not approval to fill.
- After job approval, inventory and fill every known value before producing one
  grouped question packet containing only true gaps.
- Resolve education, employment, confirmed EEO, authorization, resume, and
  supported writing from the current Trackly profile and evidence. Never infer
  a restricted or jurisdiction-specific fact.
- Run Humanizer for every supported employer-specific draft when that skill is
  available. Always run the self-contained writing gate as the fallback and
  final authority.
- Never activate Submit. The user owns the final submission action.
- Preserve every review-ready tab and unsaved draft across turns, handoffs, and
  restarts.
- Reconcile positive submission evidence before changing Trackly state. Close a
  completed tab only after durable `submitted` plus `applied_confirmed` proof and
  the saved cleanup policy.

## Execution mode decision

| User intent | Mode | Required behavior |
|---|---|---|
| Fill or apply to the next N accessible jobs | `complete_next_n_accessible` | Recover the active execution first; retain the latest explicit target; replace typed blockers until target or exhaustion. |
| Inspect the next N queue records | Fixed inspection | Freeze exactly N records; do not replace or replenish them. |
| Continue after tab, app, or context loss | Active recovery | Restore exact server lineage, tab state, and mutation authority as three independent receipts. |
| Reconcile work the user already submitted | Terminal reconciliation | Record current-epoch positive evidence before outcomes; do not reopen or refill forms. |

Never use the fixed-batch approval endpoint for an accessible execution. Use the
execution-scoped resume approval required by the current protocol. Never create
a replacement run for a member that already has one or for a queued member whose
run start conflicts; preserve it and report the typed control-plane conflict.

## Two approval gates

1. **Job approval:** after non-mutating access probes prove the exact accessible
   set, show company, role, requisition identity when available, and any shortfall
   from the hard target. No application control may be changed before approval.
2. **Answer approval:** after approval, fill all deterministic controls first.
   Ask once for only `missing_fact`, `live_consent`, or user-resolvable
   `forbidden_inference` items that are visible now. A final truthfulness
   certification remains per run.

## Phase receipts

Keep these receipts local and value-free. Never include labels, answers, names,
emails, phone numbers, URLs, resume paths, demographics, or free-text content.
Before claiming a phase complete, resolve `<skill-dir>` as the directory that
contains the loaded `SKILL.md`, then run from any working directory:

```text
node "<skill-dir>/scripts/validate-phase-checkpoint.js" <phase>
```

Pass `{"receipt": {...}, "expectedContext": {...}}` on standard input. The
envelope permits only those two fields. `expectedContext` is required for
access, fill, review, and reconciliation, and must be omitted for selection. Build
it only from the current authoritative work receipt. For access, include the
exact current `waveJobIds`, including typed blockers. For later phases, include
the exact `approvedJobIds` from the validated selection or authoritative
recovered approval receipt. A nonzero exit means the
phase is not complete. The script accepts `selection`, `access`, `fill`,
`review`, and `reconciliation`.

### Selection

Required fields:

- `workMode`: `accessible_execution` or `fixed_inspection`;
- `latestExplicitTarget`: integer 1-20 for an accessible execution, or 1-100
  for a fixed inspection, matching the public batch-size contract;
- `approvedJobIds`: unique positive safe-integer Trackly job IDs for the exact
  approved set. This may be
  empty only when the accessible queue is exhausted;
- `approvalRecorded: true`;
- `noFormMutationBeforeApproval: true`; and
- `queueExhausted`: boolean. A non-empty set smaller than the target is a valid
  interim wave; only an empty set requires this to be true.

### Access

Required fields:

- the same mode-specific current work lineage used by Fill: `workMode`,
  `batchId`, `memberId`, `jobId`, `runId`, and non-negative `inspectionEpoch`,
  plus `executionId` only for `accessible_execution`; every value must match
  the current `expectedContext`, and `jobId` must belong to its exact
  `waveJobIds` set. This set includes terminal blockers so their required probe
  receipts can validate before replacement scheduling;
- a terminal classification supported by the active durable disposition
  contract. Under contract 3.7.3, locally observed `applicant_fields_reached`
  uses durable `accessible`, while a locally observed `inactive` posting uses
  conservative `unknown_unobservable`; never put either unsupported local state
  name in the receipt or claim Trackly stored it;
- `exactRequisitionVerified`, `originAndTenantVerified`, and
  `nonMutatingProbe` all true;
- `privateDataEntered: false`; and
- `applicantControlsObserved: true` only for durable `accessible` and
  `captcha_at_submit`.

### Fill

Required fields:

- `workMode`: `accessible_execution` or `fixed_inspection`;
- positive safe-integer `batchId`, `memberId`, `jobId`, and `runId`, plus a
  non-negative safe-integer `inspectionEpoch`; every value must equal the same
  field in `expectedContext`, and `jobId` must belong to
  `expectedContext.approvedJobIds`;
- positive safe-integer `executionId` for `accessible_execution`, matching
  `expectedContext`; omit it from both objects for `fixed_inspection`;
- `visibleControlCount`, `committedControlCount`, and `typedExceptionCount` as
  non-negative safe integers, where committed plus exceptions equals visible;
- `knownOmissionCount: 0`;
- `knownFieldsFilledBeforeQuestions: true`;
- `parserSensitiveFieldsRechecked: true`;
- `educationAndEmploymentVerified: true`;
- `writingPresent`: boolean;
- `localWritingGate`: `passed` when writing is present, otherwise
  `not_applicable`;
- `humanizerAvailability`: `available`, `unavailable`, or `not_applicable`;
- `humanizerRan: true` when Humanizer is available;
- `humanizerFallbackUsed: true` only when writing is present and Humanizer is
  unavailable. This names the fallback path; `localWritingGate` is the
  always-run final authority; and
- `questionPacketTrueGapsOnly: true`.

The fill receipt fails when any known visible control lacks either a committed
receipt or a typed exception.

### Review

Required fields:

- the same mode-specific lineage as Fill: `workMode`, `batchId`, `memberId`,
  `jobId`, `runId`, and non-negative `inspectionEpoch`, plus `executionId` only
  for `accessible_execution`; every value must match the current
  `expectedContext`, and `jobId` must remain in its approved set;
- `finalIntegrityPassed`, `truthConfirmationRecorded`,
  `reviewTabPreserved`, and `userVisibleHandoffProven` all true; and
- `submitActivated: false`.

### Reconciliation

Required fields:

- the same mode-specific current work lineage and approved-job binding required
  by Review. Reconciliation stays bound to the submitted run even though it is
  a post-submission phase;
- `positiveSubmissionEvidenceRecorded: true`;
- `memberLifecycle: submitted`;
- `tracklyJobStatus: applied_confirmed`;
- `cleanupPreference`: `never`, `submitted_only`, or
  `submitted_and_probe_blockers`;
- `browserTabStatus`: `open`, `missing`, `closure_unverified`, or
  `closed_verified`; `missing` records a durable missing-tab observation but is
  not closure proof; and
- for `closed_verified`, `completeTabInventoryRecorded`,
  `closeReceiptRecorded`, and `postCloseUnionAbsenceProven` true.

`cleanupPreference: never` forbids `closed_verified`, even when closure evidence
exists, because evidence cannot override the user's saved no-close policy.
For `open`, `missing`, or `closure_unverified`, all three close-proof fields must
be false or omitted.

Every final report must state the application lifecycle, Trackly job status,
browser tab status, and whether absence is actually `closed_verified`. These
are separate facts and none implies another.
