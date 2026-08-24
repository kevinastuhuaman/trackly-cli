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
envelope permits only those two fields. `expectedContext` is required for every
phase. Build Trackly lineage, profile, lifecycle, and approval fields only from
the current authoritative work receipt. Build browser-surface fields such as
`formInventoryFingerprint`, `resumeControl`, and browser handoff evidence only
from the independently captured, value-free current browser baseline; never
present those fields as backend-returned facts. For selection, include
`workMode`, the authoritative `latestExplicitTarget`,
`batchId`, `queueExhausted`, and `selectableJobIds`: the access-proven job IDs
for an accessible execution or exact frozen member job IDs for a fixed
inspection. Include `executionId` only for an accessible execution. For access,
include the
exact current `waveJobIds`, including typed blockers. For later phases, include
the exact `approvedJobIds` from the validated selection or authoritative
recovered approval receipt. A nonzero exit means the
phase is not complete. The script accepts `selection`, `access`, `fill`,
`review`, `handoff`, and `reconciliation`. `handoff` is a reporting receipt,
not authority to claim review readiness; it exists so visibility-unverified
work can be represented without pretending that it is visible.

### Selection

Required fields:

- `workMode`: `accessible_execution` or `fixed_inspection`;
- positive safe-integer `batchId`, plus positive safe-integer `executionId` only
  for an accessible execution;
- `latestExplicitTarget`: integer 1-20 for an accessible execution, or 1-100
  for a fixed inspection, matching the public batch-size contract;
- `approvedJobIds`: unique positive safe-integer Trackly job IDs for the exact
  approved set. This may be
  empty only when the accessible queue is exhausted;
- `approvalRecorded: true`;
- `noFormMutationBeforeApproval: true`; and
- `queueExhausted`: boolean. A non-empty set smaller than the target is a valid
  interim wave; only an empty set requires this to be true.

Every selection field must match `expectedContext`, and every approved job ID
must belong to `expectedContext.selectableJobIds`. The user's approval may
authorize a subset, but it can never introduce a job or shrink the hard target.

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
- `exactRequisitionVerified`, `originPolicyVerified`, and
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
- bind the receipt to the independently captured form/profile baseline: the
  same `profileRevision` must appear in both the receipt and `expectedContext`;
  it is a non-negative safe integer for
  `fixed_inspection` (so revision `0` is valid) and a positive safe integer for
  `accessible_execution`; canonical education and employment-position counts
  are non-negative safe integers; also include the exact value-free
  `formInventoryFingerprint` and `resumeControl` (`required`, `optional`, or
  `absent`);
- `visibleControlCount` is a safe integer of at least 1;
  `committedControlCount` and `typedExceptionCount` are non-negative safe
  integers, and committed plus exceptions equals visible;
- `controlAccounting`: one count for each allowed disposition
  (`filledExactProfile`, `filledSafeDerivation`, `filledSupportedDraft`,
  `preservedUserEdit`, `missingFact`, `liveConsent`,
  `authenticationBlocker`, `unobservableCommit`, `unsupportedControl`, and
  `notApplicable`). These counts must independently reconcile to the three
  aggregate counts above;
- `formInventoryFingerprint`: a lowercase SHA-256 over only the ordered,
  value-free semantic control fingerprints and their dispositions. Never hash
  labels, values, page text, URLs, or local paths into it;
- `knownOmissionCount: 0`;
- `knownFieldsFilledBeforeQuestions: true`;
- `answerLookupCompleted: true`, plus typed counts in
  `answerLookupScopeCounts` for `run`, `question`, `office`, `jurisdiction`,
  `company`, `provider`, and `global`, and a value-free
  `answerLookupFingerprint`. Query every applicable scope before asking;
- `parserSensitiveFieldsRechecked: true`;
- `educationAndEmploymentVerified: true`;
- `historyReconciliation`: canonical and accounted education-record counts,
  using `canonicalEducationRecordCount` and
  `accountedEducationRecordCount`; canonical and accounted employment-position
  counts using `canonicalEmploymentPositionCount` and
  `accountedEmploymentPositionCount`; reverse-chronological order proofs,
  `datePrecisionInvented: false`, and value-free reconciliation fingerprints.
  Positions, including promotions at one employer, are records; an employer
  summary is not a position-level reconciliation;
- `resumeAudit`: `control` is `required`, `optional`, or `absent`, and `mode` is
  `automated_verified`, `manual_unbound`, or `not_applicable`. An absent control
  requires `mode: not_applicable` and `not_applicable` for every stage. A
  required or optional automated upload requires `mode: automated_verified`
  and `passed` for every stage. Use `mode: manual_unbound` only when the user
  genuinely performs a browser-local upload that remains unbound; require
  `approval: passed`, `preAttachVerification: not_applicable`,
  `attachmentCommit: user_confirmed`, and `passed` for
  `filenameVerification`, `parserRecheck`, and `finalSweep`. Never use the
  manual mode for an agent-performed upload or a failed verifier;
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
- bind `checkpointAction: review/manual_submit` and
  `continuationAllowed: false` in both the receipt and `expectedContext` to the
  exact backend-accepted action result; a
  non-negative `resolvedActionCount`, and a value-free
  `resolvedActionIdsFingerprint`. Both fields must match the authoritative
  `expectedContext`; do not include raw action IDs;
- bind the receipt and `expectedContext` to the exact backend result:
  `checkpointStatus` (`recorded` or `replayed`), positive
  `checkpointMemberVersion`, non-negative `checkpointInspectionEpoch`,
  `checkpointLifecycle: review_ready`, `checkpointActionCount`, and
  `checkpointActionIdsFingerprint`. Newly recorded checkpoint actions and
  previously open actions resolved by the review are separate sets, so each
  summary binds independently to `expectedContext` rather than being forced to
  equal the other. `checkpointInspectionEpoch` must equal the receipt's current
  `inspectionEpoch`. A rejected or malformed checkpoint
  fails closed: refetch the current contract once, correct the payload only when
  the current schema proves how, and never claim durable review readiness until
  the backend accepts it; and
- `submitActivated: false`.

### Handoff state report

Use this receipt whenever reporting or transferring work, including when the
review tab cannot be proven visible. Report `employerApplicationState`,
`tracklyMemberState`, `tracklyJobState`, and `browserTabState` independently.
Set `handoffVisibility` to `verified` only for a visibly proven or exact
durably handed-off tab. Otherwise use `unverified` and
`reviewReadyClaimed: false`. A state in one system never implies a state in
another, and a valid unverified handoff receipt never authorizes telling the
user to submit. `browserTabState: durable_handoff_proven` is invalid with
unverified visibility and requires a `durable_handoff_receipt`. A true
`reviewReadyClaimed` requires `checkpointStatus`,
`checkpointMemberVersion`, `checkpointInspectionEpoch`, and
`checkpointLifecycle`; the checkpoint epoch must equal the receipt's current
`inspectionEpoch`. The reported `employerApplicationState`,
`tracklyMemberState`, and `tracklyJobState` must match the current authoritative
`expectedContext` for every handoff, even when readiness is not claimed. The
checkpoint fields must also match when readiness is claimed. The member may be
in the durable `review_ready` checkpoint state or the subsequent
`awaiting_manual_submit` state produced after the certified review-ready outcome
is recorded, but the current job state must still be `check_later`; a revoked,
already-applied, or unknown job cannot be handed off as review-ready. A verified
handoff must bind the receipt and `expectedContext` to
the exact `browserBindingHash`, a value-free `handoffEvidenceFingerprint`, and
`handoffEvidenceType`. A visible tab requires either
`visible_presentation_receipt` from the adapter's exact-tab focus/reveal action
and verified visible state, or `user_visible_handoff_receipt` from an exact
current tab-bound user-visible handoff. Inventory membership alone is never
visibility proof. A durably handed-off tab requires
`durable_handoff_receipt`. Omit those evidence fields when visibility is
unverified.

### Reconciliation

Required fields:

- the same mode-specific current work lineage and approved-job binding required
  by Review. Reconciliation stays bound to the submitted run even though it is
  a post-submission phase;
- bind the receipt and `expectedContext` to the freshly refetched backend
  result: `positiveSubmissionEvidenceRecorded: true`,
  `memberLifecycle: submitted`, and `tracklyJobStatus: applied_confirmed`.
  Self-authored terminal values are not authority; if the backend still reports
  any nonterminal state, reconciliation and cleanup fail closed;
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
